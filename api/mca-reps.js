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

function hdrs() {
  return {
    Authorization: `Bearer ${process.env.GHL_TOKEN}`,
    Version:       '2021-07-28',
    Accept:        'application/json',
  };
}

async function fetchSafe(url, opts, timeoutMs = 12000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllOpps(pipelineId, extraParams = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, status: 'won', limit: 100, page, ...extraParams }).toString();
    const res = await fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: hdrs() });
    const d   = await res.json().catch(() => ({}));
    const opps = d.opportunities ?? [];
    all.push(...opps);
    if (all.length >= (d.meta?.total ?? 0) || !opps.length) break;
    page++;
  }
  return all;
}

// Dedup por contactId, queda el opp con wonAt más reciente
function dedupByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    if (!o.contactId) continue;
    const prev = map.get(o.contactId);
    if (!prev || (o.lastStageChangeAt ?? '') > (prev.lastStageChangeAt ?? '')) map.set(o.contactId, o);
  }
  return [...map.values()];
}

// Cuenta call_records ≥30s para un conjunto de contactIds desde Supabase
// PostgREST IN filter: contact_id=in.(id1,id2,...)
async function fetchCallsForContacts(contactIds, startISO, endISO) {
  if (!SB_URL || !SB_KEY || !contactIds.length) return 0;
  const sbHdr = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' };

  // Batch en grupos de 200 para no exceder URL limit
  const BATCH = 200;
  let total = 0;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const ids  = contactIds.slice(i, i + BATCH);
    const inFilter = `in.(${ids.join(',')})`;
    const qs = new URLSearchParams({
      select:    'id',
      status:    'eq.completed',
      duration:  'gte.30',
      date_added: `gte.${startISO}`,
    });
    qs.append('date_added', `lte.${endISO}`);
    qs.append('contact_id', inFilter);
    try {
      const r = await fetchSafe(`${SB_URL}/rest/v1/call_records?${qs}`, { headers: sbHdr });
      const cr = r.headers.get('content-range');
      const n  = parseInt(cr?.split('/')[1] ?? '0');
      if (!isNaN(n)) total += n;
    } catch { /* skip batch */ }
  }
  return total;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now          = new Date();
    const monthStartMS = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const sinceMS      = new Date(SINCE).getTime();
    const sinceISO     = new Date(SINCE).toISOString();
    const monthStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const nowISO       = now.toISOString();

    // Fetch all won opps from both MCA pipelines
    const [riseOpps, ncnOpps] = await Promise.all([
      fetchAllOpps(MCA_PIPELINES[0]),
      fetchAllOpps(MCA_PIPELINES[1]),
    ]);

    const allOpps = dedupByContact([...riseOpps, ...ncnOpps])
      .filter(o => new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= sinceMS);

    // Agrupar por rep
    const repOpps = { camila: [], maria: [], sara: [] };
    for (const o of allOpps) {
      for (const [name, userId] of Object.entries(REPS)) {
        if (o.assignedTo === userId) repOpps[name].push(o);
      }
    }

    // Para cada rep: calcular LTs + contactIds → calls desde Supabase
    const results = {};
    await Promise.all(Object.entries(repOpps).map(async ([name, opps]) => {
      const ltsTotal = opps.length;
      const ltsMonth = opps.filter(o => new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= monthStartMS).length;

      const contactIds = [...new Set(opps.map(o => o.contactId).filter(Boolean))];

      const [callsTotal, callsMonth] = await Promise.all([
        fetchCallsForContacts(contactIds, sinceISO, nowISO),
        fetchCallsForContacts(contactIds, monthStartISO, nowISO),
      ]);

      results[name] = {
        ltsTotal,
        ltsMonth,
        callsTotal,
        callsMonth,
        rateCallLt:      callsTotal ? ltsTotal  / callsTotal  : null,
        rateCallLtMonth: callsMonth ? ltsMonth  / callsMonth  : null,
      };
    }));

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
