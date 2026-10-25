import { randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID = /^CA[0-9a-f]{32}$/i;

/** Save the exact approved prompt/tool/identity snapshot before contacting the provider. */
export async function freezeOutboundCallConfig(db, operation, config) {
    if (operation.audit_context?.callConfig) return operation.audit_context.callConfig;
    const snapshot = JSON.parse(JSON.stringify({ ...config,
        outboundOperationId: operation.id, mediaCapability: randomBytes(32).toString('hex'),
    }));
    const audit = { ...operation.audit_context, callConfig: snapshot };
    const result = await db.from('outbound_operations').update({ audit_context: audit })
        .eq('tenant_id', config.tenantId).eq('id', operation.id)
        .eq('audit_context', JSON.stringify(operation.audit_context || {}))
        .select('audit_context').maybeSingle();
    if (result.error || !result.data?.audit_context?.callConfig) throw new Error('Approved call configuration could not be saved');
    return result.data.audit_context.callConfig;
}

/** Caller data cannot choose a prompt. Signed webhooks restore a frozen server snapshot. */
export async function restoreOutboundCallConfig(db, {tenantId, operationId, callSid, from, to, mediaCapability, claimMedia = false}) {
    if (!db || !tenantId || !UUID.test(operationId || '') || !SID.test(callSid || '')) throw new Error('Approved call identity is required');
    const result = await db.from('outbound_operations').select('*')
        .eq('tenant_id', tenantId).eq('id', operationId).maybeSingle();
    const op = result.data, audit = op?.audit_context, config = audit?.callConfig;
    const age = Date.now() - Date.parse(op?.created_at || '');
    if (result.error || !config || op.operation_type !== 'voice' || op.status === 'failed'
        || !Number.isFinite(age) || age < -30000 || age > 3600000
        || config.tenantId !== tenantId || config.communicationId !== op.communication_id
        || config.outboundOperationId !== operationId || (op.provider_id && op.provider_id !== callSid)
        || (audit.answerCallSid && audit.answerCallSid !== callSid)) throw new Error('Approved call configuration is unavailable');
    if (claimMedia) {
        const expected = String(config.mediaCapability || ''), supplied = String(mediaCapability || '');
        if (!/^[a-f0-9]{64}$/.test(supplied) || expected.length !== supplied.length
            || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
            || audit.answerCallSid !== callSid || audit.mediaClaimedAt) throw new Error('Media authorization is invalid or already consumed');
    } else if (from !== config.serviceIdentity || to !== config.outboundTo) throw new Error('Call participants do not match the approved request');
    if (!claimMedia && audit.answerCallSid === callSid) return config;
    const next = {...audit, answerCallSid:callSid, ...(claimMedia ? {mediaClaimedAt:Date.now()} : {})};
    const saved = await db.from('outbound_operations').update({audit_context:next})
        .eq('tenant_id',tenantId).eq('id',operationId).eq('audit_context',JSON.stringify(audit))
        .select('id').maybeSingle();
    if (saved.error || !saved.data) throw new Error('Call authorization changed; do not reuse this stream');
    return config;
}
