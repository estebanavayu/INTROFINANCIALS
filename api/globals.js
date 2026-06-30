const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SINCE   = '2026-02-01';

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

async function fetchFromSupabase(table, tsField, startISO, endISO) {
  if (!SB_URL || !SB_KEY) return null;
  const params = new URLSearchParams({ select: 'contact_id' });
  params.append(tsField, `gte.${startISO}`);
  params.append(tsField, `lte.${endISO}`);
  const r = await fetch(
    `${SB_URL}/rest/v1/${table}?${params}`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' } }
  );
  const total = parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0');
  return isNaN(total) ? null : total;
}

async function fetchCallsFromSupabase(startISO, endISO) {
  if (!SB_URL || !SB_KEY) return null;
  // Contar outbound + inbound con status=completed y duration>=30
  // Se hace en dos queries porque PostgREST no soporta OR en filtros directamente
  const hdr = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' };
  const base = `${SB_URL}/rest/v1/call_records`;

  const buildParams = (dir) => {
    const p = new URLSearchParams({ select: 'id', direction: `eq.${dir}`, status: 'eq.completed', duration: 'gte.30' });
    p.append('date_added', `gte.${startISO}`);
    p.append('date_added', `lte.${endISO}`);
    return p;
  };

  const [rOut, rIn] = await Promise.all([
    fetch(`${base}?${buildParams('outbound')}`, { headers: hdr }),
    fetch(`${base}?${buildParams('inbound')}`,  { headers: hdr }),
  ]);

  const parse = (r) => parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0');
  const total = parse(rOut) + parse(rIn);
  return isNaN(total) ? null : total;
}

const PIPELINES = [
  { id: '85kFh5EWKPg7qg9FDJfg' }, // RISE OPENING
  { id: 'tzoH6Bv4qfC4Rug8yZvQ' }, // NCN OPENING
  { id: '8tbkIiJnJCnPZY6X0mA6' }, // CENTURY OPENING (CC)
];

function hdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version':       '2021-07-28',
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };
}

async function fetchAllOpps(pipelineId, params = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({ location_id: GHL_LOC, pipeline_id: pipelineId, limit: 100, page, ...params }).toString();
    const res  = await fetch(`${GHL_V2}/opportunities/search?${qs}`, { headers: hdrs() });
    const data = await res.json().catch(() => ({}));
    const opps = data.opportunities ?? [];
    all.push(...opps);
    if (all.length >= (data.meta?.total ?? 0) || opps.length === 0) break;
    page++;
  }
  return all;
}


async function fetchSmsTotal(startDate, endDate) {
  const url = `${GHL_V2}/conversations/messages/export?locationId=${GHL_LOC}&startDate=${startDate}&endDate=${endDate}&limit=10`;
  const res  = await fetch(url, { headers: hdrs() });
  const data = await res.json().catch(() => ({}));
  return data.total ?? null;
}

// Dedup contactIds de una lista de opps, devuelve Map<contactId, opp>
function dedupByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    if (!o.contactId) continue;
    const prev = map.get(o.contactId);
    if (!prev || (o.lastStageChangeAt ?? '') > (prev.lastStageChangeAt ?? '')) map.set(o.contactId, o);
  }
  return map;
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

    const sinceISO      = new Date(SINCE).toISOString();
    const monthStartISO = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const nowISO        = now.toISOString();

    const todayStartISO = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // Todo en paralelo — GHL + Supabase
    const [wonRise, wonNcn, wonCentury, smsMonth, smsTotal, smsToday, callsTotal, callsMonth, optoutMonth, optoutToday] = await Promise.all([
      fetchAllOpps(PIPELINES[0].id, { status: 'won' }),
      fetchAllOpps(PIPELINES[1].id, { status: 'won' }),
      fetchAllOpps(PIPELINES[2].id, { status: 'won' }),
      fetchSmsTotal(monthStartStr, todayStr),
      fetchSmsTotal(SINCE, todayStr),
      fetchSmsTotal(todayStr, todayStr),
      fetchCallsFromSupabase(sinceISO, nowISO),
      fetchCallsFromSupabase(monthStartISO, nowISO),
      fetchFromSupabase('optout_events', 'ts', monthStartISO, nowISO),
      fetchFromSupabase('optout_events', 'ts', todayStartISO, nowISO),
    ]);

    // Dedup contactIds por wonAt más reciente
    const wonMap = dedupByContact([...wonRise, ...wonNcn, ...wonCentury]);

    // Contar LTs por lastStageChangeAt (wonAt)
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
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
