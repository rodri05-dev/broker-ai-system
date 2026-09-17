const { createClient } = require('@supabase/supabase-js');
const { groqChat } = require('../lib/groq');
const { retrieveContext } = require('../lib/rag');
const { buildSystemPrompt } = require('../lib/prompt');
const { handleAgentAction } = require('../lib/actions');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { sessionToken, message } = req.body;
  if (!sessionToken || !message) return res.status(400).json({ error: 'missing fields' });

  let { data: session } = await supabase
    .from('chat_sessions')
    .select('*, contacts(id)')
    .eq('session_token', sessionToken)
    .single();

  if (!session) {
    const { data: created } = await supabase
      .from('chat_sessions')
      .insert({ session_token: sessionToken, transcript: [] })
      .select().single();
    session = created;
  }

  const ragContext = await retrieveContext(message);
  const systemPrompt = buildSystemPrompt({ brokerName: process.env.BROKER_NAME, ragContext });

  const history = session.transcript || [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.role === 'assistant' ? JSON.stringify(h.raw || { reply: h.text }) : h.text })),
    { role: 'user', content: message }
  ];

  const raw = await groqChat(messages, { json: true });
  const parsed = JSON.parse(raw);

  // Link this chat session to a contact record the moment we learn who they are —
  // web chat has no caller-ID equivalent, so unlike the phone flow, there's nothing
  // to create a contact from until the conversation actually reveals an email or name.
  if (!session.contact_id) {
    const email = parsed.collected_data?.email || parsed.collected_data?.attendeeEmail;
    const fullName = parsed.collected_data?.fullName || parsed.collected_data?.attendeeName;
    if (email || fullName) {
      const { data: newContact } = await supabase.from('contacts').insert({
        email, full_name: fullName,
        company_name: parsed.collected_data?.companyName,
        business_type: parsed.collected_data?.businessType,
        lead_source: 'chat', status: 'new'
      }).select().single();
      if (newContact) {
        session.contact_id = newContact.id;
        await supabase.from('chat_sessions').update({ contact_id: newContact.id }).eq('session_token', sessionToken);
      }
    }
  }

  const newHistory = [
    ...history,
    { role: 'user', text: message, at: new Date().toISOString() },
    { role: 'assistant', text: parsed.reply, raw: parsed, at: new Date().toISOString() }
  ];

  await supabase.from('chat_sessions').update({
    transcript: newHistory,
    intent: parsed.intent,
    updated_at: new Date().toISOString()
  }).eq('session_token', sessionToken);

  if (parsed.ready_to_act && session.contact_id) {
    handleAgentAction({ contactId: session.contact_id, intent: parsed.intent, data: parsed.collected_data })
      .catch(e => console.error('Agent action failed:', e));
  }

  res.status(200).json({ reply: parsed.reply, intent: parsed.intent });
};