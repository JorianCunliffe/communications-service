// Shared request authentication for every endpoint an operator calls, as
// opposed to the ones Twilio calls. Lives in its own module because the
// management API and the send/dial endpoints must agree on it exactly — two
// copies of a constant-time comparison is two chances to get one wrong.

import { timingSafeEqual } from 'node:crypto';

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
