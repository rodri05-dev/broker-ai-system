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
// Watches INBOX rather than a separate label — a real client email needs to be picked up
// with zero manual labeling. (Previously this watched a "Leads" label that nothing ever
// routed mail into, so nothing was ever found.)
async function processUnreadEmails(handler) {
  const timings = {};
  const t0 = Date.now();
  const client = getImapClient();
  await client.connect();
  timings.connectMs = Date.now() - t0;

  const t1 = Date.now();
  const lock = await client.getMailboxLock('INBOX');
  timings.lockMs = Date.now() - t1;

  let checked = 0, processed = 0;
  const perEmailMs = [];
  try {
    const t2 = Date.now();
    for await (const msg of client.fetch({ seen: false }, { envelope: true })) {
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

  return { checked, processed, timings, perEmailMs };
}

module.exports = { sendEmail, processUnreadEmails };