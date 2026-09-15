import { getDatabase } from './database.js';
import { tenantDatabase } from './tenantContext.js';
import { updateMailboxDraft } from './mailboxDraftUpdate.js';
import v1CoreRoutes from './v1Core.js';

export { CHANNELS, DIRECTIONS, TERMINAL_CALL_STATUSES, toCanonical, parseSemantic, outboundError } from './v1Core.js';

function errorReply(reply, error, status = 400) {
    return reply.code(status).send({ error: error?.message || String(error), ...(error?.code ? { code: error.code } : {}) });
}

export default async function v1Routes(fastify, options = {}) {
    // Keep the existing API/auth contract byte-for-byte in v1Core. The wrapper
    // only adds provider-native draft revision so this feature cannot regress
    // unrelated Communications routes.
    await v1CoreRoutes(fastify, options);

    const rawDatabase = () => options.database || getDatabase();
    const database = (reply) => {
        const db = rawDatabase();
        if (!db) reply.code(503).send({ error: 'Communications persistence is not configured' });
        return db ? tenantDatabase(db, reply.request.tenantId) : null;
    };

    fastify.patch('/mailboxes/:connectionId/drafts/:draftId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const draft = await updateMailboxDraft(db, {
                tenantId: request.tenantId,
                connectionId: request.params.connectionId,
                draftId: request.params.draftId,
                actorId: request.body?.initiator_id || request.authContext?.keyId,
                idempotencyKey: request.headers['idempotency-key'],
                request: request.body || {},
            });
            return reply.code(200).send(draft);
        } catch (error) {
            if (error.code === 'IDEMPOTENCY_REQUIRED') return errorReply(reply, error, 400);
            if (['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_RECONCILIATION_REQUIRED', 'DRAFT_NOT_EDITABLE', 'DRAFT_IDENTITY_CHANGED'].includes(error.code)) {
                return errorReply(reply, error, 409);
            }
            return errorReply(reply, error, error.status || 502);
        }
    });
}
