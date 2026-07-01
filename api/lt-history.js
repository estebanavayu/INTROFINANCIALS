// Devuelve LTs agrupados por mes (YYYY-MM → count)
// Solo sirve desde cache Supabase — nunca llama GHL en vivo

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: 'Supabase no configurado' });

  try {
    const hdrs = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
    const [globalsR, monthlyR] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/sync_state?key=eq.metrics_globals&select=value,updated_at`, { headers: hdrs }),
      fetch(`${SB_URL}/rest/v1/sync_state?key=eq.metrics_by_month&select=value`, { headers: hdrs }),
    ]);
    const [globalsRows, monthlyRows] = await Promise.all([globalsR.json(), monthlyR.json()]);

    if (globalsRows[0]?.value) {
      const cached  = JSON.parse(globalsRows[0].value);
      const monthly = monthlyRows[0]?.value ? JSON.parse(monthlyRows[0].value) : {};
      if (cached.ltsByMonth) {
        return res.json({
          ltsByMonth:      cached.ltsByMonth,
          metricsByMonth:  monthly,
          source:          'cache',
          updated_at:      globalsRows[0].updated_at,
        });
      }
    }
    return res.status(503).json({ error: 'Cache no disponible aún — esperar próximo cron' });
  } catch (e) {
    return res.status(500).json({ error: 'Error al leer cache', detail: e.message });
  }
}
