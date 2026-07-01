import { createTransport } from 'nodemailer';

const SB_URL     = process.env.IF_SUPABASE_URL;
const SB_KEY     = process.env.IF_SUPABASE_KEY;
const EMAIL_PASS = process.env.EMAIL_APP_PASSWORD;
const TO         = process.env.REPORT_TO ?? 'esteban@happydebt.com';
const SB_HDR     = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function readCache(key) {
  const r = await fetch(`${SB_URL}/rest/v1/sync_state?key=eq.${key}&select=value,updated_at`, { headers: SB_HDR });
  const d = await r.json();
  return d[0] ? { value: JSON.parse(d[0].value), updated_at: d[0].updated_at } : null;
}

const fmt = (n, dec=0) => n == null ? '—' : Number(n).toLocaleString('es-CL', { maximumFractionDigits: dec });
const pct = (a, b)     => (a && b)  ? (a/b*100).toFixed(2)+'%' : '—';

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
const mes      = MONTHS[now.getMonth()];
const fechaHoy = now.toLocaleDateString('es-CL', { weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'America/Santiago' });
const updated  = gc?.updated_at
  ? new Date(gc.updated_at).toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit', timeZone:'America/Santiago' })
  : '?';

const prevKey  = (() => { const d = new Date(now.getFullYear(), now.getMonth()-1, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
const prevName = MONTHS[new Date(now.getFullYear(), now.getMonth()-1, 1).getMonth()];
const prev     = mb[prevKey] ?? {};

const ltsM   = g.ltsMonth   ?? 0;
const callsM = g.callsMonth ?? m.callsMonth ?? 0;
const smsM   = g.smsMonth   ?? 0;

const REPS = [
  ['Camila', rr.camila],
  ['Maria',  rr.maria],
  ['Sara',   rr.sara],
];
const totalRepLts   = REPS.reduce((s,[,d]) => s + (d?.ltsMonth  ?? 0), 0);
const totalRepCalls = REPS.reduce((s,[,d]) => s + (d?.callsMonth ?? 0), 0);

const row = (label, value, indent='') =>
  `<tr><td style="padding:3px 0;color:#555;font-size:13px">${indent}${label}</td><td style="padding:3px 0 3px 24px;font-size:13px;font-weight:600;color:#111">${value}</td></tr>`;

const divider = (title) =>
  `<tr><td colspan="2" style="padding:20px 0 6px"><div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#111;border-bottom:2px solid #111;padding-bottom:4px">${title}</div></td></tr>`;

const repRows = REPS.map(([name, d]) => {
  const lt  = d?.ltsMonth   ?? 0;
  const cl  = d?.callsMonth ?? null;
  return row(`${name}`, `${lt} LTs · ${cl != null ? fmt(cl)+' llamadas' : '—  llamadas'} · Call→LT ${pct(lt, cl)}`);
}).join('');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:32px 24px;background:#fff;font-family:Arial,sans-serif;color:#111;max-width:560px">

  <p style="font-size:20px;font-weight:700;margin:0 0 2px">Intro Analytics</p>
  <p style="font-size:12px;color:#777;margin:0 0 28px">${fechaHoy} · Datos al ${updated} hrs Chile</p>

  <table cellpadding="0" cellspacing="0" width="100%">

    ${divider(`${mes} ${now.getFullYear()} — Acumulado del mes`)}
    ${row('Live Transfers',        fmt(ltsM))}
    ${row('Llamadas concretadas',  fmt(callsM))}
    ${row('SMS blasteados',        fmt(smsM))}
    ${row('Tasa SMS → Call',       pct(callsM, smsM))}
    ${row('Tasa Call → LT',        pct(ltsM, callsM))}

    ${divider(`Desglose por rep — ${mes}`)}
    ${repRows}
    <tr><td style="padding:6px 0 0;font-size:12px;color:#777" colspan="2">Total reps: ${totalRepLts} LTs · ${fmt(totalRepCalls)} llamadas · Call→LT ${pct(totalRepLts, totalRepCalls)}</td></tr>

    ${divider('Funnel MCA')}
    ${row('LTs totales (desde feb)',  fmt(m.ltsTotal))}
    ${row('Leads en secuencia',       fmt(m.leadsActive))}
    ${row('No-shows',                 fmt(m.noShows))}
    ${row('Tasa Call → LT (global)',  pct(m.ltsTotal, m.callsTotal))}

    ${prev.lts != null ? `
    ${divider(`${prevName} — Cierre del mes`)}
    ${row('Live Transfers',   fmt(prev.lts))}
    ${row('Llamadas',         fmt(prev.calls))}
    ${row('SMS blasteados',   fmt(prev.sms))}
    ${row('Tasa SMS → Call',  pct(prev.calls, prev.sms))}
    ${row('Tasa Call → LT',   pct(prev.lts, prev.calls))}
    ` : ''}

  </table>

  <p style="font-size:11px;color:#aaa;margin:32px 0 0;border-top:1px solid #eee;padding-top:12px">
    introfinancials.vercel.app · actualización automática cada 30 min
  </p>

</body></html>`;

const transport = createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: 'esteban@happydebt.com', pass: EMAIL_PASS },
});

await transport.sendMail({
  from:    '"Intro Analytics" <esteban@happydebt.com>',
  to:      TO,
  subject: `Intro Analytics · ${mes} ${now.getFullYear()} · ${ltsM} LTs`,
  html,
});

console.log(`✓ Email enviado a ${TO} | LTs: ${ltsM} | Llamadas: ${callsM} | SMS: ${fmt(smsM)}`);
