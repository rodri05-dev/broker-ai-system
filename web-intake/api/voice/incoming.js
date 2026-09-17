const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { groqSpeak } = require('../../lib/groq');
const { storeAudioAndGetUrl } = require('../../lib/audio-store');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VoiceResponse = twilio.twiml.VoiceResponse;

module.exports = async (req, res) => {
  const { CallSid, From } = req.body;

  let { data: contact } = await supabase.from('contacts').select('id').eq('phone', From).single();
  if (!contact) {
    const { data: created } = await supabase.from('contacts')
      .insert({ phone: From, lead_source: 'phone', status: 'new' }).select().single();
    contact = created;
  }

  await supabase.from('calls').insert({
    twilio_call_sid: CallSid, caller_phone: From, contact_id: contact.id, status: 'in_progress'
  });
  await supabase.from('call_sessions').insert({
    call_sid: CallSid, caller_phone: From, contact_id: contact.id, history: [], collected_data: {}
  });

  const greeting = `Thanks for calling ${process.env.BROKER_NAME}. I can help with a new quote, a certificate of insurance, or a renewal question — what can I do for you?`;
  const audioBuffer = await groqSpeak(greeting);
  const audioUrl = await storeAudioAndGetUrl(audioBuffer, CallSid, 0);

  const twiml = new VoiceResponse();
  twiml.play(audioUrl);
  twiml.record({
    action: '/api/voice/handle-recording',
    method: 'POST',
    maxLength: 30,
    timeout: 2,
    trim: 'trim-silence',
    playBeep: false
  });
  twiml.say("We didn't catch a response — please call back anytime. Goodbye.");

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};