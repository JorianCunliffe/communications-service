# Communications Service

Current contract release: `2.0.0`.

Purpose-aware, channel-independent communication memory with production Twilio SMS and voice adapters, OpenAI Realtime voice conversations, Supabase or direct PostgreSQL persistence, cross-channel Ask threads, first-class calendar context, provenance-backed facts and commitments, and durable outbound events.

Runtime requirement: Node.js `20.18.1` or newer.

The canonical API is `/v1`. Provider identifiers such as Twilio `SM…` and `CA…` SIDs are retained for traceability, but callers address communications with provider-independent `comm_…` IDs.

> Implementation status: the source, migrations, and tests are present in this repository. A new deployment must apply migrations `000` through `007` and configure either Supabase or PostgreSQL before `/v1` can persist or retrieve communications memory.

## Documentation

- [Complete API reference](docs/API_REFERENCE.md)
- [Environment template](.env.example)
- [Latest database migration](migrations/007_rectification.sql)

## Architecture

Four rules define the service boundary:

1. Hyperflow owns intent and workflow state.
2. Communications owns people, channel identities, delivery, transcripts, and communication history.
3. IDs and events cross the boundary; databases do not.
4. Explicit correlation wins; limited inference is only used when it is unambiguous.

### Ask is purpose, not metadata

`purpose` explains why a communication exists. A Hyperflow Ask is therefore represented directly:

```json
{
  "communication_id": "comm_82",
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_93bc"
  }
}
```

That Ask can span channels and multiple communications:

```text
ask_93bc
  └─ thread_a1
      ├─ outbound SMS: Can you approve the revised budget?
      ├─ inbound SMS: Can you send the supplier breakdown?
      ├─ outbound SMS: Here it is…
      ├─ incoming voice call
      └─ transcript: Okay, approved.
```

An inbound reply emits `ask.response.received`; it does not resolve the Ask. Hyperflow decides whether the reply actually answers the question and calls:

```http
POST /v1/asks/ask_93bc/resolve
X-API-Key: …
Content-Type: application/json

{ "communication_id": "comm_final_answer" }
```

The database function resolves the Ask binding, thread, and final communication in one transaction. Direct forms bypass Communications and enter Hyperflow at `respondToAsk()` directly.

### HyperFlow integration contract

HyperFlow is a consumer of this API, not a shared-database component. A compatible HyperFlow client must:

- authenticate outbound Communications requests with `X-API-Key`;
- supply a stable `Idempotency-Key` for every billable SMS or voice request;
- send SMS as `POST /v1/messages` with `to`, `from`, and `body`;
- send calls as `POST /v1/calls` with `to`, `from`, and allow-listed `overrides`;
- read the canonical `communication_id` response field (an `id` field is not returned);
- deliver SMS/voice Asks through those channel endpoints with `purpose.type: "human_ask"`, `purpose.ask_id`, and an HTTPS `callback_url`;
- keep email/web-form Ask delivery in HyperFlow until an email provider adapter exists here;
- verify `X-Communications-Signature` over the raw webhook body, deduplicate `event_id`, and accept at-least-once delivery;
- treat `sms.delivered` and `call.completed` as success, `sms.failed` and `call.failed` as failure, and all started/sent/answered events as nonterminal; and
- call `POST /v1/asks/:askId/resolve` only after HyperFlow has accepted a specific reply as the final answer.

