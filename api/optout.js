const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';

function ghlHdrs() {
  const token = process.env.GHL_TOKEN;
  return {
    'Authorization': `Bearer ${token}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
  };
}

// Intenta el endpoint de Phone System analytics
async function fetchInsights(startDate, endDate) {
  const url = `https://backend.leadconnectorhq.com/phone-system/messaging/messages/insights`
    + `?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}`;
  const res = await fetch(url, { headers: ghlHdrs() });
  if (!res.ok) return { status: res.status, raw: await res.text().catch(() => '') };
  return res.json().catch(() => null);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;

  const [insightsToday, insightsMonth] = await Promise.all([
    fetchInsights(today, today),
    fetchInsights(monthStart, today),
  ]);

  res.json({ insightsToday, insightsMonth, today, monthStart });
}
