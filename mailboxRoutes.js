import { getDatabase } from './database.js';
import { exchangeGmailCode, verifyMailboxOAuthState, mailboxOAuthNonceHash } from './mailboxOAuth.js';
import { connectGmailMailbox, syncGmailMailbox } from './mailboxService.js';
import { safeFetch } from './safeFetch.js';
import { tenantDatabase } from './tenantContext.js';

function publicError(reply, error, status = 400) {
    console.warn(`Mailbox OAuth: ${String(error?.message || error).slice(0, 300)}`);
    return reply.code(status).send({ error: error?.message || String(error) });
}

async function verifyPubSub(request) {
    const audience = String(process.env.GMAIL_PUBSUB_AUDIENCE || '').trim();
    const serviceAccount = String(process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT || '').trim().toLowerCase();
    const authorization = String(request.headers.authorization || '');
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!audience || !serviceAccount) throw Object.assign(new Error('Gmail Pub/Sub verification is not configured'), { status: 503 });
    if (!token || token.length > 4096) throw Object.assign(new Error('Invalid Gmail Pub/Sub bearer token'), { status: 401 });
    const url = new URL('https://oauth2.googleapis.com/tokeninfo');
    url.searchParams.set('id_token', token);
    const response = await safeFetch(url.toString(), { signal: AbortSignal.timeout(10000) }, {
        scope: 'GMAIL_PUBSUB', allowedHosts: ['oauth2.googleapis.com'], maxRedirects: 0,
    });
    const claims = await response.json().catch(() => ({}));
    if (!response.ok || claims.aud !== audience || String(claims.email || '').toLowerCase() !== serviceAccount || String(claims.email_verified) !== 'true') {
        throw Object.assign(new Error('Invalid Gmail Pub/Sub identity'), { status: 401 });
    }
    const expectedSubscription = String(process.env.GMAIL_PUBSUB_SUBSCRIPTION || '').trim();
    if (expectedSubscription && request.body?.subscription !== expectedSubscription) {
        throw Object.assign(new Error('Unexpected Gmail Pub/Sub subscription'), { status: 403 });
    }
}

function pubSubPayload(body) {
    const encoded = body?.message?.data;
    if (typeof encoded !== 'string' || !body?.message?.messageId) throw new Error('Malformed Gmail Pub/Sub notification');
    let payload;
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('Malformed Gmail Pub/Sub data'); }
    if (!payload.emailAddress || !payload.historyId) throw new Error('Incomplete Gmail Pub/Sub data');
    return { emailAddress: String(payload.emailAddress).trim().toLowerCase(), historyId: String(payload.historyId) };
}

export default async function mailboxPublicRoutes(fastify) {
    fastify.get('/mailboxes/google/callback', async (request, reply) => {
        try {
            if (request.query.error) throw new Error(`Google authorization was not completed: ${request.query.error}`);
            const state = verifyMailboxOAuthState(request.query.state);
            const db = getDatabase();
            if (!db) return reply.code(503).send({ error: 'Communications persistence is not configured' });
            const tenantDb = tenantDatabase(db, state.tenantId);
            const consumed = await tenantDb.rpc('consume_mailbox_oauth_state', {
                p_tenant_id: state.tenantId,
                p_nonce_hash: mailboxOAuthNonceHash(state.nonce),
                p_initiator_id: state.initiatorId,
            });
            if (consumed.error || consumed.data !== true) throw new Error('Mailbox OAuth state was already used or expired');
            const code = String(request.query.code || '');
            if (!code) throw new Error('Google authorization code is required');
            const tokens = await exchangeGmailCode(code);
            if (!tokens.refresh_token) throw new Error('Google did not issue offline access; reconnect and grant consent');
            await connectGmailMailbox(tenantDb, {
                tenantId: state.tenantId,
                initiatorId: state.initiatorId,
                tokens,
                scopes: String(tokens.scope || '').split(/\s+/).filter(Boolean),
            });
            const destination = new URL(state.returnUrl);
            destination.searchParams.set('mailbox', 'connected');
            return reply.redirect(destination.toString());
        } catch (error) {
            return publicError(reply, error, error.status || 400);
        }
    });

    fastify.post('/gmail', async (request, reply) => {
        try {
            await verifyPubSub(request);
            const notification = pubSubPayload(request.body);
            const db = getDatabase();
            if (!db) return reply.code(503).send({ error: 'Communications persistence is not configured' });
            const matches = await db.from('provider_connections').select('*')
                .eq('provider', 'gmail').eq('provider_account_id', notification.emailAddress).eq('enabled', true).limit(20);
            if (matches.error) throw new Error(matches.error.message);
            for (const connection of matches.data || []) {
                setImmediate(() => syncGmailMailbox(tenantDatabase(db, connection.tenant_id), {
                    tenantId: connection.tenant_id,
                    connectionId: connection.id,
                    actorId: 'gmail_pubsub',
                }).catch((error) => console.warn(`Gmail push sync ${connection.id}: ${error.message}`)));
            }
            return reply.code(204).send();
        } catch (error) {
            return publicError(reply, error, error.status || 400);
        }
    });
}
