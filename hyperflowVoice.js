import { createHmac, randomUUID } from 'node:crypto';
import { safeFetch } from './safeFetch.js';
import { hyperflowProtectionHeaders } from './vercelProtection.js';

function contextUrl() {
    const configured = String(process.env.HYPERFLOW_AGENT_CONTEXT_URL || '').trim();
    if (configured) return configured;
    const eventUrl = String(process.env.HYPERFLOW_EVENT_URL || '').trim();
    if (!eventUrl) return null;
    const url = new URL(eventUrl);
    url.pathname = '/api/agent/voice-context';
    return url.toString();
}

function signature(timestamp, body) {
    const secret = process.env.COMMUNICATIONS_WEBHOOK_SECRET;
    if (!secret) throw new Error('COMMUNICATIONS_WEBHOOK_SECRET is required for HyperFlow voice context');
    return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export async function requestHyperFlowVoiceContext({
    tenantId,
    personId,
    threadId,
    communicationId,
    serviceIdentity,
    utterance = null,
}) {
    const url = contextUrl();
    if (!url) throw new Error('HYPERFLOW_AGENT_CONTEXT_URL is not configured');
    if (!tenantId || !personId || !threadId || !communicationId || !serviceIdentity) {
        throw new Error('Trusted tenant, person, thread, communication and service identity are required');
    }
    const payload = {
        request_id: `voice_ctx_${randomUUID().replaceAll('-', '')}`,
        tenant_id: tenantId,
        person_id: personId,
        thread_id: threadId,
        communication_id: communicationId,
        service_identity: serviceIdentity,
        ...(typeof utterance === 'string' && utterance.trim() ? { utterance: utterance.trim().slice(0, 4000) } : {}),
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const configuredHosts = String(process.env.HYPERFLOW_AGENT_CONTEXT_HOSTS || '')
        .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
    const allowedHosts = configuredHosts.length ? configuredHosts : [new URL(url).hostname.toLowerCase()];
    const response = await safeFetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-communications-timestamp': timestamp,
            'x-communications-signature-v2': signature(timestamp, body),
            ...hyperflowProtectionHeaders(url, process.env.HYPERFLOW_AGENT_CONTEXT_URL || process.env.HYPERFLOW_EVENT_URL),
        },
        body,
        signal: AbortSignal.timeout(4500),
    }, { scope: 'HYPERFLOW_AGENT_CONTEXT', allowedHosts, maxRedirects: 0 });
    const text = (await response.text()).slice(0, 128 * 1024);
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) throw new Error(`HyperFlow voice context returned HTTP ${response.status}${parsed?.error ? `: ${parsed.error}` : ''}`);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.instructions !== 'string' || typeof parsed.greeting !== 'string') {
        throw new Error('HyperFlow voice context returned an invalid response');
    }
    return parsed;
}

export function applyHyperFlowVoiceContext(config, context) {
    const evidence = context.project?.context ? JSON.stringify(context.project.context).slice(0, 30000) : null;
    const scopedInstructions = [
        context.instructions,
        evidence ? `--- HYPERFLOW PROJECT CONTEXT DATA ---\n${evidence}\n--- END HYPERFLOW PROJECT CONTEXT DATA ---` : null,
        'Use select_hyperflow_project whenever the caller selects or switches projects. Never expose context from a project until that tool returns it as authorized for this call.',
    ].filter(Boolean).join('\n\n');
    return {
        ...config,
        systemMessage: `${config.systemMessage}\n\n${scopedInstructions}`,
        greetingText: context.greeting,
        aiSpeaksFirst: true,
        liveTranscript: true,
        wantsHistory: false,
        tools: [...new Set([
            ...(config.tools || []).filter((name) => ['end_call', 'get_current_time'].includes(name)),
            'select_hyperflow_project',
        ])],
        hyperflowRouting: context.routing || null,
    };
}
