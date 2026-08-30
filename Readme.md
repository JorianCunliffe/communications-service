# Communications Service

Current contract release: `2.2.5`.

Purpose-aware, tenant-isolated communication memory with production Twilio SMS/voice and Resend email adapters, OpenAI Realtime voice conversations, Supabase or direct PostgreSQL persistence, cross-channel Ask threads, first-class calendar context, provenance-backed facts and commitments, and durable outbound events.

Runtime requirement: Node.js `22` or newer.

The canonical API is `/v1`. Provider identifiers such as Twilio `SM…` and `CA…` SIDs are retained for traceability, but callers address communications with provider-independent `comm_…` IDs.

> Implementation status: the source, migrations, and tests are present in this repository. A deployment must set `LEGACY_TENANT_ID`, apply migrations `000` through `016`, and configure either Supabase or PostgreSQL before `/v1` can persist or retrieve communications memory. Resend delivery remains off until `EMAIL_ENABLED=true`; connected Gmail sync and provider-native drafts use their separate OAuth configuration and never expose a send operation.

## Documentation

- [Complete API reference](docs/API_REFERENCE.md)
- [Environment template](.env.example)
- [Latest database migration](migrations/016_connected_mailboxes.sql)

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
- send the authenticated tenant as `X-Tenant-Id` when using a scoped API client; the legacy key is restricted to `LEGACY_TENANT_ID`;
- supply a stable `Idempotency-Key` for every billable SMS, voice, or email request;
- send SMS as `POST /v1/messages` with `to`, `from`, and `body`;
- send calls as `POST /v1/calls` with `to`, `from`, and allow-listed `overrides`;
- read the canonical `communication_id` response field (an `id` field is not returned);
- deliver SMS/voice Asks through those channel endpoints with `purpose.type: "human_ask"`, `purpose.ask_id`, and an HTTPS `callback_url`;
- send email as `POST /v1/emails` after the tenant's Resend connection and service identity are provisioned;
- verify `X-Communications-Signature` over the raw webhook body, deduplicate `event_id`, and accept at-least-once delivery;
- treat `sms.delivered`, `email.delivered`, and `call.completed` as success; `sms.failed`, `email.failed`, and `call.failed` as failure; and accepted/started/sent/answered events as nonterminal. For voice, Twilio's provider status `completed` is not sufficient: this service emits `call.completed` only after verifying a meaningful response from the intended human; and
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
| Provider delivery | Twilio outbound SMS/voice; Resend outbound email behind `EMAIL_ENABLED` |
| Provider ingestion | Twilio inbound/status/recording callbacks; signed Resend receipts processed through a durable normalization queue |
| Tenancy | Mandatory tenant ownership, scoped credentials, composite provider/idempotency keys, and application-enforced query scoping |
| Voice | OpenAI Realtime bidirectional audio over Twilio Media Streams |
| Voice outcomes | Durable post-call classification; voicemail, wrong number, no answer, busy, fax, automated systems, provider failure, and non-meaningful responses fail closed |
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

Twilio performs SMS/voice delivery and Resend is the first owned email adapter. `POST /v1/communications` remains the provider-neutral ingestion surface for other channels.

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
LEGACY_TENANT_ID=tenant_primary
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
9. `migrations/008_call_outcomes.sql`
10. `migrations/009_multi_tenancy.sql`
11. `migrations/010_email_pipeline.sql`
12. `migrations/011_terminal_event_recovery.sql`
13. `migrations/012_outbound_event_conflict_target.sql`
14. `migrations/013_inbound_email_reply_recovery.sql`
15. `migrations/014_casefolded_email_reply_recovery.sql`
16. `migrations/015_inbound_email_attachment_recovery.sql`
17. `migrations/016_connected_mailboxes.sql`

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

