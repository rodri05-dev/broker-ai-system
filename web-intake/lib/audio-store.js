const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function storeAudioAndGetUrl(buffer, callSid, turnIndex) {
  const path = `call-audio/${callSid}/${turnIndex}.wav`;
  const { error } = await supabase.storage
    .from('generated-files')
    .upload(path, buffer, { contentType: 'audio/wav', upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('generated-files').getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { storeAudioAndGetUrl };