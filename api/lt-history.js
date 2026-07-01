// Devuelve LTs agrupados por mes (YYYY-MM → count)
// Solo sirve desde cache Supabase — nunca llama GHL en vivo

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: 'Supabase no configurado' });

  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/sync_state?key=eq.metrics_globals&select=value,updated_at`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const rows = await r.json();
    if (rows[0]?.value) {
      const cached = JSON.parse(rows[0].value);
      if (cached.ltsByMonth) {
        return res.json({ ltsByMonth: cached.ltsByMonth, source: 'cache', updated_at: rows[0].updated_at });
      }
    }
    return res.status(503).json({ error: 'Cache no disponible aún — esperar próximo cron' });
  } catch (e) {
    return res.status(500).json({ error: 'Error al leer cache', detail: e.message });
  }
}