Migration `003` adds the canonical API contract. Migrations `004`-`006` add calendar and recording relationships, memory enrichment, provenance, and search. Migration `007` adds outbound idempotency, terminal Ask protection, worker leases, and atomic writes. Migration `008` separates provider completion from verified human success. Migration `009` backfills every existing row to the explicitly configured `LEGACY_TENANT_ID` and replaces provider/idempotency uniqueness with tenant-scoped keys. Migration `010` adds provider connections, immutable webhook receipts, durable normalization jobs, email records, attachments, and opaque reply routes. Migrations `011` and `012` recover missing terminal call events and install the inferable tenant-scoped event dedupe index. Migrations `013`-`015` requeue inbound email jobs affected by recipient precedence, legacy mixed-case reply tokens, or the obsolete attachment-column insert. Migration `016` adds encrypted connected-mailbox credentials, OAuth state, sync cursors/leases, Gmail draft receipts and mailbox audit records.

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
LEGACY_TENANT_ID=tenant_primary
```

All `/v1` and `/api` routes require `X-API-Key`. The compatibility key maps only to `LEGACY_TENANT_ID`. Tenant-scoped clients use `<key_id>.<secret>` credentials from `api_clients` and must send `X-Tenant-Id`; stored secrets are salted scrypt verifiers. Capabilities are enforced, including `communications:read`, `communications:write`, `email:send`, `email:draft`, `mailbox:manage`, `management:read`, and `management:write`. If credentials are missing or wrong, protected routes fail closed.

To provision a scoped client, generate the verifier without placing the secret in source control, then insert the reported `key_id` and `secret_hash` with explicit `allowed_tenants`, `roles`, and `capabilities`:

```powershell
$env:API_CLIENT_SECRET = '<at-least-24-random-characters>'
npm.cmd run api-client:hash
Remove-Item Env:API_CLIENT_SECRET
```

The caller's credential is `<key_id>.<original-secret>`; the original secret is never stored by the service.

### 4. Configure Twilio delivery

```dotenv
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
PUBLIC_URL=https://communications.example.com
TWILIO_VALIDATE_SIGNATURES=enforce
TWILIO_MACHINE_DETECTION=Enable
```

`TWILIO_MACHINE_DETECTION=Enable` is recommended for outbound calls. Twilio then identifies voicemail/fax before the realtime media stream opens. Transcript classification remains mandatory, so a reported human answer that is actually a wrong number or non-meaningful response still fails safely.

Configure the Twilio number:

| Twilio setting | URL |
|---|---|
| Voice: a call comes in | `POST https://<host>/incoming-call` |
| Voice: call status changes | `POST https://<host>/call-status` |
| Messaging: a message comes in | `POST https://<host>/incoming-sms` |

Each receiving number must have one enabled `phone_configs` row and must resolve to exactly one tenant. Incoming voice and SMS never fall back to `LEGACY_TENANT_ID`. For a live HyperFlow agent call, configure `HYPERFLOW_AGENT_CONTEXT_URL` (or `HYPERFLOW_EVENT_URL` so the context URL can be derived) and the shared `COMMUNICATIONS_WEBHOOK_SECRET`. Communications sends only its trusted tenant/person/thread/service-identity tuple to HyperFlow. Until HyperFlow returns an authorized project, unscoped history and tools are withheld; a context outage produces a tenant-safe unavailable message rather than the default prompt.

### 5. Enable Resend email

Email is fail-closed and disabled by default. First set the provider secrets in Replit, insert one tenant-owned `provider_connections` row and at least one matching `service_identities` row, then register this signed webhook in Resend:

```text
POST https://<host>/webhooks/email/resend/<provider-connection-uuid>
```

The connection stores `credential_reference=env:RESEND_API_KEY` and `webhook_secret_reference=env:RESEND_WEBHOOK_SECRET`; it never stores either secret. Its `channels` must include `email`. A sending identity needs `can_send=true`; a receiving identity needs `can_receive=true`. Set `reply_domain` to the receiving domain if Ask replies should use opaque `reply+<token>@...` routes. Only after those rows and webhook subscriptions are verified should you set:

