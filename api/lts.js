const SUPABASE_URL  = 'https://jcugfkkpicfiafkqfzac.supabase.co';
const SUPABASE_ANON = 'sb_publishable_1lkbzpV1zWsPOWmO9GCGUQ_KIivJLDW';
const SB_HDR = {
  'apikey': SUPABASE_ANON,
  'Authorization': 'Bearer ' + SUPABASE_ANON,
  'Content-Type': 'application/json',
};

const MCA_PIPELINES = new Set([
  'fxzuSpmyNzMH4yupNfk1',
  '85kFh5EWKPg7qg9FDJfg',
  'tzoH6Bv4qfC4Rug8yZvQ',
]);
const CC_PIPELINES = new Set([
  '8tbkIiJnJCnPZY6X0mA6',
]);

const ATTRIBUTION_START = '2026-04-01T00:00:00.000Z';

async function fetchAllWins() {
  const wins = [];
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/ghl_wins`
      + `?select=contact_id,pipeline_id,raw_data`
      + `&created_at=gte.${ATTRIBUTION_START}`
      + `&order=created_at.asc`
      + `&limit=${PAGE}&offset=${from}`;

    const res  = await fetch(url, { headers: SB_HDR });
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    wins.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return wins;
}

function byRep(wins) {
  const map = {};
  for (const w of wins) {
    const rep = w.raw_data?.assignedTo || 'Sin asignar';
    map[rep] = (map[rep] || 0) + 1;
  }
  return map;
}

function dedup(wins) {
  const map = {};
  for (const w of wins) {
    const cid  = w.contact_id;
    const wonAt = w.raw_data?.lastStatusChangeAt || '';
    if (!map[cid] || wonAt > map[cid]._wonAt) map[cid] = { ...w, _wonAt: wonAt };
  }
  return Object.values(map);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // debug: muestra primeros 5 rows de ghl_wins sin filtros
  if (req.query?.debug === '1') {
    const url = `${SUPABASE_URL}/rest/v1/ghl_wins?select=contact_id,pipeline_id,status,created_at&order=created_at.desc&limit=5`;
    const raw = await fetch(url, { headers: SB_HDR }).then(r => r.json()).catch(e => ({ error: e.message }));
    return res.json({ raw, count: Array.isArray(raw) ? raw.length : 'error' });
  }

  try {
    const wins = await fetchAllWins();

    const deduped = dedup(wins);
    const mcaWins = deduped.filter(w => MCA_PIPELINES.has(w.pipeline_id));
    const ccWins  = deduped.filter(w => CC_PIPELINES.has(w.pipeline_id));

    res.json({
      mca:    { total: mcaWins.length, byRep: byRep(mcaWins) },
      cc:     { total: ccWins.length,  byRep: byRep(ccWins)  },
      total:  mcaWins.length + ccWins.length,
      totalRaw: wins.length,
      since:  '2026-04-01',
      source: 'supabase',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
