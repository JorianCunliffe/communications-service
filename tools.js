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
            "Check the user's calendar for events in a date range. Use this whenever the caller asks " +
            'what is on, whether a time is free, or when something is scheduled. Say that you are ' +
            'checking before you call it, so the caller is not left in silence.',
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
                    description: 'IANA timezone name, e.g. Australia/Brisbane. Defaults to Australia/Brisbane.',
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
