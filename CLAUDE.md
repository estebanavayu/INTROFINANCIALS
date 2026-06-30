# Intro Financials Dashboard — Documentación Técnica

> **Última actualización:** 2026-06-30
> Dashboard de métricas operacionales de Intro (openers). Vercel + Supabase + GHL.

---

## 🏛️ Arquitectura

```
GHL (fuente de verdad)
  ├─ Opportunities (LTs)       → api/globals.js (real-time)
  ├─ SMS Analytics             → api/globals.js (real-time)
  ├─ Conversations/Calls       → _sync_calls.mjs → Supabase call_records
  └─ Contacts DND SMS          → _sync_calls.mjs → Supabase optout_events

Supabase (cache/histórico)
  ├─ call_records              → métricas llamadas concretadas
  └─ optout_events             → métricas opt-out rate

Vercel (frontend + API)
  ├─ index.html                → dashboard estático
  ├─ api/globals.js            → endpoint métricas Global tab
  └─ api/msg-events.js         → webhook GHL (DND opt-outs real-time)
```

---

## 📁 Archivos clave

| Archivo | Qué hace |
|---|---|
| `index.html` | Dashboard completo (HTML + CSS + JS vanilla) |
| `api/globals.js` | Endpoint `/api/globals` — sirve todas las métricas del Global tab |
| `api/msg-events.js` | Webhook GHL → captura opt-outs DND en tiempo real |
| `_sync_calls.mjs` | Sync nocturno: llamadas GHL + opt-outs DND → Supabase |
| `_import_csv_calls.mjs` | One-time: importó histórico CSV llamadas Feb–Jun 2026 |
| `_import_optouts.mjs` | One-time: importó histórico CSV DND 30,585 contactos |
| `.github/workflows/sync-calls.yml` | Cron `0 6 * * *` (2 AM Chile) |

---

## 🔌 IDs y constantes

- **GHL Location ID:** `NXZFG9aQz6r1UXzZoedy`
- **Supabase URL:** `https://xunmapjtqudsmhikpklx.supabase.co`
- **Vercel project:** `introfin-6v7j` → `introfinancials.vercel.app`
- **Repo:** `estebanavayu/INTROFINANCIALS`

### Pipelines GHL (LTs)
| Pipeline | ID |
|---|---|
| RISE OPENING | `85kFh5EWKPg7qg9FDJfg` |
| NCN OPENING | `tzoH6Bv4qfC4Rug8yZvQ` |
| CENTURY OPENING (CC) | `8tbkIiJnJCnPZY6X0mA6` |

### Env vars requeridas
| Var | Dónde |
|---|---|
| `GHL_TOKEN` | Vercel env vars |
| `IF_SUPABASE_URL` | Vercel env vars |
| `IF_SUPABASE_KEY` | Vercel env vars |
| `GHL_TOKEN_IF` | GitHub Repository secrets |
| `IF_SUPABASE_KEY` | GitHub Repository secrets |
| `IF_SUPABASE_URL` | GitHub Repository secrets |

---

## 🗄️ Supabase Tables

### `call_records`
```sql
id              TEXT PRIMARY KEY,   -- GHL message ID (o "csv_*" para histórico)
conversation_id TEXT NOT NULL,
contact_id      TEXT,
duration        INT,
direction       TEXT,               -- 'outbound' | 'inbound'
status          TEXT,               -- 'completed'
date_added      TIMESTAMPTZ
```
> Registros `csv_*`: histórico importado Feb–Jun 2026. Borrar con `DELETE FROM call_records WHERE id LIKE 'csv_%'` si el sync GHL cubre todo el histórico.

### `optout_events`
```sql
contact_id  TEXT,
ts          TIMESTAMPTZ             -- last_activity del contacto DND
```

### `sync_state`
```sql
key         TEXT,                   -- 'calls_last_sync'
value       TEXT,                   -- ISO timestamp último sync
updated_at  TIMESTAMPTZ
```

---

## 📊 Métricas Global Tab

### Fuentes
| Métrica | Fuente | Lógica |
|---|---|---|
| Live Transfers | GHL API real-time | Opps won en RISE+NCN+CENTURY OPENING, dedup por contactId (latest wonAt), desde 2026-02-01 |
| Llamadas concretadas | Supabase `call_records` | direction=outbound\|inbound, status=completed, duration≥30s |
| Mensajes blasteados | GHL `/conversations/messages/export` | Solo SMS. Bug: startDate debe ser < endDate (usar mañana para "hoy") |
| Tasa SMS→Call | Calculado | llamadas / SMS |
| Tasa Call→LT | Calculado | LTs / llamadas |
| Opt-out rate | Supabase `optout_events` / SMS | Contactos DND SMS activo / mensajes enviados |

### Valores verificados (2026-06-30)
- LTs: 514 total, 164 junio (RISE 149, NCN 6, CENTURY 9)
- Llamadas: 3,150 total, 1,120 junio (outbound 2,232 + inbound 918)
- SMS: 915,118 total, 259,392 junio
- Opt-out: 0.15% junio (2,475 / 259,392)

---

## 🔄 Flujo sync nocturno (`_sync_calls.mjs`)

1. Lee cursor `calls_last_sync` de `sync_state`
2. Pagina conversaciones GHL con `TYPE_CALL` desde cursor - 24h (overlap)
3. Por cada conversación, trae mensajes y filtra `status=completed`
4. Upserta en `call_records` por message ID
5. Actualiza cursor a `now`
6. Pagina contactos GHL con `dndActive=SMS`
7. Upserta en `optout_events` por contact_id con `lastActivity` como ts

**Blindaje:** retry 3x con backoff, manejo rate limit 429, timeout 8s por request en globals.js, fallbacks null si API falla.

---

## 🚨 Lo que NUNCA hay que hacer

- ❌ Commitear las env vars / keys
- ❌ Tocar el proyecto Vercel existente (crear uno nuevo si se necesita)
- ❌ Usar `startDate == endDate` en GHL messaging export API (devuelve error)
- ❌ Insertar llamadas sin normalizar direction (debe ser `outbound`/`inbound`, no `Outgoing`/`Incoming`)

## ✅ Lo que SÍ hay que hacer

- ✅ `fetchSafe()` con timeout en todos los fetch de globals.js
- ✅ `fetchWithRetry()` con backoff en sync nocturno
- ✅ `Promise.all` con `safe()` wrapper — fallo parcial no rompe la respuesta
- ✅ Dedup contactId por `lastStageChangeAt` más reciente para LTs
- ✅ Contar outbound + inbound para llamadas concretadas

---

## 🔧 Comandos útiles

```bash
# Correr sync manualmente (con creds locales)
IF_SUPABASE_URL=https://... IF_SUPABASE_KEY=sb_secret_... GHL_TOKEN=pit-... node _sync_calls.mjs

# Disparar sync via GitHub Actions
gh workflow run sync-calls.yml --ref main

# Importar nuevo CSV de llamadas
IF_SUPABASE_KEY=... node _import_csv_calls.mjs

# Importar nuevo CSV de DND contacts
IF_SUPABASE_KEY=... node _import_optouts.mjs

# Verificar conteos en Supabase
node -e "..." # ver _import_csv_calls.mjs para ejemplo de queries
```
