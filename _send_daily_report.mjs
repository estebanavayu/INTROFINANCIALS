// Reporte diario Intro Analytics → email
// Lee cache Supabase, construye HTML, envía via Gmail SMTP

import { createTransport } from 'nodemailer';

const SB_URL = process.env.IF_SUPABASE_URL;
const SB_KEY = process.env.IF_SUPABASE_KEY;
const EMAIL_PASS = process.env.EMAIL_APP_PASSWORD;
const TO = process.env.REPORT_TO ?? 'esteban@happydebt.com';

const SB_HDR = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function readCache(key) {
  const r = await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.${key}&select=value,updated_at`, { headers: SB_HDR });
  const d = await r.json();
  return d[0] ? { value: JSON.parse(d[0].value), updated_at: d[0].updated_at } : null;
}

function fmt(n, dec = 0) {
  if (n == null) return '—';
  return typeof n === 'number' ? n.toLocaleString('es-CL', { maximumFractionDigits: dec }) : n;
}
function pct(n, dec = 2) { return n != null ? (n * 100).toFixed(dec) + '%' : '—'; }
function pctDirect(n, dec = 2) { return n != null ? n.toFixed(dec) + '%' : '—'; }

const [globalsCache, mcaCache, repsCache, monthlyCache] = await Promise.all([
  readCache('metrics_globals'),
  readCache('metrics_mca'),
  readCache('metrics_mca_reps'),
  readCache('metrics_by_month'),
]);

const g  = globalsCache?.value  ?? {};
const m  = mcaCache?.value      ?? {};
const r  = repsCache?.value     ?? {};
const mb = monthlyCache?.value  ?? {};

const now = new Date();
const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const mesActual  = monthNames[now.getMonth()];
const fechaHoy   = now.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Santiago' });
const curKey     = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
const prevKey    = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
const prevName   = monthNames[new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth()];

const updated = globalsCache?.updated_at
  ? new Date(globalsCache.updated_at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' })
  : '?';

// Datos mes actual
const ltsMonth   = g.ltsMonth   ?? 0;
const callsMonth = g.callsMonth ?? m.callsMonth ?? 0;
const smsMonth   = g.smsMonth   ?? 0;
const rateSCm    = smsMonth  && callsMonth ? callsMonth / smsMonth  : null;
const rateCLm    = callsMonth && ltsMonth  ? ltsMonth  / callsMonth : null;

// Datos mes anterior (desde metrics_by_month)
const prevData = mb[prevKey] ?? {};

// Reps
const repNames = { camila: 'Camila', maria: 'Maria', sara: 'Sara' };

const STYLE = `
  body { margin:0; padding:0; background:#0d0f1e; font-family:'Segoe UI',Arial,sans-serif; color:#e8eaf6; }
  .wrap { max-width:640px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:22px; font-weight:700; color:#fff; margin:0 0 4px; }
  .sub { color:#6b7280; font-size:13px; margin:0 0 24px; }
  .section { margin-bottom:24px; }
  .section-title { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; margin:0 0 10px; }
  .card-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .card-grid-2 { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; }
  .card-grid-5 { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
  .card { background:#1a1d35; border-radius:10px; padding:14px 12px; text-align:center; }
  .card .val { font-size:22px; font-weight:700; color:#22c55e; }
  .card .val.blue { color:#60a5fa; }
  .card .val.purple { color:#a78bfa; }
  .card .val.white { color:#e8eaf6; }
  .card .lbl { font-size:10px; color:#6b7280; margin-top:4px; }
  .rep-table { width:100%; border-collapse:collapse; font-size:13px; }
  .rep-table th { text-align:left; color:#6b7280; font-size:10px; text-transform:uppercase; letter-spacing:.05em; padding:6px 8px; border-bottom:1px solid #2e3250; }
  .rep-table td { padding:10px 8px; border-bottom:1px solid #1e2240; }
  .rep-table tr:last-child td { border-bottom:none; }
  .tag-green { display:inline-block; background:#16a34a22; color:#22c55e; border-radius:4px; padding:2px 7px; font-size:11px; font-weight:600; }
  .footer { color:#4b5563; font-size:11px; text-align:center; margin-top:32px; border-top:1px solid #1e2240; padding-top:16px; }
  .prev-row { display:flex; gap:8px; flex-wrap:wrap; }
  .prev-chip { background:#111328; border:1px solid #2e3250; border-radius:8px; padding:8px 14px; flex:1; min-width:80px; text-align:center; }
  .prev-chip .v { font-size:16px; font-weight:700; color:#e8eaf6; }
  .prev-chip .l { font-size:10px; color:#6b7280; margin-top:2px; }
`;

const repRows = Object.entries(repNames).map(([key, name]) => {
  const rep = r[key] ?? {};
  const ltM  = rep.ltsMonth  ?? 0;
  const cM   = rep.callsMonth ?? 0;
  const rate = cM ? ((ltM / cM) * 100).toFixed(1) + '%' : '—';
  return `
    <tr>
      <td style="font-weight:600">${name}</td>
      <td style="color:#22c55e;font-weight:700">${ltM}</td>
      <td>${fmt(cM)}</td>
      <td style="color:#a78bfa">${rate}</td>
    </tr>`;
}).join('');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${STYLE}</style></head>
<body><div class="wrap">

  <h1>Intro Analytics</h1>
  <p class="sub">Reporte diario · ${fechaHoy} · Datos al ${updated} hrs Chile</p>

  <!-- MES ACTUAL MTD -->
  <div class="section">
    <div class="section-title">${mesActual} ${now.getFullYear()} — acumulado del mes</div>
    <div class="card-grid" style="margin-bottom:8px">
      <div class="card"><div class="val">${fmt(ltsMonth)}</div><div class="lbl">Live Transfers</div></div>
      <div class="card"><div class="val white">${fmt(callsMonth)}</div><div class="lbl">Llamadas concretadas</div></div>
      <div class="card"><div class="val white">${fmt(smsMonth)}</div><div class="lbl">SMS blasteados</div></div>
    </div>
    <div class="card-grid-2">
      <div class="card"><div class="val blue">${pct(rateSCm)}</div><div class="lbl">Tasa SMS → Call</div></div>
      <div class="card"><div class="val purple">${pct(rateCLm)}</div><div class="lbl">Tasa Call → LT</div></div>
    </div>
  </div>

  <!-- REPS MTD -->
  <div class="section">
    <div class="section-title">Desglose por rep — ${mesActual}</div>
    <div style="background:#1a1d35;border-radius:10px;overflow:hidden">
      <table class="rep-table">
        <thead><tr>
          <th>Rep</th><th>LTs</th><th>Llamadas</th><th>Call→LT</th>
        </tr></thead>
        <tbody>${repRows}</tbody>
      </table>
    </div>
  </div>

  <!-- FUNNEL MCA -->
  <div class="section">
    <div class="section-title">Funnel MCA</div>
    <div class="card-grid">
      <div class="card"><div class="val white">${fmt(m.leadsActive)}</div><div class="lbl">Leads en secuencia</div></div>
      <div class="card"><div class="val white">${fmt(m.ltsTotal)}</div><div class="lbl">LTs totales (desde feb)</div></div>
      <div class="card"><div class="val white">${fmt(m.noShows)}</div><div class="lbl">No-shows</div></div>
    </div>
  </div>

  ${prevData.lts != null ? `
  <!-- MES ANTERIOR -->
  <div class="section">
    <div class="section-title">${prevName} — cierre del mes</div>
    <div class="prev-row">
      <div class="prev-chip"><div class="v" style="color:#22c55e">${fmt(prevData.lts)}</div><div class="l">LTs</div></div>
      <div class="prev-chip"><div class="v">${fmt(prevData.calls)}</div><div class="l">Llamadas</div></div>
      <div class="prev-chip"><div class="v">${fmt(prevData.sms)}</div><div class="l">SMS</div></div>
      <div class="prev-chip"><div class="v" style="color:#60a5fa">${prevData.sms && prevData.calls ? (prevData.calls/prevData.sms*100).toFixed(2)+'%' : '—'}</div><div class="l">SMS→Call</div></div>
      <div class="prev-chip"><div class="v" style="color:#a78bfa">${prevData.calls && prevData.lts ? (prevData.lts/prevData.calls*100).toFixed(1)+'%' : '—'}</div><div class="l">Call→LT</div></div>
    </div>
  </div>
  ` : ''}

  <div class="footer">
    Intro Analytics · introfinancials.vercel.app<br>
    Datos actualizados cada 30 min desde GHL
  </div>

</div></body></html>`;

const transport = createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: 'esteban@happydebt.com', pass: EMAIL_PASS },
});

await transport.sendMail({
  from: '"Intro Analytics" <esteban@happydebt.com>',
  to: TO,
  subject: `Intro Analytics · ${mesActual} ${now.getFullYear()} · ${ltsMonth} LTs del mes`,
  html,
});

console.log(`✓ Email enviado a ${TO}`);
console.log(`  LTs mes: ${ltsMonth} | Llamadas mes: ${callsMonth} | SMS mes: ${fmt(smsMonth)}`);
