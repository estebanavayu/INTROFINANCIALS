// Reporte diario Intro Analytics → email
import { createTransport } from 'nodemailer';

const SB_URL      = process.env.IF_SUPABASE_URL;
const SB_KEY      = process.env.IF_SUPABASE_KEY;
const EMAIL_PASS  = process.env.EMAIL_APP_PASSWORD;
const TO          = process.env.REPORT_TO ?? 'esteban@happydebt.com';
const SB_HDR      = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function readCache(key) {
  const r = await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.${key}&select=value,updated_at`, { headers: SB_HDR });
  const d = await r.json();
  return d[0] ? { value: JSON.parse(d[0].value), updated_at: d[0].updated_at } : null;
}

const fmt  = (n, d=0) => n == null ? '—' : Number(n).toLocaleString('es-CL', { maximumFractionDigits: d });
const pct  = (a, b)   => (a && b) ? (a/b*100).toFixed(1)+'%' : '—';

const [gc, mc, rc, mbc] = await Promise.all([
  readCache('metrics_globals'),
  readCache('metrics_mca'),
  readCache('metrics_mca_reps'),
  readCache('metrics_by_month'),
]);

const g  = gc?.value  ?? {};
const m  = mc?.value  ?? {};
const rr = rc?.value  ?? {};
const mb = mbc?.value ?? {};

const now      = new Date();
const MONTHS   = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const mesActual = MONTHS[now.getMonth()];
const fechaHoy  = now.toLocaleDateString('es-CL', { day:'numeric', month:'long', year:'numeric', timeZone:'America/Santiago' });
const updated   = gc?.updated_at
  ? new Date(gc.updated_at).toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit', timeZone:'America/Santiago' })
  : '?';
const prevKey  = (() => { const d = new Date(now.getFullYear(), now.getMonth()-1, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
const prevName = MONTHS[new Date(now.getFullYear(), now.getMonth()-1, 1).getMonth()];
const prev     = mb[prevKey] ?? {};

const ltsM   = g.ltsMonth   ?? 0;
const callsM = g.callsMonth ?? m.callsMonth ?? 0;
const smsM   = g.smsMonth   ?? 0;

// colores
const C = { bg:'#0d0f1e', card:'#141728', border:'#1e2240', green:'#22c55e', blue:'#60a5fa', purple:'#a78bfa', white:'#e8eaf6', muted:'#6b7280' };

const cell = (val, color=C.white, sub='') => `
  <td style="background:${C.card};border-radius:8px;padding:16px 12px;text-align:center;border:1px solid ${C.border}">
    <div style="font-size:26px;font-weight:700;color:${color};font-family:Arial">${val}</div>
    ${sub ? `<div style="font-size:10px;color:${C.muted};margin-top:3px;letter-spacing:.04em">${sub}</div>` : ''}
  </td>`;

const repRows = [
  ['Camila', rr.camila],
  ['Maria',  rr.maria],
  ['Sara',   rr.sara],
].map(([name, d]) => {
  const lt  = d?.ltsMonth  ?? 0;
  const cl  = d?.callsMonth ?? null;
  const rate = pct(lt, cl);
  return `
  <tr style="border-bottom:1px solid ${C.border}">
    <td style="padding:12px 14px;font-weight:600;color:${C.white};font-size:14px">${name}</td>
    <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:${C.green}">${lt}</td>
    <td style="padding:12px 14px;text-align:center;font-size:16px;color:${C.white}">${cl != null ? fmt(cl) : '—'}</td>
    <td style="padding:12px 14px;text-align:center;font-size:16px;color:${C.purple}">${rate}</td>
  </tr>`;
}).join('');

const prevSection = prev.lts != null ? `
<table width="100%" cellpadding="0" cellspacing="6" style="margin-top:24px">
  <tr>
    <td colspan="5" style="padding:0 0 8px;font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.07em">${prevName} — cierre del mes</td>
  </tr>
  <tr>
    ${cell(fmt(prev.lts),   C.green,  'LTs')}
    <td width="6"></td>
    ${cell(fmt(prev.calls), C.white,  'Llamadas')}
    <td width="6"></td>
    ${cell(fmt(prev.sms),   C.white,  'SMS')}
    <td width="6"></td>
    ${cell(pct(prev.calls, prev.sms), C.blue,   'SMS→Call')}
    <td width="6"></td>
    ${cell(pct(prev.lts, prev.calls), C.purple, 'Call→LT')}
  </tr>
</table>` : '';

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- HEADER -->
  <tr><td style="padding:0 0 20px">
    <div style="font-size:22px;font-weight:700;color:${C.white}">Intro <span style="color:${C.blue}">Analytics</span></div>
    <div style="font-size:12px;color:${C.muted};margin-top:4px">Reporte diario · ${fechaHoy} · Datos al ${updated} hrs Chile</div>
  </td></tr>

  <!-- MTD METRICS -->
  <tr><td style="padding:0 0 6px">
    <div style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">${mesActual} ${now.getFullYear()} — acumulado del mes</div>
    <table width="100%" cellpadding="0" cellspacing="6">
      <tr>
        ${cell(fmt(ltsM),   C.green,  'Live Transfers')}
        <td width="6"></td>
        ${cell(fmt(callsM), C.white,  'Llamadas concretadas')}
        <td width="6"></td>
        ${cell(fmt(smsM),   C.white,  'SMS blasteados')}
      </tr>
      <tr height="6"><td colspan="5"></td></tr>
      <tr>
        ${cell(pct(callsM, smsM),  C.blue,   'Tasa SMS → Call')}
        <td width="6"></td>
        ${cell(pct(ltsM, callsM),  C.purple, 'Tasa Call → LT')}
        <td width="6"></td>
        ${cell(fmt(m.leadsActive), C.white,  'Leads en secuencia')}
      </tr>
    </table>
  </td></tr>

  <!-- REPS -->
  <tr><td style="padding:20px 0 0">
    <div style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Desglose por rep — ${mesActual}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border-radius:10px;border:1px solid ${C.border};border-collapse:separate;overflow:hidden">
      <tr style="background:#0f1124">
        <td style="padding:10px 14px;font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em">Rep</td>
        <td style="padding:10px 14px;font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;text-align:center">LTs</td>
        <td style="padding:10px 14px;font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;text-align:center">Llamadas</td>
        <td style="padding:10px 14px;font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;text-align:center">Call→LT</td>
      </tr>
      ${repRows}
    </table>
  </td></tr>

  <!-- FUNNEL -->
  <tr><td style="padding:20px 0 0">
    <div style="font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">Funnel MCA</div>
    <table width="100%" cellpadding="0" cellspacing="6">
      <tr>
        ${cell(fmt(m.ltsTotal),    C.green,  'LTs totales (desde feb)')}
        <td width="6"></td>
        ${cell(fmt(m.leadsActive), C.white,  'Leads en secuencia')}
        <td width="6"></td>
        ${cell(fmt(m.noShows),     C.white,  'No-shows')}
      </tr>
    </table>
  </td></tr>

  <!-- MES ANTERIOR -->
  <tr><td>${prevSection}</td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:28px 0 0;text-align:center;color:${C.muted};font-size:11px;border-top:1px solid ${C.border};margin-top:8px">
    <a href="https://introfinancials.vercel.app" style="color:${C.blue};text-decoration:none">introfinancials.vercel.app</a>
    &nbsp;·&nbsp; Actualización automática cada 30 min
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

const transport = createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: 'esteban@happydebt.com', pass: EMAIL_PASS },
});

await transport.sendMail({
  from:    '"Intro Analytics" <esteban@happydebt.com>',
  to:      TO,
  subject: `📊 Intro Analytics · ${mesActual} ${now.getFullYear()} · ${ltsM} LTs del mes`,
  html,
});

console.log(`✓ Email enviado a ${TO}`);
console.log(`  LTs: ${ltsM} | Llamadas: ${callsM} | SMS: ${fmt(smsM)}`);
