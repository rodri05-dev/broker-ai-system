const { pipeline } = require('@huggingface/transformers');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

async function embed(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data); // 384-dim vector
}

async function retrieveContext(query, matchCount = 4) {
  const queryEmbedding = await embed(query);
  const { data, error } = await supabase.rpc('match_kb_chunks', {
    query_embedding: queryEmbedding,
    match_count: matchCount
  });
  if (error) { console.error('RAG retrieval error:', error); return ''; }
  if (!data || data.length === 0) return '';
  return data
    .map(c => `[${c.carrier_name || c.document_title}]: ${c.content}`)
    .join('\n\n');
}

module.exports = { embed, retrieveContext };