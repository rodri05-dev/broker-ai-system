const { getUnreadLeadEmails, markAsRead } = require('../../lib/gmail');

module.exports = async (req, res) => {
  // cron-job.org sends CRON_CHECK_SECRET as a Bearer header. ?secret=... lets you trigger this
  // by hand from a browser, the same way as the renewal-check link, to test without waiting.
  const expected = process.env.CRON_CHECK_SECRET;
  const viaHeader = Boolean(expected) && req.headers.authorization === `Bearer ${expected}`;
  const viaBrowser = Boolean(expected) && Boolean(req.query) && req.query.secret === expected;
  if (!viaHeader && !viaBrowser) return res.status(401).json({ error: 'unauthorized' });

  let emails;
  try {
    emails = await getUnreadLeadEmails();
  } catch (e) {
    // Previously this would crash with no explanation visible anywhere but Vercel's logs.
    // Gmail login/IMAP problems are common here, so surface the real reason.
    console.error('check-email: could not read the inbox:', e);
    return res.status(500).json({ error: 'Could not connect to the inbox', detail: e.message });
  }

  const processed = [];
  const failed = [];

  for (const email of emails) {
    try {
      const submitRes = await fetch(`https://${req.headers.host}/api/submit-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: email.fullName, email: email.email, companyName: email.subject,
          notes: email.snippet, leadSource: 'email'
        })
      });
      if (submitRes.ok) {
        await markAsRead(email.id);
        processed.push({ id: email.id, from: email.email, subject: email.subject });
      } else {
        failed.push({ id: email.id, status: submitRes.status });
      }
    } catch (e) {
      console.error('check-email: failed on one message:', e);
      failed.push({ id: email.id, error: e.message });
    }
  }

  res.status(200).json({ checked: emails.length, processed: processed.length, details: processed, failed });
};