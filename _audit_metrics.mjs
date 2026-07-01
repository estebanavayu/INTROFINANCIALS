// Audit: verifica leads en secuencia + opt-out rates directamente
const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2    = 'https://services.leadconnectorhq.com';
const GHL_TOKEN = process.env.GHL_TOKEN_IF ?? process.env.GHL_TOKEN;
const SB_URL    = process.env.IF_SUPABASE_URL;
const SB_KEY    = process.env.IF_SUPABASE_KEY;

const GHL_HDR = { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28', Accept: 'application/json' };
const SB_HDR  = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const GENERAL_OPENING = 'fxzuSpmyNzMH4yupNfk1';
const PIPELINES_MCA   = ['fxzuSpmyNzMH4yupNfk1','85kFh5EWKPg7qg9FDJfg','tzoH6Bv4qfC4Rug8yZvQ'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ghlGet(url) {
  const r = await fetch(url, { headers: GHL_HDR });
  if (!r.ok) { console.error('GHL error', r.status, url); return null; }
  return r.json();
}

async function sbCount(table, params) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { ...SB_HDR, Prefer: 'count=exact', Range: '0-0' },
  });
  return parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0') || 0;
}

const now       = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
const todayStr      = now.toISOString().slice(0,10);
const tomorrowStr   = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).toISOString().slice(0,10);

console.log('=== AUDIT INTRO ANALYTICS ===');
console.log('Fecha:', now.toISOString(), '\n');

// ── 1. Leads en secuencia (GENERAL OPENING, status=open) ──────
console.log('── 1. LEADS EN SECUENCIA ────────────────────────');
for (const pid of PIPELINES_MCA) {
  const d = await ghlGet(`${GHL_V2}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${pid}&status=open&limit=1`);
  const name = pid === GENERAL_OPENING ? 'GENERAL' : pid === '85kFh5EWKPg7qg9FDJfg' ? 'RISE' : 'NCN';
  console.log(` ${name}: ${d?.meta?.total ?? 'ERROR'} open opps`);
  await sleep(400);
}

// También contar por stage en GENERAL OPENING para ver distribución
const pipData = await ghlGet(`${GHL_V2}/opportunities/pipelines?locationId=${GHL_LOC}`);
const genPip  = (pipData?.pipelines ?? []).find(p => p.id === GENERAL_OPENING);
console.log('\n GENERAL OPENING stages:');
if (genPip) {
  for (const stage of (genPip.stages ?? [])) {
    const d = await ghlGet(`${GHL_V2}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${GENERAL_OPENING}&pipeline_stage_id=${stage.id}&status=open&limit=1`);
    const total = d?.meta?.total ?? 0;
    if (total > 0) console.log(`   "${stage.name}": ${total}`);
    await sleep(200);
  }
}

// ── 2. Opt-out desde Supabase ─────────────────────────────────
console.log('\n── 2. OPT-OUT RATES ─────────────────────────────');

// SMS del mes (conversations/messages/export)
const smsMonthR = await ghlGet(`${GHL_V2}/conversations/messages/export?locationId=${GHL_LOC}&startDate=${monthStartStr}&endDate=${todayStr}&limit=10`);
const smsMonth  = smsMonthR?.total ?? null;
const smsTodayR = await ghlGet(`${GHL_V2}/conversations/messages/export?locationId=${GHL_LOC}&startDate=${todayStr}&endDate=${tomorrowStr}&limit=10`);
const smsToday  = smsTodayR?.total ?? null;
console.log(` SMS mes (${monthStartStr} → ${todayStr}): ${smsMonth}`);
console.log(` SMS hoy (${todayStr}): ${smsToday}`);

// Opt-outs desde Supabase
const qMes = new URLSearchParams({ select: 'contact_id' });
qMes.append('ts', `gte.${monthStart}`);
qMes.append('ts', `lte.${now.toISOString()}`);
const optoutMonth = await sbCount('optout_events', qMes);

const qHoy = new URLSearchParams({ select: 'contact_id' });
qHoy.append('ts', `gte.${todayStart}`);
qHoy.append('ts', `lte.${now.toISOString()}`);
const optoutToday = await sbCount('optout_events', qHoy);

const qTotal = new URLSearchParams({ select: 'contact_id' });
const optoutTotal = await sbCount('optout_events', qTotal);

console.log(` Opt-outs este mes: ${optoutMonth}`);
console.log(` Opt-outs hoy: ${optoutToday}`);
console.log(` Opt-outs total histórico: ${optoutTotal}`);

if (smsMonth && optoutMonth) {
  console.log(` Rate mes: ${(optoutMonth/smsMonth*100).toFixed(3)}% (${optoutMonth}/${smsMonth})`);
}
if (smsToday && optoutToday) {
  console.log(` Rate hoy: ${(optoutToday/smsToday*100).toFixed(3)}% (${optoutToday}/${smsToday})`);
} else {
  console.log(` Rate hoy: no aplica (SMS hoy=${smsToday}, optouts hoy=${optoutToday})`);
}

// ── 3. Última fila de optout_events ───────────────────────────
console.log('\n── 3. ÚLTIMOS OPT-OUTS EN SUPABASE ─────────────');
const latestR = await fetch(`${SB_URL}/rest/v1/optout_events?select=contact_id,ts&order=ts.desc&limit=5`, { headers: SB_HDR });
const latest  = await latestR.json();
for (const row of latest) console.log(` ${row.ts} → ${row.contact_id}`);

// ── 4. Cache guardado vs calculado ───────────────────────────
console.log('\n── 4. CACHE EN SUPABASE ─────────────────────────');
const cacheR = await fetch(`${SB_URL}/rest/v1/sync_state?key=in.(metrics_globals,metrics_mca)&select=key,updated_at,value`, { headers: SB_HDR });
const caches = await cacheR.json();
for (const row of caches) {
  const v = JSON.parse(row.value);
  console.log(` [${row.key}] updated_at: ${row.updated_at}`);
  if (row.key === 'metrics_globals') {
    console.log(`   lts=${v.lts} ltsMonth=${v.ltsMonth}`);
    console.log(`   smsMonth=${v.smsMonth} smsToday=${v.smsToday}`);
    console.log(`   optoutMonth=${v.optoutMonth} optoutToday=${v.optoutToday}`);
    console.log(`   optoutRateMonth=${v.optoutRateMonth?.toFixed?.(5)} optoutRateToday=${v.optoutRateToday?.toFixed?.(5)}`);
  }
  if (row.key === 'metrics_mca') {
    console.log(`   leadsActive=${v.leadsActive} noShows=${v.noShows} ltsTotal=${v.ltsTotal}`);
  }
}

console.log('\n=== FIN AUDIT ===');
