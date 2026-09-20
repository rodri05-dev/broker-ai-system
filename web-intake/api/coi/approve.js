const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../../lib/gmail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const page = (body) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 Georgia,serif;color:#152238;background:#f6f4ef;margin:0;padding:48px 20px}
.w{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2ddd0;border-radius:8px;padding:32px}
h2{margin:0 0 6px;font-size:1.3rem}dl{font-family:Arial,sans-serif;font-size:.9rem}
dt{color:#6b7688;font-size:.72rem;text-transform:uppercase;margin-top:14px}dd{margin:2px 0 0}
a.pdf{display:inline-block;margin:20px 0;font-family:Arial,sans-serif;font-size:.9rem}
button{width:100%;padding:14px;background:#152238;color:#fff;border:none;border-radius:3px;
font:600 15px Arial,sans-serif;cursor:pointer;margin-top:10px}
small{display:block;color:#6b7688;font-family:Arial,sans-serif;font-size:.78rem;margin-top:14px}</style>
<div class="w">${body}</div>`;

module.exports = async (req, res) => {
  const id = req.query.id || (req.body && req.body.id);
  res.setHeader('Content-Type', 'text/html');
  if (!id) return res.status(400).send(page('<h2>Missing certificate id.</h2>'));

  const { data: coi } = await supabase.from('coi_requests')
    .select('*, contacts(company_name, full_name)').eq('id', id).maybeSingle();
  if (!coi) return res.status(404).send(page('<h2>Not found.</h2>'));

  // --- GET: show it for review, send nothing ---------------------------------
  if (req.method !== 'POST') {
    if (coi.status === 'sent') {
      return res.status(200).send(page(`<h2>Already sent.</h2><p>This certificate went out on ${new Date(coi.approved_at).toLocaleString()}.</p>`));
    }
    return res.status(200).send(page(`
      <h2>Review this certificate</h2>
      <p style="font-family:Arial,sans-serif;font-size:.9rem;color:#6b7688">Nothing has been sent yet. Check every field against the policy before approving.</p>
      <dl>
        <dt>Insured</dt><dd>${coi.contacts?.company_name || coi.contacts?.full_name || '—'}</dd>
        <dt>Certificate holder</dt><dd>${coi.certificate_holder_name || '—'}</dd>
        <dt>Holder address</dt><dd>${coi.certificate_holder_address || '—'}</dd>
        <dt>Will be emailed to</dt><dd>${coi.certificate_holder_email || 'no address captured — it will come back to you instead'}</dd>
        <dt>Project</dt><dd>${coi.project_description || '—'}</dd>
      </dl>
      <a class="pdf" href="${coi.pdf_url}" target="_blank">Open the draft PDF →</a>
      <form method="POST" action="/api/coi/approve">
        <input type="hidden" name="id" value="${id}">
        <input type="hidden" name="producerName" value="producer">
        <button type="submit">Approve and send</button>
      </form>
      <small>By approving you confirm, as a licensed producer, that the coverage shown is in force and accurate.</small>`));
  }

  // --- POST: actually send ---------------------------------------------------
  const producerName = (req.body && req.body.producerName) || 'producer';
  const company = coi.contacts?.company_name || '';

  if (coi.certificate_holder_email) {
    await sendEmail({
      to: coi.certificate_holder_email,
      cc: process.env.PRODUCER_EMAIL,
      subject: `Certificate of Insurance — ${company}`,
      body: `Please find the requested certificate of insurance below.\n\n${coi.pdf_url}\n\nIf anything needs correcting, reply to this email.`
    });
  } else {
    await sendEmail({
      to: process.env.PRODUCER_EMAIL,
      subject: `COI approved, no recipient on file — send manually: ${company}`,
      body: `Approved, but no certificate holder email was captured during intake.\n\nPDF: ${coi.pdf_url}`
    });
  }

  await supabase.from('coi_requests').update({
    status: 'sent', approved_by: producerName, approved_at: new Date().toISOString()
  }).eq('id', id);

  await supabase.from('producer_activity').insert({
    activity_type: 'coi_generated', contact_id: coi.contact_id, details: { coi_request_id: id }
  });

  res.status(200).send(page('<h2>Sent.</h2><p>The certificate has gone out and the record is updated.</p>'));
};