#  Speech Assistant with Twilio Voice and the OpenAI Realtime API (Node.js)

This application demonstrates how to use Node.js, [Twilio Voice](https://www.twilio.com/docs/voice) and [Media Streams](https://www.twilio.com/docs/voice/media-streams), and [OpenAI's Realtime API](https://platform.openai.com/docs/) to make a phone call to speak with an AI Assistant. 

The application opens websockets with the OpenAI Realtime API and Twilio, and sends voice audio from one to the other to enable a two-way conversation.

See [here](https://www.twilio.com/en-us/blog/voice-ai-assistant-openai-realtime-api-node) for a tutorial overview of the code.

This application uses the following Twilio products in conjuction with OpenAI's Realtime API:
- Voice (and TwiML, Media Streams)
- Phone Numbers

Per-call settings (model, voice, prompt, intro messages) can be loaded from
Supabase based on the phone number involved, and calls can be placed
programmatically. See [Call configuration](#call-configuration) and
[Outbound calls](#outbound-calls).

## Prerequisites

To use the app, you will  need:

- **Node.js 18+** We used \`18.20.4\` for development; download from [here](https://nodejs.org/).
- **A Twilio account.** You can sign up for a free trial [here](https://www.twilio.com/try-twilio).
- **A Twilio number with _Voice_ capabilities.** [Here are instructions](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console) to purchase a phone number.
- **An OpenAI account and an OpenAI API Key.** You can sign up [here](https://platform.openai.com/).
  - **OpenAI Realtime API access.**

## Local Setup

There are 4 required steps to get the app up-and-running locally for development and testing:
1. Run ngrok or another tunneling solution to expose your local server to the internet for testing. Download ngrok [here](https://ngrok.com/).
2. Install the packages
3. Twilio setup
4. Update the .env file

### Open an ngrok tunnel
When developing & testing locally, you'll need to open a tunnel to forward requests to your local development server. These instructions use ngrok.

Open a Terminal and run:
```
ngrok http 5050
```
Once the tunnel has been opened, copy the `Forwarding` URL. It will look something like: `https://[your-ngrok-subdomain].ngrok.app`. You will
need this when configuring your Twilio number setup.

Note that the `ngrok` command above forwards to a development server running on port `5050`, which is the default port configured in this application. If
you override the `PORT` defined in `index.js`, you will need to update the `ngrok` command accordingly.

Keep in mind that each time you run the `ngrok http` command, a new URL will be created, and you'll need to update it everywhere it is referenced below.

### Install required packages

Open a Terminal and run:
```
npm install
```

### Twilio setup

#### Point a Phone Number to your ngrok URL
In the [Twilio Console](https://console.twilio.com/), go to **Phone Numbers** > **Manage** > **Active Numbers** and click on the additional phone number you purchased for this app in the **Prerequisites**.

In your Phone Number configuration settings, update the first **A call comes in** dropdown to **Webhook**, and paste your ngrok forwarding URL (referenced above), followed by `/incoming-call`. For example, `https://[your-ngrok-subdomain].ngrok.app/incoming-call`. Then, click **Save configuration**.

### Update the .env file

Create a `/env` file, or copy the `.env.example` file to `.env`:

```
cp .env.example .env
```

In the .env file, update the `OPENAI_API_KEY` to your OpenAI API key from the **Prerequisites**.

The remaining variables are optional — leave them as-is to run with the
built-in defaults. See [Call configuration](#call-configuration) and
[Outbound calls](#outbound-calls).

## Run the app
Once ngrok is running, dependencies are installed, Twilio is configured properly, and the `.env` is set up, run the dev server with the following command:
```
node index.js
```
## Test the app
With the development server running, call the phone number you purchased in the **Prerequisites**. After the introduction, you should be able to talk to the AI Assistant. Have fun!

## Call configuration

Every tunable lives in `DEFAULT_CONFIG` in `config.js`: `model`, `effort`,
`voice`, `temperature`, `systemMessage`, the two `<Say>` intro lines and their
`introVoice`, `greetingText`, and `aiSpeaksFirst`. With no database configured
these defaults apply to every call, exactly as the original app behaved.

### Per-number config from Supabase

Set `SUPABASE_CONFIG_ENABLED=true` along with `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` to load settings from `public.phone_configs`. Each
row is keyed by a phone number in E.164 (`twilio_number`) and lookup runs in
this order:

1. **The caller's number** — a per-person override.
2. **The number they dialled** — the default persona for that line.
3. **`DEFAULT_CONFIG`** — if neither has a row.

Outbound calls key on the `from` number only.

Columns map to config fields as: `model`, `effort`, `temperature`,
`intro_message`, `intro_message_2`, `intro_voice`, `ai_speaks_first`, plus the
pre-existing `call_voice`, `call_system_prompt` and `call_greeting`. **Any
column left null falls back to the default**, so a row only needs to set what
it actually changes. A row with `call_enabled = false` is ignored.

Config never blocks a call: a lookup that times out (1500 ms), errors, or
matches nothing falls back to the defaults and the call proceeds. Rows are
cached for 60 seconds. Setting `SUPABASE_CONFIG_ENABLED` to anything but `true`
turns the whole feature off.

### Using the caller's name

Any of `call_system_prompt`, `intro_message`, `intro_message_2` and
`call_greeting` may contain a `{{name}}` placeholder. It is filled from
`public.contacts.name`, matched on the caller's number:

```sql
insert into public.contacts (phone_number, name) values ('+447700900123', 'Sam');
update public.phone_configs
   set intro_message = 'Hi {{name}}, connecting you now.'
 where twilio_number = '+447700900123';
```

For callers with no contact row, `{{name}}` becomes "there" — fine for
"Hi {{name}}", wrong for "speaking with {{name}}". Write `{{name|the caller}}`
to choose the fallback per placeholder:

| Template | Known caller | Unknown caller |
|---|---|---|
| `Hi {{name}}` | `Hi Sam` | `Hi there` |
| `speaking with {{name\|the caller}}` | `speaking with Sam` | `speaking with the caller` |

The contact lookup runs in parallel with the config lookup, so it costs no
extra latency, and a failure only means the fallback is used — it never affects
the call. Note `public.contacts` has RLS enabled, so this needs the
service-role key.

### One voice for the whole call

The `<Say>` intro is spoken by Twilio's text-to-speech, a different voice from
the assistant's, so playing it means the caller hears two different voices.
**`playIntro` is off by default**: no `<Say>` is emitted, `aiSpeaksFirst` is on,
and the assistant opens the call itself in its own voice using `greetingText`:

```js
greetingText: 'Open by saying "Iris here." then greet {{name|the caller}} by name and ask how you can help.',
```

The caller hears a second or so of silence while the realtime session opens,
then the assistant speaks. The intro code and its messages are retained — set
`play_intro = true` on a number to bring the Twilio intro back for that line:

```sql
update public.phone_configs set play_intro = true where twilio_number = '+447700900123';
```

With `playIntro` on, the original TwiML renders byte-for-byte as it always did.
Blanking an individual intro message drops just that `<Say>` and its `<Pause>`.

### Reasoning effort

`effort` applies to reasoning-capable models such as `gpt-realtime-2`
(`minimal`, `low`, `medium`, `high`, `xhigh`). It is only sent when set, so the
original `gpt-realtime` model is unaffected. `low` is a good starting point for
voice — higher values add latency.

## Outbound calls

`POST /outbound-call` places a call and bridges it into the same assistant.
It requires `API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
`PUBLIC_URL`; **if `API_KEY` is unset the endpoint is disabled and returns 503**,
so an incomplete deploy can't leave call placing open to the internet.

```bash
curl -X POST https://your-app.example.com/outbound-call \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "+447700900123",
        "from": "+447700900999",
        "overrides": { "voice": "cedar", "aiSpeaksFirst": true }
      }'
```

`to` and `from` must be E.164. `overrides` is optional and may only contain
`DEFAULT_CONFIG` field names; anything else is rejected with a 400. Twilio then
fetches `/outbound-answer`, which skips the "please wait" intro since the callee
has just picked up.

`GET /health` reports whether the Supabase config and outbound calling are
wired up.

## Special features

### Have the AI speak first
Set `aiSpeaksFirst` to `true` — in `DEFAULT_CONFIG` (`config.js`) to change it
everywhere, or in the `ai_speaks_first` column for one phone number. What the
assistant says is the `greetingText` / `call_greeting` value.

### Interrupt handling/AI preemption
When the user speaks and OpenAI sends `input_audio_buffer.speech_started`, the code will clear the Twilio Media Streams buffer and send OpenAI `conversation.item.truncate`.

Depending on your application's needs, you may want to use the [`input_audio_buffer.speech_stopped`](https://platform.openai.com/docs/api-reference/realtime-server-events/input_audio_buffer/speech_stopped) event, instead.
