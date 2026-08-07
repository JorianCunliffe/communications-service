// Opens the OpenAI Realtime socket while Twilio is still setting up the media
// stream, instead of after.
//
// The old order was strictly sequential: answer the call, return TwiML, wait
// for Twilio to open its WebSocket, and only then start a TLS handshake to
// OpenAI — measured at 741-1224ms with the caller already on the line, half to
// two thirds of everything they waited through before hearing a word.
//
// Nothing actually required that order. The TwiML webhook already knows the
// CallSid and has resolved the config, which is everything the connection URL
// and session.update need. So the socket is opened there and claimed by the
// media stream when it arrives.
//
// Three things make this more than moving a line:
//
//   The stream usually arrives mid-handshake. Twilio opens the media stream
//   within tens of milliseconds, and the OpenAI handshake takes hundreds. So
//   the common case is claiming a socket that is still connecting, and that
//   has to be adopted rather than abandoned — twenty milliseconds into a seven
//   hundred millisecond handshake is still a head start, and throwing it away
//   to start a second one is strictly worse.
//
//   Messages arrive before there is anything to handle them. session.created
//   and session.updated both land in the window between opening the socket and
//   the stream claiming it. They are buffered and replayed on claim.
//
//   A call that never connects a stream leaks a socket. Twilio may abandon a
//   call while it is still ringing. Unclaimed sockets are swept.

import WebSocket from 'ws';
import { buildRealtimeUrl, buildSessionUpdate } from './config.js';
import { historyForPrompt, NO_HISTORY_BLOCK } from './context.js';

// How long an unclaimed socket is kept before it is closed. Twilio opens the
// media stream within tens of milliseconds of fetching TwiML, so anything still
// unclaimed after this is a call that is not coming.
const UNCLAIMED_TTL_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

// callSid -> entry
const pending = new Map();

// Off only as an escape hatch. This changes the order of operations on the call
// path, and being able to put it back without a code change is worth one env
// read — set PRECONNECT_REALTIME=false and the media stream connects the way it
// always did.
export function preconnectEnabled() {
    return (process.env.PRECONNECT_REALTIME || '').trim().toLowerCase() !== 'false';
}

// Tearing down a socket makes it complain, and there is no one left who needs
// to hear it. A ws that is still CONNECTING throws from close() — "closed
// before the connection was established" — and emits it as an 'error' event;
// with no listener attached that is an unhandled error, which takes the whole
// process down and every call on it. terminate() is the documented way to
// abandon a handshake.
function closeQuietly(ws) {
    try {
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) ws.close();
    } catch (_) { /* already gone */ }
}

function discard(callSid, entry, why) {
    if (!pending.has(callSid)) return;
    pending.delete(callSid);
    entry.detach();
    closeQuietly(entry.ws);
    console.warn(`Discarded pre-connected Realtime session for ${callSid}: ${why}`);
}

let sweeper = null;

export function startSessionSweeper() {
    if (sweeper) return;
    sweeper = setInterval(() => {
        const cutoff = Date.now() - UNCLAIMED_TTL_MS;
        for (const [callSid, entry] of pending) {
            if (entry.openedAt < cutoff) discard(callSid, entry, 'never claimed by a media stream');
        }
        sweepHistory();
    }, SWEEP_INTERVAL_MS);
    sweeper.unref?.(); // never hold the process open on its own account
}

// Starts a session for a call that is about to connect. Fire-and-forget: a
// failure here costs the head start, not the call, because the media stream
// falls back to connecting for itself.
export function preconnect(callSid, config) {
    if (!preconnectEnabled() || !callSid || pending.has(callSid)) return;

    let ws;
    try {
        ws = new WebSocket(buildRealtimeUrl(config), {
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        });
    } catch (error) {
        console.warn(`Could not pre-connect Realtime for ${callSid}: ${error.message}`);
        return;
    }

    // Held by closure rather than looked up on each event, because onOpen has
    // to keep working after the entry has left the map — the socket is
    // routinely claimed while it is still connecting, and it is this handler
    // that configures the session when it finally opens.
    const entry = {
        ws,
        buffered: [],
        openedAt: Date.now(),
        readyAt: null,
        claimed: false,
        detach: () => {},
    };

    const onOpen = () => {
        try {
            // Configure immediately, claimed or not. Waiting for the media
            // stream to do this would put the round trip back into the part of
            // the call the caller is listening to.
            ws.send(JSON.stringify(buildSessionUpdate(config)));
            entry.readyAt = Date.now();
        } catch (error) {
            console.warn(`session.update failed for ${callSid}: ${error.message}`);
        }
    };

    // Once claimed, the media stream's own handlers are attached and these must
    // stop acting — two listeners buffering and handling the same message would
    // double every event.
    const onMessage = (data) => { if (!entry.claimed) entry.buffered.push(data); };
    const onError = (error) => { if (!entry.claimed) discard(callSid, entry, `socket error: ${error.message}`); };
    const onClose = () => { if (!entry.claimed) discard(callSid, entry, 'closed before it was claimed'); };

    // onOpen is deliberately not detached: it is what sends session.update, and
    // a socket claimed mid-handshake still needs that to happen.
    entry.detach = () => {
        ws.removeListener('message', onMessage);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
    };

    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);

    pending.set(callSid, entry);
}

