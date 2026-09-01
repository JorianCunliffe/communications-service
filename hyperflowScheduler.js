import { createHmac } from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { hyperflowProtectionHeaders } from './vercelProtection.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
let timer = null;
let running = false;

export function hyperFlowSchedulerUrl(eventUrl = process.env.HYPERFLOW_EVENT_URL) {
    if (!eventUrl) return null;
    const url = new URL(eventUrl);
    url.pathname = '/api/schedules';
    url.searchParams.set('action', 'tick');
    return url.toString();
}

export function hyperFlowSchedulerHeaders(timestamp, secret = process.env.COMMUNICATIONS_WEBHOOK_SECRET) {
    if (!secret) throw new Error('COMMUNICATIONS_WEBHOOK_SECRET is required for the HyperFlow scheduler helper');
    return {
        'x-communications-timestamp': timestamp,
        'x-communications-signature-v2': `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).digest('hex')}`,
    };
}

export async function runHyperFlowSchedulerTick({
    eventUrl = process.env.HYPERFLOW_EVENT_URL,
    secret = process.env.COMMUNICATIONS_WEBHOOK_SECRET,
    fetcher = safeFetch,
    now = Date.now(),
} = {}) {
    const url = hyperFlowSchedulerUrl(eventUrl);
    if (!url || !secret) return { skipped: true, reason: 'not_configured' };
    const timestamp = String(Math.floor(now / 1000));
    const response = await fetcher(url, {
        method: 'POST',
        headers: {
            ...hyperFlowSchedulerHeaders(timestamp, secret),
            ...hyperflowProtectionHeaders(url),
        },
        signal: AbortSignal.timeout(60_000),
    }, { scope: 'HYPERFLOW_SCHEDULER', maxRedirects: 0 });
    if (!response.ok) {
        const error = new Error(`HyperFlow scheduler tick returned HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
    }
    return { skipped: false, status: response.status };
}

export function startHyperFlowScheduler() {
    if (timer || String(process.env.HYPERFLOW_SCHEDULER_DISABLED || '').toLowerCase() === 'true') return;
    if (!process.env.HYPERFLOW_EVENT_URL || !process.env.COMMUNICATIONS_WEBHOOK_SECRET) return;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await runHyperFlowSchedulerTick();
        } catch (error) {
            console.warn(`HyperFlow scheduler helper: ${error.message}`);
        } finally {
            running = false;
        }
    };
    timer = setInterval(tick, FIVE_MINUTES_MS);
    timer.unref?.();
    tick();
}
