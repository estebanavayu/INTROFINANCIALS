// Cron: computa métricas GHL y las cachea en Supabase sync_state
// El dashboard lee SOLO de Supabase — nunca golpea GHL en vivo desde Vercel
// Corre cada 30 min via GitHub Actions

const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2    = 'https://services.leadconnectorhq.com';
const SINCE     = '2026-02-01';

const GHL_TOKEN = process.env.GHL_TOKEN_IF ?? process.env.GHL_TOKEN;
const SB_URL    = process.env.IF_SUPABASE_URL;
const SB_KEY    = process.env.IF_SUPABASE_KEY;

if (!GHL_TOKEN || !SB_URL || !SB_KEY) {
  console.error('Faltan vars: GHL_TOKEN_IF, IF_SUPABASE_URL, IF_SUPABASE_KEY');
  process.exit(1);
}

const GHL_HDR = { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28', Accept: 'application/json' };
const SB_HDR  = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

const PIPELINES_ALL = [
  '85kFh5EWKPg7qg9FDJfg', // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ', // NCN OPENING
  '8tbkIiJnJCnPZY6X0mA6', // CENTURY OPENING (CC)
];
const MCA_PIPELINES   = PIPELINES_ALL.slice(0, 2);
const GENERAL_OPENING = 'fxzuSpmyNzMH4yupNfk1';

const REPS = {
  camila: 'KDgmtLyZD3R4OiahkpSH',
  maria:  '8KZhLfeBuu5SZKTAe2nT',
  sara:   'T7N31x5q1gUckaANYMoM',
};

// ── Helpers ──────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ghlFetch(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { headers: GHL_HDR });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('Retry-After') ?? '10') * 1000;
      console.warn(`  429 rate limit, esperando ${wait}ms`);
      await sleep(wait || 10000);
      continue;
    }
    if (r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    return r;
  }
  throw new Error(`ghlFetch agotó reintentos: ${url}`);
}

async function fetchWonOpps(pipelineId) {
  const all = []; let page = 1;
  while (true) {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, status: 'won', limit: 100, page });
    const res = await ghlFetch(`${GHL_V2}/opportunities/search?${qs}`);
    const d   = await res.json().catch(() => ({}));
    const ops = d.opportunities ?? [];
    all.push(...ops);
    if (all.length >= (d.meta?.total ?? 0) || !ops.length) break;
    page++;
    await sleep(300);
  }
  console.log(`  pipeline ${pipelineId.slice(0,8)}: ${all.length} won`);
  return all;
}

async function fetchAllOpps(pipelineId) {
  const all = []; let page = 1;
  while (true) {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, limit: 100, page });
    const res = await ghlFetch(`${GHL_V2}/opportunities/search?${qs}`);
    const d   = await res.json().catch(() => ({}));
    const ops = d.opportunities ?? [];
    all.push(...ops);
    if (all.length >= (d.meta?.total ?? 0) || !ops.length) break;
    page++;
    await sleep(300);
  }
  return all;
}

function dedupByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    if (!o.contactId) continue;
    const prev = map.get(o.contactId);
    if (!prev || (o.lastStageChangeAt ?? '') > (prev.lastStageChangeAt ?? '')) map.set(o.contactId, o);
  }
  return [...map.values()];
}

async function fetchSmsTotal(startDate, endDate) {
  const r = await ghlFetch(`${GHL_V2}/conversations/messages/export?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}&limit=10`);
  const d = await r.json().catch(() => ({}));
  return d.total ?? null;
}

async function sbCount(table, params) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { ...SB_HDR, Prefer: 'count=exact', Range: '0-0' },
  });
  return parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0') || 0;
}

async function fetchCallsSb(startISO, endISO) {
  const p = (dir) => {
    const q = new URLSearchParams({ select: 'id', direction: `eq.${dir}`, status: 'eq.completed', duration: 'gte.30' });
    q.append('date_added', `gte.${startISO}`);
    q.append('date_added', `lte.${endISO}`);
    return q;
  };
  const [out, inb] = await Promise.all([
    sbCount('call_records', p('outbound')),
    sbCount('call_records', p('inbound')),
  ]);
  return out + inb;
}

async function fetchCallsForContacts(ids, startISO, endISO) {
  if (!ids.length) return 0;
  const BATCH = 200; let total = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const qs = new URLSearchParams({ select: 'id', status: 'eq.completed', duration: 'gte.30' });
    qs.append('date_added', `gte.${startISO}`);
    qs.append('date_added', `lte.${endISO}`);
    qs.append('contact_id', `in.(${ids.slice(i, i + BATCH).join(',')})`);
    total += await sbCount('call_records', qs);
  }
  return total;
}

async function fetchConvCount(userId) {
  const qs  = new URLSearchParams({ locationId: GHL_LOC, assignedTo: userId, limit: 1 });
  const res = await ghlFetch(`${GHL_V2}/conversations/search?${qs}`);
  const d   = await res.json().catch(() => ({}));
  return d.total ?? null;
}

