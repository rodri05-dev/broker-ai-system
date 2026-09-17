const { createClient } = require('@supabase/supabase-js');
const { fillCoiPdf, storeDraftCoi } = require('./coi');
const { bookMeeting } = require('./booking');
const { scoreLead } = require('./qualify');
const { sendEmail } = require('./gmail');
const { createOrUpdateContact } = require('./hubspot');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const APP = process.env.APP_DOMAIN || 'broker-ai-system-2026-8472.vercel.app';

async function handleAgentAction({ contactId, intent, data = {} }) {
  try {
    if (intent === 'coi_request')  return await handleCoiRequest({ contactId, data });
    if (intent === 'book_meeting') return await handleBookMeeting({ contactId, data });
    if (intent === 'new_business') return await handleQualifyLead({ contactId, data });
    return { skipped: true };
  } catch (e) {
    console.error(`handleAgentAction(${intent}) failed:`, e);
    await sendEmail({
      to: process.env.PRODUCER_EMAIL,
      subject: `AI agent action failed: ${intent}`,
      body: `The agent tried to handle "${intent}" and hit an error. Nothing was lost — the conversation is saved.\n\nError: ${e.message}\n\nCollected data:\n${JSON.stringify(data, null, 2)}`
    }).catch(() => {});
    return { error: e.message };
  }
}

async function handleCoiRequest({ contactId, data }) {
  const { data: contact } = await supabase.from('contacts').select('*').eq('id', contactId).single();

  const { data: policy } = await supabase.from('policies').select('*')
    .eq('contact_id', contactId).eq('status', 'active')
    .order('effective_date', { ascending: false }).limit(1).maybeSingle();

  // No policy on file usually means the caller isn't an existing client, or the book
  // hasn't been imported yet. Hand it to a human rather than dropping it.
  if (!policy) {
    await supabase.from('coi_requests').insert({
      contact_id: contactId,
      certificate_holder_name: data.certHolderName,
      certificate_holder_address: data.certHolderAddress,
      certificate_holder_email: data.certHolderEmail,
      project_description: data.projectDescription,
      status: 'pending_review', source: 'agent'
    });
    await sendEmail({
      to: process.env.PRODUCER_EMAIL,
      subject: `COI requested — no active policy on file: ${contact?.company_name || contact?.full_name || 'unknown'}`,
      body: `A certificate was requested but there is no active policy in the system for this contact, so no draft could be generated.\n\nHolder: ${data.certHolderName}\nAddress: ${data.certHolderAddress}\nSend to: ${data.certHolderEmail || 'not captured'}\nProject: ${data.projectDescription || '—'}`
    });
    return { ok: true, noPolicy: true };
  }

  const { data: coiRequest, error } = await supabase.from('coi_requests').insert({
    contact_id: contactId,
    certificate_holder_name: data.certHolderName,
    certificate_holder_address: data.certHolderAddress,
    certificate_holder_email: data.certHolderEmail,
    project_description: data.projectDescription,
    policy_id: policy.id, status: 'pending_review', source: 'agent'
  }).select().single();
  if (error) throw error;

  const pdfBuffer = await fillCoiPdf({
    policy, contact,
    certHolderName: data.certHolderName,
    certHolderAddress: data.certHolderAddress,
    projectDescription: data.projectDescription
  });
  const pdfUrl = await storeDraftCoi(pdfBuffer, coiRequest.id);
  await supabase.from('coi_requests').update({ pdf_url: pdfUrl }).eq('id', coiRequest.id);

  await sendEmail({
    to: process.env.PRODUCER_EMAIL,
    subject: `COI ready for review: ${contact?.company_name || ''}`,
    body: `A draft certificate is ready. Nothing has been sent to anyone yet.

Insured: ${contact?.company_name || contact?.full_name}
Certificate holder: ${data.certHolderName}
Holder address: ${data.certHolderAddress}
Send to: ${data.certHolderEmail || 'NOT CAPTURED — you will need to send it manually'}
Policy: ${policy.carrier_name} ${policy.policy_number}

Draft PDF: ${pdfUrl}

Review it here: https://${APP}/api/coi/approve?id=${coiRequest.id}`
  });

  return { ok: true, coiRequestId: coiRequest.id, pdfUrl };
}

async function handleBookMeeting({ contactId, data }) {
  const result = await bookMeeting({
    attendeeName: data.attendeeName,
    attendeeEmail: data.attendeeEmail,
    startTimeIso: data.chosenStartTimeIso,
    notes: data.notes
  });

  const booked = result.mode === 'booked';
  await supabase.from('contacts')
    .update({ status: booked ? 'meeting_booked' : 'qualified' })
    .eq('id', contactId);

  await sendEmail({
    to: process.env.PRODUCER_EMAIL,
    subject: booked
      ? `Meeting booked: ${data.attendeeName}`
      : `Meeting REQUEST (needs you to confirm): ${data.attendeeName}`,
    body: booked
      ? `Confirmed via Cal.com.\n\nWith: ${data.attendeeName} (${data.attendeeEmail})\nTime: ${data.chosenStartTimeIso}\nNotes: ${data.notes || '—'}`
      : `The agent could not complete the booking automatically (${result.reason}), so it told them a producer would confirm by email. Please reach out.\n\nName: ${data.attendeeName}\nEmail: ${data.attendeeEmail}\nPreferred: ${data.chosenStartTimeIso || data.preferredTimes || 'not specified'}\nNotes: ${data.notes || '—'}`
  });

  await supabase.from('producer_activity').insert({
    activity_type: 'meeting_booked', contact_id: contactId,
    details: { mode: result.mode, time: data.chosenStartTimeIso }
  });

  return { ok: true, mode: result.mode };
}

async function handleQualifyLead({ contactId, data }) {
  const score = scoreLead(data);

  await supabase.from('contacts')
    .update({ qualification_score: score, status: 'qualified', updated_at: new Date().toISOString() })
    .eq('id', contactId);

  const { data: contact } = await supabase.from('contacts').select('*').eq('id', contactId).single();

  if (contact?.email) {
    await createOrUpdateContact({
      email: contact.email, fullName: contact.full_name, companyName: contact.company_name,
      phone: contact.phone, businessType: contact.business_type, qualificationScore: score
    })
      .then(id => supabase.from('contacts').update({ hubspot_contact_id: id }).eq('id', contactId))
      .catch(e => console.error('HubSpot sync failed:', e));
  }

  await sendEmail({
    to: process.env.PRODUCER_EMAIL,
    subject: `Qualified lead: ${contact?.company_name || contact?.full_name || ''} (score ${score}/100)`,
    body: `The AI agent qualified a new lead.\n\nScore: ${score}/100\nContact: ${contact?.full_name || '—'} / ${contact?.email || '—'} / ${contact?.phone || '—'}\n\nWhat it collected:\n${JSON.stringify(data, null, 2)}`
  });

  await supabase.from('producer_activity').insert({
    activity_type: 'lead_qualified', contact_id: contactId, details: { score }
  });

  return { ok: true, score };
}

module.exports = { handleAgentAction };