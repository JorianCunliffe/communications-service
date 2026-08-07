// Tool definitions the assistant may call during a call.
//
// Two kinds of tool:
//   builtin — a handler in this file, running in process.
//   http    — a POST to a URL from the environment, so the work (and its
//             credentials) live in another system. TOOL_<NAME>_URL supplies
//             the endpoint; a tool whose URL is unset is treated as unavailable
//             and is never offered to the model.
//
// Everything here is read-only on purpose. A tool that changes state in another
// system is a much larger trust decision than one that answers a question, and
// nothing in this file should acquire side effects without that being deliberate.
//
// Latency is the constraint that shapes the rest. On a phone call, silence past
// about a second and a half reads as a dropped line, so every tool carries a
// short timeout and returns a structured failure rather than hanging. The model
// is told to say what it is doing before calling one, which covers the gap.
//
// A failure must always be legible as a failure. Tools return { error } rather
// than an empty result, and their descriptions tell the model to admit it could
// not check — an unreachable calendar reported as "nothing on" is a confident
// wrong answer, which is the worst outcome this feature can produce.

const DEFAULT_TIMEOUT_MS = 2500;

// Turns a tool name into the environment variable holding its endpoint:
// check_calendar -> TOOL_CHECK_CALENDAR_URL
function urlEnvName(name) {
    return `TOOL_${name.toUpperCase()}_URL`;
}

const TOOLS = {
    check_calendar: {
        type: 'http',
        timeoutMs: 3000,
        description:
            "Check the calendar of the person you are acting for, over a date range. Use this whenever " +
            'the caller asks what is on, whether a time is free, or when something is scheduled. Say that ' +
            'you are checking before you call it, so the caller is not left in silence. ' +
            'If the result contains an error, say plainly that you could not reach the calendar and ' +
            'cannot say what is on. Never treat a failure, or a result you cannot read, as meaning the ' +
            'time is free — saying someone is free when the calendar could not be checked is worse than ' +
            'admitting you do not know.',
        parameters: {
            type: 'object',
            properties: {
                start_date: {
                    type: 'string',
                    description: 'First day to check, as YYYY-MM-DD. Defaults to today when omitted.',
                },
                end_date: {
                    type: 'string',
                    description: 'Last day to check, as YYYY-MM-DD. Defaults to start_date when omitted.',
                },
            },
            required: ['start_date'],
        },
    },

    get_current_time: {
        type: 'builtin',
        timeoutMs: 200,
        description:
            'Get the current date and time. Use this before any reasoning about what day it is, ' +
            'rather than guessing — you have no clock of your own.',
        parameters: {
            type: 'object',
            properties: {
                timezone: {
                    type: 'string',
                    description:
                        'IANA timezone name, e.g. Europe/Paris. OMIT THIS unless the caller has ' +
                        'explicitly named a place they want the time for. Omitting it gives the ' +
                        'caller\'s own local time, which is almost always what they meant. Never ' +
                        'pass UTC: it is not where anyone is, and answering in it is wrong.',
                },
            },
            required: [],
        },
        handler: ({ timezone } = {}) => {
            const tz = timezone || 'Australia/Brisbane';
            try {
                return {
                    timezone: tz,
                    iso: new Date().toISOString(),
                    local: new Intl.DateTimeFormat('en-AU', {
                        dateStyle: 'full', timeStyle: 'short', timeZone: tz,
                    }).format(new Date()),
                };
            } catch (_) {
                // An unknown timezone should not fail the call.
                return { timezone: 'UTC', iso: new Date().toISOString(), note: `Unknown timezone ${tz}, used UTC` };
            }
        },
    },
};

// Whether a tool can actually run right now. An http tool with no configured
// URL is defined but not available, so it is filtered out rather than offered
// to the model and then failing mid-sentence.
function isAvailable(name) {
    const tool = TOOLS[name];
    if (!tool) return false;
    if (tool.type !== 'http') return true;
    return Boolean(process.env[urlEnvName(name)]);
}

// The tool definitions to advertise in session.update, in the API's expected
// shape: type/name/description/parameters at the top level of each entry.
// Unknown or unavailable names are dropped with a warning — a typo in the
// database should cost one tool, not the call.
export function buildToolDefinitions(names) {
    if (!Array.isArray(names) || names.length === 0) return [];

    const definitions = [];
    for (const name of names) {
        if (!TOOLS[name]) {
            console.warn(`Ignoring unknown tool "${name}"`);
            continue;
        }
        if (!isAvailable(name)) {
            console.warn(`Tool "${name}" is enabled but ${urlEnvName(name)} is not set — not offering it`);
            continue;
        }
        const { description, parameters } = TOOLS[name];
        definitions.push({ type: 'function', name, description, parameters });
    }
    return definitions;
}

// Every tool the registry knows about, for GET /api/tools. `available` is the
// same test the call path uses, so a tool that would be silently dropped at
// call time reports false here instead — which is the whole point of exposing
// this: the alternative is reading tools.js by hand and guessing at the
// environment. Includes the parameter schema so a caller can see what the model
// will be asked for without a second source of truth.
export function listTools() {
    return Object.entries(TOOLS).map(([name, tool]) => ({
        name,
        type: tool.type,
        description: tool.description,
        parameters: tool.parameters,
        timeoutMs: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        available: isAvailable(name),
        // Named rather than valued: this says which variable to set, and never
        // leaks the endpoint itself.
        urlEnv: tool.type === 'http' ? urlEnvName(name) : null,
    }));
}

// Just the names, for validating a configured list against the registry.
export function toolNames() {
    return Object.keys(TOOLS);
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs a tool and always resolves — never rejects. The model receives whatever
// comes back, so a failure has to be something it can read out loud and recover
// from, not an exception that strands the caller in silence.
export async function executeTool(name, args, context = {}) {
    const started = Date.now();
    const tool = TOOLS[name];

    const done = (result) => ({ ...result, durationMs: Date.now() - started });

    if (!tool) return done({ error: `Unknown tool "${name}"` });
    if (!isAvailable(name)) return done({ error: `Tool "${name}" is not configured` });

    const timeoutMs = tool.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
        if (tool.type === 'builtin') {
            const output = await withTimeout(
                Promise.resolve().then(() => tool.handler(args, context)),
                timeoutMs,
                `Tool ${name}`
            );
            return done({ output });
        }

        const url = process.env[urlEnvName(name)];
        const response = await withTimeout(
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // The call context travels with the request so the receiving
                // system knows who is asking without a second lookup.
                body: JSON.stringify({ tool: name, arguments: args ?? {}, ...context }),
            }),
            timeoutMs,
            `Tool ${name}`
        );

        if (!response.ok) {
            return done({ error: `Tool "${name}" returned HTTP ${response.status}` });
        }

        // A tool that answers with prose rather than JSON is still useful to
        // the model, so text is passed through rather than treated as a fault.
        const text = await response.text();
        try {
            return done({ output: JSON.parse(text) });
        } catch (_) {
            return done({ output: { result: text } });
        }
    } catch (error) {
        return done({ error: error.message });
    }
}

// Whether any tool by this name exists, regardless of availability. Used to
// tell "not configured" apart from "not a real tool" when reporting.
export function isKnownTool(name) {
    return Boolean(TOOLS[name]);
}