async function fetchOptOut(startISO, endISO) {
  const q = new URLSearchParams({ select: 'contact_id' });
  q.append('ts', `gte.${startISO}`);
  q.append('ts', `lte.${endISO}`);
  return sbCount('optout_events', q);
}

// ── Cache en sync_state ──────────────────────────────────────

async function readCache(key) {
  const r = await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.${key}&select=value,updated_at`, { headers: SB_HDR });
  const d = await r.json();
  if (!d[0]) return null;
  try { return { value: JSON.parse(d[0].value), updated_at: d[0].updated_at }; } catch { return null; }
}

async function writeCache(key, value) {
  await fetch(`${SB_URL}/rest/v1/sync_state`, {
    method:  'POST',
    headers: { ...SB_HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }),
  });
  console.log(`  ✓ cache guardado: ${key}`);
}

// Sanity check: si el nuevo total es <70% del anterior, no sobreescribir
function sanityOk(newVal, oldVal, label) {
  if (!oldVal) return true;
  if (newVal < oldVal * 0.7) {
    console.error(`SANITY FAIL [${label}]: ${newVal} < 70% de ${oldVal} — NO se sobreescribe`);
    return false;
  }
  return true;
}

// ── Computaciones ────────────────────────────────────────────

async function computeGlobals(D) {
  console.log('\n[globals] Fetching won opps...');
  const allWon = [];
  for (const pid of PIPELINES_ALL) {
    allWon.push(...await fetchWonOpps(pid));
    await sleep(500);
  }
  const deduped = dedupByContact(allWon);
  let ltsTotal = 0, ltsMonth = 0;
  const ltsByMonth = {};
  for (const o of deduped) {
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    if (t >= D.sinceMs) {
      ltsTotal++;
      const d = new Date(o.lastStageChangeAt ?? o.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      ltsByMonth[key] = (ltsByMonth[key] ?? 0) + 1;
    }
    if (t >= D.monthStartMs) ltsMonth++;
  }
  console.log(`[globals] LTs: ${ltsTotal} total, ${ltsMonth} mes`);

  await sleep(500);
  const [smsTotal, smsMonth, smsToday, callsTotal, callsMonth, optoutMonth, optoutToday] = await Promise.all([
    fetchSmsTotal(SINCE, D.todayStr),
    fetchSmsTotal(D.monthStartStr, D.todayStr),
    fetchSmsTotal(D.todayStr, D.tomorrowStr),
    fetchCallsSb(D.sinceISO, D.nowISO),
    fetchCallsSb(D.monthStartISO, D.nowISO),
    fetchOptOut(D.monthStartISO, D.nowISO),
    fetchOptOut(D.todayStartISO, D.nowISO),
  ]);

  return {
    lts: ltsTotal, ltsMonth, ltsByMonth,
    calls: callsTotal, callsMonth,
    smsTotal, smsMonth, smsToday,
    optoutMonth, optoutToday,
    optoutRateMonth: smsMonth && optoutMonth ? optoutMonth / smsMonth : null,
    optoutRateToday: smsToday && optoutToday ? optoutToday / smsToday : null,
    monthLabel: new Date().toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
  };
}

async function computeMca(D) {
  console.log('\n[mca] Fetching won opps...');
  const allWon = [];
  for (const pid of MCA_PIPELINES) {
    allWon.push(...await fetchWonOpps(pid));
    await sleep(500);
  }
  const deduped = dedupByContact(allWon);
  let ltsTotal = 0, ltsMonth = 0;
  for (const o of deduped) {
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    if (t >= D.sinceMs)      ltsTotal++;
    if (t >= D.monthStartMs) ltsMonth++;
  }
  console.log(`[mca] LTs: ${ltsTotal} total, ${ltsMonth} mes`);

  await sleep(500);
  const pipRes  = await ghlFetch(`${GHL_V2}/opportunities/pipelines?locationId=${GHL_LOC}`);
  const pipData = await pipRes.json().catch(() => ({}));
  const genPip  = (pipData.pipelines ?? []).find(p => p.id === GENERAL_OPENING);
  let noShows = 0;
  for (const s of (genPip?.stages ?? []).filter(s => /no[\s_-]?show/i.test(s.name))) {
    const qs = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: GENERAL_OPENING, pipeline_stage_id: s.id, limit: 1 });
    const r  = await ghlFetch(`${GHL_V2}/opportunities/search?${qs}`);
    const d  = await r.json().catch(() => ({}));
    noShows += d.meta?.total ?? 0;
    await sleep(300);
  }

  await sleep(300);
  const leadsQs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: GENERAL_OPENING, status: 'open', limit: 1 });
  const leadsRes = await ghlFetch(`${GHL_V2}/opportunities/search?${leadsQs}`);
  const leadsD   = await leadsRes.json().catch(() => ({}));
  const leadsActive = leadsD.meta?.total ?? null;

  await sleep(400);
  const [smsTotal, smsMonth, smsToday, callsTotal, callsMonth] = await Promise.all([
    fetchSmsTotal(SINCE, D.todayStr),
    fetchSmsTotal(D.monthStartStr, D.todayStr),
    fetchSmsTotal(D.todayStr, D.tomorrowStr),
    fetchCallsSb(D.sinceISO, D.nowISO),
    fetchCallsSb(D.monthStartISO, D.nowISO),
  ]);

  return {
    leadsActive, ltsTotal, ltsMonth,
    smsTotal, smsMonth, smsToday,
    callsTotal, callsMonth, noShows,
    rateSmsCall:      callsTotal && smsTotal  ? callsTotal / smsTotal   : null,
    rateCallLt:       ltsTotal  && callsTotal ? ltsTotal  / callsTotal  : null,
    rateSmsCallMonth: callsMonth && smsMonth  ? callsMonth / smsMonth   : null,
    rateCallLtMonth:  ltsMonth  && callsMonth ? ltsMonth  / callsMonth  : null,
    monthLabel: new Date().toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
  };
}

async function computeMcaReps(D) {
  console.log('\n[mca_reps] Fetching all opps...');
  const allOpps = [];
  for (const pid of MCA_PIPELINES) {
    allOpps.push(...await fetchAllOpps(pid));
    await sleep(500);
  }

  const ids   = { camila: new Set(), maria: new Set(), sara: new Set() };
  const ltTot = { camila: 0, maria: 0, sara: 0 };
  const ltMon = { camila: 0, maria: 0, sara: 0 };

  for (const o of allOpps) {
    if (!o.contactId) continue;
    for (const [name, userId] of Object.entries(REPS)) {
      if (o.assignedTo !== userId) continue;
      ids[name].add(o.contactId);
      if (o.status === 'won') {
        const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
        if (t >= D.sinceMs)      ltTot[name]++;
        if (t >= D.monthStartMs) ltMon[name]++;
      }
    }
  }
  console.log('[mca_reps] LTs:', JSON.stringify(ltTot));

  await sleep(400);
  const names  = ['camila', 'maria', 'sara'];
  const arrays = names.map(n => [...ids[n]]);
  const [c0,c1,c2,cm0,cm1,cm2,s0,s1,s2] = await Promise.all([
    fetchCallsForContacts(arrays[0], D.sinceISO, D.nowISO),
    fetchCallsForContacts(arrays[1], D.sinceISO, D.nowISO),
    fetchCallsForContacts(arrays[2], D.sinceISO, D.nowISO),
    fetchCallsForContacts(arrays[0], D.monthStartISO, D.nowISO),
    fetchCallsForContacts(arrays[1], D.monthStartISO, D.nowISO),
    fetchCallsForContacts(arrays[2], D.monthStartISO, D.nowISO),
    fetchConvCount(REPS.camila),
    fetchConvCount(REPS.maria),
    fetchConvCount(REPS.sara),
  ]);

  const result = {};
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const lt = ltTot[n], ltM = ltMon[n];
    const c  = [c0,c1,c2][i], cM = [cm0,cm1,cm2][i];
    result[n] = {
      ltsTotal: lt, ltsMonth: ltM,
      callsTotal: c, callsMonth: cM,
      rateCallLt:      c  ? lt  / c  : null,
      rateCallLtMonth: cM ? ltM / cM : null,
    };
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const D = {
    sinceMs:      new Date(SINCE).getTime(),
    monthStartMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    monthStartStr:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`,
    todayStr:      now.toISOString().slice(0, 10),
    tomorrowStr:   new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().slice(0, 10),
    sinceISO:      new Date(SINCE).toISOString(),
    monthStartISO: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    nowISO:        now.toISOString(),
    todayStartISO: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
  };

  let exitCode = 0;

  // ── Globals ──
  try {
    const g    = await computeGlobals(D);
    const prev = await readCache('metrics_globals');
    if (!sanityOk(g.lts, prev?.value?.lts, 'globals.lts')) { exitCode = 1; }
    else await writeCache('metrics_globals', g);
  } catch (e) { console.error('[globals] ERROR:', e.message); exitCode = 1; }

  await sleep(800);

  // ── MCA ──
  try {
    const m    = await computeMca(D);
    const prev = await readCache('metrics_mca');
    if (!sanityOk(m.ltsTotal, prev?.value?.ltsTotal, 'mca.ltsTotal')) { exitCode = 1; }
    else await writeCache('metrics_mca', m);
  } catch (e) { console.error('[mca] ERROR:', e.message); exitCode = 1; }

  await sleep(800);

  // ── MCA Reps ──
  try {
    const r = await computeMcaReps(D);
    await writeCache('metrics_mca_reps', r);
  } catch (e) { console.error('[mca_reps] ERROR:', e.message); exitCode = 1; }

  console.log(`\n✓ sync_metrics completado (exit=${exitCode})`);
  process.exit(exitCode);
}

main();
