const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SINCE   = '2026-02-01';

// Pipelines y stages "Lead Ganado +60s"
const PIPELINES = [
  { id: '85kFh5EWKPg7qg9FDJfg', callStage: 'b49467aa-ee9f-462c-ade5-775d9bbf4ac2' }, // RISE
  { id: 'tzoH6Bv4qfC4Rug8yZvQ', callStage: 'f5ecb2a9-050d-4f75-a007-e25ab2c12c30' }, // NCN
  { id: '8tbkIiJnJCnPZY6X0mA6', callStage: 'fb6853c0-f7b8-4b68-ad9d-c43e339ea9a5' }, // CENTURY
];

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

async function fetchAllOpps(pipelineId, params = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, limit: 100, page, ...params }).toString();
    const res  = await fetch(`${GHL_V2}/opportunities/search?${qs}`, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const opps = data.opportunities ?? [];
    all.push(...opps);
    if (all.length >= (data.meta?.total ?? 0) || opps.length === 0) break;
    page++;
  }
  return all;
}

async function fetchContactDates(contactIds) {
  const map = new Map();
  const BATCH = 200;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const batch = contactIds.slice(i, i + BATCH);
    const body  = JSON.stringify({ locationId: GHL_LOC, filters: [{ field: 'id', operator: 'contains_set', value: batch }], pageLimit: BATCH });
    const res   = await fetch(`${GHL_V2}/contacts/search`, { method: 'POST', headers: hdrs(), body });
    const data  = await res.json().catch(() => ({}));
    for (const c of (data.contacts ?? [])) {
      if (c.id && c.dateAdded) map.set(c.id, new Date(c.dateAdded).getTime());
    }
  }
  return map;
}

async function fetchLeadsInSequences() {
  const body = JSON.stringify({ locationId: GHL_LOC, filters: [{ field: 'tags', operator: 'contains', value: 'fup cold blast' }], page: 1, pageLimit: 1 });
  const res  = await fetch(`${GHL_V2}/contacts/search`, { method: 'POST', headers: hdrs(), body });
  const data = await res.json().catch(() => ({}));
  return data.total ?? data.meta?.total ?? null;
}

async function fetchSmsTotal(startDate, endDate) {
  const url = `${GHL_V2}/conversations/messages/export?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}&limit=10`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return data.total ?? null;
}

// Dedup contactIds de una lista de opps, devuelve Map<contactId, opp>
function dedupByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    if (!o.contactId) continue;
    const prev = map.get(o.contactId);
    if (!prev || (o.lastStageChangeAt ?? '') > (prev.lastStageChangeAt ?? '')) map.set(o.contactId, o);
  }
  return map;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now           = new Date();
    const monthStartMs  = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const sinceMs       = new Date(SINCE).getTime();
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const todayStr      = now.toISOString().slice(0, 10);

    // Todo en paralelo
    const [
      ...allResults
    ] = await Promise.all([
      ...PIPELINES.map(p => fetchAllOpps(p.id, { status: 'won' })),
      ...PIPELINES.map(p => fetchAllOpps(p.id, { pipeline_stage_id: p.callStage })),
      fetchLeadsInSequences(),
      fetchSmsTotal(monthStartStr, todayStr),
      fetchSmsTotal(SINCE, todayStr),
    ]);
    const wonResults  = allResults.slice(0, 3);
    const callResults = allResults.slice(3, 6);
    const [seqData, smsMonth, smsTotal] = allResults.slice(6);

    // Dedup contactIds
    const wonMap  = dedupByContact(wonResults.flat());
    const callMap = dedupByContact(callResults.flat());
    const allIds  = [...new Set([...wonMap.keys(), ...callMap.keys()])];

    // Batch lookup fechas de contacto
    const contactDates = await fetchContactDates(allIds);

    // Contar LTs (won) y Llamadas (call stage) por contact.dateAdded
    let ltsTotal = 0, ltsMonth = 0, callsTotal = 0, callsMonth = 0;
    for (const id of wonMap.keys()) {
      const t = contactDates.get(id) ?? 0;
      if (t >= sinceMs)      ltsTotal++;
      if (t >= monthStartMs) ltsMonth++;
    }
    for (const id of callMap.keys()) {
      const t = contactDates.get(id) ?? 0;
      if (t >= sinceMs)      callsTotal++;
      if (t >= monthStartMs) callsMonth++;
    }

    res.json({
      since: SINCE,
      lts: ltsTotal, ltsMonth,
      calls: callsTotal, callsMonth,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      leadsInSeq: seqData,
      smsMonth, smsTotal,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
