import { canonicalEmail, normaliseAddresses, safeHtml } from './email.js';
import { refreshOutlookToken } from './mailboxOAuth.js';
import { safeFetch } from './safeFetch.js';

const GRAPH_HOST = 'graph.microsoft.com';

export class OutlookMessageNormalizationError extends Error {
    constructor(messageId, cause) {
        super(`Outlook message could not be normalized: ${cause?.message || cause || 'invalid message'}`, { cause });
        this.name = 'OutlookMessageNormalizationError';
        this.code = 'OUTLOOK_MESSAGE_INVALID';
        this.providerMessageId = messageId || null;
    }
}

function address(recipient) {
    const item = recipient?.emailAddress || recipient;
    if (!item?.address) return null;
    return item.name ? `${item.name} <${item.address}>` : item.address;
}

function addresses(values) {
    return (Array.isArray(values) ? values : [values]).map(address).filter(Boolean);
}

export function canonicalOutlookMessage(message, { mailboxAddress = null } = {}) {
    const body = message?.body || {};
    const contentType = String(body.contentType || '').toLowerCase();
    return canonicalEmail({
        provider_email_id: message?.id,
        provider_conversation_id: message?.conversationId,
        message_id: message?.internetMessageId || null,
        in_reply_to: null,
        references: '',
        from: addresses(message?.from || message?.sender),
        to: addresses(message?.toRecipients).length ? addresses(message.toRecipients) : [mailboxAddress].filter(Boolean),
        cc: addresses(message?.ccRecipients),
        bcc: addresses(message?.bccRecipients),
        reply_to: addresses(message?.replyTo),
        subject: message?.subject || null,
        text: contentType === 'text' ? body.content : message?.bodyPreview || null,
        html: contentType === 'html' ? body.content : null,
        headers: {},
        occurred_at: message?.receivedDateTime || message?.sentDateTime || undefined,
        attachments: (message?.attachments || []).map((item) => ({
            id: item.id || null,
            filename: item.name || null,
            content_type: item.contentType || null,
            size: Number(item.size) || null,
            content_disposition: item.isInline ? 'inline' : 'attachment',
            content_id: item.contentId || null,
        })),
    });
}

async function graphRequest(accessToken, pathOrUrl, options = {}) {
    const url = new URL(pathOrUrl, `https://${GRAPH_HOST}/v1.0/`);
    if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST) throw new Error('Invalid Microsoft Graph continuation URL');
    const response = await safeFetch(url.toString(), {
        ...options,
        headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(20000),
    }, { scope: 'MICROSOFT_GRAPH', allowedHosts: [GRAPH_HOST] });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload?.error?.message || `Microsoft Graph returned HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
    }
    return payload;
}

export async function usableOutlookCredential(credential) {
    const expiresAt = Number(credential?.expires_at || 0);
    if (credential?.access_token && expiresAt > Date.now() + 60_000) return { credential, refreshed: false };
    if (!credential?.refresh_token) throw new Error('Outlook refresh token is unavailable');
    const refreshed = await refreshOutlookToken(credential.refresh_token);
    return {
        credential: {
            ...credential,
            ...refreshed,
            refresh_token: refreshed.refresh_token || credential.refresh_token,
            expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
        },
        refreshed: true,
    };
}

export function outlookProfile(accessToken, { request = graphRequest } = {}) {
    return request(accessToken, 'me?$select=displayName,mail,userPrincipalName');
}

export async function outlookDeltaMessages(accessToken, cursor = null, { maxMessages = 1000, request = graphRequest } = {}) {
    const select = 'id,conversationId,internetMessageId,receivedDateTime,sentDateTime,subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,bodyPreview,hasAttachments';
    let next = cursor || `me/mailFolders/inbox/messages/delta?$select=${encodeURIComponent(select)}&$top=100`;
    const ids = [];
    let deltaLink = null;
    while (next) {
        const page = await request(accessToken, next, { headers: { Prefer: 'odata.maxpagesize=100' } });
        for (const message of page.value || []) {
            if (message?.id && !message['@removed'] && !ids.includes(message.id)) ids.push(message.id);
            if (ids.length >= maxMessages) break;
        }
        if (ids.length >= maxMessages && page['@odata.nextLink']) {
            const error = new Error(`Outlook inbox exceeds the ${maxMessages}-message reconciliation limit`);
            error.status = 409;
            throw error;
        }
        next = page['@odata.nextLink'] || null;
        deltaLink = page['@odata.deltaLink'] || deltaLink;
    }
    if (!deltaLink) throw new Error('Microsoft Graph did not return an Outlook delta cursor');
    return { messageIds: ids, cursor: deltaLink };
}

export async function outlookMessage(accessToken, messageId, mailboxAddress = null, { request = graphRequest } = {}) {
    const select = 'id,conversationId,internetMessageId,receivedDateTime,sentDateTime,subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,body,bodyPreview,hasAttachments';
    const expand = 'attachments($select=id,name,contentType,size,isInline,contentId)';
    try {
        const message = await request(accessToken, `me/messages/${encodeURIComponent(messageId)}?$select=${encodeURIComponent(select)}&$expand=${encodeURIComponent(expand)}`, {
            headers: { Prefer: 'outlook.body-content-type="html"' },
        });
        return canonicalOutlookMessage(message, { mailboxAddress });
    } catch (error) {
        if (error.status) throw error;
        throw new OutlookMessageNormalizationError(messageId, error);
    }
}

function recipients(values) {
    return normaliseAddresses(values).map((item) => ({ emailAddress: { address: item.address, ...(item.name ? { name: item.name } : {}) } }));
}

function draftBody(input) {
    if (input.html) return { contentType: 'HTML', content: safeHtml(input.html) || '' };
    if (input.text) return { contentType: 'Text', content: String(input.text) };
    throw new Error('text or html is required');
}

export async function createOutlookDraft(accessToken, input, { request = graphRequest } = {}) {
    if (input.provider_message_id) {
        const draft = await request(accessToken, `me/messages/${encodeURIComponent(input.provider_message_id)}/createReply`, {
            method: 'POST', body: JSON.stringify({}),
        });
        const updated = await request(accessToken, `me/messages/${encodeURIComponent(draft.id)}`, {
            method: 'PATCH', body: JSON.stringify({ body: draftBody(input) }),
        });
        return { id: updated.id || draft.id, message: updated };
    }
    const toRecipients = recipients(input.to);
    if (!toRecipients.length) throw new Error('to is required');
    const message = await request(accessToken, 'me/messages', {
        method: 'POST',
        body: JSON.stringify({
            subject: String(input.subject || '').trim(),
            body: draftBody(input),
            toRecipients,
            ccRecipients: recipients(input.cc),
            bccRecipients: recipients(input.bcc),
            replyTo: recipients(input.reply_to),
        }),
    });
    return { id: message.id, message };
}

export function getOutlookDraft(accessToken, draftId, { request = graphRequest } = {}) {
    return request(accessToken, `me/messages/${encodeURIComponent(draftId)}?$select=id,conversationId,internetMessageId,isDraft,subject`);
}
