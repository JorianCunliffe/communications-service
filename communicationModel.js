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
    tenantId,
    communicationId,
    threadId = null,
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
        contract_version: '2.0',
        tenant_id: tenantId,
        communication_id: communicationId,
        thread_id: threadId,
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

export const THREAD_SCORE_THRESHOLD = 65;
export const THREAD_SCORE_MARGIN = 12;

export function normaliseThreadIdentity(value) {
    const exact = typeof value === 'string' ? value.trim() : '';
    if (!exact) return '';
    const lowered = exact.toLowerCase();
    const withoutScheme = lowered.replace(/^(?:tel|sms|whatsapp):/, '').trim();
    if (/^[+0-9().\s-]+$/.test(withoutScheme) && (withoutScheme.match(/\d/g) || []).length >= 6) {
        const digits = withoutScheme.replace(/\D/g, '');
        if (withoutScheme.startsWith('+')) return `+${digits}`;
        if (digits.startsWith('00')) return `+${digits.slice(2)}`;
        return digits;
    }
    return lowered;
}

function identityVariants(value) {
    const exact = typeof value === 'string' ? value.trim() : '';
    if (!exact) return [];
    return [...new Set([exact, exact.toLowerCase(), normaliseThreadIdentity(exact)])];
}

function identityKey(value) {
    return normaliseThreadIdentity(value);
}

function externalProject(correlation = {}) {
    return correlation.external_project_id || null;
}

function topicTerms(value) {
    const stop = new Set(['about', 'after', 'again', 'also', 'before', 'could', 'from', 'have', 'into', 'just', 'please', 're', 'that', 'the', 'their', 'there', 'they', 'this', 'with', 'would', 'your']);
    return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
        .filter((term) => !stop.has(term)).slice(0, 20);
}

function hoursBetween(left, right) {
    const leftValue = new Date(left).valueOf();
    const rightValue = new Date(right).valueOf();
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
    return Math.abs(leftValue - rightValue) / 3_600_000;
}

function feedbackApplies(item, input) {
    const inputIdentities = input.identities || [input.identity].filter(Boolean);
    if (item.active === false) return false;
    if (item.reason_code === 'channel_boundary' && item.channel && item.channel !== input.channel) return false;
    const personMatches = item.person_id && input.personIds.includes(item.person_id);
    const identityMatches = item.identity_value && inputIdentities.includes(identityKey(item.identity_value));
    if (item.person_id && input.personIds.length && !personMatches) return false;
    if ((item.person_id || item.identity_value) && !personMatches && !identityMatches) return false;
    if (item.external_project_id && item.external_project_id !== input.externalProjectId) return false;
    if (item.project_id && item.project_id !== input.projectId) return false;
    if (item.reason_code === 'wrong_topic' && Array.isArray(item.topic_terms) && item.topic_terms.length) {
        const currentTerms = new Set(topicTerms(input.subject || input.content));
        if (!item.topic_terms.some((term) => currentTerms.has(term))) return false;
    }
    if (item.reason_code === 'time_gap' && hoursBetween(input.occurredAt, item.created_at) > 336) return false;
    if (!item.person_id && !item.identity_value && !item.external_project_id && !item.project_id
        && !(Array.isArray(item.topic_terms) && item.topic_terms.length)) return false;
    return true;
}

