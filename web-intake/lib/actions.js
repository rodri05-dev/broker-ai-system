const { createClient } = require('@supabase/supabase-js');
const { fillCoiPdf, storeDraftCoi } = require('./coi');
const { bookMeeting } = require('./booking');
const { scoreLead } = require('./qualify');
const { sendEmail } = require('./gmail');
const { createOrUpdateContact } = require('./hubspot');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function handleAgentAction({ contactId, intent, data }) {
  if (intent === 'coi_request') return handleCoiRequest({ contactId, data });
  if (intent === 'book_meeting') return handleBookMeeting({ contactId, data });
  if (intent === 'new_business') return handleQualifyLead({ contactId, data });
  return { skipped: true };
}

async function handleCoiRequest({ contactId, data }) {
  const { data: contact } = await supabase.from('contacts').select('*').eq('id', contactId).single();
  const { data: policy } = await supabase.from('policies').select('*')
    .eq('contact_id', contactId).eq('status', 'active')
    .order('effective_date', { ascending: false }).limit(1).single();
  if (!policy) return { error: 'No active policy found for this contact — cannot draft a COI.' };

  const { data: coiRequest } = await supabase.from('coi_requests').insert({
    contact_id: contactId, certificate_holder_name: data.certHolderName,
    certificate_holder_address: data.certHolderAddress, certificate_holder_email: data.certHolderEmail,
    project_description: data.projectDescription,
    policy_id: policy.id, status: 'pending_review', source: 'agent'
  }).select().single();

  const pdfBuffer = await fillCoiPdf({ policy, contact, certHolderName: data.certHolderName, certHolderAddress: data.certHolderAddress, projectDescription: data.projectDescription });
  const pdfUrl = await storeDraftCoi(pdfBuffer, coiRequest.id);
  await supabase.from('coi_requests').update({ pdf_url: pdfUrl }).eq('id', coiRequest.id);

  await sendEmail({
    to: process.env.PRODUCER_EMAIL,
    subject: `COI ready for review: ${contact.company_name}`,
    body: `A draft certificate is ready for review.\n\nCertificate holder: ${data.certHolderName}\nAddress: ${data.certHolderAddress}\nPDF: ${pdfUrl}\n\nApprove and send: https://${process.env.APP_DOMAIN}/api/coi/approve?id=${coiRequest.id}&producerName=Producer`
  });

  return { ok: true, coiRequestId: coiRequest.id };
}

async function handleBookMeeting({ contactId, data }) {
  const booking = await bookMeeting({
    eventTypeSlug: 'commercial-insurance-consultation',
    attendeeName: data.attendeeName, attendeeEmail: data.attendeeEmail,
    startTimeIso: data.chosenStartTimeIso, notes: data.notes
  });
  await supabase.from('contacts').update({ status: 'meeting_booked' }).eq('id', contactId);
  await sendEmail({
    to: process.env.PRODUCER_EMAIL,
    subject: `Meeting booked: ${data.attendeeName}`,
    body: `A meeting was booked via the AI agent.\n\nWith: ${data.attendeeName} (${data.attendeeEmail})\nTime: ${data.chosenStartTimeIso}\nNotes: ${data.notes || '—'}`
  });
  return { ok: true, booking };
}

async function handleQualifyLead({ contactId, data }) {
  const score = scoreLead(data);
  await supabase.from('contacts').update({ qualification_score: score, status: 'qualified' }).eq('id', contactId);
  const { data: contact } = await supabase.from('contacts').select('*').eq('id', contactId).single();
  if (contact) {
    await createOrUpdateContact({ email: contact.email, fullName: contact.full_name, companyName: contact.company_name, phone: contact.phone, qualificationScore: score }).catch(e => console.error('HubSpot sync failed:', e));
  }
  await sendEmail({
    to: process.env.PRODUCER_EMAIL,
    subject: `Qualified lead: ${contact?.company_name || ''} (score ${score})`,
    body: `A new lead was qualified by the AI agent, score ${score}/100.\n\nDetails: ${JSON.stringify(data, null, 2)}`
  });
  return { ok: true, score };
}

module.exports = { handleAgentAction };