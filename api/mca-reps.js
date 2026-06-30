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

// Trae TODOS los opps de un pipeline (sin filtro de status = incluye open+won+lost)
async function fetchAllOpps(pipelineId) {
  const all = [];
  let page = 1;
  while (true) {
    const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, limit: 100, page }).toString();
    const res = await fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: ghlHdrs() });
    const d   = await res.json().catch(() => ({}));
    const opps = d.opportunities ?? [];
    all.push(...opps);
    if (all.length >= (d.meta?.total ?? 0) || !opps.length) break;
    page++;
  }
  return all;
}

// Conteo de conversaciones GHL asignadas a un rep (proxy SMS = contactos asignados)
async function fetchConvCount(userId) {
  try {
    const qs  = new URLSearchParams({ locationId: GHL_LOC, assignedTo: userId, limit: 1 }).toString();
    const res = await fetchSafe(`${GHL_V2}/conversations/search?${qs}`, { headers: ghlHdrs() });
    const d   = await res.json().catch(() => ({}));
    return d.total ?? null;
  } catch { return null; }
}

// Cuenta call_records ≥30s en Supabase para un set de contactIds
async function fetchCallsForContacts(contactIds, startISO, endISO) {
  if (!SB_URL || !SB_KEY || !contactIds.length) return 0;
  const BATCH = 200;
  let total = 0;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const ids = contactIds.slice(i, i + BATCH);
    const qs  = new URLSearchParams({ select: 'id', status: 'eq.completed', duration: 'gte.30' });
    qs.append('date_added',  `gte.${startISO}`);
    qs.append('date_added',  `lte.${endISO}`);
    qs.append('contact_id',  `in.(${ids.join(',')})`);
    try {
      const r = await fetchSafe(`${SB_URL}/rest/v1/call_records?${qs}`, {
        headers: sbHdrs({ Prefer: 'count=exact', Range: '0-0' }),
      });
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
    const now           = new Date();
    const sinceMS       = new Date(SINCE).getTime();
    const monthStartMS  = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const sinceISO      = new Date(SINCE).toISOString();
    const monthStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const nowISO        = now.toISOString();

    // Traer todos los opps de ambos pipelines MCA (todos los statuses)
    const [riseOpps, ncnOpps] = await Promise.all([
      fetchAllOpps(MCA_PIPELINES[0]),
      fetchAllOpps(MCA_PIPELINES[1]),
    ]);

    const allOpps = [...riseOpps, ...ncnOpps];

    // Agrupar por rep
    const repData = {};
    for (const [name, userId] of Object.entries(REPS)) {
      const opps = allOpps.filter(o => o.assignedTo === userId);

      // LTs = won opps desde SINCE
      const ltsTotal = opps.filter(o =>
        o.status === 'won' && new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= sinceMS
      ).length;
      const ltsMonth = opps.filter(o =>
        o.status === 'won' && new Date(o.lastStageChangeAt ?? o.createdAt).getTime() >= monthStartMS
      ).length;

      // ContactIds únicos de todos los opps del rep
      const contactIds = [...new Set(opps.map(o => o.contactId).filter(Boolean))];

      repData[name] = { userId, ltsTotal, ltsMonth, contactIds };
    }

    // Llamadas + SMS en paralelo para los 3 reps
    const [camCalls, marCalls, sarCalls, camCallsM, marCallsM, sarCallsM,
           camSms, marSms, sarSms] = await Promise.all([
      fetchCallsForContacts(repData.camila.contactIds, sinceISO, nowISO),
      fetchCallsForContacts(repData.maria.contactIds,  sinceISO, nowISO),
      fetchCallsForContacts(repData.sara.contactIds,   sinceISO, nowISO),
      fetchCallsForContacts(repData.camila.contactIds, monthStartISO, nowISO),
      fetchCallsForContacts(repData.maria.contactIds,  monthStartISO, nowISO),
      fetchCallsForContacts(repData.sara.contactIds,   monthStartISO, nowISO),
      fetchConvCount(REPS.camila),
      fetchConvCount(REPS.maria),
      fetchConvCount(REPS.sara),
    ]);

    const calls  = { camila: camCalls, maria: marCalls, sara: sarCalls };
    const callsM = { camila: camCallsM, maria: marCallsM, sara: sarCallsM };
    const sms    = { camila: camSms,   maria: marSms,   sara: sarSms };

    const results = {};
    for (const name of ['camila', 'maria', 'sara']) {
      const { ltsTotal, ltsMonth } = repData[name];
      const c  = calls[name];
      const cm = callsM[name];
      const s  = sms[name];
      results[name] = {
        ltsTotal,
        ltsMonth,
        callsTotal: c,
        callsMonth: cm,
        smsTotal:   s,
        rateSmsCall:     s && c ? c / s : null,
        rateCallLt:      c     ? ltsTotal / c : null,
        rateCallLtMonth: cm    ? ltsMonth / cm : null,
      };
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
