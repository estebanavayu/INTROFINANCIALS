const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SINCE   = '2026-02-01';

const OPENING_PIPELINES = [
  '85kFh5EWKPg7qg9FDJfg',  // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ',  // NCN OPENING
  '8tbkIiJnJCnPZY6X0mA6',  // CENTURY OPENING (CC)
];

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

// Pagina todos los won de un pipeline y retorna los objetos completos
async function fetchAllWon(pipelineId) {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${GHL_V2}/opportunities/search`
      + `?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=100&page=${page}`;
    const res  = await fetch(url, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const opps = data.opportunities ?? [];
    all.push(...opps);
    if (all.length >= (data.meta?.total ?? 0) || opps.length === 0) break;
    page++;
  }
  return all;
}

// Leads activos en workflow — buscar por tag "fup cold blast"
async function fetchLeadsInSequences() {
  const body = JSON.stringify({
    locationId: GHL_LOC,
    filters: [{ field: 'tags', operator: 'contains', value: 'fup cold blast' }],
    page: 1,
    pageLimit: 1,
  });
  const res  = await fetch(`${GHL_V2}/contacts/search`, { method: 'POST', headers: hdrs(), body });
  const data = await res.json().catch(() => ({}));
  return data.total ?? data.meta?.total ?? null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now = new Date();
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    // Traer todos los won de los 3 pipelines en paralelo
    const [rise, ncn, century, seqData] = await Promise.all([
      fetchAllWon(OPENING_PIPELINES[0]),
      fetchAllWon(OPENING_PIPELINES[1]),
      fetchAllWon(OPENING_PIPELINES[2]),
      fetchLeadsInSequences(),
    ]);

    // Dedup por contactId — mismo contacto puede ganar en RISE + NCN + CENTURY
    // Quedar con el opp más reciente (mayor createdAt) por contacto
    const byContact = new Map();
    for (const o of [...rise, ...ncn, ...century]) {
      const key = o.contactId ?? o.contact?.id;
      if (!key) continue;
      const prev = byContact.get(key);
      const tNew = new Date(o.createdAt ?? o.dateAdded ?? 0).getTime();
      const tOld = prev ? new Date(prev.createdAt ?? prev.dateAdded ?? 0).getTime() : 0;
      if (!prev || tNew > tOld) byContact.set(key, o);
    }
    const allOpps = [...byContact.values()];

    // Filtrar por mes — GHL usa createdAt en las oportunidades
    const thisMonth = allOpps.filter(o => {
      const t = new Date(o.createdAt ?? o.dateAdded ?? 0).getTime();
      return t >= monthStartMs;
    });

    res.json({
      since:      SINCE,
      lts:        allOpps.length,
      ltsMonth:   thisMonth.length,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      leadsInSeq: seqData,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
