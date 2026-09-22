require('dotenv').config();
const fs = require('fs');
const pdfParseModule = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function chunkText(text, maxChars = 900, overlap = 150) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  for (let start = 0; start < clean.length; start += (maxChars - overlap)) {
    const piece = clean.slice(start, start + maxChars).trim();
    if (piece.length > 60) chunks.push(piece);
  }
  return chunks;
}

// pdf-parse changed its whole API in v2: v1 was `require('pdf-parse')` called directly as a
// function; v2 is `const { PDFParse } = require('pdf-parse')` with a class and a getText()
// method. Handling both means this script keeps working whichever one npm installed.
async function extractText(filePath) {
  const buffer = fs.readFileSync(filePath);

  if (typeof pdfParseModule === 'function') {
    // v1-style API
    const data = await pdfParseModule(buffer);
    return data.text;
  }

  const PDFParse = pdfParseModule.PDFParse || (pdfParseModule.default && pdfParseModule.default.PDFParse);
  if (typeof PDFParse === 'function') {
    // v2-style API
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy();
    }
  }

  throw new Error('Could not find a usable pdf-parse API — the installed version may have changed again.');
}

async function ingest(filePath, { title, sourceType, carrierName }) {
  const text = await extractText(filePath);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No extractable text — this PDF is probably a scan, not real text.');

  const { data: doc, error } = await supabase.from('kb_documents').insert({
    title, source_type: sourceType, carrier_name: carrierName || null,
    original_filename: filePath.split(/[\\/]/).pop()
  }).select().single();
  if (error) throw error;

  // insert in batches of 100 — one round trip instead of hundreds
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100).map(content => ({ document_id: doc.id, content }));
    const { error: e } = await supabase.from('kb_chunks').insert(batch);
    if (e) throw e;
    console.log(`  ${Math.min(i + 100, chunks.length)}/${chunks.length}`);
  }
  console.log(`Done: "${title}" — ${chunks.length} chunks, document ${doc.id}`);
}

const [, , filePath, title, carrierName] = process.argv;
if (!filePath) { console.error('Usage: node scripts/ingest-kb-document.js <file.pdf> "<title>" "<carrier>"'); process.exit(1); }
ingest(filePath, { title: title || 'Untitled', sourceType: 'carrier_appetite_guide', carrierName })
  .catch(e => { console.error(e); process.exit(1); });