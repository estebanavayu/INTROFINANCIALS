// Devuelve LTs agrupados por mes (YYYY-MM → count)
// Prioridad: cache Supabase → GHL en vivo (fallback)

const SB_URL    = process.env.IF_SUPABASE_URL;
const SB_KEY    = process.env.IF_SUPABASE_KEY;
const GHL_TOKEN = process.env.GHL_TOKEN_IF ?? process.env.GHL_TOKEN;
const GHL_V2    = 'https://services.leadconnectorhq.com';
const GHL_LOC   = 'NXZFG9aQz6r1UXzZoedy';
const SINCE     = '2026-02-01';

const PIPELINES = [
  '85kFh5EWKPg7qg9FDJfg', // RISE OPENING
  'tzoH6Bv4qfC4Rug8yZvQ', // NCN OPENING
  '8tbkIiJnJCnPZY6X0mA6', // CENTURY OPENING
];

const GHL_HDR = {
  Authorization: `Bearer ${GHL_TOKEN}`,
  Version: '2021-07-28',
  Accept: 'application/json',
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ghlFetch(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { headers: GHL_HDR });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('Retry-After') ?? '5', 10) * 1000;
      await sleep(Math.max(wait, 2000) * (i + 1));
      continue;
    }
    if (!r.ok) { await sleep(1000 * (i + 1)); continue; }
    return r;
  }
  return null;
}

async function fetchWonOpps(pipelineId) {
  const opps = [];
  let page = 1;
  while (true) {
    const url = `${GHL_V2}/opportunities/search?location_id=${GHL_LOC}&pipeline_id=${pipelineId}&status=won&limit=100&page=${page}`;
    const r = await ghlFetch(url);
    if (!r) break;
    const d = await r.json().catch(() => ({}));
    const list = d.opportunities ?? [];
    opps.push(...list);
    if (list.length < 100) break;
    page++;
    await sleep(250);
  }
  return opps;
}

function dedupByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    const key = o.contactId ?? o.contact?.id;
    if (!key) continue;
    const prev = map.get(key);
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    const pt = prev ? new Date(prev.lastStageChangeAt ?? prev.createdAt).getTime() : 0;
    if (!prev || t > pt) map.set(key, o);
  }
  return [...map.values()];
}

async function computeLive() {
  const allWon = [];
  for (const pid of PIPELINES) {
    allWon.push(...await fetchWonOpps(pid));
    await sleep(400);
  }
  const sinceMs  = new Date(SINCE).getTime();
  const deduped  = dedupByContact(allWon);
  const byMonth  = {};
  for (const o of deduped) {
    const t = new Date(o.lastStageChangeAt ?? o.createdAt).getTime();
    if (t < sinceMs) continue;
    const d   = new Date(o.lastStageChangeAt ?? o.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    byMonth[key] = (byMonth[key] ?? 0) + 1;
  }
  return byMonth;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. Intentar caché
  if (SB_URL && SB_KEY) {
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/sync_state?key=eq.metrics_globals&select=value,updated_at`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      const rows = await r.json();
      if (rows[0]?.value) {
        const cached = JSON.parse(rows[0].value);
        if (cached.ltsByMonth) {
          return res.json({ ltsByMonth: cached.ltsByMonth, source: 'cache', updated_at: rows[0].updated_at });
        }
      }
    } catch {}
  }

  // 2. Fallback: GHL en vivo
  if (!GHL_TOKEN) return res.status(503).json({ error: 'GHL_TOKEN no configurado' });
  try {
    const ltsByMonth = await computeLive();
    return res.json({ ltsByMonth, source: 'live' });
  } catch (e) {
    return res.status(500).json({ error: 'Error al obtener datos de GHL', detail: e.message });
  }
}
