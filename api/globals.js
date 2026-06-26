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

// Total won sin filtro de fecha (usa meta.total)
async function fetchLtTotal(pipelineId) {
  const url = `${GHL_V2}/opportunities/search`
    + `?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=1`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return data.meta?.total ?? 0;
}

// Won este mes — filtra por createdAt (= startDate en GHL), igual que "Created this month"
async function fetchLtMonth(pipelineId, monthStart) {
  const url = `${GHL_V2}/opportunities/search`
    + `?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won`
    + `&startDate=${monthStart}&limit=1`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return data.meta?.total ?? 0;
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
    const monthStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStart = monthStartDate.getTime(); // Unix ms — GHL espera timestamp

    const [lt0, lt1, lt2,
           ltM0, ltM1, ltM2,
           seqData] = await Promise.all([
      fetchLtTotal(OPENING_PIPELINES[0]),
      fetchLtTotal(OPENING_PIPELINES[1]),
      fetchLtTotal(OPENING_PIPELINES[2]),
      fetchLtMonth(OPENING_PIPELINES[0], monthStart),
      fetchLtMonth(OPENING_PIPELINES[1], monthStart),
      fetchLtMonth(OPENING_PIPELINES[2], monthStart),
      fetchLeadsInSequences(),
    ]);

    res.json({
      since:      SINCE,
      lts:        lt0 + lt1 + lt2,
      ltsMonth:   ltM0 + ltM1 + ltM2,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      leadsInSeq: seqData,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
