const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../../lib/gmail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// `p.days` is the real number of days left, so the wording stays accurate even when a
// policy is picked up a little late (e.g. 75 days out for the "90 day" email).
const TEMPLATES = {
  90: (p) => ({
    subject: `Your ${p.carrier_name} policy renews in ${p.days} days`,
    body: `Hi ${p.full_name}, just a heads-up that your ${p.company_name} policy (#${p.policy_number}) is coming up for renewal on ${p.expiration_date}. No action needed yet — we'll start the renewal review process on our end. Reply here if anything about your business has changed (new locations, equipment, employee count, etc.) since we last talked, since that can affect your renewal terms.`
  }),
  60: (p) => ({
    subject: `Renewing your coverage — a few quick questions`,
    body: `Hi ${p.full_name}, your renewal on policy #${p.policy_number} is ${p.days} days out. To get you the best terms, could you confirm: has revenue, payroll, or your fleet/equipment changed this year? Reply here or call us — we'll have renewal options ready well before your expiration date.`
  }),
  30: (p) => ({
    subject: `Action needed — your policy renews in ${p.days} days`,
    body: `Hi ${p.full_name}, your ${p.carrier_name} policy (#${p.policy_number}) expires on ${p.expiration_date} — ${p.days} days from today. To avoid a coverage gap, please confirm your renewal terms with us this week. Call us or reply to this email and we'll get it finalized.`
  })
};

const STAGE_FOR = { 90: '90_day_sent', 60: '60_day_sent', 30: '30_day_sent' };
// Anything not listed here (for example 'renewed') is left alone.
const RANK = { none: 0, '90_day_sent': 1, '60_day_sent': 2, '30_day_sent': 3 };

// Whole days between today (UTC) and the expiration date. Both sides are midnight UTC,
// so the answer is an exact integer no matter what time of day this runs.
function daysUntil(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86400000);
}

// Which email is due right now? The most urgent window the policy has entered.
const dueThreshold = days => (days === null || days < 0 ? null : days <= 30 ? 30 : days <= 60 ? 60 : days <= 90 ? 90 : null);

module.exports = async (req, res) => {
  // Vercel sends CRON_SECRET as a Bearer token on its scheduled runs. CRON_CHECK_SECRET lets you
  // trigger this by hand from a browser: ...?secret=YOUR_CRON_CHECK_SECRET  (add &dry=1 to preview only).
  // Both are refused when the variable isn't set, so "Bearer undefined" can never get in.
  const cronSecret = process.env.CRON_SECRET;
  const manualSecret = process.env.CRON_CHECK_SECRET;
  const viaCron = Boolean(cronSecret) && req.headers.authorization === `Bearer ${cronSecret}`;
  const viaBrowser = Boolean(manualSecret) && Boolean(req.query) && req.query.secret === manualSecret;
  if (!viaCron && !viaBrowser) return res.status(401).end();

  const dryRun = Boolean(req.query && req.query.dry);

  const { data: policies, error } = await supabase
    .from('policies')
    .select('*, contacts(full_name, email, company_name, hubspot_contact_id)')
    .eq('status', 'active');
  if (error) { console.error(error); return res.status(500).json({ error: error.message }); }

  const sent = [];
  const skipped = [];
  const failed = [];

  for (const policy of policies || []) {
    const stage = policy.renewal_sequence_stage || 'none';
    if (RANK[stage] === undefined) continue;                 // e.g. 'renewed'

    const days = daysUntil(policy.expiration_date);
    const due = dueThreshold(days);
    if (!due) continue;                                       // not in the 90-day window yet, or already expired
    if (RANK[stage] >= RANK[STAGE_FOR[due]]) continue;        // this email (or a later one) already went out

    const contact = policy.contacts;
    if (!contact?.email) { skipped.push({ policyId: policy.id, reason: 'contact has no email' }); continue; }

    const entry = { policyId: policy.id, to: contact.email, stage: STAGE_FOR[due], daysOut: days };
    if (dryRun) { sent.push({ ...entry, dryRun: true }); continue; }

    const { subject, body } = TEMPLATES[due]({
      full_name: contact.full_name || 'there',
      company_name: contact.company_name,
      carrier_name: policy.carrier_name,
      policy_number: policy.policy_number,
      expiration_date: policy.expiration_date,
      days
    });

    try {
      await sendEmail({ to: contact.email, subject, body });
      const { error: updateError } = await supabase.from('policies')
        .update({ renewal_sequence_stage: STAGE_FOR[due] }).eq('id', policy.id);
      if (updateError) throw updateError;
      sent.push(entry);
    } catch (e) {
      console.error('renewal email failed for', policy.id, e);
      failed.push({ ...entry, error: e.message });
    }
  }

  res.status(200).json({
    checked: (policies || []).length,
    dryRun,
    sent: sent.length,
    details: sent,
    skipped,
    failed
  });
};