// Plaud has no assumed HTTP contract here. An authenticated integration can
// implement listRecent/fetchMetadata and pass the normalised result into the
// existing durable recording queue.

export class PlaudProvider {
    constructor(adapter = {}) { this.adapter = adapter; }
    async listRecent(options = {}) {
        if (typeof this.adapter.listRecent !== 'function') throw new Error('Plaud listRecent adapter is not configured');
        return this.adapter.listRecent(options);
    }
    async fetchMetadata(id) {
        if (typeof this.adapter.fetchMetadata !== 'function') throw new Error('Plaud fetchMetadata adapter is not configured');
        return this.adapter.fetchMetadata(id);
    }
    normalise(raw) { return normalisePlaudRecording(raw); }
}

export function normalisePlaudRecording(raw = {}) {
    const externalId = raw.externalId || raw.external_id || raw.id;
    if (typeof externalId !== 'string' || !externalId.trim()) throw new Error('Plaud recording requires an external ID');
    return {
        source: 'plaud',
        externalId: externalId.trim(),
        recordedAt: raw.recordedAt || raw.recorded_at || null,
        mediaUrl: raw.mediaUrl || raw.media_url || null,
        mediaAuth: raw.mediaAuth || raw.media_auth || null,
        transcript: raw.transcript || null,
        participants: Array.isArray(raw.participants) ? raw.participants : [],
        calendarEventId: raw.calendarEventId || raw.calendar_event_id || null,
        projectId: raw.projectId || raw.project_id || null,
        threadId: raw.threadId || raw.thread_id || null,
        title: raw.title || null,
        meetingType: raw.meetingType || raw.meeting_type || null,
        metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    };
}
