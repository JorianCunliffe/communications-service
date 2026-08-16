import { normalisePushedCalendarEvent } from './calendarProviders.js';

const CANDIDATE_WINDOW_MINUTES = Math.max(1, Number(process.env.CALENDAR_CANDIDATE_WINDOW_MINUTES) || 120);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`"${name}" is required`);
    return value.trim();
}

function iso(value, name, required = false) {
    if ((value === null || value === undefined || value === '') && !required) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`"${name}" must be a valid timestamp`);
    return date.toISOString();
}

export function normaliseCalendarEvent(raw) {
    const event = normalisePushedCalendarEvent(raw);
    const startsAt = iso(event.startsAt, 'starts_at', true);
    const endsAt = iso(event.endsAt, 'ends_at');
    if (endsAt && endsAt < startsAt) throw new Error('"ends_at" cannot be before "starts_at"');
    if (event.projectId && !UUID.test(event.projectId)) throw new Error('"project_id" must be an internal project UUID');
    return {
        ...event,
        provider: requiredString(event.provider, 'provider'),
        providerId: requiredString(event.providerId, 'provider_id'),
        title: requiredString(event.title, 'title'),
        startsAt,
        endsAt,
    };
}

export function normaliseParticipant(raw = {}) {
    const identityType = raw.identity_type || raw.identityType || raw.type || (raw.email ? 'email' : raw.phone ? 'phone' : null);
    const identityValue = raw.identity_value || raw.identityValue || raw.value || raw.email || raw.phone || null;
    return {
        contactId: raw.contact_id || raw.contactId || null,
        identityType: identityType ? String(identityType).trim().toLowerCase() : null,
        identityValue: identityValue ? String(identityValue).trim() : null,
        responseStatus: raw.response_status || raw.responseStatus || null,
        metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    };
}

export async function resolveExactIdentity(db, participant) {
    if (participant.contactId) return participant.contactId;
    if (!participant.identityType || !participant.identityValue) return null;
    const { data, error } = await db.from('communication_identities').select('person_id')
        .eq('type', participant.identityType).eq('value', participant.identityValue).limit(2);
    if (error) throw new Error(`Identity lookup: ${error.message}`);
    const people = [...new Set((data || []).map((row) => row.person_id).filter(Boolean))];
    return people.length === 1 ? people[0] : null;
}

