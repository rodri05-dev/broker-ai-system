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

// Escape % and _ so they are matched literally inside ILIKE.
const esc = s => s.replace(/[\\%_]/g, '\\$&');

// ---------------------------------------------------------------------------
// Working out WHO is talking. The model names its fields however it likes
// (email, callerEmail, requesterEmail...), so we look at key NAMES, not an exact list.
// Anything that belongs to the certificate holder is ignored.
// ---------------------------------------------------------------------------
const HOLDER_KEY = /^(cert(ificate)?holder|holder)/i;

const flat = (obj, prefix = '') =>
  Object.entries(obj && typeof obj === 'object' ? obj : {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flat(v, prefix + k) : [[prefix + k, v]]);

function pickValue(collected, test) {
  for (const [key, val] of flat(collected)) {
    if (HOLDER_KEY.test(key) || typeof val !== 'string') continue;
    const v = val.trim();
    if (!v || /^(true|false)$/i.test(v)) continue;
    if (test(key.toLowerCase())) return v;
  }
  return null;
}

function identityFrom(collected) {
  const isContactField = k => /email|phone|mobile|address|type/.test(k);
  return {
    email: (pickValue(collected, k => k.includes('email')) || '').toLowerCase() || null,
    phone: pickValue(collected, k => /phone|mobile/.test(k)),
    companyName: pickValue(collected, k => !isContactField(k) && /company|business|insured|organi[sz]ation/.test(k)),
    fullName: pickValue(collected, k => /name$/.test(k) && !/company|business|insured|project|carrier|policy/.test(k)),
    businessType: pickValue(collected, k => k === 'businesstype')
  };
}

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

  const { email, phone, companyName, fullName, businessType } = identityFrom(collected);
  if (!email && !fullName && !phone && !companyName) return null;

  const link = async id => {
    await supabase.from('chat_sessions').update({ contact_id: id }).eq('id', session.id);
    session.contact_id = id;
    return id;
  };

  // 1. Same email (any capitalisation) = same person.
  if (email) {
    const { data: byEmail } = await supabase.from('contacts').select('id')
      .ilike('email', esc(email)).limit(1).maybeSingle();
    if (byEmail) return link(byEmail.id);
  }

  // 2. Same company name — only when exactly one contact has it, so we never guess.
  if (companyName) {
    const { data: byName } = await supabase.from('contacts').select('id')
      .ilike('company_name', esc(companyName)).limit(2);
    if (byName && byName.length === 1) return link(byName[0].id);
  }

  // 3. Nobody we know — create a new contact.
  const { data: contact, error } = await supabase.from('contacts').insert({
    email, full_name: fullName, phone, company_name: companyName,
    business_type: businessType,
    lead_source: leadSource, status: 'new'
  }).select().single();
  if (error || !contact) { console.error('Contact create failed:', error); return null; }
  return link(contact.id);
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
  const d = parsed.collected_data && typeof parsed.collected_data === 'object' ? parsed.collected_data : {};

  // Safety net: the model sometimes keeps asking questions even though it already has a complete
  // certificate request. If everything the certificate needs is there, act anyway.
  let shouldAct = parsed.ready_to_act;
  if (!shouldAct && parsed.intent === 'coi_request' && d.certHolderName && d.certHolderAddress && d.certHolderEmail) {
    shouldAct = true;
  }

  // Run each action once per conversation — the model often repeats ready_to_act on later turns.
  const actionKey = [parsed.intent, d.certHolderName, d.certHolderAddress, d.chosenStartTimeIso]
    .map(x => String(x || '').toLowerCase().trim()).join('|');
  const alreadyDone = history.some(h => h.acted === actionKey);
  const willAct = Boolean(shouldAct && contactId && !alreadyDone);
  if (willAct) transcript[transcript.length - 1].acted = actionKey;

  // Shows up in Vercel -> Logs. willAct=false with shouldAct=true and contactId=null means
  // the agent was ready but could not tell which client is asking.
  console.log('agent turn', JSON.stringify({
    intent: parsed.intent, ready: parsed.ready_to_act, shouldAct, contactId, alreadyDone, willAct,
    keys: Object.keys(d)
  }));

  await supabase.from('chat_sessions').update({
    transcript,
    intent: parsed.intent,
    status: CLOSING.includes(parsed.intent) ? 'closed' : 'active',
    updated_at: now
  }).eq('id', session.id);

  session.transcript = transcript;
  session.intent = parsed.intent;

  if (willAct) {
    // Awaited deliberately. Vercel can freeze the function the instant the response
    // is sent, so a fire-and-forget promise here silently never finishes.
    await withTimeout(
      handleAgentAction({ contactId, intent: parsed.intent, data: d })
        .catch(e => { console.error('Agent action failed:', e); return null; }),
      12000,
      { timedOut: true }
    );
  }

  return parsed;
}

module.exports = { getOrCreateSession, runAgentTurn, withTimeout };