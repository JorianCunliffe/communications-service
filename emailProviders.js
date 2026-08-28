import { Webhook } from 'svix';
import { safeFetch } from './safeFetch.js';

function secret(reference) {
    const name = String(reference || '').replace(/^env:/, '');
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Provider credential reference must name an environment secret');
    const value = process.env[name];
    if (!value) throw new Error(`Provider credential ${name} is not configured`);
    return value;
}

async function resendRequest(connection, path, options = {}) {
    const response = await safeFetch(`https://api.resend.com${path}`, {
        ...options,
        headers: {
            authorization: `Bearer ${secret(connection.credential_reference)}`,
            'user-agent': 'communications-service/2.2',
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
    }, { scope: 'EMAIL_PROVIDER', allowedHosts: ['api.resend.com'] });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.message || `Resend returned HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
    }
    return payload;
}

const resend = {
    verifyWebhook({ connection, rawBody, headers }) {
        const signingSecret = secret(connection.webhook_secret_reference);
        return new Webhook(signingSecret).verify(rawBody, {
            'svix-id': headers['svix-id'],
            'svix-timestamp': headers['svix-timestamp'],
            'svix-signature': headers['svix-signature'],
        });
    },
    providerEventId(headers) { return headers['svix-id']; },
    async retrieveReceived(connection, emailId) {
        return resendRequest(connection, `/emails/receiving/${encodeURIComponent(emailId)}`);
    },
    async send(connection, email, idempotencyKey) {
        return resendRequest(connection, '/emails', {
            method: 'POST',
            headers: { 'idempotency-key': idempotencyKey },
            body: JSON.stringify({
                from: email.from.formatted,
                to: email.to.map((item) => item.formatted),
                cc: email.cc.map((item) => item.formatted),
                bcc: email.bcc.map((item) => item.formatted),
                reply_to: email.replyTo.map((item) => item.formatted),
                subject: email.subject,
                text: email.text || undefined,
                html: email.html || undefined,
            }),
        });
    },
};

const PROVIDERS = { resend };

export function emailProvider(connection) {
    const provider = PROVIDERS[String(connection?.provider || '').toLowerCase()];
    if (!provider) throw new Error(`Unsupported email provider: ${connection?.provider || 'missing'}`);
    return provider;
}

export const emailProviderAdapters = PROVIDERS;
