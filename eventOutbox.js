import { createHmac } from 'node:crypto';
import { getSupabase } from './configResolver.js';
import { assertFetchable } from './recordingSources.js';
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
    const db = getSupabase();
    const target = destination || process.env.HYPERFLOW_EVENT_URL;
    if (!db || !target) return null;

    const event = {
        event_id: prefixedId('evt'),
        communication_id: communicationId,
        type,
        occurred_at: new Date().toISOString(),
        purpose,
        correlation,
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
    const db = getSupabase();
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

export async function deliverPendingEvents() {
    const db = getSupabase();
    if (!db) return { attempted: 0, delivered: 0 };

    const now = new Date().toISOString();
    const { data, error } = await db.from('outbound_events').select('*')
        .in('status', ['pending', 'retrying'])
        .lte('next_attempt_at', now)
        .lt('attempts', MAX_ATTEMPTS)
        .order('created_at')
        .limit(BATCH_SIZE);
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

            const response = await fetch(destination, {
                method: 'POST', headers, body, signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await db.from('outbound_events').update({
                status: 'delivered', attempts, delivered_at: new Date().toISOString(), last_error: null,
            }).eq('event_id', row.event_id);
            delivered += 1;
        } catch (eventError) {
            const exhausted = attempts >= MAX_ATTEMPTS;
            const delayMs = Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(attempts - 1, 9)));
            await db.from('outbound_events').update({
                status: exhausted ? 'failed' : 'retrying',
                attempts,
                last_error: String(eventError.message).slice(0, 500),
                next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
            }).eq('event_id', row.event_id);
        }
    }
    return { attempted: data?.length || 0, delivered };
}

export function startEventSweeper() {
    if (timer || !getSupabase()) return;
    const sweep = () => deliverPendingEvents().catch((error) => console.warn(`Event outbox: ${error.message}`));
    timer = setInterval(sweep, 15000);
    timer.unref?.();
    sweep();
}
