const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SINCE   = '2026-02-01';

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

// Pipelines MCA + CC
const PIPELINES_WON = [
  '85kFh5EWKPg7qg9FDJfg', // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ', // NCN OPENING
  '8tbkIiJnJCnPZY6X0mA6', // CENTURY OPENING (CC)
];

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSafe(url, opts, timeoutMs = 8000, retries = 3) {
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

// Trae TODOS los won opps de un pipeline — secuencial con pausa entre páginas
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
    await sleep(250); // pausa entre páginas para no saturar GHL
  }
  return all;
}

// Fetch won opps de todos los pipelines SECUENCIALMENTE (evita rate limit paralelo)
async function fetchAllWonOpps() {
  const result = [];
  for (const pid of PIPELINES_WON) {
    const opps = await safe(fetchWonOpps(pid)) ?? [];
    result.push(...opps);
    await sleep(400); // pausa entre pipelines
  }
  return result;
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

async function fetchOptOut(startISO, endISO) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const params = new URLSearchParams({ select: 'contact_id' });
    params.append('ts', `gte.${startISO}`);
    params.append('ts', `lte.${endISO}`);
    const r = await fetchSafe(
      `${SB_URL}/rest/v1/optout_events?${params}`,
      { headers: sbHdrs({ Prefer: 'count=exact', Range: '0-0' }) }
    );
    const total = parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0');
    return isNaN(total) ? null : total;
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
    const todayStartISO = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // GHL pipelines: SECUENCIALES para evitar rate limit
    const allWonOpps = await fetchAllWonOpps();

    // Supabase + SMS en paralelo (no afectan rate limit GHL)
    const [smsMonth, smsTotal, smsToday, callsTotal, callsMonth, optoutMonth, optoutToday] = await Promise.all([
      safe(fetchSmsTotal(monthStartStr, todayStr)),
      safe(fetchSmsTotal(SINCE, todayStr)),
      safe(fetchSmsTotal(todayStr, tomorrowStr)),
      safe(fetchCallsFromSupabase(sinceISO, nowISO)),
      safe(fetchCallsFromSupabase(monthStartISO, nowISO)),
      safe(fetchOptOut(monthStartISO, nowISO)),
      safe(fetchOptOut(todayStartISO, nowISO)),
    ]);

    // Dedup + conteo LTs
    const wonMap = dedupByContact(allWonOpps);
    let ltsTotal = 0, ltsMonth = 0;
    for (const o of wonMap.values()) {
      const wonAt = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
      if (wonAt >= sinceMs)      ltsTotal++;
      if (wonAt >= monthStartMs) ltsMonth++;
    }

    const optoutRateMonth = smsMonth && optoutMonth ? optoutMonth / smsMonth : null;
    const optoutRateToday = smsToday && optoutToday ? optoutToday / smsToday : null;

    res.json({
      since: SINCE,
      lts: ltsTotal, ltsMonth,
      calls: callsTotal, callsMonth,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
      smsMonth, smsTotal, smsToday,
      optoutMonth, optoutToday,
      optoutRateMonth, optoutRateToday,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
