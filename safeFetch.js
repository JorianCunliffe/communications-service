import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

const SAFE_DISPATCHER = new Agent({
    connect: {
        lookup(hostname, _options, callback) {
            lookup(hostname, { all: true }).then((entries) => {
                if (!entries.length) throw new Error(`Could not resolve ${hostname}`);
                for (const entry of entries) {
                    if (isForbiddenAddress(entry.address)) throw new Error(`${hostname} resolves to ${entry.address}, which is inside a private or reserved range`);
                }
                callback(null, entries[0].address, entries[0].family);
            }).catch((error) => callback(error));
        },
    },
});

export function isForbiddenAddress(address) {
    if (isIP(address) === 6) {
        const value = address.toLowerCase();
        if (value === '::1' || value === '::' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
        const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped ? isForbiddenAddress(mapped[1]) : false;
    }
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function assertSafeHttpsUrl(rawUrl, { scope = 'EXTERNAL_FETCH', allowedHosts = null } = {}) {
    let url;
    try { url = new URL(rawUrl); } catch (_) { throw new Error('Not a valid URL'); }
    if (url.protocol !== 'https:') throw new Error('Only https URLs may be fetched');
    if (url.username || url.password) throw new Error('URL credentials are not allowed');
    const host = url.hostname.toLowerCase();
    if (allowedHosts && !allowedHosts.includes(host)) throw new Error(`Host ${host} is not in ${scope}_HOSTS`);
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((item) => item.address);
    if (!addresses.length) throw new Error(`Could not resolve ${host}`);
    for (const address of addresses) {
        if (isForbiddenAddress(address)) throw new Error(`${host} resolves to ${address}, which is inside a private or reserved range`);
    }
    return url;
}

export async function safeFetch(rawUrl, options = {}, { scope = 'EXTERNAL_FETCH', allowedHosts = null, maxRedirects = 3 } = {}) {
    let current = rawUrl;
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        const url = await assertSafeHttpsUrl(current, { scope, allowedHosts });
        const response = await fetch(url, { ...options, redirect: 'manual', dispatcher: SAFE_DISPATCHER });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${rawUrl}`);
        const location = response.headers.get('location');
        if (!location) throw new Error(`HTTP ${response.status} redirect had no Location header`);
        current = new URL(location, url).toString();
    }
    throw new Error(`Too many redirects fetching ${rawUrl}`);
}
