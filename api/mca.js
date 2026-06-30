// Lee métricas MCA desde Supabase cache (escrito por _sync_metrics.mjs cada 30 min)

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

const CACHE_KEY  = 'metrics_mca';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

async function readCache(key) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/sync_state?key=eq.${key}&select=value,updated_at`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const d = await r.json();
    if (!d[0]?.value) return null;
    return { value: JSON.parse(d[0].value), updated_at: d[0].updated_at };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const cached = await readCache(CACHE_KEY);

  if (!cached) {
    return res.status(503).json({ error: 'Cache no disponible. El cron aún no ha corrido.' });
  }

  const ageMs = Date.now() - new Date(cached.updated_at).getTime();
  const stale = ageMs > MAX_AGE_MS;

  res.json({
    ...cached.value,
    _cache: { updated_at: cached.updated_at, age_min: Math.round(ageMs / 60000), stale },
  });
}
