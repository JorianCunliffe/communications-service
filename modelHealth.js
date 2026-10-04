import WebSocket from 'ws';
import { DEFAULT_CONFIG, LIVE_TRANSCRIPT_MODEL } from './config.js';

const TIMEOUT_MS = 15000;
export const MODEL_HEALTH_INTERVAL_MS = 15 * 60 * 1000;

// Match the service's actual transport and fallback order, not a vendor catalog.
export function configuredModelChecks(env = process.env) {
    const summary = env.SUMMARY_MODEL || 'gpt-5.4-mini';
    const memory = env.MEMORY_MODEL || summary;
    const checks = [
        ['voice', DEFAULT_CONFIG.model, 'realtime'],
        ['live_transcription', LIVE_TRANSCRIPT_MODEL, 'transcription'],
        ['recording_transcription', env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe-diarize', 'transcription'],
        ['summary', summary, 'chat'],
        ['memory', memory, 'responses'],
        ['call_outcome', env.CALL_OUTCOME_MODEL || memory, 'responses'],
        ['promise_extraction', env.PROMISE_MODEL || env.MEMORY_MODEL || 'gpt-5.4-mini', 'responses'],
        ['operational_review', env.PROMISE_MODEL || 'gpt-5.4-mini', 'responses'],
    ];
    const groups = new Map();
    for (const [role, model, transport] of checks) {
        const id = `${transport}:${model}`;
        if (!groups.has(id)) groups.set(id, { provider: 'openai', model, transport, roles: [] });
        groups.get(id).roles.push(role);
    }
    return [...groups.values()];
}

// Never expose raw provider messages: they can contain credentials or project IDs.
export function failureStatus(status, error = {}) {
    const code = String(error.code || error.type || '');
    if (/insufficient_quota|billing|credit|quota_exceeded/.test(code)) return 'quota_or_credit_exhausted';
    if (status === 401 || status === 403) return 'authentication_failed';
    if (status === 404 || /model_not_found/.test(code)) return 'model_unavailable';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'provider_unavailable';
    return 'probe_failed';
}

function silentWav() {
    const pcmBytes = 16000 * 2;
    const wav = Buffer.alloc(44 + pcmBytes);
    wav.write('RIFF'); wav.writeUInt32LE(36 + pcmBytes, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcmBytes, 40);
    return wav;
}

export function probeRealtime(check, key, Socket = WebSocket) {
    return new Promise(resolve => {
        const socket = new Socket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(check.model)}`, {
            headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: TIMEOUT_MS,
        });
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true; clearTimeout(timer); socket.terminate(); resolve(result);
        };
        const timer = setTimeout(() => finish({ status: 'timeout', usable: false }), TIMEOUT_MS);
        socket.on('message', bytes => {
            let event;
            try { event = JSON.parse(bytes.toString()); } catch { return; }
            if (event.type === 'session.created') {
                socket.send(JSON.stringify({ type: 'response.create', response: {
                    output_modalities: ['text'], instructions: 'Reply with OK.', max_output_tokens: 16,
                } }));
            } else if (event.type === 'error') {
                finish({ status: failureStatus(null, event.error), usable: false });
            } else if (event.type === 'response.done') {
                const response = event.response;
                if (response?.status === 'completed') finish({ status: 'working', usable: true });
                else finish({ status: failureStatus(null, response?.status_details?.error), usable: false });
            }
        });
        socket.on('unexpected-response', (_request, response) => {
            let body = '';
            response.on('data', chunk => { if (body.length < 8192) body += chunk.toString(); });
            response.on('end', () => {
                let error = {}; try { error = JSON.parse(body).error || {}; } catch { /* safe generic status */ }
                finish({ status: failureStatus(response.statusCode, error), usable: false });
            });
        });
        socket.on('error', () => finish({ status: 'connection_failed', usable: false }));
        socket.on('close', () => finish({ status: 'connection_failed', usable: false }));
    });
}

export async function probeModel(check, { env = process.env, fetchImpl = fetch, Socket = WebSocket } = {}) {
    const key = env.OPENAI_API_KEY;
    if (!key) return { status: 'not_configured', usable: false };
    try {
        if (check.transport === 'realtime') return await probeRealtime(check, key, Socket);
        const headers = { Authorization: `Bearer ${key}` };
        let path, body;
        if (check.transport === 'transcription') {
            path = 'audio/transcriptions';
            body = new FormData();
            body.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'health.wav');
            body.append('model', check.model);
            if (check.model.includes('diarize')) {
                body.append('response_format', 'diarized_json'); body.append('chunking_strategy', 'auto');
            }
        } else {
            headers['Content-Type'] = 'application/json';
            path = check.transport === 'chat' ? 'chat/completions' : 'responses';
            body = JSON.stringify(check.transport === 'chat'
                ? { model: check.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 32 }
                : { model: check.model, input: 'Reply with OK.', max_output_tokens: 32, store: false });
        }
        const response = await fetchImpl(`https://api.openai.com/v1/${path}`, {
            method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) return { status: failureStatus(response.status, payload?.error), usable: false };
        if (!payload || payload.error || (payload.status && payload.status !== 'completed')) {
            return { status: failureStatus(null, payload?.error), usable: false };
        }
        return { status: 'working', usable: true };
    } catch (error) {
        return { status: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'connection_failed', usable: false };
    }
}

export function createModelHealth({ env = process.env, probe = probeModel, now = Date.now } = {}) {
    let snapshot = { status: 'checking', allWorking: false, checkedAt: null, models: [] };
    let pending = null;
    let lastStarted = -Infinity;
    const read = () => ({ ...snapshot,
        stale: !snapshot.checkedAt || now() - Date.parse(snapshot.checkedAt) > MODEL_HEALTH_INTERVAL_MS * 2,
        checking: Boolean(pending), intervalSeconds: MODEL_HEALTH_INTERVAL_MS / 1000,
        scope: 'service_defaults_and_environment_overrides',
        creditBalance: 'not_exposed_by_provider',
    });
    const refresh = () => {
        if (pending) return pending;
        // Public reads never trigger probes. Authenticated refreshes also share a cooldown.
        if (now() - lastStarted < 60000) return Promise.resolve(read());
        lastStarted = now();
        pending = (async () => {
            const models = await Promise.all(configuredModelChecks(env).map(async check => {
                let result;
                try { result = await probe(check, { env }); }
                catch { result = { status: 'probe_failed', usable: false }; }
                return { ...check, ...result, credits: result.usable ? 'request_accepted' : 'unverified' };
            }));
            const allWorking = models.every(model => model.usable);
            snapshot = { status: allWorking ? 'working' : 'degraded', allWorking, checkedAt: new Date(now()).toISOString(), models };
        })().finally(() => { pending = null; });
        return pending.then(read);
    };
    const start = () => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, MODEL_HEALTH_INTERVAL_MS);
        timer.unref();
        return () => clearInterval(timer);
    };
    return { read, refresh, start };
}