// Scoring is deliberately inspectable. Every point is returned as a named
// signal, and hard human corrections cannot be outweighed by heuristics.
export function scoreThreadCandidate(thread, input, feedback = [], participantEvidence = {}) {
    const signals = [];
    let score = 0;
    const add = (name, value, detail = null) => {
        if (!value) return;
        score += value;
        signals.push({ name, value, ...(detail ? { detail } : {}) });
    };
    const matchingFeedback = feedback.filter((item) => feedbackApplies(item, input));
    if (matchingFeedback.some((item) => item.from_thread_id === thread.thread_id && item.to_thread_id !== thread.thread_id)) {
        return { thread_id: thread.thread_id, score: -1000, confidence: 0, excluded: true,
            signals: [{ name: 'human_rejected', value: -1000 }] };
    }

    const threadProject = thread.external_project_id || externalProject(thread.correlation);
    const participantPeople = participantEvidence.people || [];
    const participantIdentities = participantEvidence.identities || [];
    const candidatePeople = [...new Set([thread.person_id, ...participantPeople].filter(Boolean))];
    const overlappingPeople = candidatePeople.filter((personId) => input.personIds.includes(personId));
    const participantMatch = overlappingPeople.length > 0;
    const inputIdentities = input.identities || [input.identity].filter(Boolean);
    const exactIdentity = inputIdentities.some((identity) => identityKey(thread.participant_identity) === identity
        || participantIdentities.includes(identity));
    if (input.personIds.length && candidatePeople.length && !participantMatch) {
        return { thread_id: thread.thread_id, score: -1000, confidence: 0, excluded: true,
            signals: [{ name: 'different_person', value: -1000 }] };
    }
    const internalProjectConflict = input.projectId && thread.project_id && thread.project_id !== input.projectId;
    const externalProjectConflict = input.externalProjectId && threadProject && threadProject !== input.externalProjectId;
    if (internalProjectConflict || externalProjectConflict) {
        return { thread_id: thread.thread_id, score: -1000, confidence: 0, excluded: true,
            signals: [{ name: 'different_project', value: -1000 }] };
    }
    const ageHours = hoursBetween(input.occurredAt, thread.last_activity_at || thread.created_at);
    const inputTerms = topicTerms(input.subject || input.content);
    const candidateTerms = new Set(topicTerms(`${thread.last_subject || ''} ${thread.title || ''} ${thread.summary || ''}`));
    const sharedTerms = inputTerms.filter((term) => candidateTerms.has(term));
    if (!participantMatch && !exactIdentity && sharedTerms.length < 2) {
        return { thread_id: thread.thread_id, score: -1000, confidence: 0, excluded: true,
            signals: [{ name: 'insufficient_participant_evidence', value: -1000 }] };
    }

    add('human_preferred', matchingFeedback.some((item) => item.to_thread_id === thread.thread_id) ? 30 : 0);
    add('exact_identity', exactIdentity ? 45 : 0);
    add('person_overlap', participantMatch ? 30 : 0);
    add('additional_person_overlap', Math.min(Math.max(0, overlappingPeople.length - 1) * 10, 20));
    add('full_person_coverage', input.personIds.length > 1 && input.personIds.every((personId) => candidatePeople.includes(personId)) ? 10 : 0);
    if ((input.projectId && thread.project_id === input.projectId)
        || (input.externalProjectId && threadProject === input.externalProjectId)) add('same_project', 35);
    const recentChannel = thread.last_channel || thread.primary_channel;
    add('same_channel', input.channel && recentChannel === input.channel ? 8 : 0);
    add('cross_channel_continuity', participantMatch && input.channel && recentChannel
        && recentChannel !== input.channel && ageHours !== null && ageHours <= 24 ? 10 : 0);
    add('topic_overlap', Math.min(sharedTerms.length * 6, 24), sharedTerms.join(','));
    if (ageHours !== null) {
        if (ageHours <= 6) add('recent_6h', 25);
        else if (ageHours <= 24) add('recent_24h', 18);
        else if (ageHours <= 72) add('recent_72h', 12);
        else if (ageHours <= 336) add('recent_14d', 5);
        else if (ageHours > 2160) add('stale_90d', -120);
        else if (ageHours > 720) add('stale_30d', -60);
        else add('stale_14d', -15);
    }
    if (thread.purpose?.type === 'human_ask') add('open_human_ask', 10);

    return {
        thread_id: thread.thread_id,
        score,
        confidence: Math.max(0, Math.min(0.99, score / 100)),
        excluded: false,
        signals,
    };
}

async function participantPersonResolution({ db, tenantId, participantIdentity }) {
    const normalized = identityKey(participantIdentity);
    if (!db || !tenantId || !normalized) return { personId: null, matched: false, ambiguous: false };

    const rows = queryError(await db.from('communication_identities').select('person_id')
        .eq('tenant_id', tenantId).eq('normalized_value', normalized), 'Participant identity lookup') || [];
    const people = [...new Set(rows.map((row) => row.person_id).filter(Boolean))];
    return {
        personId: people.length === 1 ? people[0] : null,
        matched: rows.length > 0,
        ambiguous: people.length > 1,
    };
}

export async function resolveParticipantPerson(options) {
    return (await participantPersonResolution(options)).personId;
}

