// Import CSV calls → Supabase call_records
// IDs prefijados con "csv_" para identificarlos y borrarlos una vez que el sync GHL complete.
// Normaliza: Answered→completed, Outgoing→outbound, Incoming→inbound

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const SB_URL = process.env.IF_SUPABASE_URL || 'https://xunmapjtqudsmhikpklx.supabase.co';
const SB_KEY = process.env.IF_SUPABASE_KEY;

if (!SB_KEY) { console.error('IF_SUPABASE_KEY no definida'); process.exit(1); }

const SB_HDR = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

const DOWNLOADS = 'C:/Users/Esteban Avayu/Downloads';
const FILES = [
  { path: `${DOWNLOADS}/Outgoing Calls by Status-2026-06-30_12-00-01.csv`, tag: 'out_aprmay' },
  { path: `${DOWNLOADS}/Outbound Calls María-2026-06-30_11-53-09.csv`,     tag: 'out_jun_maria' },
  { path: `${DOWNLOADS}/Outbound Calls Camila-2026-06-30_11-53-21.csv`,    tag: 'out_jun_camila' },
  { path: `${DOWNLOADS}/Incoming Calls by Status-2026-06-30_11-56-20.csv`, tag: 'inc_jun' },
];

function parseDate(str) {
  // "Jun 30 2026 11:23 AM" → ISO
  return new Date(str.trim()).toISOString();
}

function normalizeStatus(s) {
  if (s === 'Answered') return 'completed';
  return s.toLowerCase();
}

function normalizeDir(d) {
  if (d === 'Outgoing') return 'outbound';
  if (d === 'Incoming') return 'inbound';
  return d.toLowerCase();
}

async function readCSV(filepath) {
  return new Promise((resolve) => {
    const rows = [];
    let headers = null;
    const rl = createInterface({ input: createReadStream(filepath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const cols = line.split(',');
      if (!headers) { headers = cols; return; }
      const obj = {};
      headers.forEach((h, i) => { obj[h.trim()] = (cols[i] || '').trim(); });
      rows.push(obj);
    });
    rl.on('close', () => resolve(rows));
  });
}

async function upsertBatch(records) {
  const r = await fetch(`${SB_URL}/rest/v1/call_records`, {
    method: 'POST',
    headers: { ...SB_HDR, Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify(records),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error(`Error upsert: ${r.status} ${t}`);
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  let totalInserted = 0;
  let totalSkipped = 0;

  for (const { path, tag } of FILES) {
    console.log(`\nLeyendo ${tag}...`);
    const rows = await readCSV(path);
    console.log(`  ${rows.length} filas totales`);

    const records = [];
    rows.forEach((row, i) => {
      const status = normalizeStatus(row['Call status'] || '');
      const duration = parseInt(row['Duration (in seconds)'] || '0');
      const direction = normalizeDir(row['Direction'] || 'Outgoing');

      if (status !== 'completed') { totalSkipped++; return; }

      let dateAdded;
      try { dateAdded = parseDate(row['Created on']); }
      catch { totalSkipped++; return; }

      records.push({
        id:              `csv_${tag}_${i}`,
        conversation_id: `csv_${tag}_${i}`,
        contact_id:      null,
        duration,
        direction,
        status,
        date_added: dateAdded,
      });
    });

    console.log(`  ${records.length} registros a insertar`);

    // Insertar en batches de 500
    for (let i = 0; i < records.length; i += 500) {
      const batch = records.slice(i, i + 500);
      await upsertBatch(batch);
      process.stdout.write(`  batch ${Math.ceil((i+1)/500)}/${Math.ceil(records.length/500)}\r`);
      await sleep(300);
    }
    totalInserted += records.length;
    console.log(`  OK - ${records.length} insertados`);
  }

  console.log(`\nDone. Total insertados: ${totalInserted}, omitidos: ${totalSkipped}`);
  console.log('NOTA: Borrar registros csv_* una vez que el sync GHL complete:');
  console.log('  DELETE FROM call_records WHERE id LIKE \'csv_%\';');
}

main().catch(console.error);
