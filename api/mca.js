const GHL_LOC  = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2   = 'https://services.leadconnectorhq.com';
const SINCE    = '2026-02-01';

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

const MCA_PIPELINES = [
  '85kFh5EWKPg7qg9FDJfg', // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ', // NCN OPENING
];

// Nombres exactos de los workflows MCA en GHL
const MCA_WORKFLOW_NAMES = new Set([
  'MARIA V2 - BULK FUP COLD BLAST',
  'CAMILA V2 - BULK FUP COLD BLAST',
  'PROVISORIO Y LA CTM - FIXED NUMBERS',
  'PROVISORIO test botón recuperar lead de sara',
  'PARTNER SEQUENCE - Defaults & Declined',
]);

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

async function fetchSafe(url, opts, timeoutMs = 10000) {
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

async function fetchAllOpps(pipelineId, params = {}) {
  const all = [];
  let page = 1;
  while (true) {
    try {
      const qs  = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, limit: 100, page, ...params }).toString();
      const res = await fetchSafe(`${GHL_V2}/opportunities/search?${qs}`, { headers: hdrs() });
      const d   = await res.json().catch(() => ({}));
      const opps = d.opportunities ?? [];
      all.push(...opps);
      if (all.length >= (d.meta?.total ?? 0) || opps.length === 0) break;
      page++;
    } catch (e) {
      console.error(`fetchAllOpps ${pipelineId} p${page}: ${e.message}`);
      break;
    }
  }
  return all;
}

// Dedup contactId por wonAt más reciente
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
    const res = await fetchSafe(url, { headers: hdrs() });
    const d   = await res.json().catch(() => ({}));
    return d.total ?? null;
  } catch { return null; }
}

async function fetchCallsFromSupabase(startISO, endISO) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const hdr  = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' };
    const base = `${SB_URL}/rest/v1/call_records`;
    const buildParams = (dir) => {
      const p = new URLSearchParams({ select: 'id', direction: `eq.${dir}`, status: 'eq.completed', duration: 'gte.30' });
      p.append('date_added', `gte.${startISO}`);
      p.append('date_added', `lte.${endISO}`);
      return p;
    };
    const [rOut, rIn] = await Promise.all([
      fetchSafe(`${base}?${buildParams('outbound')}`, { headers: hdr }),
      fetchSafe(`${base}?${buildParams('inbound')}`,  { headers: hdr }),
    ]);
    const parse = (r) => parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0');
    const total = parse(rOut) + parse(rIn);
    return isNaN(total) ? null : total;
  } catch { return null; }
}

// Cuenta contactos ACTIVE en los workflows MCA via POST /contacts/search
async function fetchLeadsEnSecuencia() {
  try {
    const res  = await fetchSafe(`${GHL_V2}/workflows/?locationId=${GHL_LOC}`, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const workflows = data.workflows ?? [];
    const mcaWfs = workflows.filter(w => MCA_WORKFLOW_NAMES.has(w.name));

    if (!mcaWfs.length) {
      console.error('fetchLeadsEnSecuencia: no se encontraron workflows MCA. Nombres disponibles:', workflows.map(w => w.name));
      return null;
    }

    let total = 0;
    for (const wf of mcaWfs) {
      let page = 1;
      while (true) {
        const body = {
          locationId: GHL_LOC,
          page,
          pageLimit: 100,
          filters: [{
            group: 'AND',
            filters: [
              { field: 'workflowId',     operator: 'workflow_is',        value: wf.id },
              { field: 'workflowStatus', operator: 'workflow_is_active', value: 'active' },
            ],
          }],
        };
        const r = await fetchSafe(`${GHL_V2}/contacts/search`, {
          method:  'POST',
          headers: { ...hdrs(), 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        console.log(`WF "${wf.name}" p${page}: status=${r.status} contacts=${(d.contacts ?? d.data ?? []).length} total=${d.total ?? d.meta?.total ?? '?'}`);
        const contacts = d.contacts ?? d.data ?? [];
        total += contacts.length;
        const totalExpected = d.total ?? d.meta?.total ?? 0;
        if (contacts.length < 100 || total >= totalExpected) break;
        page++;
      }
    }
    return total;
  } catch (e) {
    console.error('fetchLeadsEnSecuencia:', e.message);
    return null;
  }
}

// No Show vive en GENERAL OPENING (fxzuSpmyNzMH4yupNfk1)
const GENERAL_OPENING = 'fxzuSpmyNzMH4yupNfk1';

async function fetchNoShowCount() {
  try {
    const res  = await fetchSafe(`${GHL_V2}/opportunities/pipelines?locationId=${GHL_LOC}`, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const pipelines = data.pipelines ?? [];

    // Buscar stage "No Show" en GENERAL OPENING
    const noShowStageIds = [];
    for (const p of pipelines) {
      if (p.id !== GENERAL_OPENING) continue;
      for (const stage of p.stages ?? []) {
        if (/no[\s_-]?show/i.test(stage.name)) noShowStageIds.push(stage.id);
      }
    }

    if (!noShowStageIds.length) return null;

    let total = 0;
    for (const stageId of noShowStageIds) {
      const opps = await fetchAllOpps(GENERAL_OPENING, { pipeline_stage_id: stageId });
      total += opps.length;
    }
    return total;
  } catch (e) {
    console.error('fetchNoShowCount:', e.message);
    return null;
  }
}

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

    const safe = (p) => Promise.resolve(p).catch(() => null);

    // Fetch all in parallel (LTs + SMS + calls + no shows + leads en secuencia)
    const [wonRise, wonNcn, smsMonth, smsTotal, smsToday, callsTotal, callsMonth, noShows, leadsActive] = await Promise.all([
      safe(fetchAllOpps(MCA_PIPELINES[0], { status: 'won' })),
      safe(fetchAllOpps(MCA_PIPELINES[1], { status: 'won' })),
      safe(fetchSmsTotal(monthStartStr, todayStr)),
      safe(fetchSmsTotal(SINCE, todayStr)),
      safe(fetchSmsTotal(todayStr, tomorrowStr)),
      safe(fetchCallsFromSupabase(sinceISO, nowISO)),
      safe(fetchCallsFromSupabase(monthStartISO, nowISO)),
      safe(fetchNoShowCount()),
      safe(fetchLeadsEnSecuencia()),
    ]);

    // Dedup + filter by wonAt
    const wonMap = dedupByContact([...(wonRise ?? []), ...(wonNcn ?? [])]);
    let ltsTotal = 0, ltsMonth = 0;
    for (const o of wonMap.values()) {
      const wonAt = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
      if (wonAt >= sinceMs)      ltsTotal++;
      if (wonAt >= monthStartMs) ltsMonth++;
    }

    res.json({
      since: SINCE,
      // Leads en secuencia (activos en workflows MCA)
      leadsActive,
      // LTs
      ltsTotal, ltsMonth,
      // SMS (blasteados)
      smsTotal, smsMonth, smsToday,
      // Llamadas
      callsTotal, callsMonth,
      // No shows
      noShows,
      // Rates (total)
      rateSmsCall:  callsTotal && smsTotal  ? callsTotal  / smsTotal  : null,
      rateCallLt:   ltsTotal  && callsTotal ? ltsTotal    / callsTotal : null,
      // Rates (mes)
      rateSmsCallMonth: callsMonth && smsMonth ? callsMonth / smsMonth : null,
      rateCallLtMonth:  ltsMonth  && callsMonth ? ltsMonth  / callsMonth : null,
      monthLabel: now.toLocaleString('es-CL', { month: 'long', year: 'numeric' }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
