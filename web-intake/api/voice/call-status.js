const { createClient } = require('@supabase/supabase-js');
const { groqChat } = require('../../lib/groq');
const { logCallActivity } = require('../../lib/hubspot');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  if (CallStatus !== 'completed') return res.status(200).end();

  const { data: call } = await supabase.from('calls').select('*, contacts(hubspot_contact_id)').eq('twilio_call_sid', CallSid).single();
  if (!call) return res.status(200).end();

  const summaryRaw = await groqChat([
    { role: 'system', content: 'Summarize this insurance-agency phone call in 2 sentences for a producer to read before calling back. Be concrete about what the caller wants.' },
    { role: 'user', content: JSON.stringify(call.transcript) }
  ]);

  await supabase.from('calls').update({
    status: 'completed', duration_seconds: parseInt(CallDuration || '0', 10),
    summary: summaryRaw, ended_at: new Date().toISOString()
  }).eq('twilio_call_sid', CallSid);

  await supabase.from('producer_activity').insert({
    activity_type: 'call_handled', contact_id: call.contact_id, details: { summary: summaryRaw, phone: call.caller_phone }
  });

  if (call.contacts?.hubspot_contact_id) {
    await logCallActivity(call.contacts.hubspot_contact_id, summaryRaw).catch(e => console.error('HubSpot call log failed:', e));
  }

  res.status(200).end();
};