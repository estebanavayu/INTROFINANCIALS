const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2    = 'https://services.leadconnectorhq.com';
const SINCE     = '2026-02-01';

// Pipelines opening (LTs)
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
  };
}

// Pagina todos los resultados de un endpoint con ?page=
async function paginateOpps(pipelineId) {
  let total = 0;
  let page  = 1;
  while (true) {
    const url = `${GHL_V2}/opportunities/search`
      + `?location_id=${GHL_LOC}`
      + `&pipeline_id=${pipelineId}`
      + `&status=won`
      + `&startDate=${SINCE}`
      + `&limit=100&page=${page}`;
    const res  = await fetch(url, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const opps = data.opportunities || [];
    total += opps.length;
    if (opps.length < 100) break;
    page++;
  }
  return total;
}

// Leads activos en algún workflow
async function fetchLeadsInSequences() {
  let total = 0;
  let page  = 1;
  while (true) {
    const url = `${GHL_V2}/contacts/`
      + `?locationId=${GHL_LOC}`
      + `&workflowActivity=active`
      + `&limit=100&page=${page}`;
    const res  = await fetch(url, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const contacts = data.contacts || [];
    total += contacts.length;
    if (contacts.length < 100) break;
    page++;
  }
  return total;
}

// Mensajes blasteados — total outbound del location
async function fetchBlasted() {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${GHL_V2}/conversations/search`
    + `?locationId=${GHL_LOC}`
    + `&startDate=${SINCE}`
    + `&endDate=${today}`
    + `&limit=1`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  // Devuelve el total si el API lo expone
  return data.total || data.count || null;
}

async function rawFetch(url) {
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, url, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const [r1, r2, r3] = await Promise.all([
    rawFetch(`${GHL_V2}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${OPENING_PIPELINES[0]}&status=won&limit=5`),
    rawFetch(`${GHL_V2}/contacts/?locationId=${GHL_LOC}&workflowActivity=active&limit=5`),
    rawFetch(`${GHL_V2}/contacts/?locationId=${GHL_LOC}&limit=1`),
  ]);

  res.json({ opps: r1, workflow: r2, contacts: r3 });
}
