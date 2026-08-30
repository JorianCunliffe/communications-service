import { randomUUID } from 'node:crypto';
import { canonicalEmail, normaliseAddresses, safeHtml } from './email.js';
import { refreshGmailToken } from './mailboxOAuth.js';
import { safeFetch } from './safeFetch.js';

const GMAIL_HOST = 'gmail.googleapis.com';

function headerMap(headers = []) {
    return Object.fromEntries(headers.map((item) => [String(item.name || '').toLowerCase(), String(item.value || '')]));
}

function splitAddresses(value) {
    const output = [];
    let current = '';
    let quoted = false;
    let angleDepth = 0;
    for (const character of String(value || '')) {
        if (character === '"') quoted = !quoted;
        if (!quoted && character === '<') angleDepth += 1;
        if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
        if (character === ',' && !quoted && angleDepth === 0) {
            if (current.trim()) output.push(current.trim());
            current = '';
        } else current += character;
    }
    if (current.trim()) output.push(current.trim());
    return output;
}

function decodePart(data) {
    if (!data) return '';
    try { return Buffer.from(String(data), 'base64url').toString('utf8'); } catch { return ''; }
}

function walkParts(part, result) {
    const mime = String(part?.mimeType || '').toLowerCase();
    const body = part?.body || {};
    if (mime === 'text/plain' && body.data) result.text.push(decodePart(body.data));
    if (mime === 'text/html' && body.data) result.html.push(decodePart(body.data));
    if (body.attachmentId || part?.filename) {
        result.attachments.push({
            id: body.attachmentId || null,
            filename: part.filename || null,
            content_type: mime || null,
            size: Number(body.size) || null,
            content_disposition: headerMap(part.headers)['content-disposition'] || null,
            content_id: headerMap(part.headers)['content-id'] || null,
        });
    }
    for (const child of part?.parts || []) walkParts(child, result);
}

export function canonicalGmailMessage(message) {
    const headers = headerMap(message?.payload?.headers);
    const contents = { text: [], html: [], attachments: [] };
    walkParts(message?.payload || {}, contents);
    const internalDate = Number(message?.internalDate);
    const email = canonicalEmail({
        provider_email_id: message?.id,
        provider_conversation_id: message?.threadId,
        message_id: headers['message-id'] || null,
        in_reply_to: headers['in-reply-to'] || null,
        references: headers.references || '',
        from: splitAddresses(headers.from),
        to: splitAddresses(headers.to),
        cc: splitAddresses(headers.cc),
        bcc: splitAddresses(headers.bcc),
        reply_to: splitAddresses(headers['reply-to']),
        subject: headers.subject || null,
        text: contents.text.join('\n\n').trim() || null,
        html: contents.html.join('\n').trim() || null,
        headers,
        occurred_at: Number.isFinite(internalDate) ? new Date(internalDate).toISOString() : undefined,
        attachments: contents.attachments,
    });
    Object.defineProperty(email, 'providerLabels', { value: Array.isArray(message?.labelIds) ? message.labelIds : [], enumerable: false });
    return email;
}

