const GHL_TOKEN = process.env.GHL_TOKEN;
const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V1    = 'https://rest.gohighlevel.com/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const PAGE_SIZE = 100;
    const PAGES     = 15;

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
      const contacts = p.contacts || [];
      dndCount += contacts.filter(c => c.dnd).length;
      sampled  += contacts.length;
    }

    const rate         = sampled > 0 ? (dndCount / sampled) * 100 : 0;
    const dndEstimated = Math.round((dndCount / sampled) * total);

    res.json({ rate: +rate.toFixed(2), dndEstimated, total, sampled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
