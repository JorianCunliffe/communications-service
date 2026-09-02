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

// A model asked for "the 6th" will send all sorts of things. Anything that is
// not a usable date becomes no filter at all, because a silently wrong date
// returns the wrong conversation and reads as though nothing was said.
export function normaliseSince(value) {
    const text = String(value ?? '').trim();
    if (text === '') return null;

    const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? new Date(`${text}T00:00:00.000Z`)
        : new Date(text);

    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Keeps turns containing every word asked for, case-insensitively. Deliberately
// dumb: this narrows a period the model already chose, and a clever matcher
// that quietly dropped the one relevant line would be worse than none.
export function filterTurns(turns, query) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return turns;

    return turns.filter((turn) => {
        const content = String(turn.content ?? '').toLowerCase();
        return words.every((word) => content.includes(word));
    });
}

const TOOLS = {
    select_hyperflow_project: {
        type: 'builtin',
        timeoutMs: 5000,
        description:
            'Select or switch the HyperFlow project for this call and retrieve only the context that this caller is authorized to use. ' +
            'Call this after the caller names a project, whenever they ask to switch projects, or before answering a project question when no project context is available. ' +
            'Pass the caller\'s own project wording and current question. If the result asks for clarification, ask exactly that clarification and do not guess.',
        parameters: {
            type: 'object',
            properties: {
                project_reference: { type: 'string', description: 'The project name or wording the caller used.' },
                question: { type: 'string', description: 'The caller\'s current question, when present.' },
            },
            required: ['project_reference'],
        },
        handler: async ({ project_reference, question = '' } = {}, context = {}) => {
            const { requestHyperFlowVoiceContext } = await import('./hyperflowVoice.js');
            return requestHyperFlowVoiceContext({
                tenantId: context.tenantId,
                personId: context.personId,
                threadId: context.threadId,
                communicationId: context.communicationId,
                serviceIdentity: context.serviceIdentity,
                utterance: [project_reference, question].filter(Boolean).join('. '),
            });
        },
    },

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

    // The long-term half of the assistant's memory.
    //
    // The prompt carries an overview — a dated line per past conversation, from
    // the summariser. That is deliberately thin: it fits in every call, says
    // what exists, and costs nothing to carry. This is how the assistant gets
    // from "we spoke on the 6th about the time" to what was actually said.
    //
    // Injecting the whole record into every prompt instead was tried and was
    // wrong: 3000 characters on every call, growing without bound, most of it
    // never referred to. An overview plus a lookup is the same information at a
    // fraction of the cost, and it scales when email and Slack arrive.
    recall_conversations: {
        type: 'builtin',
        // A search across everything on record, not a page of recent turns.
        // Allowed to be slower than the other tools because it only runs after
        // the model has said it is looking something up.
        timeoutMs: 5000,
        description:
            'Search everything on record with this person - calls, texts and recordings - and get back ' +
            'the conversations that answer your question, with what was actually said in them. ' +
            'The summary in your instructions says roughly what has happened; use this whenever you need ' +
            'detail, a date, a quote, or anything it does not cover. ' +
            'Put the subject in `about` and let the search do the work: it looks across all of history, ' +
            'not just recent conversations, and returns the relevant ones. Prefer one good `about` query ' +
            'over several narrow ones - you are on a phone call and have no time to page through results. ' +
            'Say that you are checking before you call it, so the caller is not left in silence. ' +
            'If the result contains an error, say plainly that you could not reach the record. Never guess ' +
            'at what was said, and never present the summary in your instructions as if it were the ' +
            'conversation itself. If no conversations come back, there is nothing on record matching that: ' +
            'say so rather than inventing one. ' +
            'Spelling does not have to be right - the search is fuzzy and forgiving, so pass the name as ' +
            'you heard it rather than asking the caller to spell it. If the result carries `did_you_mean`, ' +
            'those are the spellings on record: search again with one of them before saying there is ' +
            'nothing. A result marked `matched_by: fuzzy` matched approximately, so treat its wording as ' +
            'close rather than exact.',
        parameters: {
            type: 'object',
            properties: {
                about: {
                    type: 'string',
                    description:
                        'What you are looking for, as words that would appear in the conversation or its ' +
                        'summary - "invoice", "Brisbane time", "the roadtrip". Omit to get the most recent ' +
                        'conversations regardless of subject, which is what to do when asked an open ' +
                        'question like "what have we talked about".',
                },
                since: {
                    type: 'string',
                    description:
                        'Only conversations on or after this date, YYYY-MM-DD. Only needed when the caller ' +
                        'names a time period. Leave it off to search all of history.',
                },
                until: {
                    type: 'string',
                    description:
                        'Only conversations before this date, YYYY-MM-DD. Pair with since to ask about one ' +
                        'day - for yesterday, since is yesterday and until is today.',
                },
                limit: {
                    type: 'integer',
                    description: 'How many conversations to return. Defaults to 5, which suits a spoken answer.',
                },
            },
            required: [],
        },
        handler: async ({ about = null, since = null, until = null, limit = null } = {}, context = {}) => {
            const phoneNumber = context.phoneNumber ?? null;
            if (!phoneNumber) {
                // Better an explicit failure than a confident "we have never
                // spoken": the description tells the model not to guess, and
                // this is the case where guessing would be most plausible.
                return { error: 'No caller identity available for this call, so history cannot be looked up.' };
            }

            // Imported here rather than at module scope. config.js imports this
            // file, and context.js reaches config.js through configResolver, so
            // a static import would close a cycle through the module that every
            // call depends on. Resolved once and cached thereafter.
            const { searchCommunications } = await import('./context.js');

            const asked = Number(limit);
            const result = await searchCommunications({
                phoneNumber,
                query: about,
                since: normaliseSince(since),
                until: normaliseSince(until),
                limit: Number.isFinite(asked) && asked > 0 ? asked : 5,
            });

            return {
                // One entry per conversation, already condensed. The model gets
                // an answer to read out, not a transcript to search.
                conversations: result.conversations,
                // What was actually looked at, so "nothing on record" can be
                // told apart from "nothing in the part I looked at".
                searched: result.searched,
                matched: result.returned,
                // Only present on a miss: the spellings the search thinks were
                // meant. Speech recognition mangles unusual names, and the
                // alternative is asking the caller to spell one down the phone.
                did_you_mean: result.suggestions.length ? result.suggestions : undefined,
                partial: result.errors.length ? result.errors : undefined,
            };
        },
    },

    end_call: {
        type: 'builtin',
        timeoutMs: 200,
        description:
            'Hang up. Call this when the conversation is genuinely finished — the caller has said goodbye, ' +
            'or said they are done, or asked you to hang up. ' +
            'Say your goodbye FIRST, in the same turn, and then call this: the line stays open until you ' +
            'have finished speaking, so the caller hears you out. ' +
            'Do not call it because there is a pause, because you have answered the question, or because ' +
            'you cannot help — a caller who goes quiet is thinking, and hanging up on them is worse than ' +
            'waiting. When in doubt, ask whether there is anything else instead of calling this.',
        parameters: {
            type: 'object',
            properties: {
                reason: {
                    type: 'string',
                    description:
                        'Why the call is ending, in a few words — "caller said goodbye", "caller asked to ' +
                        'hang up". Recorded on the call, not spoken.',
                },
            },
            required: [],
        },
        // The socket lives in the media stream, not here, so this cannot do the
        // hanging up itself. It returns the intent; index.js watches for it and
        // closes the line once the goodbye has finished playing.
        handler: ({ reason = null } = {}) => ({
            ending: true,
            reason: reason || 'the assistant ended the call',
            // Read by the model, which is still composing its farewell turn.
            note: 'The line will close once you have finished speaking. Say goodbye now; do not say anything after it.',
        }),
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

// Tools every call is offered, whatever its configuration says.
//
// Hanging up is not an optional capability the way the calendar is. Without
// end_call the assistant has no way to finish a conversation: the line stays
// open until the caller hangs up or maxCallSeconds cuts it off mid-sentence,
// and "are you still there?" loops forever because nothing can act on the
// answer. Since DEFAULT_CONFIG.tools is [], leaving this to per-contact opt-in
// meant nearly every call was placed unable to end itself.
//
// Set ALWAYS_OFFER_END_CALL=false to restore the previous opt-in behaviour.
export const ALWAYS_ON_TOOLS = ['end_call'];

const alwaysOnTools = () =>
    /^(false|0|off|no)$/i.test(String(process.env.ALWAYS_OFFER_END_CALL ?? '').trim())
        ? []
        : ALWAYS_ON_TOOLS;

// The tool definitions to advertise in session.update, in the API's expected
// shape: type/name/description/parameters at the top level of each entry.
// Unknown or unavailable names are dropped with a warning — a typo in the
// database should cost one tool, not the call.
export function buildToolDefinitions(names) {
    const configured = Array.isArray(names) ? names : [];
    // Configured order is preserved, and a configuration that already names an
    // always-on tool keeps its own position for it rather than gaining a second.
    const requested = [
        ...configured,
        ...alwaysOnTools().filter((name) => !configured.includes(name)),
    ];
    if (requested.length === 0) return [];

    const definitions = [];
    for (const name of requested) {
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
