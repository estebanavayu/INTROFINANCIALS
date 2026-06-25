const GHL_TOKEN  = process.env.GHL_TOKEN;
const GHL_LOC    = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V1     = 'https://rest.gohighlevel.com/v1';
const BACKEND    = 'https://backend.leadconnectorhq.com';

// Llama al endpoint de insights de GHL (backend.leadconnectorhq.com)
async function fetchInsights(startDate, endDate) {
  const url = `${BACKEND}/phone-system/messaging/messages/insights?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}`;
  const res = await fetch(url, {
    headers: {
      'token-id':     GHL_TOKEN,
      'Authorization': `Bearer ${GHL_TOKEN}`,
      'Accept':        'application/json',
    }
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// Trae una pagina de contactos ordenados por dateUpdated desc (los mas recientes primero)
async function fetchContactsPage(startAfterId) {
  const base = `${GHL_V1}/contacts/?locationId=${GHL_LOC}&limit=100&sortBy=dateUpdated&sortOrder=desc`;
  const url  = startAfterId ? `${base}&startAfterId=${startAfterId}` : base;
  return fetch(url, {
    headers: { Authorization: `Bearer ${GHL_TOKEN}` }
  }).then(r => r.json()).catch(() => ({ contacts: [] }));
}

// Cuenta DND en contactos cuyo dateUpdated esta dentro del rango [since, until]
// Pagina hasta que los contactos sean mas viejos que `since`
async function countRecentOptouts(since, until) {
  let dnd = 0, total = 0, startAfterId = null, pages = 0;

  while (pages < 200) {
    const data = await fetchContactsPage(startAfterId);
    const contacts = data.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      const updated = new Date(c.dateUpdated || c.dateAdded || 0).getTime();

      // ya pasamos el rango — parar
      if (updated < since) return { dnd, total };

      if (!until || updated <= until) {
        total++;
        if (c.dnd) dnd++;
      }
    }

    if (contacts.length < 100) break;
    startAfterId = contacts[contacts.length - 1].id;
    pages++;
  }
  return { dnd, total };
}

// Muestra total de contactos DND (sampling)
async function sampleOverallRate() {
  const PAGE_SIZE = 100, PAGES = 15;
  const first = await fetch(
    `${GHL_V1}/contacts/?locationId=${GHL_LOC}&limit=${PAGE_SIZE}`,
    { headers: { Authorization: `Bearer ${GHL_TOKEN}` } }
  ).then(r => r.json());

  const total    = first.meta?.total || 135810;
  let dndCount   = (first.contacts || []).filter(c => c.dnd).length;
  let sampled    = (first.contacts || []).length;

  const pages = await Promise.all(
    Array.from({ length: PAGES - 1 }, (_, i) =>
      fetch(
        `${GHL_V1}/contacts/?locationId=${GHL_LOC}&limit=${PAGE_SIZE}&startAfter=${(i + 1) * PAGE_SIZE}`,
        { headers: { Authorization: `Bearer ${GHL_TOKEN}` } }
      ).then(r => r.json()).catch(() => ({ contacts: [] }))
    )
  );
  for (const p of pages) {
    const c = p.contacts || [];
    dndCount += c.filter(x => x.dnd).length;
    sampled  += c.length;
  }
  return {
    rate:         sampled > 0 ? +((dndCount / sampled) * 100).toFixed(2) : 0,
    total, sampled,
    dndEstimated: Math.round((dndCount / sampled) * total)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now = new Date();

    const monthParam = req.query?.month;
    let selectedMonthStart, selectedMonthEnd;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [y, m] = monthParam.split('-').map(Number);
      selectedMonthStart = new Date(y, m - 1, 1).getTime();
      selectedMonthEnd   = new Date(y, m, 0, 23, 59, 59, 999).getTime();
    } else {
      selectedMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      selectedMonthEnd   = now.getTime();
    }

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEnd   = now.getTime();

    const todayISO = new Date(todayStart).toISOString();
    const todayEndISO = new Date(todayEnd).toISOString();
    const monthStartISO = new Date(selectedMonthStart).toISOString();
    const monthEndISO   = new Date(selectedMonthEnd).toISOString();

    // intentar insights endpoint primero
    const [insightsToday, insightsMonth, overall] = await Promise.all([
      fetchInsights(todayISO, todayEndISO),
      fetchInsights(monthStartISO, monthEndISO),
      sampleOverallRate(),
    ]);

    // insights devuelve { optOutRate, received, sent, delivered, failed, ... }
    let todayDnd, todayTotal, todayRate, monthDnd, monthTotal, monthRate;

    if (insightsToday && insightsToday.optOutRate !== undefined) {
      todayRate  = +(insightsToday.optOutRate * 100).toFixed(2);
      todayTotal = insightsToday.received || 0;
      todayDnd   = Math.round(todayRate / 100 * todayTotal);
    } else {
      const td   = await countRecentOptouts(todayStart, todayEnd);
      todayDnd   = td.dnd; todayTotal = td.total;
      todayRate  = todayTotal > 0 ? +((todayDnd / todayTotal) * 100).toFixed(2) : 0;
    }

    if (insightsMonth && insightsMonth.optOutRate !== undefined) {
      monthRate  = +(insightsMonth.optOutRate * 100).toFixed(2);
      monthTotal = insightsMonth.received || 0;
      monthDnd   = Math.round(monthRate / 100 * monthTotal);
    } else {
      const md   = await countRecentOptouts(selectedMonthStart, selectedMonthEnd);
      monthDnd   = md.dnd; monthTotal = md.total;
      monthRate  = monthTotal > 0 ? +((monthDnd / monthTotal) * 100).toFixed(2) : 0;
    }

    res.json({
      rate:          overall.rate,
      dndEstimated:  overall.dndEstimated,
      total:         overall.total,
      sampled:       overall.sampled,
      source:        insightsToday ? 'insights' : 'contacts',
      todayDnd, todayTotal, todayRate,
      monthDnd, monthTotal, monthRate,
      selectedMonth: monthParam || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
