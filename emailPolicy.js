import { randomUUID } from 'node:crypto';
/** Transport ceiling, separate from HyperFlow workflow approval and client capabilities. */
export function emailSendMode(tenantId, accountMode) {
    if (typeof tenantId !== 'string' || !tenantId.trim()) {
        throw Object.assign(new Error('Authenticated tenant is required'), { statusCode: 403 });
    }
    let policy;
    try {
        policy = JSON.parse(process.env.EMAIL_SEND_POLICY_BY_TENANT || '{}');
        if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
            Object.values(policy).some(value => value !== 'draft_only' && value !== 'allow_send')) throw new Error();
    } catch {
        throw Object.assign(new Error('Email authority configuration is invalid'), { statusCode: 503 });
    }
    // Unconfigured accounts default to draft-only.
    // A configured restriction wins even over wildcard/admin clients.
    if (accountMode !== undefined && accountMode !== 'draft_only' && accountMode !== 'allow_send') {
        throw Object.assign(new Error('Stored email authority is invalid'), { statusCode: 503 });
    }
    if (accountMode === 'draft_only' || (Object.hasOwn(policy, tenantId) && policy[tenantId] === 'draft_only')) return 'draft_only';
    return accountMode || (Object.hasOwn(policy, tenantId) ? policy[tenantId] : 'draft_only');
}

export function assertEmailSendAllowed(tenantId, accountMode) {
    if (emailSendMode(tenantId, accountMode) !== 'allow_send') {
        throw Object.assign(new Error('Email is draft-only for this tenant'), {
            statusCode: 403, code: 'email_draft_only'
        });
    }
}

export async function readEmailPolicy(db, tenantId) {
    emailSendMode(tenantId);
    if (!db) throw Object.assign(new Error('Tenant policy storage is unavailable'), { statusCode: 503 });
    const result = await db.from('tenants').select('metadata,updated_at').eq('tenant_id', tenantId).maybeSingle();
    if (result.error || !result.data) throw Object.assign(new Error('Tenant policy is unavailable'), { statusCode: 503 });
    return { mode: emailSendMode(tenantId, result.data.metadata?.email_send_policy),
        configuredMode: result.data.metadata?.email_send_policy || null, version: result.data.metadata?.email_policy_version || 'unconfigured' };
}

export async function saveEmailPolicy(db, tenantId, input) {
    emailSendMode(tenantId);
    if (!['draft_only', 'allow_send'].includes(input?.mode) || (typeof input?.version !== 'string' || !input.version.trim())) {
        throw Object.assign(new Error('mode and current version are required'), { statusCode: 400 });
    }
    if (!db) throw Object.assign(new Error('Tenant policy storage is unavailable'), { statusCode: 503 });
    const prior = await db.from('tenants').select('metadata,updated_at').eq('tenant_id', tenantId).maybeSingle();
    if (prior.error || !prior.data) throw Object.assign(new Error('Tenant policy is unavailable'), { statusCode: 503 });
    if ((prior.data.metadata?.email_policy_version || 'unconfigured') !== input.version) throw Object.assign(new Error('Policy changed; reload before saving'), { statusCode: 409 });
    const updatedAt = new Date().toISOString();
    const result = await db.from('tenants').update({
        metadata: { ...prior.data.metadata, email_send_policy: input.mode, email_policy_version: randomUUID() }, updated_at: updatedAt
    }).eq('tenant_id', tenantId).eq('metadata', JSON.stringify(prior.data.metadata || {})).select('metadata,updated_at').maybeSingle();
    if (result.error) throw Object.assign(new Error('Policy could not be saved'), { statusCode: 503 });
    if (!result.data) throw Object.assign(new Error('Policy changed; reload before saving'), { statusCode: 409 });
    return { mode: emailSendMode(tenantId, input.mode), configuredMode: input.mode, version: result.data.metadata?.email_policy_version || 'unconfigured' };
}
