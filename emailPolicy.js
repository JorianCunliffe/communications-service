/** Transport ceiling, separate from HyperFlow workflow approval and client capabilities. */
export function assertEmailSendAllowed(tenantId) {
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
    // Existing independently authorized Communications tenants keep their behavior.
    // A configured restriction wins even over wildcard/admin clients.
    if (Object.hasOwn(policy, tenantId) && policy[tenantId] === 'draft_only') {
        throw Object.assign(new Error('Email is draft-only for this tenant'), {
            statusCode: 403, code: 'email_draft_only'
        });
    }
}
