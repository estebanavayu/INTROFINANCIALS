const GHL_LOC  = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2   = 'https://services.leadconnectorhq.com';
const SINCE    = '2026-02-01';

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

const MCA_PIPELINES = [
  '85kFh5EWKPg7qg9FDJfg', // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ', // NCN OPENING
];

const REPS = {
  camila: 'KDgmtLyZD3R4OiahkpSH',
  maria:  '8KZhLfeBuu5SZKTAe2nT',
  sara:   'T7N31x5q1gUckaANYMoM',
};

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSafe(url, opts, timeoutMs = 12000, retries = 3) {
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

// Trae TODOS los opps (todos los statuses) de un pipeline
async function fetchAllOpps(pipelineId) {
  const all = [];
  let page  = 1;
  while (true) {
    const qs = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, limit: 100, page }).toString();
    let data;
    try {
      const res = await fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: ghlHdrs() });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      console.error(`fetchAllOpps ${pipelineId} p${page}: ${e.message}`);
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

// Fetch ambos pipelines MCA SECUENCIALMENTE
async function fetchAllMcaOpps() {
  const all = [];
  for (const pid of MCA_PIPELINES) {
    const opps = await safe(fetchAllOpps(pid)) ?? [];
    all.push(...opps);
    await sleep(400);
  }
  return all;
}

// Conteo de conversaciones GHL asignadas a un rep
async function fetchConvCount(userId) {
  try {
    const qs  = new URLSearchParams({ locationId: GHL_LOC, assignedTo: userId, limit: 1 }).toString();
    const res = await fetchSafe(`${GHL_V2}/conversations/search?${qs}`, { headers: ghlHdrs() });
    const d   = await res.json().catch(() => ({}));
    return d.total ?? null;
  } catch { return null; }
}

// Cuenta call_records ≥30s en Supabase para un set de contactIds — batch de 200
async function fetchCallsForContacts(contactIds, startISO, endISO) {
  if (!SB_URL || !SB_KEY || !contactIds.length) return 0;
  const BATCH = 200;
  let total   = 0;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const ids = contactIds.slice(i, i + BATCH);
    const qs  = new URLSearchParams({ select: 'id', status: 'eq.completed', duration: 'gte.30' });
    qs.append('date_added',  `gte.${startISO}`);
    qs.append('date_added',  `lte.${endISO}`);
    qs.append('contact_id',  `in.(${ids.join(',')})`);
    try {
      const r  = await fetchSafe(`${SB_URL}/rest/v1/call_records?${qs}`, {
        headers: sbHdrs({ Prefer: 'count=exact', Range: '0-0' }),
      });
      const n = parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0');
      if (!isNaN(n)) total += n;
    } catch { /* skip batch, sigue con el siguiente */ }
  }
  return total;
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now           = new Date();
    const sinceMS       = new Date(SINCE).getTime();
    const monthStartMS  = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const sinceISO      = new Date(SINCE).toISOString();
    const monthStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const nowISO        = now.toISOString();

    // SECUENCIAL: RISE → NCN
    const allOpps = await fetchAllMcaOpps();

    // Agrupar por rep
    const repContactIds = { camila: new Set(), maria: new Set(), sara: new Set() };
    const repLtsTotal   = { camila: 0, maria: 0, sara: 0 };
    const repLtsMonth   = { camila: 0, maria: 0, sara: 0 };

    for (const o of allOpps) {
      if (!o.contactId) continue;
      for (const [name, userId] of Object.entries(REPS)) {
        if (o.assignedTo !== userId) continue;
        repContactIds[name].add(o.contactId);
        if (o.status === 'won') {
          const wonAt = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
          if (wonAt >= sinceMS)     repLtsTotal[name]++;
          if (wonAt >= monthStartMS) repLtsMonth[name]++;
        }
      }
    }

    // Llamadas + convs en paralelo para los 3 reps (Supabase no tiene rate limit GHL)
    const repNames = ['camila', 'maria', 'sara'];
    const contactArrays = repNames.map(n => [...repContactIds[n]]);

    const [c0, c1, c2, cm0, cm1, cm2, s0, s1, s2] = await Promise.all([
      safe(fetchCallsForContacts(contactArrays[0], sinceISO, nowISO)),
      safe(fetchCallsForContacts(contactArrays[1], sinceISO, nowISO)),
      safe(fetchCallsForContacts(contactArrays[2], sinceISO, nowISO)),
      safe(fetchCallsForContacts(contactArrays[0], monthStartISO, nowISO)),
      safe(fetchCallsForContacts(contactArrays[1], monthStartISO, nowISO)),
      safe(fetchCallsForContacts(contactArrays[2], monthStartISO, nowISO)),
      safe(fetchConvCount(REPS.camila)),
      safe(fetchConvCount(REPS.maria)),
      safe(fetchConvCount(REPS.sara)),
    ]);

    const callsTotal  = [c0 ?? 0, c1 ?? 0, c2 ?? 0];
    const callsMonth  = [cm0 ?? 0, cm1 ?? 0, cm2 ?? 0];
    const smsTotal    = [s0, s1, s2];

    const results = {};
    for (let i = 0; i < repNames.length; i++) {
      const name = repNames[i];
      const lt   = repLtsTotal[name];
      const ltM  = repLtsMonth[name];
      const c    = callsTotal[i];
      const cM   = callsMonth[i];
      const s    = smsTotal[i];
      results[name] = {
        ltsTotal:        lt,
        ltsMonth:        ltM,
        callsTotal:      c,
        callsMonth:      cM,
        smsTotal:        s,
        rateSmsCall:     s && c ? c / s : null,
        rateCallLt:      c     ? lt  / c  : null,
        rateCallLtMonth: cM    ? ltM / cM : null,
      };
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
