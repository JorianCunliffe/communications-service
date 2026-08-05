// The management API — everything the system needs to be driven over HTTP
// instead of by editing rows in Supabase by hand.
//
// Read paths only, for now. Writes are a deliberate second step: with these in
// place an operator can see exactly what the resolver will do before anything
// is able to change it, and every write endpoint that follows has an obvious
// way to be checked.
//
// Three rules hold across every route here.
//
//   Authentication is the same as the send and dial endpoints — one shared key,
//   absent key disables rather than opens. This reads the whole contact
//   database, so it is not a lighter class of endpoint than placing a call.
//
//   Supabase being unavailable is a 503, never a fallback. The call path is the
//   opposite on purpose: there, answering with default config beats not
//   answering. Here, showing an operator defaults dressed up as their settings
//   would be worse than an error, because they would act on it.
//
//   Nothing in this file writes. The one route that runs the real resolver
//   passes createContact: false, so asking what would happen on a call is not
//   the thing that creates a contact.

import { DEFAULT_CONFIG } from './config.js';
import { getSupabase, resolveConfig, rowToConfig } from './configResolver.js';
import { listTools, toolNames, isKnownTool } from './tools.js';
import { E164, rejectUnauthorized } from './auth.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Columns a caller may order a list by. An allow-list rather than passing the
// parameter through: PostgREST would happily order by a column that does not
// exist and return an error a caller cannot act on.
const CALL_SORTS = ['started_at', 'ended_at', 'duration_seconds', 'status'];

