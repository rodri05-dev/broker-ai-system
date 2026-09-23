const { processUnreadEmails } = require('../../lib/gmail');

module.exports = async (req, res) => {
  // cron-job.org sends CRON_CHECK_SECRET as a Bearer header. ?secret=... lets you trigger this
  // by hand from a browser, same as the renewal-check link, to test without waiting on a schedule.
  const expected = process.env.CRON_CHECK_SECRET;
  const viaHeader = Boolean(expected) && req.headers.authorization === `Bearer ${expected}`;
  const viaBrowser = Boolean(expected) && Boolean(req.query) && req.query.secret === expected;
  if (!viaHeader && !viaBrowser) return res.status(401).json({ error: 'unauthorized' });

  const host = req.headers.host;
  const processed = [];
  const failed = [];

  try {
    // processUnreadEmails only marks a message read once this handler returns true — so a
    // lead that fails to save stays unread and gets tried again on the next run instead of
    // being silently lost.
    const result = await processUnreadEmails(async (email) => {
      try {
        const submitRes = await fetch(`https://${host}/api/submit-lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: email.fullName, email: email.email, companyName: email.subject,
            notes: email.snippet, leadSource: 'email'
          })
        });
        if (submitRes.ok) {
          processed.push({ from: email.email, subject: email.subject });
          return true;
        }
        failed.push({ from: email.email, status: submitRes.status });
        return false;
      } catch (e) {
        console.error('check-email: failed on one message:', e);
        failed.push({ from: email.email, error: e.message });
        return false;
      }
    });

    res.status(200).json({
      checked: result.checked,
      processed: processed.length,
      details: processed,
      failed,
      timings: result.timings
    });
  } catch (e) {
    console.error('check-email: could not read the inbox:', e);
    res.status(500).json({ error: 'Could not connect to the inbox', detail: e.message });
  }
};