```dotenv
EMAIL_ENABLED=true
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
```

Outbound requests use `POST /v1/emails` with `Idempotency-Key`. Webhooks are verified over the exact raw body, stored once by provider event ID, acknowledged, and normalized asynchronously. The verified SMTP-envelope recipient remains authoritative when Resend's retrieval API canonicalises an alias; new opaque reply tokens are lowercase-safe, and migrations `013`-`015` recover narrowly identified jobs created by the earlier routing and attachment defects. Attachment metadata is stored in `communication_attachments`, separate from `email_messages`; attachment content is not downloaded or exposed by the API. Bounces, spam, mailing-list traffic, and automatic replies stay auditable but cannot feed memory or emit `ask.response.received`.

### 6. Connect a Gmail mailbox

Gmail OAuth is separate from Resend and remains draft-only. Set the following deployment secrets, register `https://<communications-host>/oauth/mailboxes/google/callback` as an authorized Google redirect URI, apply migration `016`, and grant the HyperFlow API client `mailbox:manage`, `email:draft`, and `communications:read`:

```dotenv
MAILBOX_CREDENTIAL_ENCRYPTION_KEY=<base64-of-exactly-32-random-bytes>
MAILBOX_OAUTH_STATE_SECRET=<at-least-32-random-bytes>
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
HYPERFLOW_URL=https://hyper-flow5.vercel.app
MAILBOX_OAUTH_RETURN_ORIGINS=https://hyper-flow5.vercel.app
```

HyperFlow starts OAuth with `POST /v1/mailboxes/oauth/google/start`, then stores only the returned non-secret connection reference. `POST /v1/mailboxes/:connectionId/sync` performs authoritative cursor reconciliation. `POST /v1/mailboxes/:connectionId/drafts` creates a provider-native Gmail draft using a required idempotency key; there is intentionally no connected-mailbox send route. Outlook is not implemented yet.

Gmail Pub/Sub is optional. If configured, set `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_AUDIENCE`, `GMAIL_PUBSUB_SERVICE_ACCOUNT`, and optionally the exact `GMAIL_PUBSUB_SUBSCRIPTION`. The authenticated push URL is `POST /oauth/gmail`; notifications are hints and never replace scheduled reconciliation.

Outbound calls and messages attach their status callbacks programmatically. If the number belongs to a Twilio Messaging Service, configure the inbound message webhook on that service.

New deployments should use `enforce`. Existing deployments may temporarily use `warn` while confirming that `PUBLIC_URL` exactly matches the externally visible URL Twilio signs.

### 7. Start

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
    "callback_url": "https://hyperflow.example.com/api/events"
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
  "resolution": null,
  "outcome": {
    "business_status": null,
    "disposition": null,
    "successful": null,
    "memory_eligible": true,
    "failure_code": null,
    "failure_reason": null,
    "source": null,
    "confidence": null,
    "detected_at": null
  }
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
HYPERFLOW_EVENT_URL=https://hyperflow.example.com/api/events
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

Voice terminal events are business outcomes, not raw Twilio status aliases. `call.completed` means the intended human supplied a meaningful response. `call.failed` includes `payload.disposition`, `payload.failure_code`, and `payload.failure_reason`; dispositions include `voicemail`, `wrong_number`, `no_answer`, `busy`, `fax`, `automated_system`, `no_meaningful_response`, `provider_failed`, `canceled`, and `unclassified`. Failed calls retain their raw audit transcript but have `memory_eligible: false` and never emit `ask.response.received`.

Implemented event types:

