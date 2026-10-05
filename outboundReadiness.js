import { probeTwilio } from './twilioHealth.js';
import { createModelHealth, probeModel } from './modelHealth.js';
import { DEFAULT_CONFIG } from './config.js';

export const outboundModelHealth = createModelHealth();
export async function assertOutboundReady({ type, request }, dependencies = {}) {
    const twilio = await (dependencies.probeTwilio || probeTwilio)();
    if (twilio.accountStatus !== 'active' || !['ok', 'low'].includes(twilio.balanceState)) {
        throw Object.assign(new Error(`Outbound ${type} deferred: Twilio ${twilio.status}`), {
            code: 'OUTBOUND_NOT_READY', statusCode: 503, dispatched: false,
        });
    }
    if (type !== 'voice') return;
    const health = dependencies.modelHealth || outboundModelHealth;
    if (health.read().stale || !health.read().checkedAt) await health.refresh();
    const models = health.read();
    const required = models.models.filter(check => check.roles.some(role => ['voice', 'live_transcription'].includes(role)));
    if (models.stale || required.length < 2 || required.some(check => !check.usable)) {
        throw Object.assign(new Error('Outbound call deferred: voice model readiness unavailable'), {
            code: 'OUTBOUND_NOT_READY', statusCode: 503, dispatched: false,
        });
    }
    const model = request.overrides?.model;
    if (model && model !== DEFAULT_CONFIG.model) {
        const custom = await (dependencies.probeModel || probeModel)({ model, transport: 'realtime' });
        if (!custom.usable) throw Object.assign(new Error('Outbound call deferred: selected voice model unavailable'), {
            code: 'OUTBOUND_NOT_READY', statusCode: 503, dispatched: false,
        });
    }
}

// A positive preflight is not proof of dispatch. Only a structured Twilio 4xx
// rejection establishes no accepted create; network/5xx outcomes stay uncertain.
export async function dispatchTwilio(db, operation, create, mark) {
    try { return await create(); }
    catch (error) {
        const rejected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
            && error.status !== 408 && Number.isInteger(error?.code);
        if (rejected) {
            const response = { error: 'Twilio rejected the outbound operation', code: 'OUTBOUND_PROVIDER_REJECTED',
                dispatched: false, provider_code: error.code, provider_status: error.status, operation_id: operation.id };
            try { await mark(db, operation.id, { status: 'failed', response, completed_at: new Date().toISOString() }); }
            catch { throw Object.assign(new Error('Provider rejection receipt could not be saved; reconciliation required'), {
                code: 'IDEMPOTENCY_RECONCILIATION_REQUIRED', statusCode: 409, operation_id: operation.id,
            }); }
            throw Object.assign(new Error(response.error), { ...response, statusCode: 422 });
        }
        throw Object.assign(new Error('Outbound outcome uncertain; reconcile the original operation before retrying'), {
            code: 'IDEMPOTENCY_RECONCILIATION_REQUIRED', statusCode: 409, operation_id: operation.id,
        });
    }
}
