const GHL_TOKEN = process.env.GHL_TOKEN;
const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V1    = 'https://rest.gohighlevel.com/v1';

async function countDndInPeriod(since) {
  let dnd = 0, total = 0, page = 0;
  while (true) {
    const url = `${GHL_V1}/contacts/?locationId=${GHL_LOC}&limit=100&startAfterDate=${since}${page > 0 ? `&startAfter=${page * 100}` : ''}`;
    const data = await fetch(url, {
      headers: { Authorization: `Bearer ${GHL_TOKEN}` }
    }).then(r => r.json()).catch(() => ({ contacts: [] }));

    const contacts = data.contacts || [];
    if (contacts.length === 0) break;
    dnd   += contacts.filter(c => c.dnd).length;
    total += contacts.length;
    if (contacts.length < 100) break;
    page++;
    if (page > 50) break; // safety cap
  }
  return { dnd, total };
}

async function sampleOverallRate() {
  const PAGE_SIZE = 100, PAGES = 15;
  const first = await fetch(
    `${GHL_V1}/contacts/?locationId=${GHL_LOC}&limit=${PAGE_SIZE}`,
    { headers: { Authorization: `Bearer ${GHL_TOKEN}` } }
  ).then(r => r.json());

  const total = first.meta?.total || 135810;
  let dndCount = first.contacts.filter(c => c.dnd).length;
  let sampled  = first.contacts.length;

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
  return { rate: sampled > 0 ? +((dndCount / sampled) * 100).toFixed(2) : 0, total, sampled, dndEstimated: Math.round((dndCount / sampled) * total) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now   = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const [overall, todayData, monthData] = await Promise.all([
      sampleOverallRate(),
      countDndInPeriod(todayStart),
      countDndInPeriod(monthStart),
    ]);

    res.json({
      // acumulado general
      rate:         overall.rate,
      dndEstimated: overall.dndEstimated,
      total:        overall.total,
      sampled:      overall.sampled,
      // hoy
      todayDnd:     todayData.dnd,
      todayTotal:   todayData.total,
      todayRate:    todayData.total > 0 ? +((todayData.dnd / todayData.total) * 100).toFixed(2) : 0,
      // mes
      monthDnd:     monthData.dnd,
      monthTotal:   monthData.total,
      monthRate:    monthData.total > 0 ? +((monthData.dnd / monthData.total) * 100).toFixed(2) : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