async function openThreadsForPerson(db, tenantId, personId) {
    const direct = queryError(await db.from('communication_threads')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('person_id', personId)
        .eq('status', 'open')
        .order('last_activity_at', { ascending: false })
        .limit(20), 'Open person thread lookup') || [];

    const identities = queryError(await db.from('communication_identities')
        .select('value,normalized_value')
        .eq('tenant_id', tenantId)
        .eq('person_id', personId), 'Person identity lookup') || [];
    const values = [...new Set(identities.flatMap((row) => [row.normalized_value, ...identityVariants(row.value)]).filter(Boolean))];
    let legacy = [];
    if (values.length) {
        legacy = queryError(await db.from('communication_threads')
            .select('*')
            .eq('tenant_id', tenantId)
            .in('participant_identity', values)
            .eq('status', 'open')
            .order('last_activity_at', { ascending: false })
            .limit(20), 'Open identity thread lookup') || [];
    }

    const compatible = [...direct, ...legacy]
        .filter((thread) => !thread.person_id || thread.person_id === personId);
    return [...new Map(compatible.map((thread) => [thread.thread_id, thread])).values()];
}

async function openThreadsForIdentity(db, tenantId, participantIdentity) {
    const values = identityVariants(participantIdentity);
    if (!values.length) return [];
    let query = db.from('communication_threads')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('status', 'open');
    query = values.length === 1
        ? query.eq('participant_identity', values[0])
        : query.in('participant_identity', values);
    return queryError(await query.order('last_activity_at', { ascending: false }).limit(20), 'Open thread lookup') || [];
}

async function openThreadsForProject(db, tenantId, projectId) {
    if (!projectId) return [];
    return queryError(await db.from('communication_threads').select('*')
        .eq('tenant_id', tenantId).eq('external_project_id', projectId).eq('status', 'open')
        .order('last_activity_at', { ascending: false }).limit(20), 'Open project thread lookup') || [];
}

async function openThreadsForInternalProject(db, tenantId, projectId) {
    if (!projectId) return [];
    return queryError(await db.from('communication_threads').select('*')
        .eq('tenant_id', tenantId).eq('project_id', projectId).eq('status', 'open')
        .order('last_activity_at', { ascending: false }).limit(20), 'Open internal project thread lookup') || [];
}

async function openThreadsForParticipants(db, tenantId, identities, personIds) {
    const participantRows = [];
    if (identities.length) {
        participantRows.push(...(queryError(await db.from('communication_thread_participants').select('thread_id')
            .eq('tenant_id', tenantId).in('normalized_identity', identities), 'Participant thread identity lookup') || []));
    }
    if (personIds.length) {
        participantRows.push(...(queryError(await db.from('communication_thread_participants').select('thread_id')
            .eq('tenant_id', tenantId).in('person_id', personIds), 'Participant thread person lookup') || []));
    }
    const threadIds = [...new Set(participantRows.map((row) => row.thread_id).filter(Boolean))];
    if (!threadIds.length) return [];
    return queryError(await db.from('communication_threads').select('*').eq('tenant_id', tenantId)
        .in('thread_id', threadIds).eq('status', 'open')
        .order('last_activity_at', { ascending: false }).limit(50), 'Participant threads lookup') || [];
}

async function threadParticipantEvidence(db, tenantId, threadIds) {
    if (!threadIds.length) return new Map();
    const rows = queryError(await db.from('communication_thread_participants').select('thread_id,person_id,normalized_identity')
        .eq('tenant_id', tenantId).in('thread_id', threadIds), 'Thread participant lookup') || [];
    const byThread = new Map();
    for (const row of rows) {
        const evidence = byThread.get(row.thread_id) || { people: [], identities: [] };
        if (row.person_id) evidence.people.push(row.person_id);
        if (row.normalized_identity) evidence.identities.push(row.normalized_identity);
        byThread.set(row.thread_id, evidence);
    }
    return byThread;
}

