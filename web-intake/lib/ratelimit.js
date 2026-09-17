const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function allow(key, { limit = 40, windowSeconds = 600 } = {}) {
  try {
    const now = new Date();
    const { data } = await supabase.from('rate_limits').select('*').eq('bucket', key).maybeSingle();

    if (!data) {
      await supabase.from('rate_limits').insert({ bucket: key, count: 1, window_start: now });
      return true;
    }
    const elapsed = (now - new Date(data.window_start)) / 1000;
    if (elapsed > windowSeconds) {
      await supabase.from('rate_limits').update({ count: 1, window_start: now }).eq('bucket', key);
      return true;
    }
    if (data.count >= limit) return false;
    await supabase.from('rate_limits').update({ count: data.count + 1 }).eq('bucket', key);
    return true;
  } catch (e) {
    console.warn('rate limit check failed, allowing:', e.message);
    return true; // never block a real visitor because the limiter itself broke
  }
}

function clientKey(req, prefix) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return `${prefix}:${ip}`;
}

module.exports = { allow, clientKey };