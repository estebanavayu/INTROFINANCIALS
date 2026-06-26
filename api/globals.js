const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SINCE   = '2026-02-01';

const OPENING_PIPELINES = [
  '85kFh5EWKPg7qg9FDJfg',  // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ',  // NCN OPENING
  '8tbkIiJnJCnPZY6X0mA6',  // CENTURY OPENING (CC)
];

// Stage "Lead Ganado +60s" por pipeline — para Llamadas Concretadas
const WON_STAGE = {
  '85kFh5EWKPg7qg9FDJfg': 'b49467aa-ee9f-462c-ade5-775d9bbf4ac2',
  'tzoH6Bv4qfC4Rug8yZvQ': 'f5ecb2a9-050d-4f75-a007-e25ab2c12c30',
  '8tbkIiJnJCnPZY6X0mA6': 'fb6853c0-f7b8-4b68-ad9d-c43e339ea9a5',
};

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

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

// Batch lookup de contactos por ID — devuelve Map<contactId, dateAdded>
async function fetchContactDates(contactIds) {
  const map = new Map();
  const BATCH = 200;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const batch = contactIds.slice(i, i + BATCH);
    const body  = JSON.stringify({
      locationId: GHL_LOC,
      filters: [{ field: 'id', operator: 'contains_set', value: batch }],
      pageLimit: BATCH,
    });
    const res  = await fetch(`${GHL_V2}/contacts/search`, { method: 'POST', headers: hdrs(), body });
    const data = await res.json().catch(() => ({}));
    for (const c of (data.contacts ?? [])) {
      if (c.id && c.dateAdded) map.set(c.id, new Date(c.dateAdded).getTime());
    }
  }
  return map;
}

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

async function fetchSmsBlasted(startDate, endDate) {
  const url = `${GHL_V2}/conversations/messages/export`
    + `?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}&limit=10`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return data.total ?? null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now = new Date();
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const sinceMs      = new Date(SINCE).getTime();
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const todayStr      = now.toISOString().slice(0, 10);

    const [rise, ncn, century, seqData, smsMonth, smsTotal] = await Promise.all([
      fetchAllWon(OPENING_PIPELINES[0]),
      fetchAllWon(OPENING_PIPELINES[1]),
      fetchAllWon(OPENING_PIPELINES[2]),
      fetchLeadsInSequences(),
      fetchSmsBlasted(monthStartStr, todayStr),
      fetchSmsBlasted(SINCE, todayStr),
    ]);

    // Dedup por contactId — quedar con 1 opp por contacto (la más reciente)
    const byContact = new Map();
    for (const o of [...rise, ...ncn, ...century]) {
      if (!o.contactId) continue;
      const prev = byContact.get(o.contactId);
      if (!prev || (o.lastStageChangeAt > (prev.lastStageChangeAt ?? ''))) {
        byContact.set(o.contactId, o);
      }
    }
    const uniqueContactIds = [...byContact.keys()];

    // Batch lookup de dateAdded por contacto
    const contactDates = await fetchContactDates(uniqueContactIds);

    // Contar LTs y llamadas concretadas por contact.dateAdded
    let ltsTotal = 0, ltsMonth = 0, callsTotal = 0, callsMonth = 0;
    for (const [id, opp] of byContact) {
      const t       = contactDates.get(id) ?? 0;
      const isCall  = WON_STAGE[opp.pipelineId] === opp.pipelineStageId;
      if (t >= sinceMs)      { ltsTotal++;  if (isCall) callsTotal++; }
      if (t >= monthStartMs) { ltsMonth++;  if (isCall) callsMonth++; }
    }

    res.json({
      since:      SINCE,
      lts:        ltsTotal,
      ltsMonth,
      calls:      callsTotal,
      callsMonth,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      leadsInSeq: seqData,
      smsMonth,
      smsTotal,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
