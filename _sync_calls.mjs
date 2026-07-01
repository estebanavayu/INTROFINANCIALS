// Sync llamadas GHL → Supabase (call_records)
// Corre via GitHub Actions nightly
// Lee conversaciones con TYPE_CALL, extrae duración, guarda en Supabase

const GHL_LOC  = 'NXZFG9aQz6r1UXzZoedy';
const GHL_URL  = 'https://services.leadconnectorhq.com';
const GHL_TOKEN = process.env.GHL_TOKEN;

const SB_URL   = process.env.IF_SUPABASE_URL;
const SB_KEY   = process.env.IF_SUPABASE_KEY;

const GHL_HDR = {
  'Authorization': `Bearer ${GHL_TOKEN}`,
  'Version': '2021-07-28',
  'Accept': 'application/json',
};
const SB_HDR = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

async function getSyncCursor() {
  const r = await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.calls_last_sync&select=value`, { headers: SB_HDR });
  const d = await r.json();
  return d[0]?.value ?? '2026-02-01T00:00:00.000Z';
}

async function setSyncCursor(ts) {
  await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.calls_last_sync`, {
    method: 'PATCH',
    headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ value: ts, updated_at: new Date().toISOString() }),
  });
}

async function fetchConvMessages(convId) {
  try {
    const r = await fetchWithRetry(`${GHL_URL}/conversations/${convId}/messages`, { headers: GHL_HDR });
    const d = await r.json().catch(() => ({}));
    const msgs = Array.isArray(d.messages?.messages) ? d.messages.messages : [];
    return msgs.filter(m => m.messageType === 'TYPE_CALL' && m.meta?.call?.status === 'completed');
  } catch (e) {
    console.warn(`Error fetching conv ${convId}: ${e.message}`);
    return [];
  }
}

async function upsertCalls(records) {
  if (!records.length) return;
  const r = await fetchWithRetry(`${SB_URL}/rest/v1/call_records`, {
    method: 'POST',
    headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(records),
  });
  if (!r.ok) console.error(`Error upsert calls: ${r.status} ${await r.text()}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class RateLimitError extends Error { constructor() { super('RATE_LIMIT'); } }

async function fetchWithRetry(url, opts, retries = 6) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, opts).catch(e => { throw e; });
    if (r.status === 429) {
      if (i === retries - 1) throw new RateLimitError();
      const wait = Math.max(parseInt(r.headers.get('Retry-After') ?? '10', 10) * 1000, 12000) * (1 + i * 0.5);
      console.warn(`Rate limit (intento ${i+1}/${retries}), esperando ${Math.round(wait/1000)}s...`);
      await sleep(wait);
      continue;
    }
    if (r.status >= 500) {
      if (i === retries - 1) throw new Error(`HTTP ${r.status}`);
      await sleep(3000 * (i + 1));
      continue;
    }
    return r;
  }
  throw new RateLimitError();
}

async function main() {
  const cursor    = await getSyncCursor();
  const cursorMs  = new Date(cursor).getTime();
  const sinceMs   = cursorMs - 24 * 60 * 60 * 1000; // overlap 1 día para seguridad
  const nowISO    = new Date().toISOString();

  console.log(`Sync desde: ${new Date(sinceMs).toISOString()}`);

  let page = 1, processed = 0, inserted = 0, stopped = false;

  while (!stopped) {
    // Sin filtro lastMessageType: captura todas las convs con actividad reciente
    // (filtrar por TYPE_CALL dentro de fetchConvMessages)
    const url = `${GHL_URL}/conversations/search?locationId=${GHL_LOC}&limit=100&page=${page}`;
    const r   = await fetchWithRetry(url, { headers: GHL_HDR });
    const d   = await r.json().catch(() => ({}));
    const convs = d.conversations ?? [];

    if (!convs.length) break;

    // Filtrar por fecha — las conversaciones están ordenadas por lastMessageDate desc
    const relevant = convs.filter(c => c.lastMessageDate >= sinceMs);
    if (!relevant.length || convs.at(-1).lastMessageDate < sinceMs) stopped = true;

    // Leer mensajes en paralelo (lotes de 10 para respetar rate limit)
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
            contact_id:      conv.contactId ?? msg.contactId ?? null,
            duration:        msg.meta.call.duration ?? null,
            direction:       msg.direction ?? null,
            status:          msg.meta.call.status,
            date_added:      msg.dateAdded ?? null,
          });
        }
      });

      await upsertCalls(records);
      inserted += records.length;
      processed += batch.length;
      await sleep(200); // respetar rate limit GHL
    }

    console.log(`Página ${page} | procesadas: ${processed} | llamadas guardadas: ${inserted}`);
    page++;
    await sleep(500);
  }

  await setSyncCursor(nowISO);
  console.log(`Sync completo. Total procesadas: ${processed} | llamadas guardadas: ${inserted}`);
}

// ── Sync opt-outs (DND SMS enabled) ──────────────────────────────────────────

async function syncOptOuts() {
  console.log('Sync opt-outs DND...');
  let page = 1, total = 0;

  while (true) {
    const qs = new URLSearchParams({
      locationId: GHL_LOC,
      dndActive: 'SMS',
      limit: 100,
      page,
    });
    const r = await fetch(`${GHL_URL}/contacts/?${qs}`, { headers: GHL_HDR });
    const d = await r.json().catch(() => ({}));
    const contacts = d.contacts ?? [];
    if (!contacts.length) break;

    const records = contacts
      .filter(c => c.id && c.lastActivity)
      .map(c => ({ contact_id: c.id, ts: new Date(c.lastActivity).toISOString() }));

    if (records.length) {
      await fetch(`${SB_URL}/rest/v1/optout_events`, {
        method: 'POST',
        headers: { ...SB_HDR, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(records),
      });
      total += records.length;
    }

    if (contacts.length < 100) break;
    page++;
    await sleep(300);
  }

  console.log(`Opt-outs sincronizados: ${total}`);
}

main()
  .then(() => syncOptOuts())
  .catch(e => {
    if (e instanceof RateLimitError) {
      console.warn('Rate limit persistente — token agotado, se omite este ciclo. Cache previo preservado.');
      process.exit(0); // salida graceful — no marcar como failure en GH Actions
    }
    console.error(e);
    process.exit(1);
  });
