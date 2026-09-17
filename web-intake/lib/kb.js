const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function retrieveContext(query, matchCount = 4) {
  const cleaned = (query || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
  if (cleaned.length < 4) return '';
  try {
    const { data, error } = await supabase.rpc('search_kb_chunks', {
      query_text: cleaned, match_count: matchCount
    });
    if (error) { console.warn('KB search:', error.message); return ''; }
    if (!data || data.length === 0) return '';
    return data
      .map(c => `[${c.carrier_name || c.document_title}] ${c.content}`)
      .join('\n\n');
  } catch (e) {
    console.warn('KB search failed:', e.message);
    return '';
  }
}

module.exports = { retrieveContext };