import { randomUUID } from 'node:crypto';

export const CORRELATION_FIELDS = [
    'tenant_id', 'external_project_id', 'run_id', 'task_id', 'hold_id',
    'thread_id', 'calendar_event_id', 'person_id',
];

export function prefixedId(prefix) {
    return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function normalisePurpose(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('"purpose" must be an object');
    }

    const purpose = structuredClone(value);
    if (typeof purpose.type !== 'string' || !purpose.type.trim()) {
        throw new Error('"purpose.type" must be a non-empty string');
    }
    purpose.type = purpose.type.trim();

    if (purpose.type === 'human_ask') {
        if (typeof purpose.ask_id !== 'string' || !purpose.ask_id.trim()) {
            throw new Error('A human_ask purpose requires a non-empty "ask_id"');
        }
        purpose.ask_id = purpose.ask_id.trim();
        if (purpose.token !== undefined && (typeof purpose.token !== 'string' || !purpose.token)) {
            throw new Error('"purpose.token" must be a non-empty string when supplied');
        }
    }

    return purpose;
}

export function normaliseCorrelation(value = {}) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('"correlation" must be an object');
    }

    const correlation = {};
    for (const field of CORRELATION_FIELDS) {
        const item = value[field];
        if (item === undefined || item === null || item === '') continue;
        if (typeof item !== 'string') throw new Error(`"correlation.${field}" must be a string`);
        correlation[field] = item;
    }
    // Transition alias: workflow project IDs are external correlation, never
    // promoted into the internal UUID foreign key.
    if (!correlation.external_project_id && typeof value.project_id === 'string' && value.project_id) {
        correlation.external_project_id = value.project_id;
    }
    return correlation;
}

export function canonicalCommunication({
    communicationId,
    channel,
    direction,
    occurredAt = new Date().toISOString(),
    personId = null,
    content = null,
    transcript = null,
    summary = null,
    provider = null,
    providerId = null,
    correlation = {},
    purpose = null,
    resolution = null,
    businessStatus = null,
    disposition = null,
    successful = null,
    memoryEligible = true,
    failureCode = null,
    failureReason = null,
    outcomeSource = null,
    outcomeConfidence = null,
    outcomeDetectedAt = null,
}) {
    return {
        communication_id: communicationId,
        channel,
        direction,
        person_id: personId,
        occurred_at: occurredAt,
        content,
        transcript,
        summary,
        provider,
        provider_id: providerId,
        correlation,
        purpose,
        resolution,
        outcome: {
            business_status: businessStatus,
            disposition,
            successful,
            memory_eligible: memoryEligible,
            failure_code: failureCode,
            failure_reason: failureReason,
            source: outcomeSource,
            confidence: outcomeConfidence,
            detected_at: outcomeDetectedAt,
        },
    };
}

function queryError(result, label) {
    if (result?.error) throw new Error(`${label}: ${result.error.message}`);
    return result?.data;
}

// Explicit IDs win. A human Ask is next. Only then may an inbound interaction
// attach to the most recent open thread for the same person. That order is the
// service boundary in code: explicit correlation first, inference later.
export async function resolveCommunicationThread({
    db,
    participantIdentity,
    serviceIdentity = null,
    direction,
    threadId = null,
    purpose = null,
    correlation = {},
    callbackUrl = null,
}) {
    const explicitId = threadId || correlation.thread_id || null;
    let thread = null;
    let linkType = null;

    if (explicitId) {
        linkType = 'explicit';
        thread = queryError(await db.from('communication_threads')
            .select('*').eq('thread_id', explicitId).maybeSingle(), 'Thread lookup');
        if (thread && thread.status !== 'open') throw new Error(`Thread ${explicitId} is ${thread.status} and cannot accept new communications`);
    }

    if (!thread && purpose?.type === 'human_ask') {
        const binding = queryError(await db.from('ask_bindings')
            .select('thread_id,status').eq('ask_id', purpose.ask_id).maybeSingle(), 'Ask lookup');
        if (binding) {
            linkType = 'explicit';
            if (binding.status !== 'open') throw new Error(`Ask ${purpose.ask_id} is ${binding.status}`);
            thread = queryError(await db.from('communication_threads')
                .select('*').eq('thread_id', binding.thread_id).maybeSingle(), 'Ask thread lookup');
        }
    }

    if (!thread && direction === 'inbound' && participantIdentity) {
        const result = await db.from('communication_threads')
            .select('*')
            .eq('participant_identity', participantIdentity)
            .eq('status', 'open')
            .order('last_activity_at', { ascending: false })
            .limit(2);
        const candidates = queryError(result, 'Open thread lookup') || [];
        // Never guess between two live intents. A single open thread is safe
        // minimal correlation; ambiguity requires an explicit thread/Ask ID.
        thread = candidates.length === 1 ? candidates[0] : null;
        if (thread) linkType = 'inferred';
    }

    if (!thread && (purpose || explicitId)) {
        linkType = 'explicit';
        const newThreadId = explicitId || prefixedId('thread');
        thread = queryError(await db.from('communication_threads').insert({
            thread_id: newThreadId,
            status: 'open',
            participant_identity: participantIdentity,
            service_identity: serviceIdentity,
            purpose,
            correlation: { ...correlation, thread_id: newThreadId },
            callback_url: callbackUrl,
            last_activity_at: new Date().toISOString(),
        }).select('*').single(), 'Thread create');
    }

    if (!thread) return { threadId: null, linkType: null, purpose, correlation };

    const inheritedPurpose = purpose || thread.purpose || null;
    const inheritedCorrelation = {
        ...(thread.correlation || {}),
        ...correlation,
        thread_id: thread.thread_id,
    };

    await db.from('communication_threads').update({
        last_activity_at: new Date().toISOString(),
        purpose: inheritedPurpose,
        correlation: inheritedCorrelation,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    }).eq('thread_id', thread.thread_id);

    if (inheritedPurpose?.type === 'human_ask') {
        const existing = queryError(await db.from('ask_bindings').select('thread_id,status')
            .eq('ask_id', inheritedPurpose.ask_id).maybeSingle(), 'Ask binding lookup');
        if (existing && existing.status !== 'open') throw new Error(`Ask ${inheritedPurpose.ask_id} is ${existing.status}`);
        queryError(await db.from('ask_bindings').upsert({
            ask_id: inheritedPurpose.ask_id,
            thread_id: thread.thread_id,
            tenant_id: inheritedCorrelation.tenant_id || null,
            status: existing?.status || 'open',
            purpose: inheritedPurpose,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'ask_id' }), 'Ask binding');
    }

    return {
        threadId: thread.thread_id,
        linkType,
        purpose: inheritedPurpose,
        correlation: inheritedCorrelation,
        callbackUrl: callbackUrl || thread.callback_url || null,
    };
}
