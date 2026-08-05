// Request authentication, both directions.
//
// Operator endpoints — the send and dial routes and everything under /api —
// present a shared key. That lives here rather than in index.js because the
// management API and the dial routes must agree on it exactly, and two copies
// of a constant-time comparison is two chances to get one wrong.
//
// Twilio's webhooks cannot present a header, so they are verified the other
// way: Twilio signs each request with the account's auth token and we check the
// signature. Same file, same idea, opposite direction.

import { timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';

export const E164 = /^\+[1-9]\d{1,14}$/;

// Fails closed: without API_KEY set, protected endpoints stay disabled rather
// than letting anyone place calls on this Twilio account or read the contact
// database. An incomplete deploy is a broken feature, never an open one.
export function isAuthorized(request) {
    const expected = process.env.API_KEY;
    if (!expected) return false;

    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string') return false;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

// The two rejections every protected route shares, kept apart on purpose: 503
// says the feature was never configured, 401 says it was and you got the key
// wrong. Returns a reply when the request should stop, null when it may go on.
export function rejectUnauthorized(request, reply, feature) {
    if (!process.env.API_KEY) {
        console.warn(`Rejected ${request.method} ${request.url}: API_KEY is not configured`);
        return reply.code(503).send({ error: `${feature} is not configured` });
    }
    if (!isAuthorized(request)) {
        return reply.code(401).send({ error: 'Invalid or missing X-API-Key' });
    }
    return null;
}

// --- Twilio webhook signatures ---------------------------------------------
//
// Without this, anyone who knows the URL can POST a fake inbound SMS, call
// status or recording callback. Today that is a logging nuisance; it stops
// being one the moment a webhook makes the app do something — send a reply,
// fetch a recording — which is exactly what is being built next.
//
// Three modes rather than a boolean, because the failure this guards against is
// the deploy that rejects every real call. Validation depends on PUBLIC_URL
// matching the URL Twilio signed byte for byte, and a proxy, a trailing slash
// or an http/https mismatch all break that silently. 'warn' runs the whole
// check and logs the verdict without acting on it, so the logs prove it works
// against real Twilio traffic before it is allowed to reject anything.
//
//   off      no checking at all
//   warn     check and log, but let everything through   (default)
//   enforce  reject a request that does not verify
const SIGNATURE_MODES = ['off', 'warn', 'enforce'];

export function signatureMode() {
    const configured = (process.env.TWILIO_VALIDATE_SIGNATURES || '').trim().toLowerCase();
    if (SIGNATURE_MODES.includes(configured)) return configured;

    // Historic boolean spellings, so setting it to "true" does the strict thing
    // someone setting it to "true" would expect.
    if (['true', '1', 'yes'].includes(configured)) return 'enforce';
    if (['false', '0', 'no'].includes(configured)) return 'off';

    if (configured) console.warn(`Unknown TWILIO_VALIDATE_SIGNATURES value "${configured}" — using "warn"`);

    // Nothing to check against without the token, so an unconfigured install
    // stays quiet rather than logging a failure on every webhook.
    return process.env.TWILIO_AUTH_TOKEN ? 'warn' : 'off';
}

// The URL Twilio signed. It signs the address it was configured with, which is
// PUBLIC_URL — not the host header, which a proxy rewrites, and not the
// protocol, which terminates at the proxy as http. Reconstructing it from the
// request is the single most common reason this check fails on a host that is
// otherwise fine.
function signedUrl(request) {
    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    if (!base) return null;
    return `${base}${request.raw.url}`; // raw.url keeps the query string
}

// Runs the check and reports what it found, without deciding anything. Returns
// { ok, reason, url } — `reason` is null when it verified.
export function checkTwilioSignature(request) {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token) return { ok: false, reason: 'TWILIO_AUTH_TOKEN is not set', url: null };

    const url = signedUrl(request);
    if (!url) return { ok: false, reason: 'PUBLIC_URL is not set', url: null };

    const signature = request.headers['x-twilio-signature'];
    if (typeof signature !== 'string') return { ok: false, reason: 'No X-Twilio-Signature header', url };

    // A GET carries its parameters in the query string, which is already part
    // of the URL above; only a POST body is appended separately.
    const params = request.method === 'POST' && request.body && typeof request.body === 'object'
        ? request.body
        : {};

    try {
        const ok = twilio.validateRequest(token, signature, url, params);
        return { ok, reason: ok ? null : 'Signature did not match', url };
    } catch (error) {
        return { ok: false, reason: `Validation threw: ${error.message}`, url };
    }
}

// The preHandler for Twilio's webhook routes. Returns a reply when the request
// should stop, null when it may go on.
//
// A rejection is 403 and deliberately terse: a forged request should learn
// nothing about why it failed. The log line carries the detail instead.
export function rejectUnsignedTwilio(request, reply) {
    const mode = signatureMode();
    if (mode === 'off') return null;

    const { ok, reason, url } = checkTwilioSignature(request);
    if (ok) return null;

    if (mode === 'warn') {
        console.warn(`Twilio signature would have been rejected on ${request.method} ${request.raw.url}: ${reason} (checked against ${url})`);
        return null;
    }

    console.warn(`Rejected unsigned Twilio request ${request.method} ${request.raw.url}: ${reason} (checked against ${url})`);
    return reply.code(403).send();
}
