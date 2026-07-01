// Audit call_records — verifica datos de llamadas en Supabase
const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;
const HDR    = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function count(params) {
  const r = await fetch(`${SB_URL}/rest/v1/call_records?${params}`, {
    headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' },
  });
  return { n: parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0') || 0, status: r.status };
}

// Últimas 5 filas para ver el formato de date_added
const r1 = await fetch(`${SB_URL}/rest/v1/call_records?select=date_added,direction,status,duration&order=date_added.desc&limit=5`, { headers: HDR });
const latest = await r1.json();
console.log('=== ÚLTIMAS 5 LLAMADAS ===');
latest.forEach(r => console.log(` ${r.date_added} | dir=${r.direction} | status=${r.status} | dur=${r.duration}`));

// Cursor del último sync
const r2 = await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.calls_last_sync&select=value,updated_at`, { headers: HDR });
const cur = await r2.json();
console.log('\n=== CURSOR SYNC CALLS ===');
console.log(` last_sync: ${cur[0]?.value}  (updated_at: ${cur[0]?.updated_at})`);

// Contar llamadas con distintos filtros para julio
const now = new Date();
const julStart = '2026-07-01T00:00:00.000Z';
const nowISO   = now.toISOString();

console.log('\n=== CONTEO JULIO ===');
const c1 = await count(`select=id&date_added=gte.${julStart}&date_added=lte.${nowISO}`);
console.log(` Total en julio (sin filtros): ${c1.n}`);

const c2 = await count(`select=id&status=eq.completed&date_added=gte.${julStart}&date_added=lte.${nowISO}`);
console.log(` status=completed: ${c2.n}`);

const c3 = await count(`select=id&status=eq.completed&duration=gte.30&date_added=gte.${julStart}&date_added=lte.${nowISO}`);
console.log(` completed + dur>=30: ${c3.n}`);

const c4 = await count(`select=id&status=eq.completed&duration=gte.30&direction=eq.outbound&date_added=gte.${julStart}&date_added=lte.${nowISO}`);
const c5 = await count(`select=id&status=eq.completed&duration=gte.30&direction=eq.inbound&date_added=gte.${julStart}&date_added=lte.${nowISO}`);
console.log(` outbound completed >=30s: ${c4.n}`);
console.log(` inbound  completed >=30s: ${c5.n}`);

// Ver 3 filas de julio sin filtros para revisar campos
const r3 = await fetch(`${SB_URL}/rest/v1/call_records?select=date_added,direction,status,duration&date_added=gte.${julStart}&order=date_added.asc&limit=3`, { headers: HDR });
const julRows = await r3.json();
console.log('\n=== MUESTRA JULIO (primeras 3) ===');
if (julRows.length) julRows.forEach(r => console.log(` ${r.date_added} | dir=${r.direction} | status=${r.status} | dur=${r.duration}`));
else console.log(' (sin filas en julio)');
