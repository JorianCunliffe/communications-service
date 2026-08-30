import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { safeFetch } from './safeFetch.js';

export const GMAIL_SCOPES = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
];

function required(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`${name} is not configured`);
    return value;
}

function stateSecret() {
    const secret = required('MAILBOX_OAUTH_STATE_SECRET');
    if (Buffer.byteLength(secret, 'utf8') < 32) {
        throw new Error('MAILBOX_OAUTH_STATE_SECRET must contain at least 32 bytes');
    }
    return secret;
}

function encode(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signature(payload) {
    return createHmac('sha256', stateSecret()).update(payload).digest('base64url');
}

function safeReturnUrl(raw) {
    const url = new URL(String(raw || required('HYPERFLOW_URL')));
    const allowed = String(process.env.MAILBOX_OAUTH_RETURN_ORIGINS || process.env.HYPERFLOW_URL || '')
        .split(',').map((item) => item.trim()).filter(Boolean).map((item) => new URL(item).origin);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('Mailbox OAuth return URL must use https');
    if (!allowed.includes(url.origin)) throw new Error('Mailbox OAuth return URL is not allowlisted');
    return url.toString();
}

export function mailboxOAuthRedirectUri() {
    return new URL('/oauth/mailboxes/google/callback', `${required('PUBLIC_URL').replace(/\/$/, '')}/`).toString();
}

export function createMailboxOAuthState({ tenantId, initiatorId, returnUrl }) {
    const now = Math.floor(Date.now() / 1000);
    const state = {
        tenantId: String(tenantId),
        initiatorId: String(initiatorId),
        returnUrl: safeReturnUrl(returnUrl),
        nonce: randomBytes(24).toString('base64url'),
        iat: now,
        exp: now + 10 * 60,
    };
    const payload = encode(state);
    return { token: `${payload}.${signature(payload)}`, state };
}

export function verifyMailboxOAuthState(token) {
    const [payload, provided] = String(token || '').split('.');
    if (!payload || !provided) throw new Error('Mailbox OAuth state is invalid');
    const expected = signature(payload);
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Mailbox OAuth state signature is invalid');
    let state;
    try { state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('Mailbox OAuth state payload is invalid'); }
    if (!state.tenantId || !state.initiatorId || !state.nonce || !state.returnUrl) throw new Error('Mailbox OAuth state is incomplete');
    if (!Number.isFinite(state.exp) || state.exp <= Math.floor(Date.now() / 1000)) throw new Error('Mailbox OAuth state has expired');
    state.returnUrl = safeReturnUrl(state.returnUrl);
    return state;
}

export function mailboxOAuthNonceHash(nonce) {
    return createHash('sha256').update(String(nonce)).digest('hex');
}

export function gmailAuthorizationUrl(state) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', required('GMAIL_OAUTH_CLIENT_ID'));
    url.searchParams.set('redirect_uri', mailboxOAuthRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
}

async function tokenRequest(parameters) {
    const response = await safeFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(parameters),
        signal: AbortSignal.timeout(15000),
    }, { scope: 'GMAIL_OAUTH', allowedHosts: ['oauth2.googleapis.com'] });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error_description || payload.error || `Google OAuth returned HTTP ${response.status}`);
    return payload;
}

export function exchangeGmailCode(code) {
    return tokenRequest({
        code: String(code),
        client_id: required('GMAIL_OAUTH_CLIENT_ID'),
        client_secret: required('GMAIL_OAUTH_CLIENT_SECRET'),
        redirect_uri: mailboxOAuthRedirectUri(),
        grant_type: 'authorization_code',
    });
}

export function refreshGmailToken(refreshToken) {
    return tokenRequest({
        refresh_token: String(refreshToken),
        client_id: required('GMAIL_OAUTH_CLIENT_ID'),
        client_secret: required('GMAIL_OAUTH_CLIENT_SECRET'),
        grant_type: 'refresh_token',
    });
}