function paging(query) {
    const asInt = (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const limit = Math.min(Math.max(asInt(query.limit, DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(asInt(query.offset, 0), 0);
    return { limit, offset, from: offset, to: offset + limit - 1 };
}

// A "+" is literal inside a path segment, but it passes through enough layers
// of encoding on the way here to arrive as a space often enough to be worth
// forgiving. Nothing else is guessed at — anything that is not E.164 after this
// is rejected rather than looked up as-is and reported as "not found", which
// would send an operator hunting for a missing row instead of a typo.
function normalisePhone(raw) {
    const value = String(raw ?? '').trim().replace(/^[ ]/, '+');
    return E164.test(value) ? value : null;
}

// PostgREST's or() filter takes a comma-separated expression, so a search term
// containing its punctuation would change the query's shape rather than its
// values. Stripped rather than escaped: these characters have no business in a
// name or a phone number, and dropping them cannot produce a wrong match.
function sanitiseSearch(raw) {
    return String(raw ?? '').replace(/[,()*%\\:."']/g, '').trim();
}

// Turns a Supabase error into a response. Kept in one place so every route
// reports the database's own message rather than a generic failure — the
// operator reading this is the person who can fix a bad column or a broken
// policy, and hiding the reason from them helps nobody.
function dbError(reply, error, what) {
    console.warn(`API: ${what} failed: ${error.message}`);
    return reply.code(502).send({ error: `Could not ${what}`, detail: error.message });
}

// Which of the configured tool names would actually be offered to the model,
// and which would be dropped. Today an unknown name is discarded at call time
// with a console.warn nobody sees, so a typo silently costs a tool for as long
// as it takes someone to notice the assistant cannot do something. This makes
// that visible before the call rather than after it.
function auditTools(names) {
    const registry = new Map(listTools().map((tool) => [tool.name, tool]));
    return (names ?? []).map((name) => {
        const tool = registry.get(name);
        if (!tool) return { name, status: 'unknown', detail: 'No tool by this name exists in the registry' };
        if (!tool.available) return { name, status: 'unavailable', detail: `${tool.urlEnv} is not set, so this tool is never offered` };
        return { name, status: 'ok' };
    });
}

// The tools a row resolves to for one direction, using exactly the fallback
// rowToConfig uses — an empty array is a deliberate "no tools on this
// direction" and must beat the generic list rather than read as unset.
function effectiveTools(row, direction) {
    const specific = direction === 'outbound' ? row?.outbound_enabled_tools : row?.inbound_enabled_tools;
    return specific ?? row?.enabled_tools ?? DEFAULT_CONFIG.tools;
}

function toolsView(row) {
    const view = (direction) => {
        const names = effectiveTools(row, direction);
        return { names, audit: auditTools(names) };
    };
    return {
        configured: {
            generic: row?.enabled_tools ?? null,
            inbound: row?.inbound_enabled_tools ?? null,
            outbound: row?.outbound_enabled_tools ?? null,
        },
        effective: { inbound: view('inbound'), outbound: view('outbound') },
        // So a caller can tell "no tools configured anywhere" apart from "this
        // contact has none but the app default has some".
        appDefault: DEFAULT_CONFIG.tools,
    };
}

export default async function apiRoutes(fastify) {
    // Applied to every route in this plugin, so a route added later cannot be
    // forgotten. Fastify stops the lifecycle once a hook has replied.
    fastify.addHook('onRequest', async (request, reply) => {
        const rejected = rejectUnauthorized(request, reply, 'The management API');
        if (rejected) return rejected;
    });

    // Resolves the client once per request. Returns null having already replied,
    // so routes read `if (!db) return reply;`.
    const client = (reply) => {
        const supabase = getSupabase();
        if (!supabase) {
            reply.code(503).send({
                error: 'Supabase is not configured',
                detail: 'Set SUPABASE_CONFIG_ENABLED=true, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
            });
            return null;
        }
        return supabase;
    };

    // --- Tools ------------------------------------------------------------
    // The registry, not the database: this is what tools.js defines and whether
    // the environment can actually run each one. Needs no Supabase.
    fastify.get('/tools', async () => ({ data: listTools() }));

    // --- Contacts ---------------------------------------------------------

    fastify.get('/contacts', async (request, reply) => {
        const db = client(reply);
        if (!db) return reply;

        const { limit, offset, from, to } = paging(request.query);
        let query = db
            .from('contacts')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);

        const search = sanitiseSearch(request.query.search);
        if (search) query = query.or(`phone_number.ilike.*${search}*,name.ilike.*${search}*`);
        if (request.query.tag) query = query.contains('tags', [request.query.tag]);

        const { data, error, count } = await query;
        if (error) return dbError(reply, error, 'list contacts');
        return reply.send({ data, limit, offset, count });
    });

    fastify.get('/contacts/:phone', async (request, reply) => {
        const phone = normalisePhone(request.params.phone);
        if (!phone) return reply.code(400).send({ error: 'Path must be an E.164 number, e.g. /api/contacts/+447700900123' });

        const db = client(reply);
        if (!db) return reply;

        const { data, error } = await db
            .from('contacts')
            .select('*, contact_config(*)')
            .eq('phone_number', phone)
            .maybeSingle();

        if (error) return dbError(reply, error, 'read contact');
        if (!data) return reply.code(404).send({ error: `No contact for ${phone}` });

        // PostgREST returns a one-to-one embed as an object or a single-element
        // array depending on how it detects the relationship.
        const { contact_config: embedded, ...contact } = data;
        const config = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null;

        return reply.send({
            contact,
            config,
            // What this row alone produces, before any line or app default is
            // considered. The full answer needs to know which of our lines is
            // involved — that is GET /api/config/resolve.
            derived: config
                ? { inbound: rowToConfig(config, 'inbound'), outbound: rowToConfig(config, 'outbound') }
                : null,
        });
    });

    fastify.get('/contacts/:phone/config', async (request, reply) => {
        const phone = normalisePhone(request.params.phone);
        if (!phone) return reply.code(400).send({ error: 'Path must be an E.164 number' });

        const db = client(reply);
        if (!db) return reply;

        const { data, error } = await db
            .from('contacts')
            .select('id, contact_config(*)')
            .eq('phone_number', phone)
            .maybeSingle();

        if (error) return dbError(reply, error, 'read contact config');
        if (!data) return reply.code(404).send({ error: `No contact for ${phone}` });

        const embedded = data.contact_config;
        const config = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null;

        // A contact with no config row is a 200 with config: null, not a 404.
        // It is the normal state for anyone who has simply never been given
        // settings, and a 404 here would read as "no such contact".
        return reply.send({ phoneNumber: phone, contactId: data.id, config });
    });

    fastify.get('/contacts/:phone/tools', async (request, reply) => {
        const phone = normalisePhone(request.params.phone);
        if (!phone) return reply.code(400).send({ error: 'Path must be an E.164 number' });

        const db = client(reply);
        if (!db) return reply;

        const { data, error } = await db
            .from('contacts')
            .select('id, contact_config(enabled_tools, inbound_enabled_tools, outbound_enabled_tools)')
            .eq('phone_number', phone)
            .maybeSingle();

        if (error) return dbError(reply, error, 'read contact tools');
        if (!data) return reply.code(404).send({ error: `No contact for ${phone}` });

        const embedded = data.contact_config;
        const config = Array.isArray(embedded) ? embedded[0] ?? null : embedded ?? null;
        return reply.send({ phoneNumber: phone, ...toolsView(config) });
    });

    fastify.get('/contacts/:phone/messages', async (request, reply) => {
        const phone = normalisePhone(request.params.phone);
        if (!phone) return reply.code(400).send({ error: 'Path must be an E.164 number' });

        const db = client(reply);
        if (!db) return reply;

        const { limit, offset, from, to } = paging(request.query);
        // Joined through the thread rather than filtered on the message, which
        // carries no phone number of its own — sms_messages only knows its
        // thread, and the thread knows both parties.
        const { data, error, count } = await db
            .from('sms_messages')
            .select('*, sms_threads!inner(phone_number, twilio_number)', { count: 'exact' })
            .eq('sms_threads.phone_number', phone)
            .order('created_at', { ascending: false })
            .range(from, to);

        if (error) return dbError(reply, error, 'list messages');
        return reply.send({ phoneNumber: phone, data, limit, offset, count });
    });

    // --- Lines ------------------------------------------------------------

    fastify.get('/lines', async (request, reply) => {
        const db = client(reply);
        if (!db) return reply;

        const { limit, offset, from, to } = paging(request.query);
        const { data, error, count } = await db
            .from('phone_configs')
            .select('*', { count: 'exact' })
            .order('twilio_number')
            .range(from, to);

        if (error) return dbError(reply, error, 'list lines');
        return reply.send({ data, limit, offset, count });
    });

    fastify.get('/lines/:phone', async (request, reply) => {
        const phone = normalisePhone(request.params.phone);
        if (!phone) return reply.code(400).send({ error: 'Path must be an E.164 number' });

        const db = client(reply);
        if (!db) return reply;

        const { data, error } = await db.from('phone_configs').select('*').eq('twilio_number', phone).maybeSingle();
        if (error) return dbError(reply, error, 'read line');
        if (!data) return reply.code(404).send({ error: `No line configured for ${phone}` });

        return reply.send({
            line: data,
            derived: { inbound: rowToConfig(data, 'inbound'), outbound: rowToConfig(data, 'outbound') },
            // The resolver only considers a line with call_enabled set, so a
            // row that exists but is switched off looks identical to a missing
            // one at call time. Said plainly rather than left to be inferred.
            appliesToCalls: data.call_enabled === true,
        });
    });

    fastify.get('/lines/:phone/tools', async (request, reply) => {
        const phone = normalisePhone(request.params.phone);
        if (!phone) return reply.code(400).send({ error: 'Path must be an E.164 number' });

        const db = client(reply);
        if (!db) return reply;

        const { data, error } = await db
            .from('phone_configs')
            .select('enabled_tools, inbound_enabled_tools, outbound_enabled_tools')
            .eq('twilio_number', phone)
            .maybeSingle();

        if (error) return dbError(reply, error, 'read line tools');
        if (!data) return reply.code(404).send({ error: `No line configured for ${phone}` });

        return reply.send({ twilioNumber: phone, ...toolsView(data) });
    });

    // --- Calls and audit --------------------------------------------------

    fastify.get('/calls', async (request, reply) => {
        const db = client(reply);
        if (!db) return reply;

        const { limit, offset, from, to } = paging(request.query);
        const sort = CALL_SORTS.includes(request.query.sort) ? request.query.sort : 'started_at';

        let query = db.from('calls').select('*', { count: 'exact' }).order(sort, { ascending: false }).range(from, to);

        if (request.query.phone) {
            const phone = normalisePhone(request.query.phone);
            if (!phone) return reply.code(400).send({ error: '"phone" must be an E.164 number' });
            query = query.eq('phone_number', phone);
        }
        if (request.query.direction) query = query.eq('direction', request.query.direction);
        if (request.query.status) query = query.eq('status', request.query.status);

        const { data, error, count } = await query;
        if (error) return dbError(reply, error, 'list calls');
        return reply.send({ data, limit, offset, count, sort });
    });

    fastify.get('/calls/:callSid', async (request, reply) => {
        const db = client(reply);
        if (!db) return reply;

        const { callSid } = request.params;
        const [call, tools] = await Promise.all([
            db.from('calls').select('*').eq('twilio_call_sid', callSid).maybeSingle(),
            db.from('tool_calls').select('*').eq('twilio_call_sid', callSid).order('created_at'),
        ]);

        if (call.error) return dbError(reply, call.error, 'read call');
        if (!call.data) return reply.code(404).send({ error: `No call recorded for ${callSid}` });
        // The tool audit is worth having but not worth failing the call read
        // over, so its failure is reported alongside rather than instead.
        if (tools.error) console.warn(`API: tool calls for ${callSid} failed: ${tools.error.message}`);

        return reply.send({
            call: call.data,
            toolCalls: tools.data ?? [],
            toolCallsError: tools.error ? tools.error.message : null,
        });
    });

    fastify.get('/calls/:callSid/tools', async (request, reply) => {
        const db = client(reply);
        if (!db) return reply;

        const { data, error } = await db
            .from('tool_calls')
            .select('*')
            .eq('twilio_call_sid', request.params.callSid)
            .order('created_at');

        if (error) return dbError(reply, error, 'list tool calls');
        return reply.send({ callSid: request.params.callSid, data });
    });

    // --- Resolver preview -------------------------------------------------
    // What a call between these two numbers would actually be configured with,
    // run through the real resolver rather than a second implementation of the
    // cascade. A reimplementation here would drift, and the one thing this
    // endpoint is for is being trusted.
    fastify.get('/config/resolve', async (request, reply) => {
        const { direction = 'inbound' } = request.query;
        if (direction !== 'inbound' && direction !== 'outbound') {
            return reply.code(400).send({ error: '"direction" must be "inbound" or "outbound"' });
        }

        const from = normalisePhone(request.query.from);
        const to = normalisePhone(request.query.to);
        if (!from && !to) return reply.code(400).send({ error: 'At least one of "from" and "to" must be an E.164 number' });
        if (request.query.from && !from) return reply.code(400).send({ error: '"from" must be an E.164 number' });
        if (request.query.to && !to) return reply.code(400).send({ error: '"to" must be an E.164 number' });

        // createContact: false — asking what would happen must not be the thing
        // that creates a contact record.
        const config = await resolveConfig({ from, to, direction, createContact: false });

        return reply.send({
            request: { from, to, direction },
            config,
            // Names the resolver already validated against nothing, so the
            // audit is the only place a typo becomes visible before a call.
            toolAudit: auditTools(config.tools),
            note: 'Config is cached for 60 seconds per phone number, so a change made just now may not appear here yet.',
        });
    });

    // Every registered tool name, for validating a list before it is written.
    // Trivial today; it exists so the write endpoints have one place to point
    // at when they reject an unknown name.
    fastify.get('/tools/names', async () => ({ data: toolNames() }));

    fastify.get('/tools/:name', async (request, reply) => {
        const { name } = request.params;
        if (!isKnownTool(name)) return reply.code(404).send({ error: `No tool named "${name}"`, valid: toolNames() });
        return reply.send(listTools().find((tool) => tool.name === name));
    });
}
