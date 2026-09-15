const { createClient } = require('@supabase/supabase-js');
const { createOrUpdateContact } = require('../lib/hubspot');
const { sendEmail } = require('../lib/gmail');

module.exports = async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_CHECK_SECRET}`) return res.status(401).end();

  try {
    const emails = await getUnreadLeadEmails();
    const results = [];

    for (const email of emails) {
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

    return res.status(200).json({ checked: emails.length, processed: results.length });
  } catch (err) {
    console.error('check-email failed:', err);
    const errDetails = {};
    Object.getOwnPropertyNames(err).forEach(k => { errDetails[k] = err[k]; });
    return res.status(500).json(errDetails);
  }
};