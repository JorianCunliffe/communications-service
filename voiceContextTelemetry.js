// Optional, metadata-only instrumentation for the existing HyperFlow context read.
// Deliberately no transport changes, dependencies, persistence or network exporter.
import { performance } from 'node:perf_hooks';

const MAX_PENDING = 64;
let pending = [];
let dropped = 0;
let scheduled = false;

function enqueue(event) {
    if (pending.length >= MAX_PENDING) {
        dropped++;
        return;
    }
    pending.push(event);
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
        const batch = pending;
        const droppedCount = dropped;
        pending = [];
        dropped = 0;
        scheduled = false;
        try {
            console.info('voice_context_telemetry', { events: batch, dropped: droppedCount });
        } catch {
            // Observability must not change the outcome of a call.
        }
    });
}

export function startVoiceContextTelemetry({
    requestId,
    body,
    enabled = process.env.VOICE_CONTEXT_TELEMETRY === '1',
    clock = () => performance.now(),
    wallClock = () => Date.now(),
    emit = enqueue,
}) {
    if (!enabled) return null;
    try {
        const started = clock();
        const event = {
            schema_version: 1,
            provider: 'hyperflow',
            operation: 'voice_context',
            request_id: requestId,
            started_at_utc: new Date(wallClock()).toISOString(),
            request_bytes: typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : null,
            response_bytes: null,
            headers_ms: null,
            body_ms: null,
            status_code: null,
        };
        let finished = false;
        return {
            headers(status) {
                try {
                    if (finished) return;
                    event.status_code = Number.isInteger(status) ? status : null;
                    event.headers_ms = Math.max(0, clock() - started);
                } catch { /* best effort */ }
            },
            body(text) {
                try {
                    if (finished) return;
                    event.response_bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : null;
                    event.body_ms = Math.max(0, clock() - started);
                } catch { /* best effort */ }
            },
            finish(outcome) {
                if (finished) return;
                finished = true;
                try {
                    emit({
                        ...event,
                        finished_at_utc: new Date(wallClock()).toISOString(),
                        duration_ms: Math.max(0, clock() - started),
                        outcome: ['ok', 'failed', 'timeout', 'cancelled'].includes(outcome) ? outcome : 'failed',
                    });
                } catch { /* best effort */ }
            },
        };
    } catch {
        return null;
    }
}
