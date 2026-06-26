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

// Total de SMS outbound via messages/export — el único endpoint que funciona con pit- token
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

    // Dedup por contactId
    const byContact = new Map();
    for (const o of [...rise, ...ncn, ...century]) {
      const key = o.contactId ?? o.contact?.id;
      if (!key) continue;
      const prev = byContact.get(key);
      const tNew = new Date(o.lastStageChangeAt ?? o.createdAt ?? 0).getTime();
      const tOld = prev ? new Date(prev.lastStageChangeAt ?? prev.createdAt ?? 0).getTime() : 0;
      if (!prev || tNew > tOld) byContact.set(key, o);
    }

    // Filtrar por lastStageChangeAt (cuando el opp pasó a Won)
    const stageTs = o => new Date(o.lastStageChangeAt ?? o.createdAt ?? 0).getTime();
    const allOpps   = [...byContact.values()].filter(o => stageTs(o) >= sinceMs);
    const thisMonth = allOpps.filter(o => stageTs(o) >= monthStartMs);

    res.json({
      since:      SINCE,
      lts:        allOpps.length,
      ltsMonth:   thisMonth.length,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      leadsInSeq: seqData,
      smsMonth,
      smsTotal,
      _debug: { rise: rise.length, ncn: ncn.length, century: century.length },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
