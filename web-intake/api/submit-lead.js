const { createLead } = require('../lib/create-lead');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const result = await createLead({ ...req.body, leadSource: req.body.leadSource || 'web_form' });
    res.status(200).json({ ok: true, contactId: result.contactId });
  } catch (e) {
    console.error('submit-lead failed:', e);
    res.status(500).json({ error: 'Could not save lead' });
  }
};