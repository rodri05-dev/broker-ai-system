const { createClient } = require('@supabase/supabase-js');
const { createOrUpdateContact } = require('./hubspot');
const { sendEmail } = require('./gmail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function createLead({ companyName, fullName, email, phone, businessType, linesOfBusiness, notes, leadSource }) {
  const { data: contact, error } = await supabase
    .from('contacts')
    .insert({
      company_name: companyName, full_name: fullName, email, phone,
      business_type: businessType, lines_of_business: linesOfBusiness,
      lead_source: leadSource || 'web_form', status: 'new'
    })
    .select().single();

  if (error) { console.error(error); throw new Error('Could not save lead'); }

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

  return contact;
}

module.exports = { createLead };