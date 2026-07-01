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
const MCA_PIPELINES     = PIPELINES_ALL.slice(0, 2); // RISE + NCN
const CENTURY_OPENING   = '8tbkIiJnJCnPZY6X0mA6';
const GENERAL_OPENING   = 'fxzuSpmyNzMH4yupNfk1';
const ALL_MCA_PIPELINES = [GENERAL_OPENING, ...MCA_PIPELINES]; // GENERAL + RISE + NCN

const REPS = {
  camila: 'KDgmtLyZD3R4OiahkpSH',
  maria:  '8KZhLfeBuu5SZKTAe2nT',
  sara:   'T7N31x5q1gUckaANYMoM',
};

// ── Helpers ──────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ghlFetch(url, retries = 10) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { headers: GHL_HDR });
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('Retry-After') ?? '10', 10);
      const wait = Math.max(retryAfter * 1000, 10000) * (1 + i * 0.5); // backoff creciente
      console.warn(`  429 rate limit (intento ${i+1}/${retries}), esperando ${Math.round(wait/1000)}s`);
      await sleep(wait);
      continue;
    }
    if (r.status >= 500) { await sleep(3000 * (i + 1)); continue; }
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

async function computeGlobals(D, wonOppsByPipeline) {
  const allWon  = PIPELINES_ALL.flatMap(pid => wonOppsByPipeline[pid] ?? []);
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
    D.monthStartStr === D.todayStr ? fetchSmsTotal(D.todayStr, D.tomorrowStr) : fetchSmsTotal(D.monthStartStr, D.todayStr),
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

async function computeMca(D, wonOppsByPipeline, allOppsByPipeline, meta) {
  const allWon  = MCA_PIPELINES.flatMap(pid => wonOppsByPipeline[pid] ?? []);
  const deduped = dedupByContact(allWon);
  let ltsTotal = 0, ltsMonth = 0;
  for (const o of deduped) {
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    if (t >= D.sinceMs)      ltsTotal++;
    if (t >= D.monthStartMs) ltsMonth++;
  }
  console.log(`[mca] LTs: ${ltsTotal} total, ${ltsMonth} mes`);

  // No-shows y leadsActive desde datos pre-fetched (sin GHL calls extra)
  const genOpps    = allOppsByPipeline[GENERAL_OPENING] ?? [];
  const noShows    = genOpps.filter(o => (meta.noShowStageIds ?? []).includes(o.pipelineStageId)).length;
  const leadsActive = genOpps.filter(o => o.status === 'open').length;
  console.log(`[mca] noShows=${noShows} leadsActive=${leadsActive}`);

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

// Pipelines MCA opening (sin CENTURY que es CC)
const MCA_OPENING_PIPELINES = [
  { id: GENERAL_OPENING,          name: 'GENERAL' },
  { id: '85kFh5EWKPg7qg9FDJfg',  name: 'RISE'    },
  { id: 'tzoH6Bv4qfC4Rug8yZvQ',  name: 'NCN'     },
];

// Descubre y cachea metadata (stage IDs, field IDs) en Supabase — TTL 24h
// Evita 2 GHL calls por run cuando el cache está fresco
async function discoverAndCacheMeta() {
  const cached = await readCache('metrics_meta');
  if (cached?.value && cached.updated_at) {
    const ageMs = Date.now() - new Date(cached.updated_at).getTime();
    const hasStages = (cached.value.noShowStageIds?.length ?? 0) > 0;
    if (ageMs < 24 * 60 * 60 * 1000 && hasStages) {
      console.log('  [meta] usando cache (age=' + Math.round(ageMs/3600000) + 'h)');
      return cached.value;
    }
    if (!hasStages) console.log('  [meta] cache sin noShowStageIds — redescubriendo');
  }

  const meta = { llamadaStageIds: {}, callNowFieldId: null, noShowStageIds: [] };

  try {
    const r = await ghlFetch(`${GHL_V2}/opportunities/pipelines?locationId=${GHL_LOC}`);
    const d = await r.json().catch(() => ({}));
    for (const { id, name } of MCA_OPENING_PIPELINES) {
      const pip = (d.pipelines ?? []).find(p => p.id === id);
      const st  = (pip?.stages ?? []).find(s => /llamada.?agendada/i.test(s.name));
      if (st) { meta.llamadaStageIds[id] = st.id; console.log(`  [meta] Llamada Agendada en ${name}: ${st.id}`); }
    }
    const genPip = (d.pipelines ?? []).find(p => p.id === GENERAL_OPENING);
    meta.noShowStageIds = (genPip?.stages ?? []).filter(s => /no.?show/i.test(s.name.replace(/\p{Emoji}/gu,''))).map(s => s.id);
    console.log(`  [meta] noShowStageIds: ${meta.noShowStageIds.join(', ') || 'ninguno'}`);
  } catch(e) { console.warn('  [meta] error pipelines:', e.message); }

  await sleep(400);

  try {
    const r  = await ghlFetch(`${GHL_V2}/custom-fields?locationId=${GHL_LOC}`);
    const d  = await r.json().catch(() => ({}));
    const cf = (d.customFields ?? []).find(f => /call.?now/i.test(f.name));
    if (cf) { meta.callNowFieldId = cf.id; console.log(`  [meta] CALL NOW field: ${cf.id}`); }
    else    { console.warn('  [meta] Campo CALL NOW no encontrado'); }
  } catch(e) { console.warn('  [meta] error custom-fields:', e.message); }

  await writeCache('metrics_meta', meta);
  return meta;
}

// Cuenta opps en "Llamada Agendada" desde datos pre-fetched (sin GHL calls)
function countRepStageFromData(repId, llamadaStageIds, allOppsByPipeline) {
  if (!llamadaStageIds || !Object.keys(llamadaStageIds).length) return null;
  let total = 0;
  for (const [pipId, stageId] of Object.entries(llamadaStageIds)) {
    total += (allOppsByPipeline[pipId] ?? []).filter(o => o.assignedTo === repId && o.pipelineStageId === stageId).length;
  }
  return total;
}

// Cuenta opps con "CALL NOW" set, desde datos pre-fetched (sin GHL calls)
function countRepCallNowFromData(repId, fieldId, generalOpps) {
  if (!fieldId) return null;
  return generalOpps
    .filter(o => o.assignedTo === repId && o.status === 'open')
    .filter(o => (o.customFields ?? []).some(f => f.id === fieldId && f.value != null && f.value !== '' && f.value !== false))
    .length;
}

async function computeMcaReps(D, allOppsByPipeline, meta) {
  const allOpps = MCA_PIPELINES.flatMap(pid => allOppsByPipeline[pid] ?? []);

  // Dedup won opps por contactId (mismo criterio que globals) — evita doble conteo
  // cuando el mismo contact está won en GENERAL y RISE
  const wonDeduped = dedupByContact(allOpps.filter(o => o.status === 'won'));

  const ids   = { camila: new Set(), maria: new Set(), sara: new Set() };
  const ltTot = { camila: 0, maria: 0, sara: 0 };
  const ltMon = { camila: 0, maria: 0, sara: 0 };

  // Usar deduped para LT counts, allOpps para contact IDs (para llamadas)
  for (const o of wonDeduped) {
    if (!o.contactId) continue;
    for (const [name, userId] of Object.entries(REPS)) {
      if (o.assignedTo !== userId) continue;
      const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
      if (t >= D.sinceMs)      { ltTot[name]++; ids[name].add(o.contactId); }
      if (t >= D.monthStartMs) ltMon[name]++;
    }
  }

  // Para contact IDs (llamadas): incluir también opps open del rep
  for (const o of allOpps) {
    if (!o.contactId) continue;
    for (const [name, userId] of Object.entries(REPS)) {
      if (o.assignedTo !== userId) continue;
      ids[name].add(o.contactId);
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

  // ── Call breakdown por rep (Scheduled + Call Now) desde datos pre-fetched ──
  const generalOpps = allOppsByPipeline[GENERAL_OPENING] ?? [];
  for (const n of names) {
    const userId = REPS[n];
    const scheduled = countRepStageFromData(userId, meta.llamadaStageIds, allOppsByPipeline);
    const callNow   = countRepCallNowFromData(userId, meta.callNowFieldId, generalOpps);
    result[n].scheduled = scheduled;
    result[n].callNow   = callNow;
    result[n].inbound   = null;
    result[n].coldCall  = null;
    console.log(`  [${n}] scheduled=${scheduled} callNow=${callNow}`);
  }

  return result;
}

// ── CC Reps (CENTURY OPENING) ────────────────────────────────

async function computeCcReps(D, wonOppsByPipeline, allCcOpps) {
  const allWon  = wonOppsByPipeline[CENTURY_OPENING] ?? [];
  const deduped = dedupByContact(allWon);

  const ids   = { camila: new Set(), maria: new Set(), sara: new Set(), unknown: new Set() };
  const ltTot = { camila: 0, maria: 0, sara: 0, unknown: 0 };
  const ltMon = { camila: 0, maria: 0, sara: 0, unknown: 0 };

  for (const o of deduped) {
    if (!o.contactId) continue;
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    if (t < D.sinceMs) continue;
    let matched = false;
    for (const [name, userId] of Object.entries(REPS)) {
      if (o.assignedTo !== userId) continue;
      ltTot[name]++;
      ids[name].add(o.contactId);
      if (t >= D.monthStartMs) ltMon[name]++;
      matched = true;
      break;
    }
    if (!matched) {
      ltTot.unknown++;
      ids.unknown.add(o.contactId);
      if (t >= D.monthStartMs) ltMon.unknown++;
    }
  }

  // Incluir opps abiertos de CC para acumular contactIds de llamadas
  for (const o of allCcOpps) {
    if (!o.contactId) continue;
    let matched = false;
    for (const [name, userId] of Object.entries(REPS)) {
      if (o.assignedTo !== userId) continue;
      ids[name].add(o.contactId); matched = true; break;
    }
    if (!matched) ids.unknown.add(o.contactId);
  }

  console.log('[cc_reps] LTs:', JSON.stringify(ltTot));

  await sleep(400);
  const names  = ['camila', 'maria', 'sara', 'unknown'];
  const arrays = names.map(n => [...ids[n]]);
  const [c0,c1,c2,c3,cm0,cm1,cm2,cm3] = await Promise.all([
    fetchCallsForContacts(arrays[0], D.sinceISO,      D.nowISO),
    fetchCallsForContacts(arrays[1], D.sinceISO,      D.nowISO),
    fetchCallsForContacts(arrays[2], D.sinceISO,      D.nowISO),
    fetchCallsForContacts(arrays[3], D.sinceISO,      D.nowISO),
    fetchCallsForContacts(arrays[0], D.monthStartISO, D.nowISO),
    fetchCallsForContacts(arrays[1], D.monthStartISO, D.nowISO),
    fetchCallsForContacts(arrays[2], D.monthStartISO, D.nowISO),
    fetchCallsForContacts(arrays[3], D.monthStartISO, D.nowISO),
  ]);

  const callsTot  = [c0,c1,c2,c3];
  const callsMon  = [cm0,cm1,cm2,cm3];
  const result = {};
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    result[n] = {
      ltsTotal: ltTot[n], ltsMonth: ltMon[n],
      callsTotal: callsTot[i], callsMonth: callsMon[i],
    };
  }

  const ccTotal = deduped.filter(o => new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= D.sinceMs).length;
  const ccMonth = deduped.filter(o => new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= D.monthStartMs).length;
  result._totals = { ltsTotal: ccTotal, ltsMonth: ccMonth };
  return result;
}

// ── Métricas mensuales (desde junio 2026) ────────────────────

async function computeMonthlyBreakdown(wonOppsByPipeline) {
  const DESDE  = '2026-06';
  const now    = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  // Generar lista de meses desde junio hasta el actual
  const months = [];
  let d = new Date('2026-06-01');
  while (true) {
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    months.push(key);
    if (key >= curKey) break;
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }

  // LTs por mes desde los won opps (todos los pipelines, deduplicados)
  const allWon  = PIPELINES_ALL.flatMap(pid => wonOppsByPipeline[pid] ?? []);
  const deduped = dedupByContact(allWon);
  const ltsByM  = {};
  for (const o of deduped) {
    const t   = new Date(o.lastStageChangeAt ?? o.createdAt);
    const key = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}`;
    if (key >= DESDE) ltsByM[key] = (ltsByM[key] ?? 0) + 1;
  }

  const result = {};
  for (const month of months) {
    const [yr, mo] = month.split('-').map(Number);
    const start     = new Date(yr, mo - 1, 1);
    const nextMonth = new Date(yr, mo, 1);
    const startStr  = `${yr}-${String(mo).padStart(2,'0')}-01`;
    const endStr    = nextMonth.toISOString().slice(0, 10);
    const startISO  = start.toISOString();
    const isCurrent = month === curKey;
    const endISO    = isCurrent ? now.toISOString() : nextMonth.toISOString();
    // Si hoy es el primer día del mes, start=end → GHL 400; usar mañana
    const smsEnd    = isCurrent
      ? (startStr === now.toISOString().slice(0, 10) ? endStr : now.toISOString().slice(0, 10))
      : endStr;

    const [sms, calls] = await Promise.all([
      fetchSmsTotal(startStr, smsEnd),
      fetchCallsSb(startISO, endISO),
    ]);

    result[month] = { lts: ltsByM[month] ?? 0, sms: sms ?? 0, calls: calls ?? 0 };
    console.log(`  [monthly] ${month}: lts=${result[month].lts} sms=${sms} calls=${calls}`);
    await sleep(500);
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

  // ── Metadata (stage IDs, field IDs) — cacheada 24h en Supabase ──
  // Solo hace 2 GHL calls si el cache está vencido (1x al día)
  console.log('\n[meta] Obteniendo metadata pipeline...');
  let meta = { llamadaStageIds: {}, callNowFieldId: null, noShowStageIds: [] };
  try { meta = await discoverAndCacheMeta(); } catch(e) { console.warn('[meta] ERROR (continúa con meta vacía):', e.message); }

  await sleep(500);

  // ── Fetch único de opps (compartido entre globals/mca/mca_reps) ──
  console.log('\n[fetch] Fetching won opps por pipeline (fetch único)...');
  const wonOppsByPipeline = {};
  try {
    for (const pid of PIPELINES_ALL) {
      wonOppsByPipeline[pid] = await fetchWonOpps(pid);
      await sleep(600);
    }
  } catch(e) {
    console.warn('\n[fetch] Rate limit persistente al inicio — token agotado, se omite este ciclo.');
    console.warn('  El cache de Supabase conserva los valores del último run exitoso.');
    process.exit(0); // salida graceful: GH Actions no marca como failure
  }

  console.log('\n[fetch] Fetching ALL opps (GENERAL+RISE+NCN) para stage/callnow/noshows...');
  const allOppsByPipeline = {};
  for (const pid of ALL_MCA_PIPELINES) {
    allOppsByPipeline[pid] = await fetchAllOpps(pid);
    await sleep(600);
  }

  console.log('\n[fetch] Fetching ALL opps CENTURY OPENING (CC)...');
  let allCcOpps = [];
  try {
    allCcOpps = await fetchAllOpps(CENTURY_OPENING);
    await sleep(600);
  } catch(e) { console.warn('[fetch] Error CENTURY all opps:', e.message); }

  // ── Globals ──
  try {
    const g    = await computeGlobals(D, wonOppsByPipeline);
    const prev = await readCache('metrics_globals');
    if (!sanityOk(g.lts, prev?.value?.lts, 'globals.lts')) { exitCode = 1; }
    else await writeCache('metrics_globals', g);
  } catch (e) { console.error('[globals] ERROR:', e.message); exitCode = 1; }

  await sleep(600);

  // ── MCA ──
  try {
    const m    = await computeMca(D, wonOppsByPipeline, allOppsByPipeline, meta);
    const prev = await readCache('metrics_mca');
    if (!sanityOk(m.ltsTotal, prev?.value?.ltsTotal, 'mca.ltsTotal')) { exitCode = 1; }
    else await writeCache('metrics_mca', m);
  } catch (e) { console.error('[mca] ERROR:', e.message); exitCode = 1; }

  await sleep(600);

  // ── MCA Reps ──
  try {
    const r = await computeMcaReps(D, allOppsByPipeline, meta);
    await writeCache('metrics_mca_reps', r);
  } catch (e) { console.error('[mca_reps] ERROR:', e.message); exitCode = 1; }

  await sleep(600);

  // ── CC Reps ──
  try {
    const cc = await computeCcReps(D, wonOppsByPipeline, allCcOpps);
    await writeCache('metrics_cc', cc);
  } catch (e) { console.error('[cc_reps] ERROR:', e.message); }

  await sleep(600);

  // ── Desglose mensual (desde jun 2026) ──
  try {
    const mb = await computeMonthlyBreakdown(wonOppsByPipeline);
    await writeCache('metrics_by_month', mb);
  } catch (e) { console.error('[monthly] ERROR:', e.message); }

  console.log(`\n✓ sync_metrics completado (exit=${exitCode})`);
  process.exit(exitCode);
}

main();
