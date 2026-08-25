import { createHmac } from 'node:crypto';
import { getDatabase } from './database.js';
import { assertFetchable } from './recordingSources.js';
import { safeFetch } from './safeFetch.js';
import { prefixedId } from './communicationModel.js';

const MAX_ATTEMPTS = 12;
const BATCH_SIZE = 20;
let timer = null;

export async function enqueueEvent({
    type,
    communicationId = null,
    purpose = null,
    correlation = {},
    payload = {},
    destination = null,
}) {
    const db = getDatabase();
    const target = destination || process.env.HYPERFLOW_EVENT_URL;
    if (!db || !target) return null;
    if (!process.env.COMMUNICATIONS_WEBHOOK_SECRET) throw new Error('COMMUNICATIONS_WEBHOOK_SECRET is required for durable webhook delivery');

    const eventCorrelation = correlation.external_project_id && !correlation.project_id
        ? { ...correlation, project_id: correlation.external_project_id }
        : correlation;
    const event = {
        event_id: prefixedId('evt'),
        communication_id: communicationId,
        type,
        occurred_at: new Date().toISOString(),
        purpose,
        correlation: eventCorrelation,
        payload,
    };

    const { error } = await db.from('outbound_events').insert({
        event_id: event.event_id,
        communication_id: communicationId,
        type,
        destination: target,
        payload: event,
        status: 'pending',
        next_attempt_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Could not enqueue ${type}: ${error.message}`);
    return event;
}

export async function callbackForThread(threadId) {
    const db = getDatabase();
    if (!db || !threadId) return null;
    const { data, error } = await db.from('communication_threads').select('callback_url')
        .eq('thread_id', threadId).maybeSingle();
    if (error) throw new Error(`Could not read thread callback: ${error.message}`);
    return data?.callback_url || null;
}

function signature(body) {
    const secret = process.env.COMMUNICATIONS_WEBHOOK_SECRET;
    return secret ? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` : null;
}

export function describeDeliveryError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error && typeof error === 'object' ? error.cause : null;
    if (!cause || typeof cause !== 'object') return message;
    const detail = [cause.code, cause.message].filter(Boolean).join(': ');
    return detail ? `${message} (${detail})` : message;
}

export async function deliverPendingEvents() {
    const db = getDatabase();
    if (!db) return { attempted: 0, delivered: 0 };

    const { data, error } = await db.rpc('claim_outbound_events', { p_limit: BATCH_SIZE, p_lease_seconds: 60 });
    if (error) throw new Error(`Could not read outbound events: ${error.message}`);

    let delivered = 0;
    for (const row of data || []) {
        const attempts = (row.attempts || 0) + 1;
        try {
            const destination = await assertFetchable(row.destination, 'communications_webhook');
            const body = JSON.stringify(row.payload);
            const headers = { 'content-type': 'application/json', 'x-communications-event-id': row.event_id };
            const signed = signature(body);
            if (signed) headers['x-communications-signature'] = signed;

            const allowedHosts = process.env.COMMUNICATIONS_WEBHOOK_HOSTS
                ? process.env.COMMUNICATIONS_WEBHOOK_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
                : null;
            const response = await safeFetch(destination, {
                method: 'POST', headers, body, signal: AbortSignal.timeout(15000),
            }, { scope: 'COMMUNICATIONS_WEBHOOK', allowedHosts });
            if (!response.ok) {
                const deliveryError = new Error(`HTTP ${response.status}`);
                deliveryError.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
                throw deliveryError;
            }

            await db.from('outbound_events').update({
                status: 'delivered', attempts, delivered_at: new Date().toISOString(), last_error: null,
                lease_token: null, lease_expires_at: null,
            }).eq('event_id', row.event_id).eq('lease_token', row.lease_token);
            delivered += 1;
        } catch (eventError) {
            const exhausted = attempts >= MAX_ATTEMPTS || eventError.retryable === false;
            const delayMs = Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(attempts - 1, 9)));
            await db.from('outbound_events').update({
                status: exhausted ? 'failed' : 'retrying',
                attempts,
                last_error: describeDeliveryError(eventError).slice(0, 500),
                next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
                lease_token: null, lease_expires_at: null,
            }).eq('event_id', row.event_id).eq('lease_token', row.lease_token);
        }
    }
    return { attempted: data?.length || 0, delivered };
}

export function startEventSweeper() {
    if (timer || !getDatabase()) return;
    const sweep = () => deliverPendingEvents().catch((error) => console.warn(`Event outbox: ${error.message}`));
    timer = setInterval(sweep, 15000);
    timer.unref?.();
    sweep();
}
