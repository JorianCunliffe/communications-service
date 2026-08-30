# Communications Service

A purpose-aware, tenant-isolated communications API (v2.2.3) built with Fastify, Twilio, OpenAI Realtime, and PostgreSQL.

## How to run

Production startup runs `npm run start:production` on port 3000. It applies pending migrations before starting the API.

The server will not start without `OPENAI_API_KEY`. Add it via the Secrets panel before starting.

## Database

Replit uses its built-in PostgreSQL database. `DATABASE_URL` is injected automatically. The migration runner applies numbered migrations 000 through 012 once, in order:

```sh
npm run db:migrate
```

## Required secrets

| Secret | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI Realtime voice and model-backed workers |
| `API_KEY` | Yes | Compatibility credential sent as `X-API-Key` |
| `LEGACY_TENANT_ID` | Yes | Tenant used by compatibility credentials and provider callbacks |
| `TWILIO_ACCOUNT_SID` | For SMS/voice | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | For SMS/voice | Twilio auth token and webhook validation |
| `COMMUNICATIONS_WEBHOOK_SECRET` | For durable events | Signs events sent to HyperFlow |
| `SUPABASE_URL` | Supabase only | Not needed with Replit PostgreSQL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase only | Not needed with Replit PostgreSQL |

## Published configuration

| Variable | Value |
|---|---|
| `PERSISTENCE_PROVIDER` | `postgres` |
| `PORT` | `3000` |
| `PUBLIC_URL` | `https://communications-service.replit.app` |
| `DATABASE_URL` | Replit managed PostgreSQL, injected automatically |

## Architecture

- `index.js` - Fastify server, Twilio webhooks, and OpenAI Realtime bridge
- `database.js` - PostgreSQL abstraction layer
- `v1.js` - canonical `/v1` communications API
- `api.js` - read-only management API
- `callOutcome.js` - durable post-call classification and terminal-event finalization
- `memory.js` / `enrichment.js` - memory reads and asynchronous enrichment
- `eventOutbox.js` - signed, replay-safe event delivery to HyperFlow
- `migrations/` - SQL migrations 000 through 012
- `scripts/migrate.js` - migration runner used by production startup
- `docs/API_REFERENCE.md` - complete API reference

## Twilio webhook URLs

- Voice: `POST https://communications-service.replit.app/incoming-call`
- Inbound SMS: `POST https://communications-service.replit.app/incoming-sms`
- Call status: `POST https://communications-service.replit.app/call-status`
