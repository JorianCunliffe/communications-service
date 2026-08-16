// Where a recording came from, and how to go and get it.
//
// One adapter per source. Each knows how to fetch its own audio and with what
// credentials, and nothing else in the pipeline needs to care — the sweeper
// asks for bytes and gets bytes. Twilio is the first; Plaud and generic URLs
// arrive the same way rather than as a second implementation.
//
// The security shape of this file is worth stating plainly: it makes the server
// fetch a URL that, for some sources, came from outside. That is the exact
// shape of an SSRF, on a process holding database credentials and a
// Twilio auth token. So a URL from an untrusted source is checked before it is
// fetched, and a URL from Twilio is not taken from the request at all.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { safeFetch } from './safeFetch.js';

const FETCH_TIMEOUT_MS = 60 * 1000;

// Anything in these ranges is inside the network the server runs on, or is the
// cloud metadata endpoint, and nothing legitimate ever asks us to fetch from
// there. Checked against the *resolved* address, because a hostname under
// someone else's control can point wherever they like.
function isForbiddenAddress(address) {
    if (isIP(address) === 6) {
        const v6 = address.toLowerCase();
        if (v6 === '::1' || v6 === '::') return true;
        if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
        // ::ffff:169.254.169.254 and friends
        const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped ? isForbiddenAddress(mapped[1]) : false;
    }

    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
    const [a, b] = parts;

    if (a === 0 || a === 10 || a === 127) return true;                 // this host, private, loopback
    if (a === 169 && b === 254) return true;                           // link-local, and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;                  // private
    if (a === 192 && b === 168) return true;                           // private
    if (a === 100 && b >= 64 && b <= 127) return true;                 // carrier-grade NAT
    if (a >= 224) return true;                                         // multicast and reserved
    return false;
}

// An optional per-source allow-list, so a deployment can say "plaud recordings
// only ever come from these hosts" and mean it.
function allowedHosts(source) {
    const raw = process.env[`RECORDING_SOURCE_${String(source).toUpperCase()}_HOSTS`];
    return raw ? raw.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean) : null;
}

// Throws unless this URL is safe to fetch. Every rejection names what was
// wrong: an operator debugging a legitimate source needs to know which rule
// caught them.
export async function assertFetchable(rawUrl, source) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch (_) {
        throw new Error('Not a valid URL');
    }

    if (url.protocol !== 'https:') throw new Error('Only https URLs may be fetched');

    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts(source);
    if (allowed && !allowed.includes(host)) {
        throw new Error(`Host ${host} is not in RECORDING_SOURCE_${String(source).toUpperCase()}_HOSTS`);
    }

    // Resolve rather than trusting the name. A literal IP is checked directly;
    // a hostname is checked against every address it answers with, because one
    // safe answer among several proves nothing.
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
    if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);

    for (const address of addresses) {
        if (isForbiddenAddress(address)) {
            throw new Error(`${host} resolves to ${address}, which is inside a private or reserved range`);
        }
    }

    return url.toString();
}

async function readBody(response, url) {
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('The recording was empty');
    return { buffer, contentType: response.headers.get('content-type') || 'application/octet-stream' };
}

// --- Twilio ----------------------------------------------------------------

function twilioAuthHeader() {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error('Twilio credentials are not configured');
    return `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`;
}

// The media URL is built from the RecordingSid and our own account, never taken
// from the webhook body. A forged status callback can then name a recording SID
// at worst; it cannot make this process fetch a host of the attacker's choosing.
export function twilioMediaUrl(recordingSid) {
    const { TWILIO_ACCOUNT_SID } = process.env;
    return `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
}

async function fetchTwilio(recording) {
    const sid = recording.external_id;
    if (!sid) throw new Error('No RecordingSid to fetch');

    const url = twilioMediaUrl(sid);
    const response = await fetch(url, {
        headers: { Authorization: twilioAuthHeader() },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const { buffer, contentType } = await readBody(response, url);
    return { buffer, contentType, filename: `${sid}.mp3` };
}

// Removes the audio from Twilio once its transcript is safely stored. Called
// only after the transcript is committed, and never on a failure path — this is
// not reversible.
export async function deleteTwilioRecording(recordingSid) {
    const { TWILIO_ACCOUNT_SID } = process.env;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.json`;

    const response = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: twilioAuthHeader() },
        signal: AbortSignal.timeout(30000),
    });

    // 404 means it is already gone, which is the state we wanted.
    if (!response.ok && response.status !== 404) {
        throw new Error(`Could not delete recording ${recordingSid}: HTTP ${response.status}`);
    }
}

// --- Anything with a URL ----------------------------------------------------

async function fetchUrl(recording) {
    const url = await assertFetchable(recording.media_url, recording.source);

    const headers = {};
    // The caller can request provider authentication, but the source name maps
    // to one fixed server-side credential; no environment name is accepted.
    if (recording.media_auth === 'provider') {
        const name = `RECORDING_SOURCE_${String(recording.source).toUpperCase()}_TOKEN`;
        const token = process.env[name];
        if (!token) throw new Error(`${name} is not set, so ${recording.source} media cannot be fetched`);
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await safeFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, {
        scope: `RECORDING_SOURCE_${String(recording.source).toUpperCase()}`,
        allowedHosts: allowedHosts(recording.source),
    });
    const { buffer, contentType } = await readBody(response, url);
    return { buffer, contentType, filename: new URL(url).pathname.split('/').pop() || 'audio' };
}

// --- Registry ---------------------------------------------------------------

const SOURCES = {
    twilio: {
        fetch: fetchTwilio,
        // Twilio records in dual channel with the caller on one track and the
        // assistant on the other, but the transcription model does not know
        // that — it returns speakers as A and B. On a call where the assistant
        // greets first, whoever speaks first is the assistant.
        speakerRoles: (recording) => (recording.metadata?.aiSpeaksFirst
            ? { A: 'assistant', B: 'user' }
            : { A: 'user', B: 'assistant' }),
        cleanup: (recording) => deleteTwilioRecording(recording.external_id),
    },
    // Everything else fetches by URL and keeps whatever speaker labels the
    // model produces. A Plaud recording of a meeting has speakers we genuinely
    // cannot name, and guessing would put words in someone's mouth.
    default: {
        fetch: fetchUrl,
        speakerRoles: () => ({}),
        cleanup: null,
    },
};

export function sourceFor(name) {
    return SOURCES[name] || SOURCES.default;
}

export function isKnownSource(name) {
    return typeof name === 'string' && name.trim() !== '';
}
