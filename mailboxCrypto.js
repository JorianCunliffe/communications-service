import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function encryptionKey() {
    const value = String(process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY || '').trim();
    if (!value) throw new Error('MAILBOX_CREDENTIAL_ENCRYPTION_KEY is not configured');
    let decoded;
    try { decoded = Buffer.from(value, 'base64'); } catch { decoded = Buffer.alloc(0); }
    if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        throw new Error('MAILBOX_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return decoded;
}

export function mailboxKeyFingerprint() {
    return createHash('sha256').update(encryptionKey()).digest('hex').slice(0, 16);
}

export function sealMailboxCredential(value, associatedData) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(String(associatedData)));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function openMailboxCredential(value, associatedData) {
    const [version, iv, tag, ciphertext] = String(value || '').split('.');
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('Mailbox credential has an unsupported encrypted format');
    try {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(String(associatedData)));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8'));
    } catch {
        throw new Error('Mailbox credential could not be decrypted or authenticated');
    }
}
