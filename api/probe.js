const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
  };
}

async function tryUrl(url) {
  try {
    const res = await fetch(url, { headers: hdrs() });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { url, status: res.status, body };
  } catch(e) {
    return { url, error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = '2026-06-01';
  const qs = `locationId=${GHL_LOC}&startDate=${monthStart}&endDate=${today}`;

  const results = await Promise.all([
    tryUrl(`https://services.leadconnectorhq.com/phone-system/messaging/messages/insights?${qs}`),
    tryUrl(`https://services.leadconnectorhq.com/locations/${GHL_LOC}/messaging/stats?startDate=${monthStart}&endDate=${today}`),
    tryUrl(`https://services.leadconnectorhq.com/locations/${GHL_LOC}/reporting/messages?startDate=${monthStart}&endDate=${today}`),
    tryUrl(`https://services.leadconnectorhq.com/conversations/reporting?${qs}`),
    tryUrl(`https://services.leadconnectorhq.com/reporting/sms?${qs}`),
    tryUrl(`https://backend.leadconnectorhq.com/phone-system/messaging/messages/insights?${qs}&channel=api`),
  ]);

  res.json(results);
}
