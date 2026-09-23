const { processUnreadEmails } = require('../../lib/gmail');
const { createLead } = require('../../lib/create-lead');

module.exports = async (req, res) => {
  const expected = process.env.CRON_CHECK_SECRET;
  const viaHeader = Boolean(expected) && req.headers.authorization === `Bearer ${expected}`;
  const viaBrowser = Boolean(expected) && Boolean(req.query) && req.query.secret === expected;
  if (!viaHeader && !viaBrowser) return res.status(401).json({ error: 'unauthorized' });

  const ownAddress = (process.env.GMAIL_ADDRESS || '').toLowerCase();
  const processed = [];
  const skipped = [];
  const failed = [];

  try {
    const result = await processUnreadEmails(async (email) => {
      if (ownAddress && email.email.toLowerCase() === ownAddress) {
        skipped.push({ from: email.email, subject: email.subject, reason: 'own address' });
        return true;
      }
      // System/notification mail lands in the same inbox and would otherwise be retried as a
      // "lead" on every run it stays unread -- mark it read and move on instead.
      if (/no-?reply|mailer-daemon|notifications?@|calendar-notification|accounts\.google\.com/i.test(email.email)) {
        skipped.push({ from: email.email, subject: email.subject, reason: 'system sender' });
        return true;
      }

      try {
        await createLead({
          fullName: email.fullName, email: email.email, companyName: email.subject,
          notes: email.snippet, leadSource: 'email'
        });
        processed.push({ from: email.email, subject: email.subject });
        return true;
      } catch (e) {
        console.error('check-email: createLead failed for', email.email, e.message);
        failed.push({ from: email.email, error: e.message });
        return false; // leave unread, retry next run
      }
    }, { budgetMs: Number(process.env.CHECK_EMAIL_BUDGET_MS) || 20000 });

    res.status(200).json({
      checked: result.checked,
      processed: processed.length,
      details: processed,
      skipped,
      failed,
      ranOutOfTime: result.ranOutOfTime,
      timings: result.timings
    });
  } catch (e) {
    console.error('check-email: could not read the inbox:', e);
    res.status(500).json({ error: 'Could not connect to the inbox', detail: e.message });
  }
};