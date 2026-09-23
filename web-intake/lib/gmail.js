const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD }
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

// One connection for the whole batch: fetches each unread message, hands it to `handler`,
// and marks it read in the SAME session the moment handler succeeds — instead of opening
// a brand new IMAP connection per message just to flip one flag.
//
// Watches INBOX rather than a separate label, so a real client email needs zero manual
// labeling to be picked up.
//
// `sinceDays` keeps this from re-scanning months of old unread newsletters/receipts on every
// run — only mail that's both unread AND recent is a realistic candidate for a new lead.
// `maxMessages` is a hard ceiling so one unusually large backlog can never blow past Vercel's
// function time limit again; anything past the cap is simply left unread and picked up on the
// next run a few minutes later, not lost.
async function processUnreadEmails(handler, { sinceDays = 3, maxMessages = 25 } = {}) {
  const timings = {};
  const t0 = Date.now();
  const client = getImapClient();
  await client.connect();
  timings.connectMs = Date.now() - t0;

  const t1 = Date.now();
  const lock = await client.getMailboxLock('INBOX');
  timings.lockMs = Date.now() - t1;

  const since = new Date(Date.now() - sinceDays * 86400000);

  let checked = 0, processed = 0, hitCap = false;
  const perEmailMs = [];
  try {
    const t2 = Date.now();
    for await (const msg of client.fetch({ seen: false, since }, { envelope: true })) {
      if (checked >= maxMessages) { hitCap = true; break; }
      checked++;
      const email = {
        id: msg.uid,
        fullName: msg.envelope.from?.[0]?.name || '',
        email: msg.envelope.from?.[0]?.address || '',
        subject: msg.envelope.subject || '',
        snippet: ''
      };
      const tHandler = Date.now();
      const ok = await handler(email);
      const handlerMs = Date.now() - tHandler;
      if (ok) {
        const tFlag = Date.now();
        await client.messageFlagsAdd(msg.uid, ['\\Seen']);
        perEmailMs.push({ from: email.email, handlerMs, flagMs: Date.now() - tFlag });
        processed++;
      } else {
        perEmailMs.push({ from: email.email, handlerMs, skipped: true });
      }
    }
    timings.fetchLoopMs = Date.now() - t2;
  } finally {
    lock.release();
  }
  const t3 = Date.now();
  await client.logout();
  timings.logoutMs = Date.now() - t3;

  return { checked, processed, hitCap, timings, perEmailMs };
}

module.exports = { sendEmail, processUnreadEmails };