// Import CSV DND contacts → optout_events
// Solo por esta vez. El sync nocturno (_sync_calls.mjs) se encarga de mantenerlo actualizado.

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const SB_URL = process.env.IF_SUPABASE_URL || 'https://xunmapjtqudsmhikpklx.supabase.co';
const SB_KEY = process.env.IF_SUPABASE_KEY;
if (!SB_KEY) { console.error('IF_SUPABASE_KEY no definida'); process.exit(1); }

const SB_HDR = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

const CSV = 'C:/Users/Esteban Avayu/Downloads/Export_Contacts_undefined_Jun_2026_12_47_PM.csv';

async function readCSV(filepath) {
  return new Promise((resolve) => {
    const rows = []; let headers = null;
    const rl = createInterface({ input: createReadStream(filepath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      // CSV con comillas
      const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g)?.map(c => c.replace(/^"|"$/g, '').trim()) ?? [];
      if (!headers) { headers = cols; return; }
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
      rows.push(obj);
    });
    rl.on('close', () => resolve(rows));
  });
}

async function upsertBatch(records) {
  const r = await fetch(`${SB_URL}/rest/v1/optout_events`, {
    method: 'POST',
    headers: { ...SB_HDR, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(records),
  });
  if (!r.ok) console.error('Error:', r.status, await r.text());
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('Leyendo CSV...');
  const rows = await readCSV(CSV);
  console.log(`${rows.length} contactos`);

  const records = [];
  let skipped = 0;

  for (const row of rows) {
    const contactId = row['Contact Id'];
    const lastActivity = row['Last Activity'];
    if (!contactId || !lastActivity) { skipped++; continue; }

    let ts;
    try { ts = new Date(lastActivity).toISOString(); }
    catch { skipped++; continue; }

    records.push({ contact_id: contactId, ts });
  }

  console.log(`Insertando ${records.length} opt-outs (${skipped} omitidos)...`);

  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    await upsertBatch(batch);
    process.stdout.write(`  batch ${Math.ceil((i+1)/500)}/${Math.ceil(records.length/500)}\r`);
    await sleep(200);
  }

  console.log('\nDone.');
}

main().catch(console.error);
