const GROQ_BASE = 'https://api.groq.com/openai/v1';

async function groqChat(messages, { json = false } = {}) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.4,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!res.ok) throw new Error(`Groq chat error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function groqTranscribe(audioBuffer, filename = 'audio.wav') {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', 'whisper-large-v3');
  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form
  });
  if (!res.ok) throw new Error(`Groq transcribe error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.text;
}

async function groqSpeak(text, voice = 'Fritz-PlayAI') {
  const res = await fetch(`${GROQ_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'playai-tts',
      input: text,
      voice,
      response_format: 'wav'
    })
  });
  if (!res.ok) throw new Error(`Groq TTS error: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { groqChat, groqTranscribe, groqSpeak };