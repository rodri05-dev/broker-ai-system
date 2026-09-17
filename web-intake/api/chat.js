const { getOrCreateSession, runAgentTurn } = require('../lib/agent');
const { allow, clientKey } = require('../lib/ratelimit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const { sessionToken, message } = req.body || {};
  if (!sessionToken || !message) return res.status(400).json({ error: 'missing fields' });

  if (!(await allow(clientKey(req, 'chat'), { limit: 60, windowSeconds: 600 }))) {
    return res.status(429).json({ reply: "We're getting a lot of messages right now — please try again shortly." });
  }

  try {
    const session = await getOrCreateSession(sessionToken, 'chat');
    const parsed = await runAgentTurn({ session, userText: message, leadSource: 'chat' });
    res.status(200).json({ reply: parsed.reply, intent: parsed.intent });
  } catch (e) {
    console.error('chat failed:', e);
    res.status(500).json({ reply: "Sorry, something went wrong. Please try the contact form and we'll get straight back to you." });
  }
};