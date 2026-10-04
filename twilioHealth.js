import { isAuthorized } from './auth.js';

export const TWILIO_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const SID = /^AC[0-9a-fA-F]{32}$/;
const empty = status => ({ status, accountStatus: 'unknown', balanceState: 'unknown', balanceCheck: 'not_checked', balance: null });

// Only fixed, read-only provider endpoints. Never retain account payloads or errors.
export async function probeTwilio({ env = process.env, fetchImpl = fetch } = {}) {
    const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return empty('not_configured');
    if (!SID.test(sid)) return empty('invalid_configuration');
    const threshold = Number(env.TWILIO_LOW_BALANCE_THRESHOLD || 10);
    if (!Number.isFinite(threshold) || threshold < 0) return empty('invalid_configuration');
    const get = async suffix => {
        try {
            const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}${suffix}`, {
                method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
                headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
            });
            if (!response.ok) return { error: response.status === 401 || response.status === 403
                ? 'authentication_failed' : response.status === 429 ? 'rate_limited' : 'provider_unavailable' };
            return { data: await response.json() };
        } catch (error) {
            return { error: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'check_failed' };
        }
    };
    const account = await get('.json');
    if (account.error) return empty(account.error);
    if (account.data?.sid !== sid || !['active', 'suspended', 'closed'].includes(account.data?.status)) return empty('invalid_response');
    const result = { ...empty(account.data.status), accountStatus: account.data.status };
    // Subaccounts share their parent's billing. Do not misrepresent a child balance.
    if (account.data.owner_account_sid !== sid) {
        result.balanceCheck = 'parent_account_required';
    } else {
        const balance = await get('/Balance.json');
        const value = balance.data?.balance, currency = balance.data?.currency;
        if (balance.error) result.balanceCheck = balance.error;
        else if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))
            || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) result.balanceCheck = 'invalid_response';
        else {
            result.balance = { amount: value, currency, lowThreshold: threshold };
            result.balanceCheck = 'checked';
            result.balanceState = Number(value) <= 0 ? 'depleted' : Number(value) <= threshold ? 'low' : 'ok';
        }
    }
    if (result.accountStatus === 'active') result.status = result.balanceState === 'ok' ? 'active'
        : result.balanceState === 'unknown' ? 'balance_unavailable' : `${result.balanceState}_balance`;
    return result;
}

export function createTwilioHealth({ env = process.env, probe = probeTwilio, now = Date.now } = {}) {
    let snapshot = { ...empty('checking'), checkedAt: null }, pending, lastAttempt = null;
    function read({ privateDetails = false } = {}) {
        const { balance, ...publicSnapshot } = snapshot;
        const stale = !snapshot.checkedAt || now() - Date.parse(snapshot.checkedAt) > 2 * TWILIO_HEALTH_INTERVAL_MS;
        return { ...publicSnapshot, ...(privateDetails ? { balance } : {}), stale, checking: Boolean(pending),
            accountReady: !stale && !pending && snapshot.status === 'active',
            intervalSeconds: TWILIO_HEALTH_INTERVAL_MS / 1000,
            scope: 'Account and balance only; does not verify phone routing, calls or SMS delivery.' };
    }
    async function refresh() {
        if (pending) return pending;
        if (lastAttempt !== null && now() - lastAttempt < 60000) return;
        lastAttempt = now();
        pending = Promise.resolve().then(() => probe({ env })).then(result => {
            snapshot = { ...result, checkedAt: new Date(now()).toISOString() };
        }).catch(() => { snapshot = { ...empty('check_failed'), checkedAt: new Date(now()).toISOString() }; });
        try { await pending; } finally { pending = null; }
    }
    return { read, refresh, start() {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, TWILIO_HEALTH_INTERVAL_MS);
        timer.unref();
        return () => clearInterval(timer);
    } };
}

export function registerTwilioHealthRoutes(fastify, health) {
    const authorize = async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!isAuthorized(request)) return reply.code(401).send({ error: 'Invalid or missing X-API-Key' });
    };
    fastify.get('/health/twilio', { preHandler: authorize }, async () => health.read({ privateDetails: true }));
    fastify.post('/health/twilio/refresh', { preHandler: authorize }, async () => {
        await health.refresh();
        return health.read({ privateDetails: true });
    });
}
