const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;

const SB_HDR = () => ({
  'apikey':        SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type':  'application/json',
  'Prefer':        'resolution=merge-duplicates',
});

async function upsert(table, row) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: SB_HDR(),
    body:    JSON.stringify(row),
  });
  return res.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  const { type, data } = req.body || {};
  if (!type || !data) return res.status(400).json({ error: 'bad payload' });

  // ── Opt-out: contacto hizo STOP ───────────────────────────
  if (type === 'ContactDndUpdate') {
    const smsOptOut = data.dndSettings?.SMS?.status === 'active';
    if (smsOptOut && data.id) {
      await upsert('optout_events', {
        contact_id: data.id,
        ts:         new Date().toISOString(),
      });
    }
    return res.status(200).json({ ok: true, event: 'dnd', recorded: smsOptOut });
  }

  // ── Mensaje outbound SMS: sent / delivered / failed ───────
  if (type === 'OutboundMessage' && data.messageType === 'TYPE_SMS') {
    await upsert('msg_events', {
      message_id: data.id,
      contact_id: data.contactId || null,
      ts:         data.dateAdded || new Date().toISOString(),
      status:     data.status   || 'sent',
      error_code: data.errorCode || null,
    });
    return res.status(200).json({ ok: true, event: 'msg', status: data.status });
  }

  return res.status(200).json({ ignored: type });
}
