const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

const SB_HDR = {
  'apikey':        SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Accept':        'application/json',
};

async function count(table, filters) {
  const params = new URLSearchParams({ select: '*', ...filters });
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { ...SB_HDR, 'Prefer': 'count=exact' },
  });
  const total = parseInt(res.headers.get('content-range')?.split('/')[1] || '0');
  return total;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = new Date();

  // Hoy
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  // Mes actual (del 1 al día de hoy)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  try {
    const [sentToday, failedToday, optoutsToday,
           sentMonth, failedMonth, optoutsMonth] =
      await Promise.all([
        count('msg_events',    { status: 'eq.sent',   ts: `gte.${todayISO}` }),
        count('msg_events',    { status: 'eq.failed', ts: `gte.${todayISO}` }),
        count('optout_events', { ts: `gte.${todayISO}` }),
        count('msg_events',    { status: 'eq.sent',   ts: `gte.${monthStart}` }),
        count('msg_events',    { status: 'eq.failed', ts: `gte.${monthStart}` }),
        count('optout_events', { ts: `gte.${monthStart}` }),
      ]);

    const pct = (n, d) => d > 0 ? +((n / d) * 100).toFixed(2) : 0;

    res.json({
      today: {
        sent:       sentToday,
        failed:     failedToday,
        optouts:    optoutsToday,
        optOutRate: pct(optoutsToday, sentToday),
        errorRate:  pct(failedToday,  sentToday),
      },
      month: {
        label:      `${now.toLocaleString('es-CL', { month: 'long' })} ${now.getFullYear()}`,
        sent:       sentMonth,
        failed:     failedMonth,
        optouts:    optoutsMonth,
        optOutRate: pct(optoutsMonth, sentMonth),
        errorRate:  pct(failedMonth,  sentMonth),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, sbUrl: !!SB_URL, sbKey: !!SB_KEY });
  }
}