```text
communication.created     communication.received
sms.sent                  sms.delivered             sms.failed
email.accepted            email.delivered           email.failed
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
| `LEGACY_TENANT_ID` | Always with persistence/protected APIs | Stable tenant that owns all pre-009 rows and the compatibility `API_KEY`; required before migration 009 |
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
| `TWILIO_MACHINE_DETECTION` | Recommended for outbound voice | `Enable` or `DetectMessageEnd`; detects voicemail/fax before the realtime stream opens |
| `TWILIO_MACHINE_DETECTION_TIMEOUT` | Optional with AMD | Twilio detection timeout in seconds, clamped to `3…59`; default `30` |
| `GREETING_MODE` | Optional | `instructions` by default; `item` restores the legacy greeting mode |
| `CONTEXT_TIMEZONE` | Optional | IANA zone used for history grouping; default `Australia/Brisbane` |
| `SUMMARY_MODEL` | Optional | Summary model; default `gpt-5.4-mini` |
| `MEMORY_MODEL` | Optional | Structured memory extraction model; defaults to `SUMMARY_MODEL`, then `gpt-5.4-mini` |
| `CALL_OUTCOME_MODEL` | Optional | Strict call-outcome model; defaults to `MEMORY_MODEL`, then `SUMMARY_MODEL`, then `gpt-5.4-mini` |
| `CALL_OUTCOME_TRANSCRIPT_WAIT_MS` | Optional | How long a completed call waits for a transcript before failing as no meaningful response; default `60000` ms |
| `TRANSCRIBE_MODEL` | Optional | Diarized transcription model; default `gpt-4o-transcribe-diarize` |
| `CALENDAR_CANDIDATE_WINDOW_MINUTES` | Optional | Nearby-event candidate window; default `120` minutes |
| `MEMORY_SEARCH_*` | Optional | Testable text/person/project/thread/calendar/recency ranking weights |
| `HYPERFLOW_EVENT_URL` | Optional | Default durable event destination |
| `COMMUNICATIONS_WEBHOOK_SECRET` | Durable events | Required HMAC-SHA256 event signing secret |
| `COMMUNICATIONS_WEBHOOK_HOSTS` | Optional | Comma-separated allow-list for event destinations |
| `HYPERFLOW_AGENT_CONTEXT_URL` | Inbound HyperFlow voice | Signed HyperFlow project-selection endpoint; defaults to the `HYPERFLOW_EVENT_URL` origin at `/api/agent/voice-context` |
| `HYPERFLOW_AGENT_CONTEXT_HOSTS` | Optional | Comma-separated allow-list for the live voice-context endpoint; defaults to its configured host |
| `HYPERFLOW_VERCEL_AUTOMATION_BYPASS_SECRET` | Blocked HyperFlow origin only | Backend-only Vercel automation-bypass secret. Configure it only when an anonymous probe of the selected production origin is intercepted by Deployment Protection. Added as `x-vercel-protection-bypass` only when the event/context destination exactly matches the configured HTTPS HyperFlow origin. |
| `MAILBOX_CREDENTIAL_ENCRYPTION_KEY` | Connected Gmail | Base64 encoding of exactly 32 random bytes used for AES-256-GCM OAuth credential encryption |
| `MAILBOX_OAUTH_STATE_SECRET` | Connected Gmail | Independent random OAuth state signing secret of at least 32 bytes |
| `GMAIL_OAUTH_CLIENT_ID` | Connected Gmail | Google OAuth web client ID |
| `GMAIL_OAUTH_CLIENT_SECRET` | Connected Gmail | Google OAuth web client secret |
| `HYPERFLOW_URL` | Connected Gmail | Default allowlisted HyperFlow return URL |
| `MAILBOX_OAUTH_RETURN_ORIGINS` | Optional with connected Gmail | Comma-separated exact origins accepted after OAuth; defaults to `HYPERFLOW_URL` |
| `GMAIL_PUBSUB_TOPIC` | Optional Gmail push | Full Gmail watch topic name; omit to use scheduled/manual sync only |
| `GMAIL_PUBSUB_AUDIENCE` | Gmail push enabled | Exact OIDC audience expected on `POST /oauth/gmail` |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Gmail push enabled | Exact verified Google service-account email allowed to push |
| `GMAIL_PUBSUB_SUBSCRIPTION` | Optional Gmail push hardening | Exact Pub/Sub subscription resource name |
| `EMAIL_ENABLED` | Optional | `false` by default; set `true` only after provider connections, identities, and webhook secrets are ready |
| `RESEND_API_KEY` | Resend connection references it | Resend API key; inbound email requires permission to retrieve received email content; the connection stores only `env:RESEND_API_KEY` |
| `RESEND_WEBHOOK_SECRET` | Resend webhook connection references it | Resend/Svix signing secret; the connection stores only `env:RESEND_WEBHOOK_SECRET` |
| `TOOL_<NAME>_URL` | Per HTTP tool | Makes that tool available to the voice model |
| `RECORDING_SOURCE_<NAME>_HOSTS` | Optional | Comma-separated host allow-list for external recording media |
| `RECORDING_SOURCE_<NAME>_TOKEN` | Authenticated media | Fixed server-side bearer credential for that recording source |

## Data model

| Table | Responsibility |
|---|---|
| `contacts` | Current person/contact record and primary phone configuration link |
| `communication_identities` | Many phone/email/Slack/WhatsApp/Teams identities for one person |
| `calls` | Provider call state, prompt, raw transcript, summary, canonical linkage, and verified business outcome |
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
| `call_outcome_jobs` | Durable post-call classification and terminal-event finalization work |
| `tenants` / `api_clients` | Tenant registry and hashed, tenant-scoped service credentials |
| `provider_connections` / `service_identities` | Tenant-owned provider accounts and trusted send/receive addresses |
| `webhook_receipts` / `communication_jobs` | Immutable signed provider receipts and durable asynchronous normalization |
| `email_messages` / `communication_attachments` | Safe canonical email plus separate attachment metadata |
| `email_reply_routes` | Hashed, expiring, revocable Ask/thread reply capabilities |

The original provider tables remain because they contain channel-specific details. Database triggers project calls and SMS into `communications` without using provider SIDs as public identifiers.

## Security

- Protected APIs fail closed when `API_KEY` is absent.
- Privileged database connections are wrapped so every tenant-owned read, update, delete, and insert is tenant-scoped; composite foreign keys reject cross-tenant parent links.
- API keys are compared in constant time.
- Twilio callbacks enforce signatures by default when the auth token exists.
- `do_not_contact` blocks outbound delivery; an override requires `override_do_not_contact: true` and a non-empty `override_reason`.
- Recording-provider credentials are selected from fixed server-side configuration, not request-supplied environment-variable names.
- External recording URLs and event destinations reject private, loopback, link-local, carrier NAT, multicast, reserved, and cloud-metadata addresses.
- Database URLs and Supabase service-role credentials belong in deployment secrets, never source control.
- `purpose.token`, when supplied, is persisted and included in event payloads. Treat it as a secret-bearing capability and scope/rotate it accordingly.

## Operational limitations

- Email uses the Resend adapter only. Other future channels enter through provider adapters using `POST /v1/communications`.
- Memory enrichment is asynchronous and eventually consistent. A newly stored communication may appear in search before its summary, facts, commitments, or current state exist.
- Voice calls remain `business_status: pending` until outcome finalization. Only `human_completed` calls are memory eligible. Failed-call transcripts remain available through audit endpoints but are excluded from history prompts, semantic search, memory views, Ask responses, facts, commitments, and thread summaries.
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
- provider completion is separated from verified human success, and failed-call evidence cannot enter semantic memory.

## Repository map

| Path | Role |
|---|---|
| `index.js` | Fastify server, Twilio webhooks, voice bridge, health/UI |
| `v1.js` | Canonical Communications API |
| `api.js` | Legacy management/audit and recording-ingest API |
| `communicationModel.js` | IDs, purpose/correlation validation, canonical shape, thread resolution |
| `eventOutbox.js` | Durable event enqueue and delivery worker |
| `callLog.js` / `smsLog.js` | Provider persistence and canonical linkage |
| `callOutcome.js` | Durable voice outcome classification, memory eligibility, and terminal events |
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
