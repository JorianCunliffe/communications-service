# Communications Service

A purpose-aware, channel-independent communications API (v2.0.0) built with Fastify, Twilio, OpenAI Realtime, and PostgreSQL.

## How to run

Start the workflow: **Start application** → `node index.js` on port 5000.

The server will not start without `OPENAI_API_KEY`. Add it via the Secrets panel (lock icon) before starting.

## Database

Uses **Replit's built-in PostgreSQL** (`DATABASE_URL` is set automatically). All 8 migrations (000–007) have been applied. To re-run migrations:

```
npm run db:migrate
```

## Required secrets

| Secret | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | ✅ Yes | Process exits on startup without it |
| `API_KEY` | Recommended | Shared secret sent as `X-API-Key`; protected routes return 503 if unset |
| `TWILIO_ACCOUNT_SID` | For SMS/voice | From Twilio console |
| `TWILIO_AUTH_TOKEN` | For SMS/voice | From Twilio console |
| `SUPABASE_URL` | Optional | Only needed if using Supabase-specific features (set `SUPABASE_CONFIG_ENABLED=true`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional | Supabase service-role key |

## Environment variables (already set)

| Variable | Value |
|---|---|
| `PORT` | `5000` |
| `PUBLIC_URL` | Your Replit dev domain (set automatically) |
| `DATABASE_URL` | Replit managed PostgreSQL (set automatically) |

## Architecture

- `index.js` — entry point, Fastify server, Twilio webhook handlers, OpenAI Realtime WebSocket bridge
- `database.js` — PostgreSQL abstraction layer (Supabase-compatible API over `pg`)
- `v1.js` — canonical `/v1` REST API (messages, calls, asks, contacts)
- `api.js` — `/api` read-only management routes
- `config.js` — per-call tunable defaults
- `configResolver.js` — database-backed config lookup
- `tools.js` — OpenAI function-calling tools (calendar, etc.)
- `transcripts.js` / `callLog.js` / `smsLog.js` — call/SMS record keeping
- `memory.js` — async communications memory worker
- `migrations/` — SQL migrations 000–007 (all applied)
- `scripts/migrate.js` — migration runner (`npm run db:migrate`)
- `docs/API_REFERENCE.md` — full API reference

## Twilio webhook URLs (set in Twilio console)

- Voice: `POST https://a8bb884d-9560-4f4e-b2d0-0f67c4ec39ca-00-3s3rdlke53rb-lguwe7ry.worf.replit.dev/incoming-call`
- Inbound SMS: `POST https://a8bb884d-9560-4f4e-b2d0-0f67c4ec39ca-00-3s3rdlke53rb-lguwe7ry.worf.replit.dev/incoming-sms`
- Call status: `POST https://a8bb884d-9560-4f4e-b2d0-0f67c4ec39ca-00-3s3rdlke53rb-lguwe7ry.worf.replit.dev/call-status`

## User preferences
