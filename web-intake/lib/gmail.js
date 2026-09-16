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
async function processUnreadEmails(handler) {
  const client = getImapClient();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  let checked = 0, processed = 0;
  try {
    for await (const msg of client.fetch({ seen: false }, { envelope: true })) {
      checked++;
      const email = {
        id: msg.uid,
        fullName: msg.envelope.from?.[0]?.name || '',
        email: msg.envelope.from?.[0]?.address || '',
        subject: msg.envelope.subject || '',
        snippet: ''
      };
      if (await handler(email)) {
        await client.messageFlagsAdd(msg.uid, ['\\Seen']);
        processed++;
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();
  return { checked, processed };
}

module.exports = { sendEmail, processUnreadEmails };