import { normaliseAddresses } from './email.js';

const HEADER_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DOT_ATOM_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isSupportedMailbox(address) {
    if (typeof address !== 'string' || address.length > 254) return false;
    const at = address.lastIndexOf('@');
    if (at <= 0 || at !== address.indexOf('@')) return false;

    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    if (local.length > 64 || domain.length > 253) return false;

    const localParts = local.split('.');
    if (localParts.some((part) => !DOT_ATOM_PART.test(part))) return false;

    const labels = domain.split('.');
    return labels.length >= 2 && labels.every((label) => label.length <= 63 && DNS_LABEL.test(label));
}

function isSingleRecipient(value) {
    if (typeof value !== 'string' || HEADER_CONTROL.test(value)) return false;

    const input = value.trim();
    const beginsWithQuotedName = /^"[^"<>]*"\s*</.test(input);
    if (!input || (input.includes(',') && !beginsWithQuotedName) || (input.includes(';') && !beginsWithQuotedName)) {
        return false;
    }

    if (!input.includes('<') && !input.includes('>')) return !input.includes('"');

    // Accept only one complete display-name/address form. Anchoring the parse
    // prevents accidentally extracting the first address from arbitrary text.
    const match = input.match(/^(?:(?:"([^"<>]*)"|([^"<>@,;]+?))\s*)?<([^<>]+)>$/);
    if (!match) return false;

    const displayName = match[1] ?? match[2];
    return displayName === undefined || !displayName.includes('@') && displayName.trim().length > 0;
}

function canonicalRecipientList(value) {
    if (!Array.isArray(value)) return null;
    for (const recipient of value) {
        if (!isSingleRecipient(recipient)) return null;
    }

    try {
        const addresses = normaliseAddresses(value).map(({ address }) => address);
        if (!addresses.every(isSupportedMailbox)) return null;
        return addresses.sort();
    } catch {
        return null;
    }
}

/**
 * Compares draft recipient lists by normalized address, ignoring order and
 * display names while retaining duplicate recipients. Invalid input never
 * matches.
 */
export function draftRecipientListsMatch(left, right) {
    const leftAddresses = canonicalRecipientList(left);
    const rightAddresses = canonicalRecipientList(right);
    if (!leftAddresses || !rightAddresses || leftAddresses.length !== rightAddresses.length) return false;
    return leftAddresses.every((address, index) => address === rightAddresses[index]);
}