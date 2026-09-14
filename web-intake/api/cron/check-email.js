const { getUnreadLeadEmails, markAsRead } = require('../../../lib/gmail');

module.exports = async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_CHECK_SECRET}`) return res.status(401).end();

  const emails = await getUnreadLeadEmails();
  const results = [];

  for (const email of emails) {
    // Reuse the exact same intake logic the web form uses, by calling our own endpoint —
    // keeps "what happens when a new lead arrives" defined in exactly one place.
    const submitRes = await fetch(`https://${req.headers.host}/api/submit-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: email.fullName, email: email.email, companyName: email.subject,
        notes: email.snippet, leadSource: 'email'
      })
    });
    if (submitRes.ok) { await markAsRead(email.id); results.push(email.id); }
  }

  res.status(200).json({ checked: emails.length, processed: results.length });
};