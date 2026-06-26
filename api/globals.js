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

// Lee solo meta.total — 1 request por pipeline
async function fetchLtTotal(pipelineId) {
  const url = `${GHL_V2}/opportunities/search`
    + `?location_id=${GHL_LOC}`
    + `&pipeline_id=${pipelineId}`
    + `&status=won`
    + `&limit=1`;
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
    const [ltGeneral, ltRise, ltNcn, seqData] = await Promise.all([
      fetchLtTotal(OPENING_PIPELINES[0]),
      fetchLtTotal(OPENING_PIPELINES[1]),
      fetchLtTotal(OPENING_PIPELINES[2]),
      fetchLeadsInSequences(),
    ]);

    res.json({
      since:     SINCE,
      lts:       ltGeneral + ltRise + ltNcn,
      leadsInSeq: seqData.total,
      debug:     { ltGeneral, ltRise, ltNcn, seqData },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
