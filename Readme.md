# Iris — Twilio Voice + SMS with the OpenAI Realtime API

A Node.js server that bridges Twilio phone calls to [OpenAI's Realtime
API](https://platform.openai.com/docs/) for two-way voice conversation, records
calls and SMS to Supabase, and personalises every interaction from a per-contact
configuration cascade.

Built on [Twilio Voice](https://www.twilio.com/docs/voice) and [Media
Streams](https://www.twilio.com/docs/voice/media-streams). The original tutorial
this grew from is
[here](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node).

## What it does today

| Capability | Status |
|---|---|
| Inbound calls — answer, bridge to the assistant | Working |
| Outbound calls — place and bridge | Working |
| Inbound SMS — receive and record | Working |
| Outbound SMS — send and record | Working |
| Per-contact / per-line configuration from Supabase | Working |
| Call recording to `public.calls` (both directions) | Working |
| Tool calling on voice calls, per contact and direction | Working |
| Auto-reply to inbound SMS | **Not built** — see [Roadmap](#roadmap) |
| Management API for contacts, config and tools | **Not built** — see [Pending API](#pending-api) |
| Outbound webhooks on call/SMS events | **Not built** — see [Roadmap](#roadmap) |

> **Everything is intended to be driven by the API.** Configuration that today
> requires SQL against Supabase is listed under [Pending API](#pending-api) with
> the endpoint that will replace it. Treat direct SQL as a temporary measure.

## Contents

- [Prerequisites](#prerequisites)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Twilio configuration](#twilio-configuration)
- [HTTP API](#http-api)
- [Pending API](#pending-api)
- [Configuration model](#configuration-model)
- [Tool calling](#tool-calling)
- [Data model](#data-model)
- [Operations](#operations)
- [Testing](#testing)
- [Known gaps](#known-gaps)
- [Roadmap](#roadmap)

## Prerequisites

- **Node.js 18+** (deployed on 20; `.replit` pins `nodejs-20`).
- **A Twilio account** and a number with **Voice** and **SMS** capabilities.
- **An OpenAI API key with Realtime API access.**
- **A Supabase project** — optional, but without it every call uses the built-in
  defaults and nothing is recorded.

## Local setup

```bash
npm install
cp .env.example .env      # then fill in OPENAI_API_KEY at minimum
node index.js             # listens on PORT, default 5050
```

Twilio needs to reach the server, so for local development open a tunnel:

```bash
ngrok http 5050
```

Use the resulting `https://…ngrok.app` URL wherever `PUBLIC_URL` or a Twilio
webhook is called for below. Each `ngrok http` run mints a new URL, so it has to
be updated in Twilio every time.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | **Yes** | Realtime API access. The process exits without it. |
| `PORT` | No | Listen port. Defaults to `5050`. |
| `SUPABASE_CONFIG_ENABLED` | No | Must be exactly `true` to enable config lookup **and all recording**. Anything else disables both. |
| `SUPABASE_URL` | If Supabase on | Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | If Supabase on | `contacts`, `contact_config` and `calls` have RLS enabled — the anon key silently returns nothing. |
| `API_KEY` | For write endpoints | Shared secret for `X-API-Key`. **If unset, `/outbound-call` and `/sms` return 503** rather than running unprotected. |
| `TWILIO_ACCOUNT_SID` | For outbound | Twilio credentials. |
| `TWILIO_AUTH_TOKEN` | For outbound | Twilio credentials. |
| `PUBLIC_URL` | For outbound calls | Public base URL Twilio can reach, used to build the `/outbound-answer` and `/call-status` callbacks. |
| `TOOL_<NAME>_URL` | Per HTTP tool | Endpoint for an `http`-type tool, e.g. `TOOL_CHECK_CALENDAR_URL`. A tool whose URL is unset is never offered to the model. |

## Twilio configuration

On your number in the [Twilio Console](https://console.twilio.com/) → **Phone
Numbers** → **Manage** → **Active Numbers**:

| Setting | Value |
|---|---|
| Voice — "A call comes in" | `https://<your-host>/incoming-call` (HTTP POST) |
| Voice — "Call status changes" | `https://<your-host>/call-status` (HTTP POST) |
| Messaging — "A message comes in" | `https://<your-host>/incoming-sms` (HTTP POST) |

The status callback is what fills in `status`, `ended_at` and
`duration_seconds` on inbound calls. Outbound calls set their own callback
programmatically and do not depend on this field.

If the number belongs to a Messaging Service, the service's inbound webhook
overrides the number's — set it there instead.

> **Security note.** None of the webhook routes validate Twilio's
> `X-Twilio-Signature` header yet. See [Known gaps](#known-gaps).

## HTTP API

### Authentication

Write endpoints require the shared secret in an `X-API-Key` header, compared in
constant time. Webhook endpoints called by Twilio are unauthenticated, because
Twilio cannot present a custom header.

| Response | Meaning |
|---|---|
| `401` | Key missing or wrong. |
| `503` | The feature is not configured (`API_KEY` or Twilio credentials unset). |

### `GET /`

Landing page. Content-negotiated: a browser (`Accept: text/html`) gets
`home.html`; anything else gets JSON.

```json
{ "message": "Twilio Media Stream Server is running!", "console": "/console" }
```

### `GET /console`

The operator test console — place calls, send SMS, inspect health. Same-origin
with the API so its buttons reach it directly. The API key is entered by the
operator and never leaves their browser.

### `GET /health`

```json
{
  "status": "ok",
  "version": "ec7a826",
  "build": "997c6f06b197",
  "model": "gpt-realtime",
  "playIntro": false,
  "supabaseConfig": true,
  "outboundCalls": true
}
```

`version` is the git short SHA where git is available, else `v<package
version>`. `build` is the source fingerprint — see
[Identifying a deployment](#identifying-a-deployment).

### `POST /outbound-call`

Places a call and bridges it into the assistant. Requires `API_KEY`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `PUBLIC_URL`.

```bash
curl -X POST https://your-host/outbound-call \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to":   "+61415828522",
        "from": "+61468271148",
        "overrides": { "voice": "cedar", "aiSpeaksFirst": true }
      }'
```

| Field | Notes |
|---|---|
| `to` | **Required.** E.164. The person being called. |
| `from` | **Required.** E.164, a number you own on Twilio. |
| `overrides` | Optional. Only these keys: `model`, `effort`, `voice`, `temperature`, `systemMessage`, `introMessage`, `introMessage2`, `introVoice`, `greetingText`, `aiSpeaksFirst`. Anything else is a `400`. |

`overrides` cannot currently set `tools` — see [Pending API](#pending-api).

**`201`** → `{ "callSid": "CA…", "to": …, "from": …, "status": "queued" }`
**`502`** → Twilio rejected the call; `detail` carries the reason.

### `POST /sms`

Sends a message and records it.

```bash
curl -X POST https://your-host/sms \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+61415828522", "from": "+61468271148", "body": "Hello from Iris" }'
```

`body` must be 1–1600 characters. **`201`** → `{ "messageSid": "SM…", … }`.

### Webhook endpoints (Twilio calls these)

| Route | Methods | Purpose |
|---|---|---|
| `/incoming-call` | GET, POST | Resolves config, records the call as `ringing`, returns `<Connect><Stream>` TwiML. |
| `/outbound-answer` | GET, POST | Fetched when the callee picks up. Same TwiML, intro suppressed. |
| `/call-status` | GET, POST | Call progress. Updates status, `ended_at`, `duration_seconds`. Always answers `2xx` so Twilio does not retry. |
| `/incoming-sms` | GET, POST | Records the inbound message. Returns empty TwiML — **nothing replies automatically yet.** |
| `/media-stream` | WebSocket | The audio bridge. Twilio connects here from the TwiML above. |

## Pending API

Everything below is currently only possible with direct SQL against Supabase or
by editing source. These are the endpoints that will replace that, and the shape
they are expected to take. **None of them exist yet.**

### Contacts and configuration

| Method | Path | Replaces |
|---|---|---|
| `GET` | `/api/contacts` | `select * from contacts` |
| `POST` | `/api/contacts` | Manual insert; today a contact is only auto-created on first interaction |
| `GET` | `/api/contacts/:phone` | Contact plus its resolved config |
| `PATCH` | `/api/contacts/:phone` | Name, email, company, tags, `do_not_contact` |
| `DELETE` | `/api/contacts/:phone` | Manual delete |
| `GET` | `/api/contacts/:phone/config` | `select * from contact_config` |
| `PUT` / `PATCH` | `/api/contacts/:phone/config` | Prompts, voice, model, effort, greetings, per-direction overrides |
| `GET` | `/api/lines` | `select * from phone_configs` |
| `PUT` / `PATCH` | `/api/lines/:phone` | Per-line defaults |

### Tools

| Method | Path | Replaces |
|---|---|---|
| `GET` | `/api/tools` | Reading `tools.js` by hand — should return name, description, parameter schema, type, and whether it is available (HTTP tools need their `TOOL_*_URL` set) |
| `GET` | `/api/contacts/:phone/tools` | `select inbound_enabled_tools, outbound_enabled_tools, enabled_tools` |
| `PUT` | `/api/contacts/:phone/tools` | Replace the lists wholesale |
| `PATCH` | `/api/contacts/:phone/tools` | `{ "add": [...], "remove": [...] }` against a direction |
| `DELETE` | `/api/contacts/:phone/tools/:name` | Remove one tool |
| `GET` / `PUT` / `PATCH` | `/api/lines/:phone/tools` | The same, per line |

Tool names must be validated against the registry on write and rejected with
`422` plus the list of valid names. Today an unknown name is dropped at call
time with a `console.warn` nobody sees, so a typo silently costs a tool.

Registering a *new* tool still means editing `tools.js` — defining tools over
the API (name, description, JSON-Schema parameters, endpoint) is a later step,
since it means executing operator-supplied definitions.

### History and audit

| Method | Path | Replaces |
|---|---|---|
| `GET` | `/api/calls` | `select * from calls` |
| `GET` | `/api/calls/:callSid` | One call with its tool calls |
| `GET` | `/api/calls/:callSid/tools` | `select * from tool_calls` |
| `GET` | `/api/contacts/:phone/messages` | `select * from sms_messages` |
| `GET` | `/api/contacts/:phone/history` | Unified cross-channel history — does not exist in any form yet |

### Not yet designed

- SMS auto-reply settings (`sms_autorespond` and friends).
- Outbound webhook registration.
- Per-tenant API keys. There is one shared `API_KEY` for everything.

## Configuration model

`DEFAULT_CONFIG` in `config.js` is the source of truth for every tunable:
`model`, `effort`, `voice`, `temperature`, `assistantName`, `systemMessage`,
`playIntro`, `introMessage`, `introMessage2`, `introVoice`, `greetingText`,
`aiSpeaksFirst`, `tools`. With no database configured these apply to every call.

### The cascade

With `SUPABASE_CONFIG_ENABLED=true`, config is resolved per call in this order:

1. **`contact_config`** — the row belonging to *the other party*, joined through
   `contacts.phone_number`. This is the person's own settings and always wins.
2. **`phone_configs`** — the row for one of our lines, keyed on `twilio_number`
   with `call_enabled = true`.
3. **`DEFAULT_CONFIG`**.

**"The other party" is whoever is not us**: the caller (`From`) on an inbound
call, the callee (`To`) on an outbound one. Keying this on `From` in both
directions would look up our own line on every outbound call — which is exactly
the bug fixed in `54bce46`.

Line candidates differ by direction. Inbound tries `[From, To]` — a personal
override first, then the line dialled. Outbound tries `[From]` only, since that
is our line.

### Direction-specific columns

Within a row, a direction-specific column beats the generic one, which beats the
app default:

| Direction-specific | Generic | Falls back to |
|---|---|---|
| `inbound_call_prompt` / `outbound_call_prompt` | `call_system_prompt` | `systemMessage` |
| `inbound_call_greeting` / `outbound_call_greeting` | `call_greeting` | `greetingText` |
| `inbound_ai_speaks_first` / `outbound_ai_speaks_first` | `ai_speaks_first` | `aiSpeaksFirst` |
| `inbound_enabled_tools` / `outbound_enabled_tools` | `enabled_tools` | `tools` (empty) |
| — | `model`, `effort`, `call_voice`, `temperature`, `assistant_name`, `play_intro`, `intro_message`, `intro_message_2`, `intro_voice` | the matching default |

**Any column left null falls back**, so a row only needs to set what it changes.

One deliberate exception: an **empty** direction-specific tools array means "no
tools in this direction" and beats the generic list, rather than being treated
as unset. `inbound_enabled_tools = '{}'` disables tools on inbound calls even
when `enabled_tools` is populated.

### Placeholders

`systemMessage`, `introMessage`, `introMessage2` and `greetingText` may contain
`{{name}}`, `{{assistant}}` or `{{combined_history}}`, filled from the contact
record. Write `{{token|fallback}}` to choose the fallback for that placeholder:

| Template | Known contact | Unknown |
|---|---|---|
| `Hi {{name}}` | `Hi Sam` | `Hi there` |
| `speaking with {{name\|the caller}}` | `speaking with Sam` | `speaking with the caller` |

Defaults are `there`, `the assistant`, and `No previous contact on record.`

### Reliability

Config never blocks a call. A lookup that times out (2500 ms), errors, or
matches nothing falls back to the defaults and the call proceeds. Rows and
contacts are cached for 60 seconds, misses included. A background `warmUp()` at
boot pays the DNS/TLS cost once — measured at ~1.8 s cold versus ~0.3 s warm,
enough to blow the per-call timeout on the first call after a deploy.

### One voice for the whole call

`playIntro` is **off** by default. Twilio's `<Say>` text-to-speech is a
different voice from the assistant's, so playing it means the caller hears two.
With it off, no `<Say>` is emitted, `aiSpeaksFirst` is on, and the assistant
opens the call itself in its own voice using `greetingText`. Set `play_intro =
true` on a line to bring the Twilio intro back; the TwiML then renders exactly
as it originally did.

### Reasoning effort

`effort` (`minimal` | `low` | `medium` | `high` | `xhigh`) applies to
reasoning-capable models such as `gpt-realtime-2`. It is only sent when set, so
`gpt-realtime` is unaffected. **`temperature` is omitted whenever `effort` is
set** — reasoning models reject it, and sending it fails the connection and
kills the call.

## Tool calling

Tools let the assistant call out mid-conversation. They are **off by default**:
`DEFAULT_CONFIG.tools` is empty, and when a call has no tools the
`session.update` payload omits the `tools` and `tool_choice` keys entirely, so
it is byte-identical to what it has always been. Enabling tools for one contact
cannot change how any other call is set up.

### The registry

Tools are defined in `tools.js`. Two types:

| Type | Behaviour |
|---|---|
| `builtin` | A handler in `tools.js`, run in process. |
| `http` | A `POST` to the URL in `TOOL_<NAME>_URL`, so the work and its credentials live in another system. |

Currently registered:

| Name | Type | Timeout | Requires |
|---|---|---|---|
| `get_current_time` | builtin | 200 ms | — |
| `check_calendar` | http | 3000 ms | `TOOL_CHECK_CALENDAR_URL` |

An `http` tool whose URL is unset is **defined but unavailable**, and is filtered
out rather than offered and then failing mid-sentence.

Everything here is read-only on purpose. A tool that changes state in another
system is a much larger trust decision than one that answers a question.

### Enabling tools

Per contact and direction, via `contact_config` (until the [API](#pending-api)
lands):

```sql
update public.contact_config cc
   set inbound_enabled_tools  = '{get_current_time}',
       outbound_enabled_tools = '{get_current_time}'
  from public.contacts c
 where cc.contact_id = c.id
   and c.phone_number = '+61415828522';
```

### The call path

1. `session.update` advertises the tools with `tool_choice: "auto"`.
2. OpenAI emits `response.output_item.added` (carrying the tool name), then
   `response.function_call_arguments.done`.
3. `executeTool` runs it and **always resolves, never rejects** — the model gets
   something it can read aloud, not an exception that strands the caller.
4. The result goes back as `conversation.item.create` →
   `function_call_output`, followed by `response.create`.
5. The invocation is recorded in `public.tool_calls` with arguments, result,
   error and duration, linked to the call row.

**Barge-in:** a generation counter increments on
`input_audio_buffer.speech_started`. A tool result that arrives after the caller
interrupted is discarded rather than spoken over them.

**Failures are always legible as failures.** Tools return `{ error }`, never an
empty result, and descriptions instruct the model to say it could not check.
An unreachable calendar reported as "nothing on" is a confident wrong answer —
the worst outcome this feature can produce.

### Latency

On a phone call, silence past about a second and a half reads as a dropped line.
Every tool carries a short timeout, and the model is told to say what it is
doing before calling one. See [Known gaps](#known-gaps) for a real limitation in
how that timeout is enforced.

## Data model

Supabase (`public` schema). RLS is enabled on every table **except
`tool_calls`** — see [Known gaps](#known-gaps) — so the service-role key is
required for everything the app reads and writes.

| Table | Holds |
|---|---|
| `contacts` | One row per person. `phone_number` unique, plus `name`, `email`, `company`, `tags`, `notes`, `combined_history`, `do_not_contact`. Auto-created on first interaction. |
| `contact_config` | Per-person settings, `contact_id` → `contacts`. Mirrors `phone_configs` columns. |
| `phone_configs` | Per-line settings, keyed `twilio_number`. |
| `calls` | One row per call: SID, direction, status, `contact_id`, prompt used, duration, timestamps, metadata. |
| `tool_calls` | One row per tool invocation: name, arguments, result, error, duration, linked to `calls`. |
| `sms_threads` | One row per `(phone_number, twilio_number)` pair, reused forever. |
| `sms_messages` | One row per message, `thread_id` → `sms_threads`. `inbound` → role `user`, `outbound` → role `assistant`. |
| `messages` | **Unused.** Predates `sms_messages`. Nothing reads or writes it. |

All recording is fire-and-forget with a 2500 ms timeout and is never awaited on
the call path. A database that is slow or unreachable is logged and ignored.
`/incoming-sms` is the one exception — it awaits its write, because recording is
the only reason the endpoint exists and nothing is waiting on the response.

## Operations

### Identifying a deployment

`/health` reports two identifiers:

- **`version`** — the git short SHA. Useful locally; on hosts without a `.git`
  directory (Replit) it falls back to `v<package version>`, which is identical
  across every commit.
- **`build`** — a sha256 over the source files, first 12 hex characters. Needs
  no git, works on any host, and changes exactly when the code does.

Files are hashed **by name as well as content**, so a rename moves the
fingerprint, and line endings are normalised — a Windows checkout stores CRLF
and a Linux deployment LF, which otherwise made the same commit fingerprint
differently on each host.

Compare local to deployed:

```bash
curl -s https://your-host/health | jq -r .build
```

If a file is not in the `SOURCES` list in `index.js`, changes to it are
invisible to the fingerprint. Add new modules there.

Both identifiers also render as chips on `/` and `/console`.

### Logging

The media stream logs the full `session.update` payload, so whether tools were
advertised on a given call is answerable from the process log. `LOG_EVENT_TYPES`
in `index.js` controls which OpenAI events are echoed; it includes `error`,
`session.created` and `session.updated`.

## Testing

The suite runs against a **live server**:

```bash
node index.js &                                       # or in another terminal
export $(grep -E '^OPENAI_API_KEY=' .env | xargs)     # the suite reads its own env
PORT=5050 npm test
```

19 tests covering server health, TwiML shape, WebSocket resilience (malformed
JSON, unknown events, missing config), `/outbound-call` authorisation, and
direct OpenAI Realtime connectivity. The last two consume a small amount of
OpenAI credit.

`BASE_URL` is hardcoded to localhost. To run against a deployment, copy the
suite and point it elsewhere — do not commit that copy.

**Not covered:** tools, SMS, config resolution.

## Known gaps

**No Twilio signature validation.** None of the webhook routes check
`X-Twilio-Signature`, so anyone who knows the URL can POST a fake inbound SMS or
call status and have it recorded. This is a logging nuisance today. It becomes
serious the moment SMS auto-reply exists, because a forged inbound message would
make the app send a real one. This should land before that does.

**`tool_calls` has RLS disabled.** Every other table in the `public` schema has
row-level security enabled; `tool_calls` does not. That table holds the
arguments sent to each tool and the result it returned, so anyone holding the
anon key — which is public by design — can read it. Enable RLS on it with no
permissive policy: the app uses the service-role key, which bypasses RLS, so
nothing breaks.

**Tool timeouts do not survive a stalled event loop.** `withTimeout` races a
`setTimeout` against the work. If the loop blocks, both are delayed, and on
unblock microtasks drain before timers — so the work wins the race no matter how
long it took. A `get_current_time` call with a 200 ms budget has been observed
completing in 1048 ms and reporting success. The budget protects against a slow
async operation, not against a blocked loop.

**Transcripts are never written.** `calls.transcript` and `calls.summary` exist
and are always null, so there is no record of what was actually said.

**One shared API key.** No per-tenant keys, no scopes, no rate limiting.

**No principal identity.** `executeTool` receives only `{ callSid }`. A tool
cannot know *whose* calendar or mailbox it should act on, which blocks any
per-user integration.

## Roadmap

In dependency order:

1. **Management API** — the [pending endpoints](#pending-api), read paths first.
2. **Twilio signature validation** — prerequisite for anything that replies.
3. **Generic conversation context** — a provider interface returning normalised
   `{ role, content, at, channel }` turns, so history can span SMS, calls and
   later email without the caller knowing which channel it came from.
4. **SMS auto-reply** — behind an `sms_autorespond` flag, default off, using
   `inbound_sms_prompt` and the context from (3). Replies asynchronously via the
   Twilio REST API rather than in TwiML, so an LLM call cannot blow Twilio's
   webhook timeout. Needs loop protection, per-contact rate limits, and
   STOP/UNSUBSCRIBE handling.
5. **Tools on SMS** — `tools.js` emits the Realtime flat shape; the text API
   needs `{ type, function: { … } }`, so this needs a format argument.
6. **Outbound webhooks** — best-effort POST of a JSON payload after call and
   message events.
7. **Tenant and principal identity** — resolved through the cascade and carried
   into tool execution.
