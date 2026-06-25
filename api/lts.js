const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';

const PIPELINES = {
  mca: ['85kFh5EWKPg7qg9FDJfg', 'tzoH6Bv4qfC4Rug8yZvQ'],
  cc:  ['8tbkIiJnJCnPZY6X0mA6'],
};

const ATTRIBUTION_START = new Date('2026-04-01T00:00:00.000Z').getTime();

function hdrs() {
  return {
    Authorization: `Bearer ${process.env.GHL_TOKEN}`,
    Version: '2021-07-28',
  };
}

async function fetchWonOpps(pipelineId) {
  const opps = [];
  let startAfterId = null;

  while (true) {
    const base = `${GHL_V2}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=100`;
    const url  = startAfterId ? `${base}&startAfterId=${startAfterId}` : base;
    const data = await fetch(url, { headers: hdrs() })
      .then(r => r.json())
      .catch(() => ({ opportunities: [] }));

    const batch = data.opportunities || [];
    if (batch.length === 0) break;

    for (const opp of batch) {
      const wonAt = new Date(
        opp.lastStatusChangeAt || opp.closedDate || opp.updatedAt || opp.dateAdded
      ).getTime();
      if (wonAt >= ATTRIBUTION_START) opps.push({ ...opp, _wonAt: wonAt });
    }

    if (batch.length < 100) break;
    startAfterId = batch[batch.length - 1].id;
    if (opps.length > 5000) break;
  }
  return opps;
}

async function fetchUsers() {
  const data = await fetch(
    `${GHL_V2}/users/?locationId=${GHL_LOC}`,
    { headers: hdrs() }
  ).then(r => r.json()).catch(() => ({ users: [] }));
  const map = {};
  for (const u of (data.users || [])) {
    map[u.id] = `${u.firstName || ''} ${u.lastName || ''}`.trim();
  }
  return map;
}

function groupByRep(opps, userMap) {
  const counts = {};
  for (const opp of opps) {
    const userId = opp.assignedTo || 'unassigned';
    const name   = userMap[userId] || userId;
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function dedup(opps) {
  const map = {};
  for (const opp of opps) {
    const cid = opp.contactId;
    if (!map[cid] || opp._wonAt > map[cid]._wonAt) map[cid] = opp;
  }
  return Object.values(map);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // debug: muestra respuesta cruda + token presente
  if (req.query?.debug) {
    const pid = req.query.debug;
    const token = process.env.GHL_TOKEN;
    const url = `${GHL_V2}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${pid}&status=won&limit=5`;
    const raw = await fetch(url, { headers: hdrs() }).then(r => r.json()).catch(e => ({ error: e.message }));
    return res.json({ url, raw, tokenPresent: !!token, tokenPrefix: token?.slice(0, 8) });
  }

  try {
    const [userMap, rise, ncn, century] = await Promise.all([
      fetchUsers(),
      fetchWonOpps(PIPELINES.mca[0]),
      fetchWonOpps(PIPELINES.mca[1]),
      fetchWonOpps(PIPELINES.cc[0]),
    ]);

    const mcaDedup = dedup([...rise, ...ncn]);
    const ccDedup  = dedup(century);

    res.json({
      mca: { total: mcaDedup.length, byRep: groupByRep(mcaDedup, userMap) },
      cc:  { total: ccDedup.length,  byRep: groupByRep(ccDedup,  userMap) },
      total: mcaDedup.length + ccDedup.length,
      since: '2026-04-01',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