export async function ingestCalendarEvent(db, raw) {
    const event = normaliseCalendarEvent(raw);
    // Production uses one database transaction for the event and its complete
    // participant snapshot. Lightweight test adapters fall through to the
    // equivalent query sequence below.
    if (typeof db.rpc === 'function') {
        const atomic = await db.rpc('ingest_calendar_event', { p_event: event });
        if (atomic?.error) throw new Error(`Calendar event ingest: ${atomic.error.message}`);
        if (atomic?.data?.event) return atomic.data;
    }
    const organiser = event.organiser ? normaliseParticipant(event.organiser) : null;
    const organiserContactId = event.organiserContactId || (organiser ? await resolveExactIdentity(db, organiser) : null);
    const row = {
        provider: event.provider,
        provider_id: event.providerId,
        title: event.title,
        description: event.description,
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        location: event.location,
        organiser_contact_id: organiserContactId,
        project_id: event.projectId,
        communication_thread_id: event.threadId,
        metadata: event.metadata,
        updated_at: new Date().toISOString(),
    };
    const result = await db.from('calendar_events').upsert(row, { onConflict: 'provider,provider_id' }).select('*').single();
    if (result.error) throw new Error(`Calendar event ingest: ${result.error.message}`);

    const existing = await db.from('calendar_event_participants').select('*').eq('event_id', result.data.id);
    if (existing.error) throw new Error(`Calendar participant lookup: ${existing.error.message}`);
    const knownKeys = new Set((existing.data || []).map((item) =>
        `${item.contact_id || ''}|${item.identity_type || ''}|${item.identity_value || ''}`));
    const participants = [];
    const participantInputs = [...event.participants];
    if (event.organiser) {
        const organiserKey = `${organiser?.identityType || ''}|${organiser?.identityValue || ''}|${organiser?.contactId || ''}`;
        const alreadyListed = participantInputs.map(normaliseParticipant).some((item) =>
            `${item.identityType || ''}|${item.identityValue || ''}|${item.contactId || ''}` === organiserKey);
        if (!alreadyListed) participantInputs.push({ ...event.organiser, metadata: { ...(event.organiser.metadata || {}), role: 'organiser' } });
    }
    for (const rawParticipant of participantInputs) {
        const participant = normaliseParticipant(rawParticipant);
        if (!participant.contactId && !participant.identityValue) throw new Error('Every participant needs contact_id or an identity value');
        const contactId = await resolveExactIdentity(db, participant);
        const participantRow = {
            event_id: result.data.id,
            contact_id: contactId,
            identity_type: participant.identityType,
            identity_value: participant.identityValue,
            response_status: participant.responseStatus,
            metadata: participant.metadata,
        };
        const key = `${contactId || ''}|${participant.identityType || ''}|${participant.identityValue || ''}`;
        if (!knownKeys.has(key)) {
            const inserted = await db.from('calendar_event_participants').insert(participantRow).select('*').single();
            if (inserted.error) throw new Error(`Calendar participant ingest: ${inserted.error.message}`);
            participants.push(inserted.data);
            knownKeys.add(key);
        } else {
            const matched = (existing.data || []).find((item) =>
                `${item.contact_id || ''}|${item.identity_type || ''}|${item.identity_value || ''}` === key);
            const updated = await db.from('calendar_event_participants').update({
                response_status: participant.responseStatus, metadata: participant.metadata, updated_at: new Date().toISOString(),
            }).eq('id', matched.id).select('*').single();
            if (updated.error) throw new Error(`Calendar participant update: ${updated.error.message}`);
            participants.push(updated.data);
        }
    }
    const retainedIds = participants.filter(Boolean).map((item) => item.id);
    for (const stale of (existing.data || []).filter((item) => !retainedIds.includes(item.id))) {
        const removed = await db.from('calendar_event_participants').delete().eq('id', stale.id);
        if (removed.error) throw new Error(`Calendar participant removal: ${removed.error.message}`);
    }
    return { event: result.data, participants: participants.filter(Boolean) };
}

export async function resolveCalendarEvent(db, value) {
    if (!value) return null;
    let query = db.from('calendar_events').select('*');
    query = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? query.eq('id', value)
        : query.eq('provider_id', value);
    const result = await query.limit(2);
    if (result.error) throw new Error(`Calendar event lookup: ${result.error.message}`);
    return result.data?.length === 1 ? result.data[0] : null;
}

export async function resolveCalendarEventId(db, value) {
    return (await resolveCalendarEvent(db, value))?.id || null;
}

export async function calendarCandidates(db, { contactId, occurredAt, windowMinutes = CANDIDATE_WINDOW_MINUTES }) {
    if (!contactId || !occurredAt) return [];
    const at = new Date(occurredAt);
    if (!Number.isFinite(at.getTime())) return [];
    const participants = await db.from('calendar_event_participants').select('event_id').eq('contact_id', contactId);
    if (participants.error) throw new Error(`Calendar candidates: ${participants.error.message}`);
    const ids = [...new Set((participants.data || []).map((row) => row.event_id))];
    if (!ids.length) return [];
    const windowMs = windowMinutes * 60000;
    const lower = at.getTime() - windowMs;
    const events = await db.from('calendar_events').select('*').in('id', ids)
        .lte('starts_at', new Date(at.getTime() + windowMs).toISOString())
        .order('starts_at', { ascending: false }).limit(100);
    if (events.error) throw new Error(`Calendar candidates: ${events.error.message}`);
    return (events.data || []).filter((event) => new Date(event.ends_at || event.starts_at).getTime() >= lower).map((event) => {
        const starts = new Date(event.starts_at).getTime();
        const ends = new Date(event.ends_at || event.starts_at).getTime();
        const distance = at.getTime() < starts ? starts - at.getTime() : at.getTime() > ends ? at.getTime() - ends : 0;
        const minutes = Math.round(distance / 60000);
        return {
            event_id: event.id,
            reason: `same participant within ${minutes} minutes`,
            confidence: Number(Math.max(0.5, 0.95 - (minutes / Math.max(windowMinutes, 1)) * 0.4).toFixed(2)),
        };
    }).sort((a, b) => b.confidence - a.confidence);
}
