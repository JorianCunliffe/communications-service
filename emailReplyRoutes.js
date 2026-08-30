import { createHash, randomBytes } from 'node:crypto';

function tokenHash(token) {
    return createHash('sha256').update(token).digest('hex');
}

export function newEmailReplyToken() {
    // Email local-parts are frequently case-folded by providers and mailbox
    // infrastructure. Hex keeps the capability opaque while remaining stable
    // when an address is normalised to lowercase.
    return randomBytes(24).toString('hex');
}

export async function createEmailReplyRoute(db, { tenantId, threadId, askId = null, personId = null, serviceIdentityId, expiresAt }) {
    const token = newEmailReplyToken();
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

export function replyRouteAddressFromAddresses(addresses = []) {
    for (const item of addresses) {
        const address = String(item.address || item).trim().toLowerCase();
        const match = address.match(/^reply\+([a-z0-9_-]{20,})@([^@]+)$/i);
        if (match) return { address, token: match[1], domain: match[2].toLowerCase() };
    }
    return null;
}

export function replyTokenFromAddresses(addresses = []) {
    return replyRouteAddressFromAddresses(addresses)?.token || null;
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

export async function resolveLegacyEmailReplyRoute(db, tenantId, addresses = []) {
    const replyAddress = replyRouteAddressFromAddresses(addresses);
    if (!replyAddress) return null;
    if (!tenantId) throw new Error('tenant_id is required for legacy email reply resolution');

    // Versions before 2.2.4 generated mixed-case base64url tokens and then
    // lowercased the Reply-To address during normalisation. The stored hash can
    // therefore be unrecoverable. Match the full opaque address to the one we
    // recorded on the outbound message, then fail closed unless it identifies
    // exactly one live route.
    const messages = await db.from('email_messages').select('thread_id,service_identity_id')
        .eq('tenant_id', tenantId).eq('direction', 'outbound')
        .contains('reply_to_addresses', [{ address: replyAddress.address }])
        .order('occurred_at', { ascending: false }).limit(2);
    if (messages.error) throw new Error(`Could not resolve legacy email reply message: ${messages.error.message}`);
    if ((messages.data || []).length !== 1) return null;
    const message = messages.data[0];
    if (!message.thread_id || !message.service_identity_id) return null;

    const routes = await db.from('email_reply_routes').select('*')
        .eq('tenant_id', tenantId).eq('thread_id', message.thread_id)
        .eq('service_identity_id', message.service_identity_id)
        .order('created_at', { ascending: false }).limit(10);
    if (routes.error) throw new Error(`Could not resolve legacy email reply route: ${routes.error.message}`);
    const now = Date.now();
    const live = (routes.data || []).filter((route) => !route.revoked_at && new Date(route.expires_at).getTime() > now);
    if (live.length !== 1) return null;
    await db.from('email_reply_routes').update({ last_used_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('id', live[0].id);
    return live[0];
}
