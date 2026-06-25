const SUPABASE_URL  = 'https://jcugfkkpicfiafkqfzac.supabase.co';
const SUPABASE_ANON = 'sb_publishable_1lkbzpV1zWsPOWmO9GCGUQ_KIivJLDW';
const SB_HDR = {
  'apikey': SUPABASE_ANON,
  'Authorization': 'Bearer ' + SUPABASE_ANON,
};

// Pipelines que cuentan como LT (desde CLAUDE.md)
const MCA_PIPELINES = new Set([
  'fxzuSpmyNzMH4yupNfk1', // GENERAL OPENING
  '85kFh5EWKPg7qg9FDJfg',  // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ',  // NCN OPENING
]);
const CC_PIPELINES = new Set([
  '8tbkIiJnJCnPZY6X0mA6',  // CENTURY OPENING
]);

const ATTRIBUTION_START = '2026-04-01T00:00:00.000Z';

// Trae todos los WON desde abril, paginando de 1000 en 1000
async function fetchAllWins() {
  const wins = [];
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/ghl_wins`
      + `?select=contact_id,pipeline_id,raw_data`
      + `&status=eq.won`
      + `&created_at=gte.${ATTRIBUTION_START}`
      + `&order=created_at.asc`
      + `&limit=${PAGE}&offset=${from}`;

    const res = await fetch(url, { headers: SB_HDR });
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    wins.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return wins;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const wins = await fetchAllWins();

    // Dedup por contact_id: si un contacto ganó en varios pipelines,
    // usar el won más reciente (lastStatusChangeAt)
    const byContact = {};
    for (const w of wins) {
      const cid = w.contact_id;
      const wonAt = w.raw_data?.lastStatusChangeAt || w.raw_data?.dateAdded || '';
      if (!byContact[cid] || wonAt > byContact[cid]._wonAt) {
        byContact[cid] = { ...w, _wonAt: wonAt };
      }
    }

    const deduped = Object.values(byContact);

    // Separar MCA vs CC
    const mcaWins = deduped.filter(w => MCA_PIPELINES.has(w.pipeline_id));
    const ccWins  = deduped.filter(w => CC_PIPELINES.has(w.pipeline_id));

    // Agrupar por rep (assignedTo en raw_data)
    function byRep(wins) {
      const map = {};
      for (const w of wins) {
        const rep = w.raw_data?.assignedTo || 'Sin asignar';
        map[rep] = (map[rep] || 0) + 1;
      }
      return map;
    }

    res.json({
      mca:   { total: mcaWins.length, byRep: byRep(mcaWins) },
      cc:    { total: ccWins.length,  byRep: byRep(ccWins)  },
      total: mcaWins.length + ccWins.length,
      since: '2026-04-01',
      source: 'supabase',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