// Hands the socket to the media stream. Returns null when there is nothing to
// hand over, which is the signal to connect the old way — a caller must always
// handle that, because pre-connection is an optimisation and never a
// requirement.
//
// `open` says whether it is usable right now. When false the socket is still
// handshaking and the caller should greet from its own 'open' handler; because
// listeners fire in the order they were added, the session.update above will
// already have gone out by then.
//
// Buffered messages come back rather than being replayed here: the caller owns
// the handler, and replaying before it has finished wiring up its own state
// would deliver events into a half-built connection.
export function claim(callSid) {
    if (!callSid) return null;

    const entry = pending.get(callSid);
    if (!entry) return null;

    pending.delete(callSid);
    entry.claimed = true;
    entry.detach();

    // CLOSING or CLOSED — nothing to adopt, and the caller falls back.
    if (entry.ws.readyState === WebSocket.CLOSING || entry.ws.readyState === WebSocket.CLOSED) {
        closeQuietly(entry.ws);
        return null;
    }

    return {
        ws: entry.ws,
        buffered: entry.buffered,
        open: entry.ws.readyState === WebSocket.OPEN,
        // How long the socket had been sitting ready, when it was. This is the
        // head start, and it is what the latency line reports.
        readyForMs: entry.readyAt ? Date.now() - entry.readyAt : 0,
        startedMsAgo: Date.now() - entry.openedAt,
    };
}

// For /health, so "is pre-connection working" is answerable without the logs.
export function pendingCount() {
    return pending.size;
}

// --- Conversation history ---------------------------------------------------
//
// The same trick as the socket above, for the same reason. Reading what was
// said to this person before takes 330-590ms against the live database, and
// there is no version of that which is worth putting between a caller dialling
// and the assistant speaking — first-word latency is about 1.5s, and this would
// be a third of it again.
//
// So the lookup starts at the TwiML webhook, runs while Twilio sets up the
// media stream and the assistant delivers its greeting, and the record is
// handed to the model afterwards. Verified against the Realtime API: adding a
// conversation item mid-response does not disturb the response in flight
// (status=completed, no truncation) and does not start a new one, and the
// record is in context for the next turn.
//
// The prompt already says a record is coming, via {{history}}. That wording is
// hedged with "any" precisely because this can arrive empty or not at all.

const historyPending = new Map(); // callSid -> { promise, startedAt }

// Begins the lookup for a call that is about to connect. Fire-and-forget, and
// never rejects: losing history costs context, not the call.
export function startHistory(callSid, config, phoneNumber) {
    if (!callSid || !phoneNumber || historyPending.has(callSid)) return;

    // Set by personaliseConfig, because by now the prompt holds the rendered
    // notice and the {{history}} placeholder that asked for it is gone.
    // Checking the text here found nothing and quietly skipped every lookup.
    if (!config.wantsHistory) return;

    const startedAt = Date.now();
    const promise = historyForPrompt({
        phoneNumber,
        limit: config.historyLimit,
        maxChars: config.historyMaxChars,
        days: config.historyDays,
    })
        .then((block) => {
            const what = block === NO_HISTORY_BLOCK ? 'no previous contact' : `${block.length} chars`;
            console.log(`History for ${phoneNumber}: ${what} in ${Date.now() - startedAt}ms`);
            return block;
        })
        // historyForPrompt already swallows its own failures; this is the belt
        // to that braces, so an unhandled rejection can never reach the call.
        // Still the empty record rather than null — the prompt has promised the
        // model a record, and giving it none is what makes it invent one.
        .catch((error) => {
            console.warn(`History lookup failed for ${phoneNumber}: ${error.message}`);
            return NO_HISTORY_BLOCK;
        });

    historyPending.set(callSid, { promise, startedAt });
}

// The pending lookup for this call, or null if none was started. Returns the
// promise rather than a value: the media stream reaches this point in a few
// hundred milliseconds and the query may still be in flight, and waiting for it
// there costs nothing because the assistant is already talking.
export function claimHistory(callSid) {
    const entry = callSid ? historyPending.get(callSid) : undefined;
    if (!entry) return null;
    historyPending.delete(callSid);
    return entry.promise;
}

// A call that never connected a stream leaves its lookup behind. Same sweep as
// the sockets above, for the same reason.
function sweepHistory() {
    const cutoff = Date.now() - UNCLAIMED_TTL_MS;
    for (const [callSid, entry] of historyPending) {
        if (entry.startedAt < cutoff) historyPending.delete(callSid);
    }
    const partyCutoff = Date.now() - PARTY_TTL_MS;
    for (const [callSid, entry] of callParties) {
        if (entry.notedAt < partyCutoff) callParties.delete(callSid);
    }
}

// --- Who is on the other end -----------------------------------------------
//
// A CallSid is not a person, and a tool that looks up "what have we said to
// this caller before" needs the person. The TwiML webhook knows the number; the
// media stream, where tools actually run, only ever sees the CallSid.
//
// Kept longer than the pre-connect entries because this outlives the setup
// window: it has to still be here on the last turn of an hour-long call.
const PARTY_TTL_MS = 4 * 60 * 60 * 1000;

const callParties = new Map(); // callSid -> { phoneNumber, notedAt }

export function noteParty(callSid, phoneNumber) {
    if (!callSid || !phoneNumber) return;
    callParties.set(callSid, { phoneNumber, notedAt: Date.now() });
}

// Read without consuming. A tool can be called many times in one call, and the
// second lookup must not come back with nobody on the other end.
export function partyFor(callSid) {
    return callSid ? (callParties.get(callSid)?.phoneNumber ?? null) : null;
}
