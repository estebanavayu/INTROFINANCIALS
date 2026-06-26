const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SINCE   = '2026-02-01';

const OPENING_PIPELINES = [
  'fxzuSpmyNzMH4yupNfk1', // GENERAL OPENING
  '85kFh5EWKPg7qg9FDJfg',  // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ',  // NCN OPENING
];

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

// Total won sin filtro de fecha (usa meta.total)
async function fetchLtTotal(pipelineId) {
  const url = `${GHL_V2}/opportunities/search`
    + `?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=1`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return data.meta?.total ?? 0;
}

// Won este mes — pagina todo y filtra por lastStatusChangeAt
async function fetchLtMonth(pipelineId, monthStartMs) {
  let count = 0, cursor = null;
  while (true) {
    let url = `${GHL_V2}/opportunities/search`
      + `?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=100`;
    if (cursor) url += `&startAfter=${cursor.ts}&startAfterId=${cursor.id}`;
    const res  = await fetch(url, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const opps = data.opportunities || [];
    for (const o of opps) {
      if (new Date(o.lastStatusChangeAt).getTime() >= monthStartMs) count++;
    }
    if (opps.length < 100) break;
    const last = opps[opps.length - 1];
    cursor = { ts: last.sort?.[0] ?? new Date(last.createdAt).getTime(), id: last.contactId };
  }
  return count;
}

// Leads activos en workflow — buscar por tag "fup cold blast" o workflow enrollment
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
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const monthStartMs = new Date(monthStart).getTime();

    const [ltGeneral, ltRise, ltNcn,
           ltGeneralM, ltRiseM, ltNcnM,
           seqData] = await Promise.all([
      fetchLtTotal(OPENING_PIPELINES[0]),
      fetchLtTotal(OPENING_PIPELINES[1]),
      fetchLtTotal(OPENING_PIPELINES[2]),
      fetchLtMonth(OPENING_PIPELINES[0], monthStartMs),
      fetchLtMonth(OPENING_PIPELINES[1], monthStartMs),
      fetchLtMonth(OPENING_PIPELINES[2], monthStartMs),
      fetchLeadsInSequences(),
    ]);

    res.json({
      since:      SINCE,
      lts:        ltGeneral + ltRise + ltNcn,
      ltsMonth:   ltGeneralM + ltRiseM + ltNcnM,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      leadsInSeq: seqData,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
