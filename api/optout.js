const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const BACKEND   = 'https://backend.leadconnectorhq.com';

function ghlHeaders() {
  const token = process.env.GHL_TOKEN;
  return {
    'Authorization': `Bearer ${token}`,
    'token-id':      token,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
  };
}

async function fetchInsights(startDate, endDate) {
  const url = `${BACKEND}/phone-system/messaging/messages/insights`
    + `?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}`;
  const res = await fetch(url, { headers: ghlHeaders() });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now      = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Mes seleccionado (default = mes actual)
    const monthParam = req.query?.month; // formato YYYY-MM
    let monthStart, monthEnd;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [y, m] = monthParam.split('-').map(Number);
      monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      monthEnd   = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;
    } else {
      const y = now.getFullYear();
      const m = now.getMonth() + 1;
      monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
      monthEnd   = todayStr;
    }

    const [insightsToday, insightsMonth] = await Promise.all([
      fetchInsights(todayStr, todayStr),
      fetchInsights(monthStart, monthEnd),
    ]);

    // debug: ver respuesta cruda si hay token issue
    if (req.query?.debug === '1') {
      return res.json({ insightsToday, insightsMonth, todayStr, monthStart, monthEnd });
    }

    function parseInsights(data) {
      if (!data) return null;
      // GHL devuelve optOutRate como decimal (0.0071) o porcentaje (0.71)
      const rate = data.optOutRate !== undefined
        ? (data.optOutRate > 1 ? data.optOutRate : data.optOutRate * 100)
        : null;
      return {
        rate:     rate !== null ? +rate.toFixed(2) : null,
        sent:     data.sent      || data.totalSent      || 0,
        received: data.received  || data.totalReceived  || 0,
        optOuts:  data.optOuts   || data.totalOptOuts   || 0,
      };
    }

    const today = parseInsights(insightsToday);
    const month = parseInsights(insightsMonth);

    res.json({
      today,
      month,
      selectedMonth: monthParam || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`,
      source: (today || month) ? 'ghl-insights' : 'unavailable',
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
