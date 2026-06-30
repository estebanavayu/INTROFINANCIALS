const GHL_LOC  = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2   = 'https://services.leadconnectorhq.com';
const SINCE    = '2026-02-01';

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

const MCA_PIPELINES = [
  '85kFh5EWKPg7qg9FDJfg', // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ', // NCN OPENING
];
const GENERAL_OPENING = 'fxzuSpmyNzMH4yupNfk1';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSafe(url, opts, timeoutMs = 10000, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (r.status === 429) {
        const wait = parseInt(r.headers.get('Retry-After') ?? '8') * 1000;
        await sleep(wait || 8000);
        continue;
      }
      if (r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      return r;
    } catch (e) {
      if (e.name === 'AbortError' && i === retries - 1) throw new Error(`Timeout: ${url}`);
      if (i < retries - 1) await sleep(1500 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetchSafe agotó reintentos: ${url}`);
}

const safe = (p) => Promise.resolve(p).catch(() => null);

function ghlHdrs() {
  return {
    Authorization: `Bearer ${process.env.GHL_TOKEN}`,
    Version:       '2021-07-28',
    Accept:        'application/json',
  };
}

function sbHdrs(extra = {}) {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}

// Trae won opps de un pipeline, paginando con pausa entre páginas
async function fetchWonOpps(pipelineId) {
  const all = [];
  let page  = 1;
  while (true) {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, status: 'won', limit: 100, page }).toString();
    let data;
    try {
      const res = await fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: ghlHdrs() });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      console.error(`fetchWonOpps ${pipelineId} p${page}: ${e.message}`);
      break;
    }
    const opps = data.opportunities ?? [];
    all.push(...opps);
    if (all.length >= (data.meta?.total ?? 0) || !opps.length) break;
    page++;
    await sleep(250);
  }
  return all;
}

// Fetch RISE + NCN SECUENCIALMENTE para no saturar GHL
async function fetchMcaWonOpps() {
  const all = [];
  for (const pid of MCA_PIPELINES) {
    const opps = await safe(fetchWonOpps(pid)) ?? [];
    all.push(...opps);
    await sleep(400);
  }
  return all;
}

// Dedup contactId → opp con wonAt más reciente
function dedupByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    if (!o.contactId) continue;
    const prev = map.get(o.contactId);
    if (!prev || (o.lastStageChangeAt ?? '') > (prev.lastStageChangeAt ?? '')) map.set(o.contactId, o);
  }
  return map;
}

async function fetchSmsTotal(startDate, endDate) {
  try {
    const url = `${GHL_V2}/conversations/messages/export?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}&limit=10`;
    const res = await fetchSafe(url, { headers: ghlHdrs() });
    const d   = await res.json().catch(() => ({}));
    return d.total ?? null;
  } catch { return null; }
}

async function fetchCallsFromSupabase(startISO, endISO) {
  if (!SB_URL || !SB_KEY) return null;
  const hdr  = sbHdrs({ Prefer: 'count=exact', Range: '0-0' });
  const base = `${SB_URL}/rest/v1/call_records`;
  const buildParams = (dir) => {
    const p = new URLSearchParams({ select: 'id', direction: `eq.${dir}`, status: 'eq.completed', duration: 'gte.30' });
    p.append('date_added', `gte.${startISO}`);
    p.append('date_added', `lte.${endISO}`);
    return p;
  };
  try {
    const [rOut, rIn] = await Promise.all([
      fetchSafe(`${base}?${buildParams('outbound')}`, { headers: hdr }),
      fetchSafe(`${base}?${buildParams('inbound')}`,  { headers: hdr }),
    ]);
    const parse = (r) => parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0');
    const total = parse(rOut) + parse(rIn);
    return isNaN(total) ? null : total;
  } catch { return null; }
}

// Leads en secuencia = opps open en GENERAL OPENING
async function fetchLeadsEnSecuencia() {
  try {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: GENERAL_OPENING, status: 'open', limit: 1 });
    const res = await fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: ghlHdrs() });
    const d   = await res.json().catch(() => ({}));
    return d.meta?.total ?? null;
  } catch { return null; }
}

// No Show stage en GENERAL OPENING
async function fetchNoShowCount() {
  try {
    const res      = await fetchSafe(`${GHL_V2}/opportunities/pipelines?locationId=${GHL_LOC}`, { headers: ghlHdrs() });
    const data     = await res.json().catch(() => ({}));
    const pipeline = (data.pipelines ?? []).find(p => p.id === GENERAL_OPENING);
    const stageIds = (pipeline?.stages ?? [])
      .filter(s => /no[\s_-]?show/i.test(s.name))
      .map(s => s.id);

    if (!stageIds.length) return null;

    let total = 0;
    for (const stageId of stageIds) {
      const opps = await safe(fetchWonOpps(GENERAL_OPENING)) ?? []; // reutiliza paginador
      // Filtrar por stage directamente
      const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: GENERAL_OPENING, pipeline_stage_id: stageId, limit: 1 });
      const r   = await safe(fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: ghlHdrs() }));
      const d   = await r?.json().catch(() => ({})) ?? {};
      total += d.meta?.total ?? 0;
      await sleep(300);
    }
    return total;
  } catch { return null; }
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now           = new Date();
    const monthStartMs  = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const sinceMs       = new Date(SINCE).getTime();
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const todayStr      = now.toISOString().slice(0, 10);
    const tomorrowStr   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().slice(0, 10);
    const sinceISO      = new Date(SINCE).toISOString();
    const monthStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const nowISO        = now.toISOString();

    // GHL opps: SECUENCIALES
    const allWonOpps = await fetchMcaWonOpps();

    // Resto en paralelo (no compiten por rate limit GHL de opps)
    const [smsMonth, smsTotal, smsToday, callsTotal, callsMonth, noShows, leadsActive] = await Promise.all([
      safe(fetchSmsTotal(monthStartStr, todayStr)),
      safe(fetchSmsTotal(SINCE, todayStr)),
      safe(fetchSmsTotal(todayStr, tomorrowStr)),
      safe(fetchCallsFromSupabase(sinceISO, nowISO)),
      safe(fetchCallsFromSupabase(monthStartISO, nowISO)),
      safe(fetchNoShowCount()),
      safe(fetchLeadsEnSecuencia()),
    ]);

    // Dedup + conteo
    const wonMap = dedupByContact(allWonOpps);
    let ltsTotal = 0, ltsMonth = 0;
    for (const o of wonMap.values()) {
      const wonAt = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
      if (wonAt >= sinceMs)      ltsTotal++;
      if (wonAt >= monthStartMs) ltsMonth++;
    }

    res.json({
      since: SINCE,
      leadsActive,
      ltsTotal, ltsMonth,
      smsTotal, smsMonth, smsToday,
      callsTotal, callsMonth,
      noShows,
      rateSmsCall:      callsTotal && smsTotal  ? callsTotal  / smsTotal  : null,
      rateCallLt:       ltsTotal  && callsTotal ? ltsTotal    / callsTotal : null,
      rateSmsCallMonth: callsMonth && smsMonth  ? callsMonth  / smsMonth  : null,
      rateCallLtMonth:  ltsMonth  && callsMonth ? ltsMonth    / callsMonth : null,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
