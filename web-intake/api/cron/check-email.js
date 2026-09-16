const { processUnreadEmails } = require('../../lib/gmail');
const { createLead } = require('../../lib/create-lead');

module.exports = async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_CHECK_SECRET}`) return res.status(401).end();

  try {
    const result = await processUnreadEmails(async (email) => {
      try {
        await createLead({
          fullName: email.fullName, email: email.email, companyName: email.subject,
          notes: email.snippet, leadSource: 'email'
        });
        return true;
      } catch (e) {
        console.error('Failed to create lead from email:', email.email, e);
        return false;
      }
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('check-email failed:', err);
    const errDetails = {};
    Object.getOwnPropertyNames(err).forEach(k => { errDetails[k] = err[k]; });
    return res.status(500).json(errDetails);
  }
};