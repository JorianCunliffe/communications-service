function header(headers, name) {
    return String(headers?.[name] || '').trim().toLowerCase();
}

export function triageEmail(email, eventType = 'email.received') {
    const autoSubmitted = header(email.headers, 'auto-submitted');
    const precedence = header(email.headers, 'precedence');
    const spam = header(email.headers, 'x-spam-status');
    const content = `${email.subject || ''}\n${email.text_body || ''}`.toLowerCase();
    const bounce = eventType === 'email.bounced'
        || /mailer-daemon|postmaster/.test(email.from_addresses?.[0]?.address || '')
        || /delivery status notification|undeliverable|mail delivery failed/.test(content);
    const automated = bounce
        || (autoSubmitted && autoSubmitted !== 'no')
        || ['bulk', 'junk', 'list'].includes(precedence)
        || Boolean(header(email.headers, 'x-autoreply'))
        || Boolean(header(email.headers, 'x-autorespond'));
    const spamDetected = /(^|\s)yes\b|score=[6-9]|score=\d{2,}/.test(spam)
        || eventType === 'email.complained';
    const mailingList = Boolean(header(email.headers, 'list-id')) || Boolean(header(email.headers, 'list-unsubscribe'));
    const unsubscribeIntent = /\b(?:unsubscribe|remove me|stop (?:emailing|sending)|opt out)\b/.test(content);
    const systemGenerated = /^(?:no-?reply|notifications?|alerts?)@/i.test(email.from_addresses?.[0]?.address || '');

    let classification = 'candidate_human_response';
    if (bounce) classification = 'bounce';
    else if (spamDetected) classification = 'spam';
    else if (automated) classification = 'automatic_reply';
    else if (unsubscribeIntent) classification = 'unsubscribe_intent';
    else if (mailingList) classification = 'mailing_list';
    else if (systemGenerated) classification = 'system_generated';

    return {
        classification,
        bounce,
        automated,
        memoryEligible: classification === 'candidate_human_response',
        askResponseEligible: classification === 'candidate_human_response',
    };
}
