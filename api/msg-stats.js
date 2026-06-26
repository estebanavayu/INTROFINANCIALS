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

  const days  = parseInt(req.query.days || '30');
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // today window
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  try {
    const [sent30, failed30, optouts30, sentToday, failedToday, optoutsToday] =
      await Promise.all([
        count('msg_events',    { 'status': 'eq.sent',   'ts': `gte.${since}` }),
        count('msg_events',    { 'status': 'eq.failed', 'ts': `gte.${since}` }),
        count('optout_events', { 'ts': `gte.${since}` }),
        count('msg_events',    { 'status': 'eq.sent',   'ts': `gte.${todayISO}` }),
        count('msg_events',    { 'status': 'eq.failed', 'ts': `gte.${todayISO}` }),
        count('optout_events', { 'ts': `gte.${todayISO}` }),
      ]);

    const pct = (n, d) => d > 0 ? +((n / d) * 100).toFixed(2) : 0;

    res.json({
      rolling: {
        days,
        sent:       sent30,
        failed:     failed30,
        optouts:    optouts30,
        optOutRate: pct(optouts30, sent30),
        errorRate:  pct(failed30,  sent30),
      },
      today: {
        sent:       sentToday,
        failed:     failedToday,
        optouts:    optoutsToday,
        optOutRate: pct(optoutsToday, sentToday),
        errorRate:  pct(failedToday,  sentToday),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
