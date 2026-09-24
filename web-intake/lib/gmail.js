const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 10000
});

async function sendEmail({ to, subject, body, cc }) {
  await transporter.sendMail({ from: process.env.GMAIL_ADDRESS, to, cc, subject, text: body });
}

function getImapClient() {
  const client = new ImapFlow({
    disableAutoIdle: true,
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false
  });
  // Without an 'error' listener, a dropped connection can crash the whole function.
  client.on('error', err => console.warn('check-email: IMAP client error:', err.message));
  return client;
}

const TIMEOUT = Symbol('timeout');
class OutOfTime extends Error {}

// Races a promise against a deadline. Out of time -> resolves TIMEOUT.
// Real errors still reject so the caller can see them (the old version turned every error into a
// fake "timeout", which hid the actual problem). A failure that lands after the race is over is
// swallowed, so it can never become an unhandled rejection.
function withDeadline(promise, deadlineAt) {
  let timer;
  const work = Promise.resolve(promise);
  work.catch(() => {});
  const clock = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(250, deadlineAt - Date.now()));
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

// Never waits on Gmail: a polite LOGOUT for at most 1s, then the socket is force-closed.
async function closeImap(client) {
  try { await withDeadline(client.logout(), Date.now() + 1000); } catch {}
  try { client.close(); } catch {}
}

// handler(email) returns:  true   -> handled: mark the email read
//                          'skip' -> ignore it, but mark it read so it stops being re-checked
//                          false  -> leave it unread and try again next run
// Always returns within `budgetMs` and always closes the connection.
async function processUnreadEmails(handler, { sinceDays = 1, maxMessages = 5, budgetMs = 20000 } = {}) {
  const deadlineAt = Date.now() + budgetMs;
  const timings = {};
  const perEmail = [];
  let checked = 0, processed = 0, ranOutOfTime = false, stage = 'start', lock = null;
  const own = (process.env.GMAIL_ADDRESS || '').trim().toLowerCase();

  console.log(`check-email: starting, budget ${budgetMs}ms`);
  const client = getImapClient();

  // Runs one IMAP step against the shared deadline and records how long it took.
  const step = async (name, timingKey, promise) => {
    stage = name;
    const t = Date.now();
    try {
      const out = await withDeadline(promise, deadlineAt);
      if (out === TIMEOUT) throw new OutOfTime(`did not finish within the ${budgetMs}ms budget`);
      return out;
    } finally {
      timings[timingKey] = Date.now() - t;
    }
  };

  // true | false | TIMEOUT. Marked by UID: without { uid: true } imapflow reads the number as a
  // message POSITION, so it would flag the wrong email (or none) and the same one would come back every run.
  const markRead = uid =>
    withDeadline(client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }), deadlineAt)
      .catch(err => { console.error(`check-email: could not mark uid ${uid} read:`, err.message); return false; });

  try {
    await step('connect', 'connectMs', client.connect());
    lock = await step('lock', 'lockMs', client.getMailboxLock('INBOX'));

    // 1) List the unread UIDs. 2) Download just those envelopes, start to finish.
    // Nothing else may touch the connection while the download runs: imapflow hangs if it does.
    // (The old loop marked emails read INSIDE the download, and a stalled download also blocked logout.)
    const since = new Date(Date.now() - sinceDays * 86400000);
    const found = await step('search', 'searchMs', client.search({ seen: false, since }, { uid: true }));
    const uids = (Array.isArray(found) ? found : []).slice(0, maxMessages);
    console.log(`check-email: ${Array.isArray(found) ? found.length : 0} unread, taking ${uids.length}`);

    const messages = [];
    if (uids.length) {
      await step('fetch', 'fetchMs', (async () => {
        for await (const msg of client.fetch(uids.join(','), { envelope: true }, { uid: true })) messages.push(msg);
      })());
    }

    // 3) The download is finished, so it is now safe to handle each email and mark it read.
    for (const msg of messages) {
      checked++;
      const env = msg.envelope || {};
      const email = {
        id: msg.uid,
        fullName: env.from?.[0]?.name || '',
        email: env.from?.[0]?.address || '',
        subject: env.subject || '',
        snippet: ''
      };
      console.log(`check-email: [${checked}] from ${email.email || 'unknown'} - "${email.subject}"`);

      // Never leads: our own outgoing mail (producer notifications land in this same inbox) and
      // delivery-failure notices. Marked read here so they can't pile up and block real leads
      // behind the per-run limit.
      const isNoise = (own && email.email.toLowerCase() === own) || /^(mailer-daemon|postmaster)@/i.test(email.email);

      stage = 'handler';
      const tHandler = Date.now();
      const result = isNoise ? 'skip' : await withDeadline(
        Promise.resolve().then(() => handler(email)).catch(err => {
          console.error(`check-email: [${checked}] handler threw -- leaving unread:`, err.message);
          return false;
        }),
        deadlineAt
      );
      const handlerMs = Date.now() - tHandler;

      if (result === TIMEOUT) {
        perEmail.push({ from: email.email, handlerMs, timedOut: true });
        throw new OutOfTime('handler did not finish within the budget -- left unread, will retry next run');
      }
      if (!result) {
        perEmail.push({ from: email.email, handlerMs, skipped: true });
        continue;
      }

      stage = 'mark-read';
      const flagged = await markRead(msg.uid);
      if (result !== 'skip') processed++;
      perEmail.push({
        from: email.email, handlerMs,
        markedRead: flagged !== false && flagged !== TIMEOUT,
        ...(result === 'skip' ? { skipped: true } : {}),
        ...(isNoise ? { ownOrSystemMail: true } : {})
      });
      if (flagged === false || flagged === TIMEOUT) {
        // Handled, but still unread -- it will be picked up again next run.
        timings.problem = `mark-read failed for uid ${msg.uid} (it will be picked up again next run)`;
      }
      if (flagged === TIMEOUT) { ranOutOfTime = true; break; }
    }
  } catch (e) {
    if (e instanceof OutOfTime) ranOutOfTime = true;
    // Shows up in the JSON you already look at: which step stopped, and the real error message.
    timings.problem = `${stage}: ${e.message}`;
    console.error(`check-email: stopped during "${stage}":`, e.message);
  } finally {
    try { if (lock) lock.release(); } catch (e) { console.warn('check-email: lock release failed:', e.message); }
    const t = Date.now();
    await closeImap(client);
    timings.logoutMs = Date.now() - t;
  }

  console.log(`check-email: done -- checked ${checked}, processed ${processed}, ranOutOfTime ${ranOutOfTime}`);
  return { checked, processed, ranOutOfTime, timings, perEmail, ...(timings.problem ? { stage } : {}) };
}

module.exports = { sendEmail, processUnreadEmails };