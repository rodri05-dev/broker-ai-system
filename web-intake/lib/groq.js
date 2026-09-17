const GROQ_BASE = 'https://api.groq.com/openai/v1';

// All overridable by env var, so a future deprecation is a Vercel setting change, not a deploy.
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
const STT_MODEL  = process.env.GROQ_STT_MODEL  || 'whisper-large-v3-turbo';
const TTS_MODEL  = process.env.GROQ_TTS_MODEL  || 'canopylabs/orpheus-v1-english';
const TTS_VOICE  = process.env.GROQ_TTS_VOICE  || 'hannah'; // autumn, diana, hannah, austin, daniel, troy

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function groqChat(messages, { json = false, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages,
          temperature: 0.4,
          max_tokens: 700,
          ...(json ? { response_format: { type: 'json_object' } } : {})
        })
      });

      // 429 = free-tier rate limit. Back off and try once or twice more.
      if (res.status === 429 && attempt < retries) {
        await sleep(900 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`Groq chat ${res.status}: ${await res.text()}`);

      const data = await res.json();
      return data.choices[0].message.content;
    } catch (e) {
      lastError = e;
      if (attempt === retries) throw e;
      await sleep(600);
    }
  }
  throw lastError;
}

// The agent is told to reply in JSON, but models occasionally wrap it in prose or a
// code fence. Never let that kill a live conversation.
function parseAgentJson(raw) {
  const attempt = str => { try { return JSON.parse(str); } catch { return null; } };
  let parsed = attempt(raw);
  if (!parsed) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) parsed = attempt(fenced[1]);
  }
  if (!parsed) {
    const braces = raw.match(/\{[\s\S]*\}/);
    if (braces) parsed = attempt(braces[0]);
  }
  if (!parsed || typeof parsed.reply !== 'string') {
    return {
      reply: typeof raw === 'string' ? raw.slice(0, 500) : "Sorry, could you say that another way?",
      intent: 'general',
      collected_data: {},
      ready_to_act: false
    };
  }
  return {
    reply: parsed.reply,
    intent: parsed.intent || 'general',
    collected_data: parsed.collected_data || {},
    ready_to_act: parsed.ready_to_act === true
  };
}

async function groqTranscribe(audioBuffer, filename = 'audio.webm') {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', STT_MODEL);
  form.append('language', 'en');
  form.append('temperature', '0');
  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form
  });
  if (!res.ok) throw new Error(`Groq transcribe ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text || '';
}

async function groqSpeak(text, voice = TTS_VOICE) {
  const res = await fetch(`${GROQ_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: 'wav' })
  });
  if (!res.ok) throw new Error(`Groq TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { groqChat, parseAgentJson, groqTranscribe, groqSpeak, CHAT_MODEL };