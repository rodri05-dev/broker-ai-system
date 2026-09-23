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
  return new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false
  });
}

// Races any promise against a shared deadline. On timeout it resolves to `fallback` instead
// of rejecting, and swallows whatever the original promise eventually does in the background,
// so a slow IMAP call that finishes late never turns into an unhandled rejection.
const TIMEOUT = Symbol('timeout');
function withDeadline(promise, deadlineAt, fallback = TIMEOUT) {
  const remaining = Math.max(250, deadlineAt - Date.now());
  return Promise.race([
    Promise.resolve(promise).catch(err => {
      console.warn('withDeadline: background rejection after race settled:', err.message);
      return fallback;
    }),
    new Promise(resolve => setTimeout(() => resolve(fallback), remaining))
  ]);
}

// One IMAP connection for the whole batch: fetches unread messages, hands each to `handler`,
// and marks it read in the SAME session the instant handler returns true. Every network-facing
// step is raced against `deadlineAt`, so this ALWAYS returns by then no matter how slow Gmail
// or `handler` is being -- it never depends on Vercel or cron-job.org to cut it off.
async function processUnreadEmails(handler, { sinceDays = 1, maxMessages = 5, budgetMs = 20000 } = {}) {
  const deadlineAt = Date.now() + budgetMs;
  const timings = {};
  const perEmail = [];
  let checked = 0, processed = 0, ranOutOfTime = false;

  console.log(`check-email: starting, budget ${budgetMs}ms`);
  const client = getImapClient();

  const t0 = Date.now();
  const connected = await withDeadline(client.connect(), deadlineAt);
  timings.connectMs = Date.now() - t0;
  if (connected === TIMEOUT) {
    console.error(`check-email: IMAP connect exceeded budget after ${timings.connectMs}ms`);
    client.close();
    return { checked: 0, processed: 0, ranOutOfTime: true, timings, perEmail, stage: 'connect' };
  }
  console.log(`check-email: connected in ${timings.connectMs}ms`);

  const t1 = Date.now();
  const lock = await withDeadline(client.getMailboxLock('INBOX'), deadlineAt);
  timings.lockMs = Date.now() - t1;
  if (lock === TIMEOUT) {
    console.error(`check-email: mailbox lock exceeded budget after ${timings.lockMs}ms`);
    withDeadline(client.logout(), Date.now() + 3000).catch(() => {});
    return { checked: 0, processed: 0, ranOutOfTime: true, timings, perEmail, stage: 'lock' };
  }
  console.log(`check-email: locked INBOX in ${timings.lockMs}ms`);

  const since = new Date(Date.now() - sinceDays * 86400000);

  try {
    const iterator = client.fetch({ seen: false, since }, { envelope: true })[Symbol.asyncIterator]();
    while (checked < maxMessages) {
      if (Date.now() > deadlineAt) { ranOutOfTime = true; console.warn('check-email: hit time budget before finishing the fetch loop'); break; }

      const step = await withDeadline(iterator.next(), deadlineAt);
      if (step === TIMEOUT) { ranOutOfTime = true; console.warn('check-email: fetching the next message exceeded budget'); break; }
      if (step.done) break;

      const msg = step.value;
      checked++;
      const email = {
        id: msg.uid,
        fullName: msg.envelope.from?.[0]?.name || '',
        email: msg.envelope.from?.[0]?.address || '',
        subject: msg.envelope.subject || '',
        snippet: ''
      };
      console.log(`check-email: [${checked}] from ${email.email || 'unknown'} - "${email.subject}"`);

      const tHandler = Date.now();
      const ok = await withDeadline(Promise.resolve().then(() => handler(email)), deadlineAt);
      const handlerMs = Date.now() - tHandler;

      if (ok === TIMEOUT) {
        console.warn(`check-email: [${checked}] handler exceeded budget after ${handlerMs}ms -- leaving unread, will retry next run`);
        perEmail.push({ from: email.email, handlerMs, timedOut: true });
        ranOutOfTime = true;
        break;
      }
      if (ok) {
        const tFlag = Date.now();
        await withDeadline(client.messageFlagsAdd(msg.uid, ['\\Seen']), deadlineAt);
        perEmail.push({ from: email.email, handlerMs, flagMs: Date.now() - tFlag });
        processed++;
        console.log(`check-email: [${checked}] processed in ${handlerMs}ms, marked read`);
      } else {
        perEmail.push({ from: email.email, handlerMs, skipped: true });
        console.log(`check-email: [${checked}] handler returned false -- left unread`);
      }
    }
  } catch (e) {
    console.error('check-email: fetch loop threw:', e.message);
  } finally {
    try { lock.release(); } catch (e) { console.warn('check-email: lock release failed:', e.message); }
  }

  const t3 = Date.now();
  await withDeadline(client.logout(), Date.now() + 3000).catch(() => {});
  timings.logoutMs = Date.now() - t3;

  console.log(`check-email: done -- checked ${checked}, processed ${processed}, ranOutOfTime ${ranOutOfTime}`);
  return { checked, processed, ranOutOfTime, timings, perEmail };
}

module.exports = { sendEmail, processUnreadEmails };