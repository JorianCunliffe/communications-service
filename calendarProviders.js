// Calendar adapters produce one canonical event shape. Provider-specific
// authentication and pagination stay outside the memory layer.

export function calendarProvider({ name, listEvents, getEvent, normaliseEvent }) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Calendar provider requires a name');
    for (const [method, value] of Object.entries({ listEvents, getEvent, normaliseEvent })) {
        if (typeof value !== 'function') throw new Error(`Calendar provider ${name} requires ${method}()`);
    }
    return { name: name.trim(), listEvents, getEvent, normaliseEvent };
}

export function normalisePushedCalendarEvent(raw) {
    const event = raw || {};
    return {
        provider: event.provider,
        providerId: event.provider_id || event.providerId,
        title: event.title,
        description: event.description ?? null,
        startsAt: event.starts_at || event.startsAt,
        endsAt: event.ends_at || event.endsAt || null,
        location: event.location ?? null,
        organiserContactId: event.organiser_contact_id || event.organiserContactId || null,
        organiser: event.organiser || null,
        projectId: event.project_id || event.projectId || null,
        threadId: event.thread_id || event.communication_thread_id || event.threadId || null,
        participants: Array.isArray(event.participants) ? event.participants : [],
        metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : {},
    };
}
