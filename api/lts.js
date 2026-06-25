const GHL_TOKEN = process.env.GHL_TOKEN;
const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V1    = 'https://rest.gohighlevel.com/v1';

const PIPELINES = {
  mca:  ['85kFh5EWKPg7qg9FDJfg', 'tzoH6Bv4qfC4Rug8yZvQ'],
  cc:   ['8tbkIiJnJCnPZY6X0mA6'],
};

const ATTRIBUTION_START = new Date('2026-04-01T00:00:00.000Z').getTime();

// Fetch all WON opps from a pipeline since April 1
async function fetchWonOpps(pipelineId) {
  const opps = [];
  let page = 1;
  while (true) {
    const url = `${GHL_V1}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=100&page=${page}`;
    const data = await fetch(url, {
      headers: { Authorization: `Bearer ${GHL_TOKEN}` }
    }).then(r => r.json()).catch(() => ({ opportunities: [] }));

    const batch = data.opportunities || [];
    if (batch.length === 0) break;

    for (const opp of batch) {
      const wonAt = new Date(opp.lastStatusChangeAt || opp.updatedAt).getTime();
      if (wonAt >= ATTRIBUTION_START) opps.push(opp);
    }
    if (batch.length < 100) break;
    page++;
    if (page > 50) break;
  }
  return opps;
}

// Fetch GHL users to map id → name
async function fetchUsers() {
  const data = await fetch(
    `${GHL_V1}/users/?locationId=${GHL_LOC}`,
    { headers: { Authorization: `Bearer ${GHL_TOKEN}` } }
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [userMap, ...pipelineResults] = await Promise.all([
      fetchUsers(),
      ...PIPELINES.mca.map(fetchWonOpps),
      ...PIPELINES.cc.map(fetchWonOpps),
    ]);

    const mcaOpps = [...pipelineResults[0], ...pipelineResults[1]];
    const ccOpps  = [...pipelineResults[2]];

    // dedup por contactId (latest wonAt)
    function dedup(opps) {
      const map = {};
      for (const opp of opps) {
        const cid = opp.contactId;
        const wonAt = new Date(opp.lastStatusChangeAt || opp.updatedAt).getTime();
        if (!map[cid] || wonAt > new Date(map[cid].lastStatusChangeAt || map[cid].updatedAt).getTime()) {
          map[cid] = opp;
        }
      }
      return Object.values(map);
    }

    const mcaDedup = dedup(mcaOpps);
    const ccDedup  = dedup(ccOpps);

    res.json({
      mca: {
        total: mcaDedup.length,
        byRep: groupByRep(mcaDedup, userMap),
      },
      cc: {
        total: ccDedup.length,
        byRep: groupByRep(ccDedup, userMap),
      },
      total: mcaDedup.length + ccDedup.length,
      since: '2026-04-01',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
