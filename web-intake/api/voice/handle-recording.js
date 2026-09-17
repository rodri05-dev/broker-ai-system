const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { groqChat, groqTranscribe, groqSpeak } = require('../../lib/groq');
const { retrieveContext } = require('../../lib/kb');
const { buildSystemPrompt } = require('../../lib/prompt');
const { storeAudioAndGetUrl } = require('../../lib/audio-store');
const { handleAgentAction } = require('../../lib/actions');
const { getAvailableSlots } = require('../../lib/booking');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VoiceResponse = twilio.twiml.VoiceResponse;

module.exports = async (req, res) => {
  const { CallSid, RecordingUrl } = req.body;
  const twiml = new VoiceResponse();

  const audioRes = await fetch(`${RecordingUrl}.wav`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') }
  });
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  const transcript = await groqTranscribe(audioBuffer, 'caller.wav');

  if (!transcript || transcript.trim().length === 0) {
    twiml.say("Sorry, I didn't catch that — could you say that again?");
    twiml.record({ action: '/api/voice/handle-recording', method: 'POST', maxLength: 30, timeout: 2, trim: 'trim-silence', playBeep: false });
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  }

  const { data: session } = await supabase.from('call_sessions').select('*').eq('call_sid', CallSid).single();

  let slotContext = '';
  const mentionsMeeting = /meeting|book|schedule|appointment/i.test(transcript);
  if (session?.intent === 'new_business' || session?.intent === 'book_meeting' || mentionsMeeting) {
    try {
      const now = new Date(); const in5days = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
      const slots = await getAvailableSlots({ eventTypeSlug: 'commercial-insurance-consultation', dateFrom: now.toISOString(), dateTo: in5days.toISOString() });
      slotContext = `\nReal open meeting times (only offer times from this list): ${JSON.stringify(slots).slice(0, 800)}`;
    } catch (e) { console.error('slot fetch failed', e); }
  }

  const ragContext = await retrieveContext(transcript);
  const systemPrompt = buildSystemPrompt({ brokerName: process.env.BROKER_NAME, ragContext: ragContext + slotContext });

  const history = session?.history || [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.role === 'assistant' ? JSON.stringify(h.raw) : h.text })),
    { role: 'user', content: transcript }
  ];

  const raw = await groqChat(messages, { json: true });
  const parsed = JSON.parse(raw);

  const audioBuffer2 = await groqSpeak(parsed.reply);
  const turnIndex = (session?.turn_count || 0) + 1;
  const audioUrl = await storeAudioAndGetUrl(audioBuffer2, CallSid, turnIndex);

  const newHistory = [
    ...history,
    { role: 'user', text: transcript, at: new Date().toISOString() },
    { role: 'assistant', text: parsed.reply, raw: parsed, at: new Date().toISOString() }
  ];
  await supabase.from('call_sessions').update({
    history: newHistory, turn_count: turnIndex, intent: parsed.intent, collected_data: parsed.collected_data, updated_at: new Date().toISOString()
  }).eq('call_sid', CallSid);
  await supabase.from('calls').update({ transcript: newHistory, intent: parsed.intent }).eq('twilio_call_sid', CallSid);

  if (parsed.ready_to_act && session?.contact_id) {
    handleAgentAction({ contactId: session.contact_id, intent: parsed.intent, data: parsed.collected_data })
      .catch(e => console.error('Agent action failed:', e));
  }

  if (parsed.intent === 'transfer_human') {
    twiml.play(audioUrl);
    twiml.dial(process.env.PRODUCER_TRANSFER_NUMBER);
  } else if (parsed.intent === 'end_conversation') {
    twiml.play(audioUrl);
    twiml.hangup();
  } else {
    twiml.play(audioUrl);
    twiml.record({ action: '/api/voice/handle-recording', method: 'POST', maxLength: 30, timeout: 2, trim: 'trim-silence', playBeep: false });
  }

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};