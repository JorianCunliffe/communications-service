import { createHash } from 'node:crypto';

export function requestFingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function idempotencyKey(request) {
    const value = request.headers['idempotency-key'];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function reserveOutbound(db, { tenantId, key, type, request, communicationId }) {
    if (!key) {
        const error = new Error('Idempotency-Key header is required for outbound operations');
        error.code = 'IDEMPOTENCY_REQUIRED';
        throw error;
    }
    const scopedTenant = tenantId || db?.tenantId || process.env.LEGACY_TENANT_ID;
    if (!scopedTenant) throw new Error('tenant_id is required for outbound operations');
    const result = await db.rpc('reserve_outbound_operation', {
        p_tenant_id: scopedTenant,
        p_idempotency_key: key,
        p_operation_type: type,
        p_request_hash: requestFingerprint(request),
        p_communication_id: communicationId,
        p_audit_context: {
            to: request.to || null,
            from: request.from || null,
            override_do_not_contact: request.override_do_not_contact === true,
            override_reason: request.override_reason || null,
        },
    });
    if (result.error) throw new Error(`Could not reserve outbound operation: ${result.error.message}`);
    const operation = result.data;
    if (operation?.conflict) {
        const error = new Error('Idempotency-Key was already used for a different request');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
    }
    if (operation?.claimed === false && operation.status === 'reserved') {
        const error = new Error('An outbound operation with this Idempotency-Key is already in progress; reconcile it before retrying');
        error.code = 'IDEMPOTENCY_IN_PROGRESS';
        throw error;
    }
    return operation;
}

export async function markOutbound(db, id, values) {
    const result = await db.from('outbound_operations').update({ ...values, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single();
    if (result.error) throw new Error(`Could not update outbound operation: ${result.error.message}`);
    return result.data;
}
