import { emailProvider } from './emailProviders.js';
import { normaliseAddress, outboundEmailRequest } from './email.js';

export async function loadEmailConnection(db, tenantId, { connectionId = null, serviceIdentityId = null, from = null } = {}) {
    let identityQuery = db.from('service_identities').select('*').eq('tenant_id', tenantId).eq('channel', 'email').eq('can_send', true);
    if (serviceIdentityId) identityQuery = identityQuery.eq('id', serviceIdentityId);
    else if (from) identityQuery = identityQuery.eq('address', normaliseAddress(from).address);
    else identityQuery = identityQuery.eq('is_default', true);
    const identity = await identityQuery.limit(2);
    if (identity.error) throw new Error(`Could not load sending identity: ${identity.error.message}`);
    if ((identity.data || []).length !== 1) throw new Error('Email sending identity did not resolve to exactly one tenant identity');
    const serviceIdentity = identity.data[0];
    if (connectionId && serviceIdentity.provider_connection_id !== connectionId) throw new Error('Sending identity does not belong to provider connection');

    const connection = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('id', serviceIdentity.provider_connection_id).eq('enabled', true).maybeSingle();
    if (connection.error) throw new Error(`Could not load email provider connection: ${connection.error.message}`);
    if (!connection.data || !(connection.data.channels || []).includes('email')) throw new Error('Email provider connection is unavailable');
    return { connection: connection.data, serviceIdentity };
}

export async function sendEmailWithProvider({ connection, request, idempotencyKey }) {
    const email = outboundEmailRequest(request);
    const result = await emailProvider(connection).send(connection, email, idempotencyKey);
    if (!result?.id) throw new Error('Email provider accepted the request without returning an email ID');
    return { providerId: result.id, providerResponse: result, email };
}
