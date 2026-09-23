const { createClient } = require('@supabase/supabase-js');
const { createOrUpdateContact } = require('./hubspot');
const { sendEmail } = require('./gmail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

// Shared by the web form (api/submit-lead.js) and the inbox checker (api/cron/check-email.js)
// so there's exactly one place that decides what "a new lead came in" means -- and so the
// inbox checker never has to make an HTTP call back to its own deployment to do it.
async function createLead({ companyName, fullName, email, phone, businessType, linesOfBusiness, notes, leadSource }) {
  const { data: contact, error } = await supabase
    .from('contacts')
    .insert({
      company_name: companyName || null, full_name: fullName || null, email: email || null, phone: phone || null,
      business_type: businessType || null, lines_of_business: linesOfBusiness || null,
      lead_source: leadSource || 'web_form', status: 'new'
    })
    .select().single();

  if (error) {
    console.error('createLead: Supabase insert failed:', error.message);
    throw error;
  }
  console.log(`createLead: saved contact ${contact.id} (${leadSource})`);

  // HubSpot sync and the producer notification run in parallel and are each capped at a few
  // seconds -- the lead is already safely in Supabase by this point, so a slow or down external
  // service can't hold up the response.
  const [hubspotResult, emailResult] = await Promise.all([
    withTimeout(
      createOrUpdateContact({ email, fullName, companyName, phone, businessType, linesOfBusiness })
        .then(id => ({ ok: true, id }))
        .catch(e => ({ ok: false, error: e.message })),
      5000,
      { ok: false, error: 'timed out' }
    ),
    withTimeout(
      sendEmail({
        to: process.env.PRODUCER_EMAIL,
        subject: `New lead: ${companyName || fullName || email}`,
        body: `Source: ${leadSource || 'web form'}\nBusiness: ${companyName || '-'}\nContact: ${fullName || '-'} - ${email || '-'} - ${phone || '-'}\nType: ${businessType || '-'}\nCoverage: ${(linesOfBusiness || []).join(', ') || '-'}\nNotes: ${notes || '-'}`
      }).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
      5000,
      { ok: false, error: 'timed out' }
    )
  ]);

  if (hubspotResult.ok) {
    await supabase.from('contacts').update({ hubspot_contact_id: hubspotResult.id }).eq('id', contact.id);
  } else {
    console.warn('createLead: HubSpot sync skipped:', hubspotResult.error);
  }
  if (!emailResult.ok) console.warn('createLead: producer notification skipped:', emailResult.error);

  return { contactId: contact.id, hubspotSynced: hubspotResult.ok, notified: emailResult.ok };
}

module.exports = { createLead };