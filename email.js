import sanitizeHtml from 'sanitize-html';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normaliseAddress(value) {
    if (typeof value !== 'string') throw new Error('Email address must be a string');
    const input = value.trim();
    const match = input.match(/^(?:(.*?)\s*)?<([^<>]+)>$/);
    const address = (match?.[2] || input).trim().toLowerCase();
    if (!EMAIL.test(address)) throw new Error(`Invalid email address: ${value}`);
    const name = match?.[1]?.trim().replace(/^"|"$/g, '') || null;
    return { address, name, formatted: name ? `${name} <${address}>` : address };
}

export function normaliseAddresses(value, { required = false } = {}) {
    const values = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
    const result = values.map(normaliseAddress);
    if (required && result.length === 0) throw new Error('At least one email address is required');
    return result;
}

export function normaliseHeaders(value = {}) {
    const output = {};
    if (Array.isArray(value)) {
        for (const item of value) {
            if (item?.name) output[String(item.name).toLowerCase()] = String(item.value ?? '');
        }
        return output;
    }
    for (const [name, item] of Object.entries(value || {})) output[name.toLowerCase()] = String(item ?? '');
    return output;
}

export function safeHtml(value) {
    if (!value) return null;
    return sanitizeHtml(String(value), {
        allowedTags: sanitizeHtml.defaults.allowedTags.filter((tag) => !['style'].includes(tag)),
        allowedAttributes: { a: ['href', 'name', 'target'], img: ['src', 'alt', 'title', 'width', 'height'] },
        allowedSchemes: ['http', 'https', 'mailto', 'cid'],
        allowProtocolRelative: false,
        disallowedTagsMode: 'discard',
    });
}

export function canonicalEmail(input) {
    const headers = normaliseHeaders(input.headers);
    const occurredAt = new Date(input.occurred_at || input.created_at || Date.now());
    if (Number.isNaN(occurredAt.valueOf())) throw new Error('Email timestamp is invalid');
    return {
        provider_email_id: input.provider_email_id || input.email_id || input.id || null,
        provider_conversation_id: input.provider_conversation_id || input.conversation_id || null,
        message_id: input.message_id || headers['message-id'] || null,
        in_reply_to: input.in_reply_to || headers['in-reply-to'] || null,
        references_header: String(input.references || headers.references || '').split(/\s+/).filter(Boolean),
        from_addresses: normaliseAddresses(input.from, { required: true }),
        to_addresses: normaliseAddresses(input.to, { required: true }),
        cc_addresses: normaliseAddresses(input.cc),
        bcc_addresses: normaliseAddresses(input.bcc),
        reply_to_addresses: normaliseAddresses(input.reply_to),
        subject: input.subject ? String(input.subject) : null,
        text_body: input.text ? String(input.text) : null,
        sanitized_html: safeHtml(input.html),
        headers,
        spam_results: input.spam_results || {},
        authentication_results: input.authentication_results || {},
        occurred_at: occurredAt.toISOString(),
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
    };
}

export function outboundEmailRequest(body = {}) {
    const from = normaliseAddress(body.from);
    const to = normaliseAddresses(body.to, { required: true });
    const cc = normaliseAddresses(body.cc);
    const bcc = normaliseAddresses(body.bcc);
    const replyTo = normaliseAddresses(body.reply_to);
    if (!body.subject || typeof body.subject !== 'string') throw new Error('subject is required');
    if (!body.text && !body.html) throw new Error('text or html is required');
    return {
        from, to, cc, bcc, replyTo,
        subject: body.subject.trim(),
        text: body.text ? String(body.text) : null,
        html: body.html ? safeHtml(body.html) : null,
    };
}
