const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  const expected = process.env.DASHBOARD_ACCESS_TOKEN;
  const token = req.headers.authorization?.replace('Bearer ', '');
  // If DASHBOARD_ACCESS_TOKEN is ever unset in Vercel, `expected` is undefined — without this
  // extra check, a request with no Authorization header at all would compare undefined to
  // undefined and wrongly pass. Both sides must be a real, matching value.
  if (!expected || !token || token !== expected) return res.status(401).json({ error: 'unauthorized' });

  try {
    const [
      { data: recentCalls, error: callsError },
      { data: pipeline, error: pipelineError },
      { data: renewals, error: renewalsError },
      { data: pendingCois, error: coiError },
      { data: conversations, error: conversationsError }
    ] = await Promise.all([
      supabase.from('calls').select('*, contacts(company_name)').order('started_at', { ascending: false }).limit(15),
      supabase.from('contacts').select('id, company_name, full_name, status, qualification_score, business_type').order('updated_at', { ascending: false }).limit(50),
      supabase.from('policies').select('*, contacts(company_name, email, phone)').gte('expiration_date', new Date().toISOString().slice(0, 10)).order('expiration_date', { ascending: true }).limit(20),
      supabase.from('coi_requests').select('*, contacts(company_name)').eq('status', 'pending_review').order('created_at', { ascending: false }),
      supabase.from('chat_sessions').select('id, channel, intent, status, updated_at, contacts(company_name, full_name)').order('updated_at', { ascending: false }).limit(15)
    ]);

    // One table having a bad day shouldn't blank the whole dashboard — log it and still
    // return everything that did succeed, with that one panel simply empty.
    [
      ['calls', callsError], ['contacts', pipelineError], ['policies', renewalsError],
      ['coi_requests', coiError], ['chat_sessions', conversationsError]
    ].forEach(([table, err]) => { if (err) console.error(`dashboard-data: ${table} query failed:`, err); });

    res.status(200).json({
      recentCalls: recentCalls || [],
      pipeline: pipeline || [],
      renewals: renewals || [],
      pendingCois: pendingCois || [],
      conversations: conversations || []
    });
  } catch (e) {
    console.error('dashboard-data failed:', e);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
};