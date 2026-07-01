// Audit: muestra todos los LTs del mes actual y sus assignees
const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2    = 'https://services.leadconnectorhq.com';
const GHL_TOKEN = process.env.GHL_TOKEN_IF ?? process.env.GHL_TOKEN;
const GHL_HDR   = { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28', Accept: 'application/json' };

const PIPELINES = {
  '85kFh5EWKPg7qg9FDJfg':  'RISE',
  'tzoH6Bv4qfC4Rug8yZvQ':  'NCN',
};
const KNOWN_REPS = {
  'KDgmtLyZD3R4OiahkpSH': 'camila',
  '8KZhLfeBuu5SZKTAe2nT': 'maria',
  'T7N31x5q1gUckaANYMoM': 'sara',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const now        = new Date();
const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

async function fetchWonOpps(pipelineId) {
  const all = []; let page = 1;
  while (true) {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, status: 'won', limit: 100, page });
    const r   = await fetch(`${GHL_V2}/opportunities/search?${qs}`, { headers: GHL_HDR });
    const d   = await r.json().catch(() => ({}));
    const ops = d.opportunities ?? [];
    all.push(...ops);
    if (all.length >= (d.meta?.total ?? 0) || !ops.length) break;
    page++; await sleep(300);
  }
  return all;
}

// Fetch user names
async function getUserName(userId) {
  try {
    const r = await fetch(`${GHL_V2}/users/${userId}`, { headers: GHL_HDR });
    const d = await r.json().catch(() => ({}));
    return `${d.name ?? d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || userId;
  } catch { return userId; }
}

console.log('=== LTs DEL MES ACTUAL ===');
console.log('Mes:', monthStart, '\n');

const monthStartMs = new Date(monthStart).getTime();
const allWon = [];
const unknownReps = new Map(); // userId → count

for (const [pipId, pipName] of Object.entries(PIPELINES)) {
  const opps = await fetchWonOpps(pipId);
  const thisMonth = opps.filter(o => {
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    return t >= monthStartMs;
  });
  if (thisMonth.length) {
    console.log(`${pipName}: ${thisMonth.length} LTs este mes`);
    for (const o of thisMonth) {
      const repName = KNOWN_REPS[o.assignedTo] ?? '?DESCONOCIDO';
      const wonAt   = (o.lastStageChangeAt ?? o.createdAt)?.slice(0,10);
      const contact = o.contact?.name ?? o.contactId ?? '?';
      console.log(`  [${wonAt}] ${contact} → rep: ${repName} (${o.assignedTo?.slice(0,8)})`);
      if (!KNOWN_REPS[o.assignedTo]) {
        unknownReps.set(o.assignedTo, (unknownReps.get(o.assignedTo) ?? 0) + 1);
      }
      allWon.push({ ...o, pipName });
    }
  }
  await sleep(500);
}

if (unknownReps.size) {
  console.log('\n=== REPS DESCONOCIDOS — RAW OPP FIELDS ===');
  const unknownOpps = allWon.filter(o => !KNOWN_REPS[o.assignedTo]);
  for (const o of unknownOpps) {
    console.log(`  Contact: ${o.contact?.name} (contactId: ${o.contactId})`);
    console.log(`    o.assignedTo: ${JSON.stringify(o.assignedTo)}`);
    console.log(`    o.userId: ${JSON.stringify(o.userId)}`);
    console.log(`    o.contact?.assignedTo: ${JSON.stringify(o.contact?.assignedTo)}`);
    console.log(`    o.id: ${o.id}`);
  }
}

console.log(`\nTotal LTs este mes: ${allWon.length}`);
