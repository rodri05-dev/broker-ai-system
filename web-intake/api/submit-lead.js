const { createLead } = require('../lib/create-lead');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const contact = await createLead(req.body);
    res.status(200).json({ ok: true, contactId: contact.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
  
};