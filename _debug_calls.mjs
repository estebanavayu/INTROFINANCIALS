const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;
const HDR = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// 1. Total de registros
const r1 = await fetch(`${SB_URL}/rest/v1/call_records?select=id`, { headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' } });
console.log('Total registros:', r1.headers.get('content-range'));

// 2. Distribución de status
const r2 = await fetch(`${SB_URL}/rest/v1/call_records?select=status&limit=5`, { headers: HDR });
const d2 = await r2.json();
console.log('Sample status:', d2.map(r => r.status));

// 3. Distribución de duration (primeros 10)
const r3 = await fetch(`${SB_URL}/rest/v1/call_records?select=duration,status,direction&limit=10`, { headers: HDR });
const d3 = await r3.json();
console.log('Sample rows:', JSON.stringify(d3, null, 2));

// 4. Cuántos tienen duration >= 30
const r4 = await fetch(`${SB_URL}/rest/v1/call_records?select=id&duration=gte.30`, { headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' } });
console.log('duration >= 30:', r4.headers.get('content-range'));

// 5. Cuántos tienen status = completed
const r5 = await fetch(`${SB_URL}/rest/v1/call_records?select=id&status=eq.completed`, { headers: { ...HDR, Prefer: 'count=exact', Range: '0-0' } });
console.log('status=completed:', r5.headers.get('content-range'));
