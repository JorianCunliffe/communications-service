import { createHash, randomBytes } from 'node:crypto';

function tokenHash(token) {
    return createHash('sha256').update(token).digest('hex');
}

export async function createEmailReplyRoute(db, { tenantId, threadId, askId = null, personId = null, serviceIdentityId, expiresAt }) {
    const token = randomBytes(24).toString('base64url');
    const result = await db.from('email_reply_routes').insert({
        tenant_id: tenantId,
        token_hash: tokenHash(token),
        thread_id: threadId,
        ask_id: askId,
        person_id: personId,
        service_identity_id: serviceIdentityId,
        expires_at: expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).select('*').single();
    if (result.error) throw new Error(`Could not create email reply route: ${result.error.message}`);
    return { token, route: result.data };
}

export function replyTokenFromAddresses(addresses = []) {
    for (const item of addresses) {
        const match = String(item.address || item).match(/^reply\+([A-Za-z0-9_-]{20,})@/i);
        if (match) return match[1];
    }
    return null;
}

export async function resolveEmailReplyRoute(db, tenantId, token) {
    if (!token) return null;
    if (!tenantId) throw new Error('tenant_id is required for email reply resolution');
    const result = await db.from('email_reply_routes').select('*').eq('tenant_id', tenantId).eq('token_hash', tokenHash(token)).maybeSingle();
    if (result.error) throw new Error(`Could not resolve email reply route: ${result.error.message}`);
    const route = result.data;
    if (!route || route.revoked_at || new Date(route.expires_at) <= new Date()) return null;
    await db.from('email_reply_routes').update({ last_used_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', route.id);
    return route;
}
