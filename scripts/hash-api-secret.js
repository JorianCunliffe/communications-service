import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashApiSecret } from '../auth.js';

const secret = process.env.API_CLIENT_SECRET;
if (!secret) {
    console.error('API_CLIENT_SECRET is required; provide it as a temporary environment variable.');
    process.exitCode = 1;
} else {
    const keyId = process.env.API_CLIENT_KEY_ID || `client_${randomBytes(8).toString('hex')}`;
    const secretHash = await hashApiSecret(secret);
    console.log(JSON.stringify({ key_id: keyId, secret_hash: secretHash }, null, 2));
}
