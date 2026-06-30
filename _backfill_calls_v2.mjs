// Backfill completo de llamadas — sin filtro lastMessageType
// Pagina TODAS las conversaciones desde SINCE y busca TYPE_CALL dentro de cada una

const GHL_LOC  = 'NXZFG9aQz6r1UXzZoedy';
const GHL_URL  = 'https://services.leadconnectorhq.com';
const GHL_TOKEN = process.env.GHL_TOKEN_IF ?? process.env.GHL_TOKEN;
const SB_URL   = process.env.IF_SUPABASE_URL;
const SB_KEY   = process.env.IF_SUPABASE_KEY;

const SINCE_MS = new Date('2026-02-01').getTime();

const GHL_HDR = { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28', Accept: 'application/json' };
const SB_HDR  = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429) { await sleep(parseInt(r.headers.get('Retry-After') ?? '10') * 1000); continue; }
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function fetchConvMessages(convId) {
  try {
    const r = await fetchWithRetry(`${GHL_URL}/conversations/${convId}/messages`, { headers: GHL_HDR });
    const d = await r.json().catch(() => ({}));
    const msgs = Array.isArray(d.messages?.messages) ? d.messages.messages : [];
    return msgs.filter(m => m.messageType === 'TYPE_CALL' && m.meta?.call?.status === 'completed');
  } catch { return []; }
}

async function upsertCalls(records) {
  if (!records.length) return;
  const r = await fetchWithRetry(`${SB_URL}/rest/v1/call_records`, {
    method: 'POST',
    headers: { ...SB_HDR, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(records),
  });
  if (!r.ok) console.error(`Upsert error: ${r.status} ${await r.text()}`);
}

let page = 1, totalConvs = 0, totalCalls = 0, stopped = false;

while (!stopped) {
  const url = `${GHL_URL}/conversations/search?locationId=${GHL_LOC}&limit=100&page=${page}`;
  const r   = await fetchWithRetry(url, { headers: GHL_HDR });
  const d   = await r.json().catch(() => ({}));
  const convs = d.conversations ?? [];

  if (!convs.length) break;

  // Filtrar solo las que tienen actividad desde SINCE_MS
  const relevant = convs.filter(c => c.lastMessageDate >= SINCE_MS);
  if (!relevant.length || convs.at(-1).lastMessageDate < SINCE_MS) stopped = true;

  // Procesar en lotes de 10
  const BATCH = 10;
  for (let i = 0; i < relevant.length; i += BATCH) {
    const batch = relevant.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(c => fetchConvMessages(c.id)));
    const records = [];
    batch.forEach((conv, idx) => {
      for (const msg of results[idx]) {
        records.push({
          id:              msg.id,
          conversation_id: conv.id,
          contact_id:      conv.contactId ?? null,
          duration:        msg.meta?.call?.duration ?? null,
          direction:       msg.direction ?? null,
          status:          msg.meta?.call?.status,
          date_added:      msg.dateAdded ?? null,
        });
      }
    });
    await upsertCalls(records);
    totalCalls += records.length;
    await sleep(150);
  }

  totalConvs += relevant.length;
  if (page % 10 === 0) console.log(`Página ${page} | convs: ${totalConvs} | calls guardadas: ${totalCalls}`);
  page++;
  await sleep(300);
}

console.log(`Backfill completo. Convs procesadas: ${totalConvs} | Calls guardadas: ${totalCalls}`);
