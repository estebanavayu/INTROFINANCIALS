const GHL_LOC = 'NXZFG9aQz6r1UXzZoedy';
const GHL_V2  = 'https://services.leadconnectorhq.com';
const SB_URL  = process.env.IF_SUPABASE_URL;
const SB_KEY  = process.env.IF_SUPABASE_KEY;

const SINCE = '2026-06-01T00:00:00.000Z';

function ghlHdrs() {
  return {
    'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
    'Version': '2021-07-28',
    'Accept': 'application/json',
  };
}

const sbHdrs = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates',
};

async function sbUpsertBatch(table, rows) {
  if (!rows.length) return;
  await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHdrs,
    body: JSON.stringify(rows),
  });
}

// Trae conversaciones paginadas con mensajes SMS desde SINCE
async function fetchConversations(startAfter = null) {
  let url = `${GHL_V2}/conversations/search?locationId=${GHL_LOC}&limit=100`;
  if (startAfter) url += `&startAfterId=${startAfter}`;
  const res = await fetch(url, { headers: ghlHdrs() });
  return res.json().catch(() => ({ conversations: [] }));
}

// Trae mensajes de una conversación
async function fetchMessages(conversationId) {
  const url = `${GHL_V2}/conversations/${conversationId}/messages?limit=100`;
  const res = await fetch(url, { headers: ghlHdrs() });
  const data = await res.json().catch(() => ({ messages: [] }));
  return data.messages || [];
}

// Trae contactos con DND=true actualizados desde SINCE (opt-outs históricos)
async function fetchDndContacts() {
  const contacts = [];
  let startAfterId = null;
  let pages = 0;

  while (pages < 50) {
    let url = `${GHL_V2}/contacts/?locationId=${GHL_LOC}&limit=100&sortBy=dateUpdated&sortOrder=desc`;
    if (startAfterId) url += `&startAfterId=${startAfterId}`;
    const res  = await fetch(url, { headers: ghlHdrs() });
    const data = await res.json().catch(() => ({ contacts: [] }));
    const batch = data.contacts || [];
    if (!batch.length) break;

    for (const c of batch) {
      const updated = new Date(c.dateUpdated || c.dateAdded || 0).getTime();
      if (updated < new Date(SINCE).getTime()) return contacts; // ya pasamos el rango
      if (c.dnd) contacts.push({ contact_id: c.id, ts: c.dateUpdated || c.dateAdded });
    }

    if (batch.length < 100) break;
    startAfterId = batch[batch.length - 1].id;
    pages++;
  }
  return contacts;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Seguridad mínima
  if (req.query?.key !== 'backfill2026') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const mode = req.query?.mode || 'both'; // 'optouts' | 'msgs' | 'both'
  const stats = { optouts: 0, msgs: 0, convs: 0, errors: 0 };

  try {
    // ── PARTE 1: Opt-outs históricos (DND desde junio 1) ────
    if (mode === 'optouts' || mode === 'both') {
      const dndContacts = await fetchDndContacts();
      if (dndContacts.length) {
        await sbUpsertBatch('optout_events', dndContacts);
        stats.optouts = dndContacts.length;
      }
    }

    // ── PARTE 2: Mensajes enviados históricos ────────────────
    if (mode === 'msgs' || mode === 'both') {
      let startAfterId = null;
      let pages = 0;
      const sinceMs = new Date(SINCE).getTime();

      while (pages < 200) {
        const data = await fetchConversations(startAfterId);
        const convs = data.conversations || [];
        if (!convs.length) break;

        for (const conv of convs) {
          // saltar conversaciones sin actividad SMS reciente
          const lastMsg = new Date(conv.lastMessageDate || 0).getTime();
          if (lastMsg < sinceMs) continue;

          stats.convs++;
          const messages = await fetchMessages(conv.id);
          const msgRows = [];

          for (const m of messages) {
            if (m.direction !== 'outbound') continue;
            if (m.messageType !== 'TYPE_SMS') continue;
            const ts = m.dateAdded || m.createdAt || '';
            if (ts && new Date(ts).getTime() < sinceMs) continue;

            msgRows.push({
              message_id: m.id,
              contact_id: conv.contactId,
              ts:         ts || new Date().toISOString(),
              status:     m.status || 'sent',
              error_code: m.errorCode || null,
            });
          }

          if (msgRows.length) {
            await sbUpsertBatch('msg_events', msgRows);
            stats.msgs += msgRows.length;
          }
        }

        if (convs.length < 100) break;
        startAfterId = convs[convs.length - 1].id;
        pages++;
      }
    }

    res.json({ ok: true, since: SINCE, stats });

  } catch (e) {
    res.status(500).json({ error: e.message, stats });
  }
}
