---
name: Twilio PUBLIC_URL coupling
description: Why Twilio "application error" usually means a wrong PUBLIC_URL, and where that value lives
---

# Twilio PUBLIC_URL coupling

Rule: `PUBLIC_URL` (in `.replit` `[userenv.shared]`) must exactly match the live Replit dev domain (`$REPLIT_DEV_DOMAIN`) or the production URL. The app builds Twilio callback URLs (`/outbound-answer`, `/call-status`) from it and verifies webhook signatures byte-for-byte against it.

**Why:** A task merge once wrote a stale/suffixed dev domain into `.replit`; Twilio fetched TwiML from a 404 host and every call played "application error" while the server logs looked perfectly clean (the request never arrived).

**How to apply:** When a caller reports "application error" with clean server logs, curl the configured `PUBLIC_URL` first. `.replit` `[userenv.shared]` values win over shared env vars set via setEnvVars. `.replit` edits require writing a temp file and calling `verifyAndReplaceDotReplit`. The dev domain also changes over time — production `.replit.app` URL is the stable choice for Twilio console webhooks. Signature mode is `TWILIO_VALIDATE_SIGNATURES` (off|warn|enforce), currently `warn`.
