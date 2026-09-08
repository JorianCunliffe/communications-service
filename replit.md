# Communications Service

A purpose-aware, tenant-isolated communications API (v2.4.0) built with Fastify, Twilio, OpenAI Realtime, and PostgreSQL.

## How to run

Production startup runs `npm run start:production` on port 3000. It applies pending migrations before starting the API.

The server will not start without `OPENAI_API_KEY`. Add it via the Secrets panel before starting.

## Database

Replit uses its built-in PostgreSQL database. `DATABASE_URL` is injected automatically. The migration runner applies numbered migrations 000 through 019 once, in order:

```sh
npm run db:migrate
```

Release 2.4.0 requires migration `019_ranked_thread_resolution.sql`. Pull the release before republishing; a GitHub push alone does not update a published Replit snapshot. Check the deployed `/health` build against the intended source and verify an authenticated `/v1/thread-register` read after startup. No additional provider secret is required for the register.

Run `npm run test:unit` and `npm run test:db` for credential-free checks. The latter uses an isolated PostgreSQL fixture, not the production database. See `docs/THREADING.md` for the model and rollout checks.

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

When `HYPERFLOW_EVENT_URL` and `COMMUNICATIONS_WEBHOOK_SECRET` are present, the always-on deployment also sends HyperFlow's signed scheduler tick every five minutes. It reuses the existing replay-safe webhook HMAC; no scheduler secret is stored in this app. Set `HYPERFLOW_SCHEDULER_DISABLED=true` only if another reliable sub-daily timer has replaced it.

## Architecture

- `index.js` - Fastify server, Twilio webhooks, and OpenAI Realtime bridge
- `database.js` - PostgreSQL abstraction layer
- `v1.js` - canonical `/v1` communications API
- `api.js` - read-only management API
- `callOutcome.js` - durable post-call classification and terminal-event finalization
- `memory.js` / `enrichment.js` - memory reads and asynchronous enrichment
- `eventOutbox.js` - signed, replay-safe event delivery to HyperFlow
- `migrations/` - SQL migrations 000 through 019
- `scripts/migrate.js` - migration runner used by production startup
- `docs/API_REFERENCE.md` - complete API reference

## Twilio webhook URLs

- Voice: `POST https://communications-service.replit.app/incoming-call`
- Inbound SMS: `POST https://communications-service.replit.app/incoming-sms`
- Call status: `POST https://communications-service.replit.app/call-status`


See [Phase 02 record](docs/implementation/P02.md) for migration 020, actor assertion capability, project safeguards and local acceptance limits.
