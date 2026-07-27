# Speech Assistant – Twilio + OpenAI Realtime API

A Node.js server that bridges Twilio phone calls to OpenAI's Realtime API, enabling two-way AI voice conversations over the phone.

## How to run

1. Ensure `OPENAI_API_KEY` is set in Replit Secrets (Realtime API access required).
2. Start the **"Start application"** workflow — the server listens on port 3000.
3. Point your Twilio phone number's "A call comes in" webhook to:
   `https://<your-replit-dev-domain>/incoming-call`
4. Call the Twilio number to speak with the AI assistant.

## Stack

- **Runtime:** Node.js 18+ (ES modules)
- **Server:** Fastify + `@fastify/websocket`
- **External APIs:** OpenAI Realtime API, Twilio Voice / Media Streams

## Required secrets

| Key | Description |
|-----|-------------|
| `OPENAI_API_KEY` | OpenAI API key with Realtime API access |

## Key files

- `index.js` — entire application (Fastify routes, WebSocket bridge)
- `.env.example` — template for required env vars

## User preferences

_None recorded yet._