async function gmailRequest(accessToken, path, options = {}) {
    const response = await safeFetch(`https://${GMAIL_HOST}/gmail/v1/users/me${path}`, {
        ...options,
        headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(20000),
    }, { scope: 'GMAIL_API', allowedHosts: [GMAIL_HOST] });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload?.error?.message || `Gmail returned HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
    }
    return payload;
}

export async function usableGmailCredential(credential) {
    const expiresAt = Number(credential?.expires_at || 0);
    if (credential?.access_token && expiresAt > Date.now() + 60_000) return { credential, refreshed: false };
    if (!credential?.refresh_token) throw new Error('Gmail refresh token is unavailable');
    const refreshed = await refreshGmailToken(credential.refresh_token);
    return {
        credential: {
            ...credential,
            ...refreshed,
            refresh_token: credential.refresh_token,
            expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
        },
        refreshed: true,
    };
}

export function gmailProfile(accessToken) {
    return gmailRequest(accessToken, '/profile');
}

export async function gmailMessage(accessToken, messageId) {
    return canonicalGmailMessage(await gmailRequest(accessToken, `/messages/${encodeURIComponent(messageId)}?format=full`));
}

export async function gmailInitialMessageIds(accessToken, { maxMessages = 1000 } = {}) {
    const ids = [];
    let pageToken = null;
    do {
        const query = new URLSearchParams({ maxResults: String(Math.min(500, maxMessages - ids.length)), labelIds: 'INBOX' });
        if (pageToken) query.set('pageToken', pageToken);
        const page = await gmailRequest(accessToken, `/messages?${query}`);
        for (const message of page.messages || []) {
            if (message?.id && !ids.includes(message.id)) ids.push(message.id);
            if (ids.length >= maxMessages) break;
        }
        pageToken = ids.length < maxMessages ? page.nextPageToken || null : null;
    } while (pageToken);
    return ids;
}

export async function gmailHistoryMessageIds(accessToken, startHistoryId) {
    const ids = new Set();
    let pageToken = null;
    let historyId = String(startHistoryId);
    do {
        const query = new URLSearchParams({ startHistoryId: String(startHistoryId), maxResults: '500', historyTypes: 'messageAdded' });
        if (pageToken) query.set('pageToken', pageToken);
        const page = await gmailRequest(accessToken, `/history?${query}`);
        for (const history of page.history || []) {
            for (const added of history.messagesAdded || []) {
                if (added?.message?.id) ids.add(added.message.id);
            }
        }
        historyId = page.historyId || historyId;
        pageToken = page.nextPageToken || null;
    } while (pageToken);
    return { messageIds: [...ids], historyId };
}

export function startGmailWatch(accessToken) {
    const topicName = String(process.env.GMAIL_PUBSUB_TOPIC || '').trim();
    if (!topicName) return Promise.resolve(null);
    return gmailRequest(accessToken, '/watch', {
        method: 'POST',
        body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
    });
}

function cleanHeader(value, name) {
    const output = String(value || '').replace(/[\r\n]+/g, ' ').trim();
    if (!output) throw new Error(`${name} is required`);
    return output;
}

function encodedSubject(value) {
    const subject = cleanHeader(value, 'subject');
    return /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
}

export function gmailDraftMessage(input, mailboxAddress) {
    const from = cleanHeader(mailboxAddress, 'mailbox address');
    const to = normaliseAddresses(input.to, { required: true }).map((item) => item.formatted).join(', ');
    const cc = normaliseAddresses(input.cc).map((item) => item.formatted).join(', ');
    const bcc = normaliseAddresses(input.bcc).map((item) => item.formatted).join(', ');
    const replyTo = normaliseAddresses(input.reply_to).map((item) => item.formatted).join(', ');
    const boundary = `hyperflow-${randomUUID()}`;
    const headers = [
        `From: ${from}`,
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
        `Subject: ${encodedSubject(input.subject)}`,
        'MIME-Version: 1.0',
    ];
    if (input.in_reply_to) headers.push(`In-Reply-To: ${cleanHeader(input.in_reply_to, 'in_reply_to')}`);
    if (input.references) headers.push(`References: ${cleanHeader(input.references, 'references')}`);
    let body;
    if (input.text && input.html) {
        headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        body = [
            `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', String(input.text),
            `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', safeHtml(input.html) || '',
            `--${boundary}--`, '',
        ].join('\r\n');
    } else if (input.text) {
        headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit');
        body = String(input.text);
    } else if (input.html) {
        headers.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit');
        body = safeHtml(input.html) || '';
    } else throw new Error('text or html is required');
    return { raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`).toString('base64url'), threadId: input.provider_thread_id || undefined };
}

export async function createGmailDraft(accessToken, input, mailboxAddress) {
    const message = gmailDraftMessage(input, mailboxAddress);
    return gmailRequest(accessToken, '/drafts', { method: 'POST', body: JSON.stringify({ message }) });
}

export function getGmailDraft(accessToken, draftId) {
    return gmailRequest(accessToken, `/drafts/${encodeURIComponent(draftId)}?format=metadata`);
}
