const DEFAULT_LIMIT = 20;

function weight(name, fallback) {
    if (process.env[name] === undefined || process.env[name] === '') return fallback;
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be a number between 0 and 1`);
    return parsed;
}

export const SEARCH_WEIGHTS = Object.freeze({
    text: weight('MEMORY_SEARCH_TEXT_WEIGHT', 0.65),
    project: weight('MEMORY_SEARCH_PROJECT_BOOST', 0.10),
    person: weight('MEMORY_SEARCH_PERSON_BOOST', 0.10),
    thread: weight('MEMORY_SEARCH_THREAD_BOOST', 0.05),
    calendar: weight('MEMORY_SEARCH_CALENDAR_BOOST', 0.05),
    recency: weight('MEMORY_SEARCH_RECENCY_BOOST', 0.05),
});

function check(result, label) {
    if (result?.error) throw new Error(`${label}: ${result.error.message}`);
    return result?.data || [];
}

function limitOf(value, maximum = 100) {
    return Math.min(Math.max(Number(value) || DEFAULT_LIMIT, 1), maximum);
}

function includeOptions(value = {}) {
    return {
        communications: value.communications !== false,
        threads: value.threads !== false,
        facts: value.facts !== false,
        commitments: value.commitments === true,
        calendar: value.calendar !== false,
    };
}

function recencyBoost(occurredAt, now = Date.now()) {
    const ageDays = Math.max(0, (now - new Date(occurredAt).getTime()) / 86400000);
    return Number((SEARCH_WEIGHTS.recency * Math.exp(-ageDays / 90)).toFixed(4));
}

export function scoreCommunication(row, filters = {}, now = Date.now()) {
    const rawRank = Math.max(0, Number(row.rank) || 0);
    const reasons = {
        text: Number(Math.min(SEARCH_WEIGHTS.text, rawRank * 4).toFixed(4)),
        project: filters.project_id && row.project_id === filters.project_id ? SEARCH_WEIGHTS.project : 0,
        person: filters.person_id && row.contact_id === filters.person_id ? SEARCH_WEIGHTS.person : 0,
        thread: filters.thread_id && row.thread_id === filters.thread_id ? SEARCH_WEIGHTS.thread : 0,
        calendar: filters.calendar_event_id && row.calendar_event_id === filters.calendar_event_id ? SEARCH_WEIGHTS.calendar : 0,
        recency: recencyBoost(row.occurred_at, now),
    };
    return { score: Number(Math.min(1, Object.values(reasons).reduce((a, b) => a + b, 0)).toFixed(4)), score_reasons: reasons };
}

function words(query) {
    return String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((item) => item.length > 1);
}

function relevantText(row, query) {
    const wanted = words(query);
    if (!wanted.length) return true;
    const text = `${row.text || ''} ${row.description || ''}`.toLowerCase();
    return wanted.some((word) => text.includes(word));
}

async function queryFacts(db, body, limit) {
    let query = db.from('communication_facts').select('*').eq('status', 'active')
        .order('updated_at', { ascending: false }).limit(Math.max(limit * 3, 30));
    if (body.person_id || body.contact_id) query = query.eq('contact_id', body.person_id || body.contact_id);
    if (body.project_id) query = query.eq('project_id', body.project_id);
    if (body.thread_id) query = query.eq('thread_id', body.thread_id);
    return check(await query, 'Fact search').filter((row) => relevantText(row, body.query)).slice(0, limit);
}

async function queryCommitments(db, body, limit) {
    let query = db.from('communication_commitments').select('*').eq('status', 'open')
        .order('updated_at', { ascending: false }).limit(Math.max(limit * 3, 30));
    if (body.thread_id) query = query.eq('thread_id', body.thread_id);
    const personId = body.person_id || body.contact_id;
    const rows = check(await query, 'Commitment search');
    return rows.filter((row) => (!personId || row.promisor_contact_id === personId || row.promisee_contact_id === personId)
        && relevantText(row, body.query)).slice(0, limit);
}

async function eventIdsForPerson(db, personId) {
    if (!personId) return null;
    const rows = check(await db.from('calendar_event_participants').select('event_id').eq('contact_id', personId), 'Calendar participant search');
    return [...new Set(rows.map((row) => row.event_id))];
}

async function queryCalendar(db, body, limit) {
    let query = db.from('calendar_events').select('*').order('starts_at', { ascending: false }).limit(limit);
    if (body.calendar_event_id) query = query.eq('id', body.calendar_event_id);
    if (body.project_id) query = query.eq('project_id', body.project_id);
    if (body.thread_id) query = query.eq('communication_thread_id', body.thread_id);
    if (body.since) query = query.gte('starts_at', body.since);
    if (body.until) query = query.lt('starts_at', body.until);
    const personIds = await eventIdsForPerson(db, body.person_id || body.contact_id);
    if (personIds && !personIds.length) return [];
    if (personIds) query = query.in('id', personIds);
    return check(await query, 'Calendar search');
}

export async function searchMemory(db, body = {}) {
    const limit = limitOf(body.limit);
    const include = includeOptions(body.include);
    const personId = body.person_id || body.contact_id || null;
    const rpc = await db.rpc('search_communications', {
        q: body.query || null,
        contact: personId,
        project: body.project_id || null,
        since: body.since || null,
        until: body.until || null,
        channels: body.channels || null,
        max_results: limit,
        thread: body.thread_id || null,
        calendar_event: body.calendar_event_id || null,
    });
    const hits = check(rpc, 'Communication search');
    const filters = { ...body, person_id: personId };
    const direct = hits.map((row) => ({
        ...row,
        ...scoreCommunication(row, filters),
        relationship_to_query: 'direct_match',
    }));

    const threadIds = [...new Set(direct.map((row) => row.thread_id).filter(Boolean))];
    const directIds = new Set(direct.map((row) => row.communication_id));
    let expansion = [];
    if (include.communications && threadIds.length) {
        const related = check(await db.from('communications').select('*').in('thread_id', threadIds)
            .order('occurred_at', { ascending: false }).limit(Math.min(limit * 4, 200)), 'Thread context expansion');
        const via = new Map(direct.filter((row) => row.thread_id).map((row) => [row.thread_id, row.communication_id]));
        expansion = related.filter((row) => !directIds.has(row.communication_id)).map((row) => ({
            ...row,
            relationship_to_query: 'thread_context',
            via: via.get(row.thread_id),
            score: 0,
            score_reasons: {},
        }));
    }

    let threads = [];
    if (include.threads && threadIds.length) {
        const threadRows = check(await db.from('communication_threads').select('*').in('thread_id', threadIds), 'Thread search');
        threads = threadRows.map((thread) => {
            const matches = direct.filter((row) => row.thread_id === thread.thread_id);
            const best = Math.max(...matches.map((row) => row.score), 0);
            return {
                thread_id: thread.thread_id,
                title: thread.title,
                summary: thread.summary,
                current_state: thread.current_state,
                score: Number(Math.min(1, best + Math.min(0.1, matches.length * 0.02)).toFixed(4)),
                matching_communication_ids: matches.map((row) => row.communication_id),
            };
        }).sort((a, b) => b.score - a.score);
    }

    const [facts, commitments, calendarEvents] = await Promise.all([
        include.facts ? queryFacts(db, body, limit) : [],
        include.commitments ? queryCommitments(db, body, limit) : [],
        include.calendar ? queryCalendar(db, body, limit) : [],
    ]);
    return {
        communications: include.communications ? [...direct, ...expansion] : [],
        threads,
        facts,
        calendar_events: calendarEvents,
        commitments,
        query_context: { filters: { ...filters, contact_id: undefined }, include, weights: SEARCH_WEIGHTS },
    };
}

async function contactsByIds(db, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    return unique.length ? check(await db.from('contacts').select('*').in('id', unique), 'Participant lookup') : [];
}

export async function getThreadMemory(db, threadId) {
    const result = await db.from('communication_threads').select('*').eq('thread_id', threadId).maybeSingle();
    if (result.error) throw new Error(`Thread lookup: ${result.error.message}`);
    if (!result.data) return null;
    const [communications, events, commitments, facts] = await Promise.all([
        db.from('communications').select('*').eq('thread_id', threadId).order('occurred_at'),
        db.from('calendar_events').select('*').eq('communication_thread_id', threadId).order('starts_at'),
        db.from('communication_commitments').select('*').eq('thread_id', threadId).order('created_at'),
        db.from('communication_facts').select('*').eq('thread_id', threadId).eq('status', 'active').order('updated_at', { ascending: false }),
    ]);
    const communicationRows = check(communications, 'Thread communications');
    const eventRows = check(events, 'Thread calendar');
    const factRows = check(facts, 'Thread facts');
    const commitmentRows = check(commitments, 'Thread commitments');
    const eventIds = eventRows.map((row) => row.id);
    const calendarParticipants = eventIds.length
        ? check(await db.from('calendar_event_participants').select('*').in('event_id', eventIds), 'Thread calendar participants')
        : [];
    const recordingParticipants = communicationRows.flatMap((row) => Array.isArray(row.metadata?.participants)
        ? row.metadata.participants.map((participant) => ({ ...participant, source: 'recording' })) : []);
    const allParticipantRows = [...calendarParticipants, ...recordingParticipants];
    const contactRows = await contactsByIds(db, [
        ...communicationRows.map((row) => row.person_id || row.contact_id),
        ...allParticipantRows.map((row) => row.contact_id),
    ]);
    const contacts = new Map(contactRows.map((row) => [row.id, row]));
    const participants = allParticipantRows.map((row) => ({ ...row, contact: contacts.get(row.contact_id) || null }));
    for (const contact of contactRows) {
        if (!participants.some((row) => row.contact_id === contact.id)) participants.push({ contact_id: contact.id, contact });
    }
    return {
        thread: result.data,
        communications: communicationRows,
        calendar_events: eventRows,
        participants,
        summary: result.data.summary || null,
        current_state: result.data.current_state || null,
        commitments: commitmentRows,
        facts: factRows,
        provenance: {
            summary: result.data.summary_source_ids || [],
            current_state: result.data.current_state_source_ids || [],
            facts: Object.fromEntries(factRows.map((row) => [row.id, row.source_communication_ids])),
            commitments: Object.fromEntries(commitmentRows.map((row) => [row.id, [row.communication_id]])),
        },
    };
}

export async function getLooseEnds(db, { personId = null, projectId = null, limit = 100 } = {}) {
    let scopedThreadIds = null;
    if (projectId || personId) {
        let scope = db.from('communications').select('thread_id').not('thread_id', 'is', null).limit(500);
        if (projectId) scope = scope.eq('project_id', projectId);
        if (personId) scope = scope.eq('person_id', personId);
        scopedThreadIds = [...new Set(check(await scope, 'Loose-end scope').map((row) => row.thread_id))];
    }
    let commitmentsQuery = db.from('communication_commitments').select('*').eq('status', 'open')
        .order('due_at', { ascending: true }).limit(limitOf(limit, 200));
    if (scopedThreadIds?.length) commitmentsQuery = commitmentsQuery.in('thread_id', scopedThreadIds);
    const commitments = check(await commitmentsQuery, 'Open commitments').filter((row) =>
        (!personId || scopedThreadIds?.includes(row.thread_id) || row.promisor_contact_id === personId || row.promisee_contact_id === personId)
        && (!projectId || scopedThreadIds?.includes(row.thread_id)));
    let asksQuery = db.from('ask_bindings').select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(limitOf(limit, 200));
    if (scopedThreadIds?.length) asksQuery = asksQuery.in('thread_id', scopedThreadIds);
    const asks = check(await asksQuery, 'Open Ask bindings').filter((row) => !scopedThreadIds || scopedThreadIds.includes(row.thread_id));
    let threadsQuery = db.from('communication_threads').select('*').not('outstanding_dependency', 'is', null)
        .eq('status', 'open').order('last_activity_at', { ascending: false }).limit(limitOf(limit, 200));
    if (scopedThreadIds?.length) threadsQuery = threadsQuery.in('thread_id', scopedThreadIds);
    const threads = check(await threadsQuery, 'Outstanding thread states')
        .filter((row) => !scopedThreadIds || scopedThreadIds.includes(row.thread_id));
    return [
        ...commitments.map((row) => ({
            type: 'commitment', description: row.description, due_at: row.due_at,
            contact_id: row.promisor_contact_id, thread_id: row.thread_id,
            source_communication_ids: [row.communication_id], confidence: row.confidence,
        })),
        ...asks.map((row) => ({
            type: 'human_ask', description: row.purpose?.description || `Human Ask ${row.ask_id} is unresolved`,
            due_at: null, contact_id: null, thread_id: row.thread_id, source_communication_ids: [], ask_id: row.ask_id,
        })),
        ...threads.map((row) => ({
            type: 'outstanding_state', description: row.outstanding_dependency, due_at: null,
            contact_id: null, thread_id: row.thread_id, source_communication_ids: row.outstanding_source_ids || [],
        })),
    ].slice(0, limitOf(limit, 200));
}

export async function getPersonMemory(db, personId) {
    const person = await db.from('contacts').select('*').eq('id', personId).maybeSingle();
    if (person.error) throw new Error(`Contact lookup: ${person.error.message}`);
    if (!person.data) return null;
    const events = await eventIdsForPerson(db, personId);
    const [communications, commitments, facts, calendar, threadRows] = await Promise.all([
        db.from('communications').select('*').eq('person_id', personId).order('occurred_at', { ascending: false }).limit(50),
        queryCommitments(db, { person_id: personId }, 50),
        queryFacts(db, { person_id: personId }, 50),
        events?.length ? db.from('calendar_events').select('*').in('id', events).gte('starts_at', new Date().toISOString()).order('starts_at').limit(50) : Promise.resolve({ data: [] }),
        db.from('communications').select('thread_id').eq('person_id', personId).not('thread_id', 'is', null).limit(200),
    ]);
    const threadIds = [...new Set(check(threadRows, 'Person threads').map((row) => row.thread_id))];
    const threads = threadIds.length ? check(await db.from('communication_threads').select('*').in('thread_id', threadIds).eq('status', 'open'), 'Active threads') : [];
    return { person: person.data, active_threads: threads, open_commitments: commitments, recent_facts: facts,
        recent_communications: check(communications, 'Recent communications'), upcoming_calendar_events: check(calendar, 'Upcoming calendar') };
}

export async function getProjectMemory(db, projectId) {
    const project = await db.from('projects').select('*').eq('id', projectId).maybeSingle();
    if (project.error) throw new Error(`Project lookup: ${project.error.message}`);
    if (!project.data) return null;
    const [members, communications, facts, events] = await Promise.all([
        db.from('project_contacts').select('role, contacts(*)').eq('project_id', projectId),
        db.from('communications').select('*').eq('project_id', projectId).order('occurred_at', { ascending: false }).limit(100),
        queryFacts(db, { project_id: projectId }, 100),
        db.from('calendar_events').select('*').eq('project_id', projectId).order('starts_at', { ascending: false }).limit(100),
    ]);
    const communicationRows = check(communications, 'Project communications');
    const threadIds = [...new Set(communicationRows.map((row) => row.thread_id).filter(Boolean))];
    const threads = threadIds.length ? check(await db.from('communication_threads').select('*').in('thread_id', threadIds), 'Project threads') : [];
    const commitments = threadIds.length ? check(await db.from('communication_commitments').select('*')
        .in('thread_id', threadIds).eq('status', 'open').order('updated_at', { ascending: false }).limit(100), 'Project commitments') : [];
    return { project: project.data, people: check(members, 'Project people'), threads, current_facts: facts,
        open_commitments: commitments, recent_communications: communicationRows, calendar_events: check(events, 'Project calendar') };
}

export async function getEventContext(db, eventId) {
    const event = await db.from('calendar_events').select('*').eq('id', eventId).maybeSingle();
    if (event.error) throw new Error(`Calendar event lookup: ${event.error.message}`);
    if (!event.data) return null;
    const participants = check(await db.from('calendar_event_participants').select('*').eq('event_id', eventId), 'Event participants');
    const personIds = [...new Set(participants.map((row) => row.contact_id).filter(Boolean))];
    let communications = [];
    if (personIds.length) communications = check(await db.from('communications').select('*').in('person_id', personIds)
        .lte('occurred_at', event.data.starts_at).order('occurred_at', { ascending: false }).limit(50), 'Pre-meeting communications');
    const threadIds = [...new Set([event.data.communication_thread_id, ...communications.map((row) => row.thread_id)].filter(Boolean))];
    const [threads, commitmentsResult, factsResult] = await Promise.all([
        threadIds.length ? db.from('communication_threads').select('*').in('thread_id', threadIds).order('last_activity_at', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
        event.data.communication_thread_id
            ? db.from('communication_commitments').select('*').eq('thread_id', event.data.communication_thread_id).eq('status', 'open').order('updated_at', { ascending: false }).limit(50)
            : db.from('communication_commitments').select('*').eq('status', 'open').order('updated_at', { ascending: false }).limit(100),
        event.data.communication_thread_id
            ? db.from('communication_facts').select('*').eq('thread_id', event.data.communication_thread_id).eq('status', 'active').order('updated_at', { ascending: false }).limit(50)
            : db.from('communication_facts').select('*').eq('status', 'active').order('updated_at', { ascending: false }).limit(100),
    ]);
    const commitments = check(commitmentsResult, 'Event commitments').filter((row) => event.data.communication_thread_id
        || personIds.includes(row.promisor_contact_id) || personIds.includes(row.promisee_contact_id));
    const facts = check(factsResult, 'Event facts').filter((row) => event.data.communication_thread_id || personIds.includes(row.contact_id));
    return { event: event.data, participants, recent_threads: check(threads, 'Recent threads'), open_commitments: commitments,
        recent_facts: facts, recent_communications: communications };
}
