const { createClient } = require('@supabase/supabase-js');
const { createOrUpdateContact } = require('../../lib/hubspot');
const { sendEmail } = require('../../lib/gmail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { companyName, fullName, email, phone, businessType, linesOfBusiness, notes, leadSource } = req.body;

  const { data: contact, error } = await supabase
    .from('contacts')
    .insert({
      company_name: companyName, full_name: fullName, email, phone,
      business_type: businessType, lines_of_business: linesOfBusiness,
      lead_source: leadSource || 'web_form', status: 'new'
    })
    .select().single();

  if (error) { console.error(error); return res.status(500).json({ error: 'Could not save lead' }); }

  try {
    const hubspotId = await createOrUpdateContact({ email, fullName, companyName, phone, businessType, linesOfBusiness });
    await supabase.from('contacts').update({ hubspot_contact_id: hubspotId }).eq('id', contact.id);
    await sendEmail({
      to: process.env.PRODUCER_EMAIL,
      subject: `New lead: ${companyName || fullName}`,
      body: `Source: ${leadSource || 'web form'}\nBusiness: ${companyName}\nContact: ${fullName} — ${email} — ${phone}\nType: ${businessType}\nCoverage: ${(linesOfBusiness || []).join(', ')}\nNotes: ${notes || '—'}`
    });
  } catch (e) {
    console.error('HubSpot sync or notification failed (lead is still saved):', e);
  }

  res.status(200).json({ ok: true, contactId: contact.id });
};