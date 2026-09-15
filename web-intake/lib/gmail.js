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

async function getUnreadLeadEmails() {
  const client = getImapClient();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const results = [];
  try {
    for await (const msg of client.fetch({ seen: false }, { envelope: true })) {
      results.push({
        id: msg.uid,
        fullName: msg.envelope.from?.[0]?.name || '',
        email: msg.envelope.from?.[0]?.address || '',
        subject: msg.envelope.subject || '',
        snippet: ''
      });
    }
  } finally {
    lock.release();
  }
  await client.logout();
  return results;
}

async function markAsRead(uid) {
  const client = getImapClient();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try { await client.messageFlagsAdd(uid, ['\\Seen']); }
  finally { lock.release(); }
  await client.logout();
}

module.exports = { sendEmail, getUnreadLeadEmails, markAsRead };