const { createClient } = require('@supabase/supabase-js');
const { groqChat, parseAgentJson } = require('./groq');
const { retrieveContext } = require('./kb');
const { buildSystemPrompt } = require('./prompt');
const { handleAgentAction } = require('./actions');
const { getAvailableSlots } = require('./booking');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MEETING_RE = /meeting|book|schedul|appointment|speak to someone|talk to someone|call me/i;
const CLOSING = ['end_conversation', 'transfer_human'];

const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);

async function getOrCreateSession(sessionToken, channel = 'chat') {
  const { data: existing } = await supabase
    .from('chat_sessions').select('*').eq('session_token', sessionToken).maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('chat_sessions')
    .insert({ session_token: sessionToken, channel, transcript: [] })
    .select().single();
  if (error) throw error;
  return created;
}

// Web chat and web voice have no caller ID, so there is nobody to attach the
// conversation to until the person actually tells us who they are.
async function ensureContact(session, collected = {}, leadSource) {
  if (session.contact_id) return session.contact_id;

  const email = collected.email || collected.attendeeEmail;
  const fullName = collected.fullName || collected.attendeeName || collected.contactName;
  const phone = collected.phone;
  if (!email && !fullName && !phone) return null;

  if (email) {
    const { data: found } = await supabase
      .from('contacts').select('id').eq('email', email).maybeSingle();
    if (found) {
      await supabase.from('chat_sessions').update({ contact_id: found.id }).eq('id', session.id);
      session.contact_id = found.id;
      return found.id;
    }
  }

  const { data: contact, error } = await supabase.from('contacts').insert({
    email: email || null,
    full_name: fullName || null,
    phone: phone || null,
    company_name: collected.companyName || null,
    business_type: collected.businessType || null,
    lead_source: leadSource,
    status: 'new'
  }).select().single();
  if (error || !contact) { console.error('Contact create failed:', error); return null; }

  await supabase.from('chat_sessions').update({ contact_id: contact.id }).eq('id', session.id);
  session.contact_id = contact.id;
  return contact.id;
}

async function runAgentTurn({ session, userText, leadSource = 'chat' }) {
  const kbContext = await withTimeout(retrieveContext(userText), 4000, '');

  let slotContext = '';
  if (MEETING_RE.test(userText) || ['new_business', 'book_meeting'].includes(session.intent)) {
    const slots = await withTimeout(getAvailableSlots(), 4000, null);
    if (slots && slots.length) {
      slotContext = `\nReal open meeting times — offer ONLY times from this list, and put the exact ISO string you chose in collected_data.chosenStartTimeIso: ${slots.join(', ')}`;
    } else {
      slotContext = `\nOnline booking is unavailable right now. If they want a meeting, collect their name, email and the times that suit them, then say a producer will confirm the exact slot by email.`;
    }
  }

  const history = session.transcript || [];
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        brokerName: process.env.BROKER_NAME || 'the agency',
        ragContext: kbContext + slotContext
      })
    },
    // keep the last 12 turns — enough context, no runaway token bill
    ...history.slice(-12).map(h => ({
      role: h.role,
      content: h.role === 'assistant' ? JSON.stringify(h.raw || { reply: h.text }) : h.text
    })),
    { role: 'user', content: userText }
  ];

  const parsed = parseAgentJson(await groqChat(messages, { json: true }));
  const now = new Date().toISOString();

  const transcript = [
    ...history,
    { role: 'user', text: userText, at: now },
    { role: 'assistant', text: parsed.reply, raw: parsed, at: now }
  ];

  const contactId = await ensureContact(session, parsed.collected_data, leadSource);

  await supabase.from('chat_sessions').update({
    transcript,
    intent: parsed.intent,
    status: CLOSING.includes(parsed.intent) ? 'closed' : 'active',
    updated_at: now
  }).eq('id', session.id);

  session.transcript = transcript;
  session.intent = parsed.intent;

  if (parsed.ready_to_act && contactId) {
    // Awaited deliberately. Vercel can freeze the function the instant the response
    // is sent, so a fire-and-forget promise here silently never finishes.
    await withTimeout(
      handleAgentAction({ contactId, intent: parsed.intent, data: parsed.collected_data })
        .catch(e => { console.error('Agent action failed:', e); return null; }),
      12000,
      { timedOut: true }
    );
  }

  return parsed;
}

module.exports = { getOrCreateSession, runAgentTurn, withTimeout };