There is deliberately no `POST /v1/asks` delivery endpoint. Ask is semantic purpose attached to a real channel communication, not a separate transport. See the [API reference integration section](docs/API_REFERENCE.md#hyperflow-consumer-contract) for payload and event details.

### Thread correlation order

For each communication, the service uses this order:

1. Explicit `thread_id` or `correlation.thread_id`.
2. Existing `ask_bindings` entry for `purpose.ask_id`.
3. For inbound communication only, exactly one open thread for the participant identity.
4. Otherwise, no inferred thread.

If a person has two open Ask threads, the service does not guess. The sender must provide an explicit thread or Ask ID.

## What is implemented

| Area | Current implementation |
|---|---|
| Canonical communications | Universal `comm_…` IDs; voice, SMS, email, WhatsApp, Slack, Teams, and recording shapes |
| Provider delivery | Twilio outbound SMS and voice |
| Provider ingestion | Twilio inbound SMS, calls, call status, message status, and recordings |
| Voice | OpenAI Realtime bidirectional audio over Twilio Media Streams |
| Purpose and correlation | First-class `purpose`; allow-listed workflow correlation fields |
| Ask threads | Explicit Ask binding, safe reply correlation, transactional resolution |
| People and identities | Existing contacts plus multiple channel identities per person |
| Context | Chronological call/SMS/recording history and ranked communication search |
| Memory layer | Calendar context, explainable thread expansion, summaries/current state, commitments, facts, and loose ends |
| Memory views | Before-meeting, person, project, and enriched thread read models |
| Enrichment | Durable asynchronous queue; raw communication storage never waits for model extraction |
| Events | Durable leased PostgreSQL outbox, exponential retry, required HMAC signature |
| Management | Read/audit API for contacts, lines, calls, tools, history, and recordings |
| Operator UI | Landing page, visible version/build marker, and test console |

Only Twilio currently performs outbound delivery. `POST /v1/communications` lets future email, Slack, Teams, WhatsApp, or other adapters record canonical communication data without changing the public model.

## Quick start

### 1. Install

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Minimum startup configuration:

```dotenv
OPENAI_API_KEY=sk-...
PORT=5050
```

The process exits when `OPENAI_API_KEY` is absent. Without a persistence provider, voice can still use built-in configuration, but communications are not persisted and `/v1` returns `503`.

### 2. Apply the database migrations

For Replit Database or any direct PostgreSQL deployment, add the database, make sure `DATABASE_URL` is available, then run:

```powershell
npm.cmd run db:migrate
```

The runner applies every numbered SQL file once and refuses to continue if an already-applied migration has changed. For Supabase, either use the same command with its direct PostgreSQL connection string or run the files in order in the SQL editor:

1. `migrations/000_core.sql`
2. `migrations/001_communications_search.sql`
3. `migrations/002_search_communications.sql`
4. `migrations/003_communications_api.sql`
5. `migrations/004_calendar_memory.sql`
6. `migrations/005_communications_enrichment.sql`
7. `migrations/006_memory_search.sql`
8. `migrations/007_rectification.sql`

Choose one runtime provider. Replit Database is direct PostgreSQL:

```dotenv
PERSISTENCE_PROVIDER=postgres
DATABASE_URL=postgresql://...
```

[Replit Database](https://docs.replit.com/build/add-database) normally injects `DATABASE_URL` after a database is added to the app. Verify the deployment is connected to the intended production database before applying migrations; development and production data should not be assumed to be the same.

Existing Supabase deployments use:

```dotenv
PERSISTENCE_PROVIDER=supabase
SUPABASE_CONFIG_ENABLED=true
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Migration `003` adds the canonical API contract. Migrations `004`-`006` add calendar and recording relationships, memory enrichment, provenance, and search. Migration `007` is required for outbound idempotency, terminal Ask protection, worker leases, atomic contact/calendar writes, and the `external_project_id` correlation field.

If `PERSISTENCE_PROVIDER` is omitted, the service keeps backward compatibility: enabled Supabase is preferred, otherwise `DATABASE_URL` selects PostgreSQL. Set the provider explicitly in production. [Replit App Storage](https://docs.replit.com/references/data-and-storage/object-storage) is not required by the current recording flow because media is fetched from its source for transcription while metadata and transcripts live in PostgreSQL; use object storage only if permanent raw-audio archiving is added.

### Memory ingestion and retrieval

Calendar systems push provider-neutral, idempotent events to `POST /v1/calendar/events`. External Plaud/native recordings continue through `POST /api/recordings`; participants, calendar, project, and thread relationships are retained by the existing recording queue and canonical projection.

Useful read models:

```text
POST /v1/context/search
GET  /v1/threads/:threadId
GET  /v1/loose-ends
GET  /v1/calendar/events/:eventId/context
GET  /v1/contacts/:personId/memory
GET  /v1/projects/:projectId/memory
```

Search results distinguish direct matches from `thread_context` expansion and return the ranking components. Facts, commitments, summaries, and current state always carry source communication IDs.

### 3. Configure protected APIs

```dotenv
API_KEY=replace-with-a-long-random-secret
```

All `/v1` and `/api` routes require `X-API-Key`. If `API_KEY` is missing, protected routes return `503`; if it is wrong or absent from a configured deployment, they return `401`.

### 4. Configure Twilio delivery

```dotenv
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
PUBLIC_URL=https://communications.example.com
TWILIO_VALIDATE_SIGNATURES=enforce
```

Configure the Twilio number:

| Twilio setting | URL |
|---|---|
| Voice: a call comes in | `POST https://<host>/incoming-call` |
| Voice: call status changes | `POST https://<host>/call-status` |
| Messaging: a message comes in | `POST https://<host>/incoming-sms` |

Outbound calls and messages attach their status callbacks programmatically. If the number belongs to a Twilio Messaging Service, configure the inbound message webhook on that service.

New deployments should use `enforce`. Existing deployments may temporarily use `warn` while confirming that `PUBLIC_URL` exactly matches the externally visible URL Twilio signs.

### 5. Start

```powershell
node index.js
```

Open:

- `http://localhost:5050/` — service landing page and visible build marker
- `http://localhost:5050/console` — operator call/SMS test console
- `http://localhost:5050/health` — machine-readable health and feature wiring

## First Ask over SMS

```bash
curl -X POST https://communications.example.com/v1/messages \
  -H "X-API-Key: $API_KEY" \
  -H "Idempotency-Key: ask_93bc:sms:initial" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+61400000000",
    "from": "+61411111111",
    "body": "Can you approve the revised $180k budget?",
    "purpose": {
      "type": "human_ask",
      "ask_id": "ask_93bc"
    },
    "correlation": {
      "tenant_id": "tenant_1",
      "external_project_id": "project_42",
      "run_id": "run_8",
      "task_id": "task_12",
      "hold_id": "hold_5"
    },
    "callback_url": "https://hyperflow.example.com/api/communications/events"
  }'
```

Example response:

```json
{
  "communication_id": "comm_7d0d7cc95c8946aa80c68d6ed8431dd7",
  "channel": "sms",
  "direction": "outbound",
  "person_id": null,
  "occurred_at": "2026-08-11T07:30:00.000Z",
  "content": "Can you approve the revised $180k budget?",
  "transcript": null,
  "summary": null,
  "provider": "twilio",
  "provider_id": "SM…",
  "correlation": {
    "tenant_id": "tenant_1",
    "external_project_id": "project_42",
    "run_id": "run_8",
    "task_id": "task_12",
    "hold_id": "hold_5",
    "thread_id": "thread_…"
  },
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_93bc"
  },
  "resolution": null
}
```

## Canonical communication contract

Supported channels:

```text
voice | sms | email | whatsapp | slack | teams | recording
```

Supported directions:

```text
inbound | outbound
```

Allowed correlation fields:

```text
tenant_id | external_project_id | run_id | task_id | hold_id |
thread_id | calendar_event_id | person_id
```

`ask_id` deliberately is not correlation metadata. It belongs under `purpose`. Top-level `project_id` is the internal project UUID; workflow IDs belong in `correlation.external_project_id`. During transition, `correlation.project_id` is accepted as an alias and normalized to `external_project_id`.

## Durable events

Set a deployment-wide destination, pass a per-thread HTTPS callback URL, or both:

```dotenv
HYPERFLOW_EVENT_URL=https://hyperflow.example.com/api/communications/events
COMMUNICATIONS_WEBHOOK_SECRET=replace-with-a-shared-secret
```

The outbox:

- persists the complete event before delivery;
- delivers batches of up to 20 every 15 seconds;
- retries up to 12 times with exponential backoff from 5 seconds to 1 hour;
- accepts only public HTTPS destinations after DNS/private-address checks;
- includes `X-Communications-Event-Id`;
- requires `COMMUNICATIONS_WEBHOOK_SECRET` and includes `X-Communications-Signature: sha256=<hex>`;
- validates every redirect destination against HTTPS, DNS, private-address, and optional host allow-list policy;
- leases rows so multiple service instances cannot deliver the same claim concurrently.

Delivery is at least once. Consumers should deduplicate by `event_id`.

Implemented event types:

```text
communication.created     communication.received
sms.sent                  sms.delivered             sms.failed
sms.received
call.started              call.answered             call.completed
call.failed               transcript.completed      summary.completed
ask.response.received     ask.resolved
```

No destination means no outbox row is created.

## Environment variables

| Variable | Required when | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | Always | Required at process startup; Realtime voice and summaries/transcription use it |
| `PORT` | Optional | Listen port; default `5050` |
| `API_KEY` | Using `/v1`, `/api`, `/sms`, `/outbound-call` | Shared `X-API-Key` secret |
| `PERSISTENCE_PROVIDER` | Persistence enabled | `postgres` for Replit/direct PostgreSQL, `supabase` for Supabase, or `none`; explicit selection is recommended |
| `DATABASE_URL` | PostgreSQL selected | PostgreSQL connection string; supplied by Replit Database when attached |
| `DATABASE_POOL_MAX` | Optional PostgreSQL tuning | Maximum pool size; default `10` |
| `DATABASE_CONNECT_TIMEOUT_MS` | Optional PostgreSQL tuning | Connection timeout; default `5000` ms |
| `SUPABASE_CONFIG_ENABLED` | Legacy Supabase selection | Set exactly `true` only for backward-compatible Supabase selection; prefer `PERSISTENCE_PROVIDER=supabase` |
| `SUPABASE_URL` | Supabase enabled | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase enabled | Service role; required because tables use RLS |
| `TWILIO_ACCOUNT_SID` | Twilio delivery/signing | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio delivery/signing | Twilio auth token |
| `PUBLIC_URL` | Outbound voice and webhook verification | Exact public base URL, without a required trailing slash |
| `TWILIO_VALIDATE_SIGNATURES` | Optional | `off`, `warn`, or `enforce`; defaults to `enforce` when the auth token exists |
| `PRECONNECT_REALTIME` | Optional | Set `false` to disable early Realtime connection |
| `GREETING_MODE` | Optional | `instructions` by default; `item` restores the legacy greeting mode |
| `CONTEXT_TIMEZONE` | Optional | IANA zone used for history grouping; default `Australia/Brisbane` |
| `SUMMARY_MODEL` | Optional | Summary model; default `gpt-5.4-mini` |
| `MEMORY_MODEL` | Optional | Structured memory extraction model; defaults to `SUMMARY_MODEL`, then `gpt-5.4-mini` |
| `TRANSCRIBE_MODEL` | Optional | Diarized transcription model; default `gpt-4o-transcribe-diarize` |
| `CALENDAR_CANDIDATE_WINDOW_MINUTES` | Optional | Nearby-event candidate window; default `120` minutes |
| `MEMORY_SEARCH_*` | Optional | Testable text/person/project/thread/calendar/recency ranking weights |
| `HYPERFLOW_EVENT_URL` | Optional | Default durable event destination |
| `COMMUNICATIONS_WEBHOOK_SECRET` | Durable events | Required HMAC-SHA256 event signing secret |
| `COMMUNICATIONS_WEBHOOK_HOSTS` | Optional | Comma-separated allow-list for event destinations |
| `TOOL_<NAME>_URL` | Per HTTP tool | Makes that tool available to the voice model |
| `RECORDING_SOURCE_<NAME>_HOSTS` | Optional | Comma-separated host allow-list for external recording media |
| `RECORDING_SOURCE_<NAME>_TOKEN` | Authenticated media | Fixed server-side bearer credential for that recording source |

## Data model

| Table | Responsibility |
|---|---|
| `contacts` | Current person/contact record and primary phone configuration link |
| `communication_identities` | Many phone/email/Slack/WhatsApp/Teams identities for one person |
| `calls` | Provider call state, prompt, transcript, summary, and canonical linkage |
| `sms_threads` / `sms_messages` | Native Twilio phone-line history |
| `recordings` | Durable recording/transcription queue |
| `communications` | Canonical provider-independent projection and search surface |
| `communication_threads` | Cross-channel thread state, purpose, correlation, and callback destination |
| `communication_thread_members` | Explicit/native/inferred communication membership |
| `ask_bindings` | External Ask-to-thread binding and resolution state |
| `outbound_events` | Durable webhook payload, retry, and delivery state |
| `projects` / `project_contacts` | Optional project association for contextual retrieval |
| `calendar_events` / `calendar_event_participants` | Idempotent provider events and resolved/unresolved attendees |
| `communication_commitments` | Promise/request state with due date and source excerpt |
| `communication_facts` | Active, superseded, or retracted claims with source communication IDs |
| `communication_enrichment_jobs` | Recoverable asynchronous summary/state/fact/commitment work |

The original provider tables remain because they contain channel-specific details. Database triggers project calls and SMS into `communications` without using provider SIDs as public identifiers.

## Security

- Protected APIs fail closed when `API_KEY` is absent.
- API keys are compared in constant time.
- Twilio callbacks enforce signatures by default when the auth token exists.
- `do_not_contact` blocks outbound delivery; an override requires `override_do_not_contact: true` and a non-empty `override_reason`.
- Recording-provider credentials are selected from fixed server-side configuration, not request-supplied environment-variable names.
- External recording URLs and event destinations reject private, loopback, link-local, carrier NAT, multicast, reserved, and cloud-metadata addresses.
- Database URLs and Supabase service-role credentials belong in deployment secrets, never source control.
- `purpose.token`, when supplied, is persisted and included in event payloads. Treat it as a secret-bearing capability and scope/rotate it accordingly.

## Operational limitations

- Only Twilio currently sends communications; other channels enter through provider adapters using `POST /v1/communications`.
- Memory enrichment is asynchronous and eventually consistent. A newly stored communication may appear in search before its summary, facts, commitments, or current state exist.
- Direct Plaud network sync requires an injected authenticated adapter because no undocumented Plaud API is assumed. The generic idempotent recording endpoint is production-ready for pushes.
- Config CRUD for legacy contact and phone-line settings is not implemented; `/api` provides read/audit endpoints.
- Outbound SMS/calls require `Idempotency-Key`. Reusing a key with a different request, or retrying an operation whose provider outcome is uncertain, returns `409` instead of risking a second billable send.
- Event delivery is at least once and rows are leased across service instances. Consumers must still deduplicate `event_id`.
- Applying migration files is an operational step; committed SQL does not prove a live Supabase or Replit PostgreSQL schema has been updated.
- Full integration tests require a running server and real provider credentials. Unit tests do not place calls or send SMS.

## Testing

Unit tests:

```powershell
npm.cmd run test:unit
```

The full suite expects a running server and includes live OpenAI Realtime connectivity checks:

```powershell
npm.cmd test
```

The purpose/thread suite verifies:

- `human_ask` requires `ask_id`;
- `ask_id` is not accepted as random correlation metadata;
- explicit thread IDs are preserved;
- one open Ask can correlate an incoming call after an SMS;
- two open Asks remain ambiguous;
- `/v1` fails closed without API and database configuration;
- the migration contains the canonical ID, identity, thread, Ask, resolution, and outbox contracts.
- calendar ingestion is idempotent and retains unresolved identities;
- Plaud normalization feeds the existing recording contract;
- thread context is explainable and unrelated threads are excluded;
- commitments, due dates, loose ends, fact provenance, and supersession work as specified.
- outbound idempotency, signature defaults, redirect validation, and project-ID normalization match the documented contract.

## Repository map

| Path | Role |
|---|---|
| `index.js` | Fastify server, Twilio webhooks, voice bridge, health/UI |
| `v1.js` | Canonical Communications API |
| `api.js` | Legacy management/audit and recording-ingest API |
| `communicationModel.js` | IDs, purpose/correlation validation, canonical shape, thread resolution |
| `eventOutbox.js` | Durable event enqueue and delivery worker |
| `callLog.js` / `smsLog.js` | Provider persistence and canonical linkage |
| `context.js` | Chronological history and ranked retrieval integration |
| `calendar.js` / `calendarProviders.js` | Canonical calendar ingestion, exact identity resolution, and candidates |
| `memory.js` | Thread-aware search, loose ends, and person/project/event memory views |
| `enrichment.js` | Durable structured summary/state/fact/commitment worker |
| `plaud.js` | Plaud adapter contract and recording normalization |
| `database.js` | Supabase/direct PostgreSQL provider selection and compatibility adapter |
| `migrations/` | Provider-neutral PostgreSQL schema and verification scripts |
| `scripts/migrate.js` | Ordered, checksummed direct-PostgreSQL migration runner |
| `docs/API_REFERENCE.md` | Endpoint-by-endpoint API contract |

## License

See [LICENSE](LICENSE).