async function resolutionFeedback(db, tenantId, { identities, personIds, projectId, externalProjectId }) {
    const rows = [];
    if (identities.length) rows.push(...(queryError(await db.from('thread_resolution_feedback').select('*')
        .eq('tenant_id', tenantId).eq('active', true).in('normalized_identity', identities),
    'Identity thread feedback lookup') || []));
    if (personIds.length) rows.push(...(queryError(await db.from('thread_resolution_feedback').select('*')
        .eq('tenant_id', tenantId).eq('active', true).in('person_id', personIds),
    'Person thread feedback lookup') || []));
    if (projectId) rows.push(...(queryError(await db.from('thread_resolution_feedback').select('*')
        .eq('tenant_id', tenantId).eq('active', true).eq('project_id', projectId),
    'Project thread feedback lookup') || []));
    if (externalProjectId) rows.push(...(queryError(await db.from('thread_resolution_feedback').select('*')
        .eq('tenant_id', tenantId).eq('active', true).eq('external_project_id', externalProjectId),
    'External project thread feedback lookup') || []));
    return [...new Map(rows.map((row, index) => [row.feedback_id || `${row.from_thread_id}:${row.to_thread_id}:${row.created_at || index}`, row])).values()];
}

export async function rankThreadCandidates({ db, tenantId, participantIdentity = null, participantIdentities = [], personIds = [], channel = null,
    occurredAt = new Date().toISOString(), subject = null, content = null, projectId = null, correlation = {} }) {
    const identity = identityKey(participantIdentity);
    const externalProjectId = externalProject(correlation);
    const identities = [...new Set([participantIdentity, ...participantIdentities].map(identityKey).filter(Boolean))];
    const collections = [];
    for (const participant of identities) collections.push(await openThreadsForIdentity(db, tenantId, participant));
    for (const personId of personIds) collections.push(await openThreadsForPerson(db, tenantId, personId));
    collections.push(await openThreadsForParticipants(db, tenantId, identities, personIds));
    if (projectId) collections.push(await openThreadsForInternalProject(db, tenantId, projectId));
    if (externalProjectId) collections.push(await openThreadsForProject(db, tenantId, externalProjectId));
    const candidates = [...new Map(collections.flat().map((thread) => [thread.thread_id, thread])).values()];
    const participantEvidence = await threadParticipantEvidence(db, tenantId, candidates.map((thread) => thread.thread_id));
    const feedback = await resolutionFeedback(db, tenantId, { identities, personIds, projectId, externalProjectId });
    const input = { identity, identities, personIds, channel, occurredAt, subject, content, projectId,
        externalProjectId };
    return candidates.map((thread) => ({
        ...scoreThreadCandidate(thread, input, feedback, participantEvidence.get(thread.thread_id) || {}),
        thread,
    })).sort((left, right) => right.score - left.score ||
        String(right.thread.last_activity_at || '').localeCompare(String(left.thread.last_activity_at || '')));
}

function chooseRankedThread(ranked) {
    const eligible = ranked.filter((candidate) => !candidate.excluded);
    const first = eligible[0];
    const second = eligible[1];
    if (!first || first.score < THREAD_SCORE_THRESHOLD) return { selected: null, margin: null, reason: 'below_threshold' };
    const margin = second ? first.score - second.score : first.score;
    if (second && margin < THREAD_SCORE_MARGIN) return { selected: null, margin, reason: 'ambiguous_margin' };
    return { selected: first, margin, reason: 'ranked_match' };
}

async function recordResolutionDecision(db, row) {
    const resolutionId = prefixedId('trd');
    queryError(await db.from('thread_resolution_decisions').insert({
        resolution_id: resolutionId,
        tenant_id: row.tenantId,
        communication_id: row.communicationId || null,
        selected_thread_id: row.threadId || null,
        action: row.action,
        method: row.method,
        confidence: row.confidence,
        score_margin: row.margin,
        candidate_scores: row.candidates,
        input: row.input,
    }), 'Thread resolution decision');
    return resolutionId;
}

async function recordThreadParticipants(db, { tenantId, threadId, participants, channel, observedAt = new Date().toISOString() }) {
    for (const participant of participants) {
        const normalized = identityKey(participant.identity);
        if (!normalized) continue;
        queryError(await db.from('communication_thread_participants').upsert({
            tenant_id: tenantId,
            thread_id: threadId,
            person_id: participant.personId || null,
            identity_value: participant.identity,
            normalized_identity: normalized,
            channel: participant.channel || channel || 'other',
            role: participant.role || 'participant',
            first_seen_at: observedAt,
            last_seen_at: observedAt,
        }, { onConflict: 'tenant_id,thread_id,channel,normalized_identity' }), 'Thread participant upsert');
    }
}

