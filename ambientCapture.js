import { createHmac } from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { hyperflowProtectionHeaders } from './vercelProtection.js';

export const ambientCaptureInstructions = "When the caller mentions actionable work outside the current conversation objective, call captureWorkItem with their original words. Use the same idempotencyKey for retries of that thought. Do not interrupt to collect missing project, date or other details. Only acknowledge capture after saved:true. On a failure say capture could not be confirmed; never claim it was saved. Then resume the current conversation. Do not capture filler, completed actions or matters already handled by the current workflow. Capturing does not schedule, send or execute anything.";

export function captureConfigured() {
    return Boolean((process.env.HYPERFLOW_AGENT_CONTEXT_URL || process.env.HYPERFLOW_EVENT_URL) && process.env.COMMUNICATIONS_WEBHOOK_SECRET);
}

export function withAmbientCapture(config) {
    if (!captureConfigured()) return config;
    return { ...config, tools: [...new Set([...(config.tools || []), 'captureWorkItem'])],
        systemMessage: `${config.systemMessage}\n\n${ambientCaptureInstructions}` };
}

export async function captureAmbientWork(args, context, { fetchCapture = safeFetch } = {}) {
    if (!captureConfigured()) throw new Error('HyperFlow capture is not configured');
    for (const field of ['tenantId', 'personId', 'threadId', 'communicationId', 'serviceIdentity']) {
        if (!context[field]) throw new Error(`Trusted ${field} is required for capture`);
    }
    const configured = process.env.HYPERFLOW_AGENT_CONTEXT_URL || process.env.HYPERFLOW_EVENT_URL;
    const url = new URL(configured);
    url.pathname = '/api/agent/capture-work';
    url.search = ''; url.hash = '';
    const capture = Object.fromEntries(['rawText', 'idempotencyKey', 'title', 'kind', 'proposedProjectName']
        .filter(key => args?.[key] !== undefined).map(key => [key, args[key]]));
    const body = JSON.stringify({ tenant_id: context.tenantId, person_id: context.personId,
        thread_id: context.threadId, communication_id: context.communicationId,
        service_identity: context.serviceIdentity, capture });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await fetchCapture(url.toString(), {
        method: 'POST', headers: { 'content-type': 'application/json',
            'x-communications-timestamp': timestamp,
            'x-communications-signature-v2': `sha256=${createHmac('sha256', process.env.COMMUNICATIONS_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`,
            ...hyperflowProtectionHeaders(url.toString(), configured) },
        body, signal: context.signal || AbortSignal.timeout(8000)
    }, { scope: 'HYPERFLOW_AGENT_CONTEXT', allowedHosts: [url.hostname.toLowerCase()], maxRedirects: 0 });
    const result = await response.json();
    if (!response.ok || result?.saved !== true || typeof result.id !== 'string' || !result.id) {
        throw new Error('Capture could not be confirmed. Do not claim it was saved; reuse the same idempotencyKey if retrying.');
    }
    return { saved: true, id: result.id, acknowledgement: 'Captured. We can review that later.' };
}

export const ambientCaptureTool = {
    type: 'builtin', timeoutMs: 8000,
    description: ambientCaptureInstructions,
    parameters: { type: 'object', additionalProperties: false, properties: {
        rawText: { type: 'string', description: "The caller's original actionable statement." },
        idempotencyKey: { type: 'string', description: 'Stable key for this thought, reused on retries.' },
        title: { type: 'string' }, kind: { type: 'string', enum: ['task', 'meeting', 'reminder', 'follow_up', 'note', 'unknown'] },
        proposedProjectName: { type: 'string' }
    }, required: ['rawText', 'idempotencyKey'] },
    handler: captureAmbientWork
};
