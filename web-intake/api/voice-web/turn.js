const { groqTranscribe, groqSpeak } = require('../../lib/groq');
const { getOrCreateSession, runAgentTurn } = require('../../lib/agent');
const { allow, clientKey } = require('../../lib/ratelimit');

const EXT = {
  'audio/webm': 'audio.webm', 'audio/ogg': 'audio.ogg',
  'audio/mp4': 'audio.mp4', 'audio/mpeg': 'audio.mp3', 'audio/wav': 'audio.wav'
};

module.exports = async (req, res) => {
  // GET ?text=... lets you test the whole agent from a browser address bar, no mic needed.
  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return res.status(405).end();

  try {
    const input = isGet ? req.query : (req.body || {});
    const sessionToken = input.sessionToken || input.session;
    if (!sessionToken) return res.status(400).json({ error: 'missing sessionToken' });

    if (!(await allow(clientKey(req, 'voice'), { limit: 40, windowSeconds: 600 }))) {
      return res.status(429).json({
        reply: "We're getting a lot of requests right now — please try again in a few minutes.",
        intent: 'general'
      });
    }

    let userText = (input.text || '').trim();

    if (!userText && input.audio) {
      const buffer = Buffer.from(input.audio, 'base64');
      if (buffer.length < 2000) {
        return res.status(200).json({ reply: null, empty: true }); // a click, not speech
      }
      const mime = (input.mimeType || 'audio/webm').split(';')[0];
      userText = (await groqTranscribe(buffer, EXT[mime] || 'audio.webm')).trim();
    }

    if (!userText) {
      return res.status(200).json({
        transcript: '', empty: true,
        reply: "Sorry, I didn't catch that — could you say it again?",
        intent: 'general'
      });
    }

    const session = await getOrCreateSession(sessionToken, 'voice_web');
    const parsed = await runAgentTurn({ session, userText, leadSource: 'voice_web' });

    let audio = null;
    if (process.env.VOICE_TTS === 'groq') {
      try { audio = (await groqSpeak(parsed.reply)).toString('base64'); }
      catch (e) { console.warn('TTS failed, browser voice will be used:', e.message); }
    }

    res.status(200).json({
      transcript: userText,
      reply: parsed.reply,
      intent: parsed.intent,
      done: ['end_conversation', 'transfer_human'].includes(parsed.intent),
      audio
    });
  } catch (e) {
    console.error('voice turn failed:', e);
    res.status(500).json({
      reply: "Sorry, something went wrong on our end. Please try again, or use the contact form.",
      intent: 'general', error: String(e.message || e)
    });
  }
};