async function resolveParticipants(db, tenantId, values, serviceIdentity, channel) {
    const byIdentity = new Map();
    for (const item of values) {
        if (!item || typeof item !== 'object') continue;
        const identity = typeof item.identity === 'string' ? item.identity.trim() : '';
        const normalized = identityKey(identity);
        if (!normalized || normalized === identityKey(serviceIdentity)) continue;
        let personId = item.personId || item.person_id || null;
        if (!personId) personId = (await participantPersonResolution({ db, tenantId, participantIdentity: identity })).personId;
        const key = `${item.channel || channel || 'other'}:${normalized}`;
        const existing = byIdentity.get(key);
        byIdentity.set(key, {
            identity,
            personId: personId || existing?.personId || null,
            channel: item.channel || channel || 'other',
            role: item.role || existing?.role || 'participant',
        });
    }
    return [...byIdentity.values()];
}

function laterTimestamp(left, right) {
    const leftTime = new Date(left).valueOf();
    const rightTime = new Date(right).valueOf();
    if (!Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? new Date(leftTime).toISOString() : new Date().toISOString();
    if (!Number.isFinite(leftTime) || rightTime >= leftTime) return new Date(rightTime).toISOString();
    return new Date(leftTime).toISOString();
}

function newThreadConfidence(reason, ranked) {
    if (reason === 'ambiguous_margin') return 0.55;
    const top = ranked.find((candidate) => !candidate.excluded);
    if (!top) return 0.95;
    return Math.max(0.55, Math.min(0.95, 1 - (top.score / Math.max(THREAD_SCORE_THRESHOLD, 1)) * 0.5));
}

async function threadHasPerson(db, tenantId, threadId, personId) {
    if (!personId) return false;
    const match = queryError(await db.from('communication_thread_participants').select('id')
        .eq('tenant_id', tenantId).eq('thread_id', threadId).eq('person_id', personId).limit(1).maybeSingle(),
    'Thread person lookup');
    return Boolean(match);
}

const tenantResolutionQueues = new Map();

// Keep the read/rank/write decision indivisible on PostgreSQL, including across
// server processes. Non-transactional adapters still serialize local workers.
// No provider or model request is made while holding this short database lock.
export async function resolveCommunicationThread(options) {
    const tenantId = options.tenantId || options.correlation?.tenant_id || options.db?.tenantId || process.env.LEGACY_TENANT_ID;
    if (!tenantId) throw new Error('tenant_id is required for thread resolution');
    const previous = tenantResolutionQueues.get(tenantId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    tenantResolutionQueues.set(tenantId, current);
    await previous;
    try {
        if (typeof options.db?.transaction === 'function') {
            return await options.db.transaction(async db => {
                queryError(await db.rpc('lock_communication_thread_resolution', { p_tenant_id: tenantId }), 'Thread decision lock');
                return resolveCommunicationThreadUnlocked({ ...options, db, tenantId });
            });
        }
        return await resolveCommunicationThreadUnlocked({ ...options, tenantId });
    } finally {
        release();
        if (tenantResolutionQueues.get(tenantId) === current) tenantResolutionQueues.delete(tenantId);
    }
}

// Explicit IDs and Ask bindings win. Unbound inbound and outbound activity ranks open threads
// using participant, project, topic, channel, time and human-feedback evidence;
// weak or ambiguous evidence creates a new conversation.
async function resolveCommunicationThreadUnlocked({
    db,
    tenantId = null,
    participantIdentity,
    serviceIdentity = null,
    direction,
    channel = null,
    occurredAt = new Date().toISOString(),
    subject = null,
    content = null,
    communicationId = null,
    participants = [],
    projectId = null,
    personId = null,
    threadId = null,
    purpose = null,
    correlation = {},
    callbackUrl = null,
    allowParticipantExpansion = false,
}) {
    const scopedTenant = tenantId || correlation.tenant_id || db?.tenantId || process.env.LEGACY_TENANT_ID;
    if (!scopedTenant) throw new Error('tenant_id is required for thread resolution');
    correlation = { ...correlation, tenant_id: scopedTenant };
    // correlation.person_id belongs to the calling workflow and may be a name,
    // directory key, or another non-UUID identifier. Only the explicit API
    // personId and verified Communications identities are internal contacts.
    const suppliedPersonId = personId || null;
    const personResolution = suppliedPersonId
        ? { personId: suppliedPersonId, matched: true, ambiguous: false }
        : await participantPersonResolution({ db, tenantId: scopedTenant, participantIdentity });
    const resolvedPersonId = personResolution.personId;
    if (resolvedPersonId && !correlation.person_id) correlation.person_id = resolvedPersonId;
    const explicitId = threadId || correlation.thread_id || null;
    let thread = null;
    let linkType = null;
    let decisionMethod = null;
    let decisionConfidence = 1;
    let decisionMargin = null;
    let ranked = [];
    let createdThread = false;

    if (explicitId) {
        linkType = 'explicit';
        decisionMethod = 'explicit_thread';
        thread = queryError(await db.from('communication_threads')
            .select('*').eq('tenant_id', scopedTenant).eq('thread_id', explicitId).maybeSingle(), 'Thread lookup');
        if (thread && thread.status !== 'open') throw new Error(`Thread ${explicitId} is ${thread.status} and cannot accept new communications`);
    }

    if (purpose?.type === 'human_ask') {
        const binding = queryError(await db.from('ask_bindings')
            .select('thread_id,status').eq('tenant_id', scopedTenant).eq('ask_id', purpose.ask_id).maybeSingle(), 'Ask lookup');
        if (binding) {
            if (explicitId && explicitId !== binding.thread_id) throw new Error(`Ask ${purpose.ask_id} already belongs to another thread`);
            linkType = 'explicit';
            decisionMethod = 'ask_binding';
            if (binding.status !== 'open') throw new Error(`Ask ${purpose.ask_id} is ${binding.status}`);
            thread = queryError(await db.from('communication_threads')
                .select('*').eq('tenant_id', scopedTenant).eq('thread_id', binding.thread_id).maybeSingle(), 'Ask thread lookup');
        }
    }
    if (thread?.purpose?.type === 'human_ask' && purpose
        && (purpose.type !== 'human_ask' || purpose.ask_id !== thread.purpose.ask_id)) {
        throw new Error(`Thread ${thread.thread_id} already belongs to another Ask`);
    }
    if (thread && ((projectId && thread.project_id && projectId !== thread.project_id)
        || (externalProject(correlation) && thread.external_project_id && externalProject(correlation) !== thread.external_project_id))) {
        throw new Error(`Thread ${thread.thread_id} belongs to a different project`);
    }

    const participantList = await resolveParticipants(db, scopedTenant, [
        ...(participantIdentity ? [{ identity: participantIdentity, personId: resolvedPersonId, channel }] : []),
        ...participants.filter((item) => item && typeof item === 'object'),
    ], serviceIdentity, channel);
    const participantPersonIds = [...new Set([resolvedPersonId, ...participantList.map((item) => item.personId)].filter(Boolean))];

    if (!thread && !explicitId && !purpose && !personResolution.ambiguous &&
        (participantPersonIds.length || participantIdentity || externalProject(correlation))) {
        ranked = await rankThreadCandidates({ db, tenantId: scopedTenant, participantIdentity,
            participantIdentities: participantList.map((item) => item.identity), personIds: participantPersonIds,
            channel, occurredAt, subject, content, projectId, correlation });
        const choice = chooseRankedThread(ranked);
        thread = choice.selected?.thread || null;
        decisionMargin = choice.margin;
        decisionMethod = choice.reason;
        decisionConfidence = choice.selected?.confidence || newThreadConfidence(choice.reason, ranked);
        if (thread) linkType = 'inferred';
    }

    if (!thread) {
        createdThread = true;
        linkType = explicitId || purpose ? 'explicit' : 'inferred';
        decisionMethod ||= personResolution.ambiguous ? 'ambiguous_identity_new_thread' : 'new_thread';
        if (decisionMethod === 'explicit_thread' || decisionMethod === 'ask_binding') decisionConfidence = 1;
        else if (!ranked.length) decisionConfidence = personResolution.ambiguous ? 0.99 : 0.95;
        const newThreadId = explicitId || prefixedId('thread');
        thread = queryError(await db.from('communication_threads').insert({
            tenant_id: scopedTenant,
            thread_id: newThreadId,
            status: 'open',
            person_id: resolvedPersonId,
            participant_identity: participantIdentity,
            service_identity: serviceIdentity,
            project_id: projectId,
            external_project_id: externalProject(correlation),
            primary_channel: channel,
            last_channel: channel,
            last_subject: subject,
            resolution_confidence: decisionConfidence,
            resolution_method: decisionMethod,
            purpose,
            correlation: { ...correlation, thread_id: newThreadId },
            callback_url: callbackUrl,
            last_activity_at: laterTimestamp(null, occurredAt),
        }).select('*').single(), 'Thread create');
    }

    if (resolvedPersonId && thread.person_id && thread.person_id !== resolvedPersonId) {
        const isParticipant = await threadHasPerson(db, scopedTenant, thread.thread_id, resolvedPersonId);
        if (!isParticipant && !allowParticipantExpansion) throw new Error(`Thread ${thread.thread_id} belongs to a different person`);
    }

    const inheritedPurpose = purpose || thread.purpose || null;
    const inheritedCorrelation = {
        ...(thread.correlation || {}),
        ...correlation,
        thread_id: thread.thread_id,
    };

    const latestActivity = laterTimestamp(thread.last_activity_at, occurredAt);
    const observedTime = new Date(occurredAt).valueOf();
    const priorTime = new Date(thread.last_activity_at).valueOf();
    const isLatest = Number.isFinite(observedTime) && (!Number.isFinite(priorTime) || observedTime >= priorTime);
    queryError(await db.from('communication_threads').update({
        last_activity_at: latestActivity,
        purpose: inheritedPurpose,
        correlation: inheritedCorrelation,
        ...(resolvedPersonId && !thread.person_id ? { person_id: resolvedPersonId } : {}),
        ...(projectId && !thread.project_id ? { project_id: projectId } : {}),
        ...(externalProject(correlation) && !thread.external_project_id ? { external_project_id: externalProject(correlation) } : {}),
        ...(channel ? { primary_channel: thread.primary_channel || channel } : {}),
        ...(channel && isLatest ? { last_channel: channel } : {}),
        ...(subject && isLatest ? { last_subject: subject } : {}),
        resolution_confidence: decisionConfidence,
        resolution_method: decisionMethod || linkType,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    }).eq('tenant_id', scopedTenant).eq('thread_id', thread.thread_id), 'Thread update');

    if (inheritedPurpose?.type === 'human_ask') {
        const existing = queryError(await db.from('ask_bindings').select('thread_id,status')
            .eq('tenant_id', scopedTenant).eq('ask_id', inheritedPurpose.ask_id).maybeSingle(), 'Ask binding lookup');
        if (existing && existing.status !== 'open') throw new Error(`Ask ${inheritedPurpose.ask_id} is ${existing.status}`);
        queryError(await db.from('ask_bindings').upsert({
            ask_id: inheritedPurpose.ask_id,
            thread_id: thread.thread_id,
            tenant_id: scopedTenant,
            status: existing?.status || 'open',
            purpose: inheritedPurpose,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,ask_id' }), 'Ask binding');
    }

    await recordThreadParticipants(db, { tenantId: scopedTenant, threadId: thread.thread_id,
        participants: participantList, channel, observedAt: laterTimestamp(null, occurredAt) });
    const resolutionId = await recordResolutionDecision(db, {
        tenantId: scopedTenant,
        communicationId,
        threadId: thread.thread_id,
        action: createdThread ? 'created' : 'attached',
        method: decisionMethod || linkType,
        confidence: decisionConfidence,
        margin: decisionMargin,
        candidates: ranked.slice(0, 10).map(({ thread: candidateThread, ...score }) => ({
            ...score, title: candidateThread.title || null, last_activity_at: candidateThread.last_activity_at || null,
        })),
        input: { channel, direction, occurred_at: occurredAt, participant_identity: participantIdentity,
            person_ids: participantPersonIds, project_id: projectId,
            external_project_id: externalProject(correlation), subject },
    });

    return {
        threadId: thread.thread_id,
        personId: resolvedPersonId || ((!participantIdentity || identityKey(participantIdentity) === identityKey(thread.participant_identity))
            ? thread.person_id || null : null),
        linkType,
        purpose: inheritedPurpose,
        correlation: inheritedCorrelation,
        callbackUrl: callbackUrl || thread.callback_url || null,
        resolution: {
            resolution_id: resolutionId,
            method: decisionMethod || linkType,
            confidence: decisionConfidence,
            score_margin: decisionMargin,
            candidates: ranked.slice(0, 10).map(({ thread: candidateThread, ...score }) => ({
                ...score, title: candidateThread.title || null, last_activity_at: candidateThread.last_activity_at || null,
            })),
        },
    };
}
