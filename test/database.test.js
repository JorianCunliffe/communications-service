import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createPostgresClient, requestedDatabaseProvider } from '../database.js';

const coreMigration = readFileSync(new URL('../migrations/000_core.sql', import.meta.url), 'utf8');

function capture(responses = []) {
    const calls = [];
    return {
        calls,
        query: async (sql, values = []) => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
            return responses.shift() || { rows: [] };
        },
    };
}

describe('persistence provider selection', () => {
    test('explicit selection wins and Replit aliases select PostgreSQL', () => {
        assert.equal(requestedDatabaseProvider({ PERSISTENCE_PROVIDER: 'supabase', DATABASE_URL: 'postgres://example' }), 'supabase');
        assert.equal(requestedDatabaseProvider({ PERSISTENCE_PROVIDER: 'replit' }), 'postgres');
        assert.equal(requestedDatabaseProvider({ PERSISTENCE_PROVIDER: 'postgres' }), 'postgres');
        assert.equal(requestedDatabaseProvider({ PERSISTENCE_PROVIDER: 'none', DATABASE_URL: 'postgres://example' }), null);
    });

    test('preserves the existing Supabase default before auto-detecting DATABASE_URL', () => {
        assert.equal(requestedDatabaseProvider({ SUPABASE_CONFIG_ENABLED: 'true', DATABASE_URL: 'postgres://example' }), 'supabase');
        assert.equal(requestedDatabaseProvider({ DATABASE_URL: 'postgres://example' }), 'postgres');
        assert.equal(requestedDatabaseProvider({}), null);
    });

    test('rejects an unknown provider instead of silently using the wrong store', () => {
        assert.throws(() => requestedDatabaseProvider({ PERSISTENCE_PROVIDER: 'firebase' }), /Unsupported PERSISTENCE_PROVIDER/);
    });
});

describe('blank PostgreSQL database contract', () => {
    test('defines every provider table required before feature migrations run', () => {
        for (const table of ['contacts', 'contact_config', 'phone_configs', 'calls', 'sms_threads', 'sms_messages', 'tool_calls', 'recordings']) {
            assert.match(coreMigration, new RegExp(`create table if not exists public\\.${table}\\s*\\(`));
        }
    });

    test('supports contact upsert, transcript-only recordings and leased claims', () => {
        assert.match(coreMigration, /unique index if not exists contacts_phone_number_unique\s+on public\.contacts\(phone_number\)/);
        assert.match(coreMigration, /media_url\s+text,/);
        assert.match(coreMigration, /claimed_at\s+timestamptz/);
    });
});

describe('PostgreSQL compatibility adapter', () => {
    test('builds parameterised select, filter, order and pagination queries', async () => {
        const database = capture([{ rows: [{ id: 'contact-1', name: 'Alex' }] }]);
        const client = createPostgresClient(database);
        const result = await client.from('contacts')
            .select('id,name')
            .eq('phone_number', '+61700000000')
            .order('created_at', { ascending: false })
            .range(0, 9);

        assert.equal(result.error, null);
        assert.deepEqual(result.data, [{ id: 'contact-1', name: 'Alex' }]);
        assert.match(database.calls[0].sql, /^select t\."id" as "id", t\."name" as "name" from public\."contacts" t where t\."phone_number" = \$1 order by t\."created_at" desc limit 10 offset 0$/);
        assert.deepEqual(database.calls[0].values, ['+61700000000']);
    });

    test('supports exact counts without returning rows for a head query', async () => {
        const database = capture([{ rows: [{ count: '12' }] }]);
        const result = await createPostgresClient(database).from('communications')
            .select('*', { count: 'exact', head: true })
            .eq('channel', 'sms');

        assert.deepEqual(result, { data: null, error: null, count: 12 });
        assert.equal(database.calls.length, 1);
    });

    test('supports the allow-listed JSON text filter used by Ask lookup', async () => {
        const database = capture([{ rows: [] }]);
        const result = await createPostgresClient(database).from('communications')
            .select('*')
            .eq('purpose->>ask_id', 'ask_1');

        assert.equal(result.error, null);
        assert.match(database.calls[0].sql, /t\."purpose"->>'ask_id' = \$1/);
        assert.deepEqual(database.calls[0].values, ['ask_1']);
    });

    test('maps supported embedded relations to PostgreSQL JSON', async () => {
        const database = capture([{ rows: [{ id: 'contact-1', contact_config: { assistant_name: 'Iris' } }] }]);
        await createPostgresClient(database).from('contacts')
            .select('id,contact_config(assistant_name)')
            .eq('id', 'contact-1')
            .maybeSingle();

        assert.match(database.calls[0].sql, /select row_to_json\(embedded\).*public\.contact_config cc where cc\.contact_id = t\.id/s);
    });

    test('honours ignoreDuplicates with ON CONFLICT DO NOTHING', async () => {
        const database = capture([{ rows: [] }]);
        const result = await createPostgresClient(database).from('recordings')
            .upsert({ source: 'twilio', external_id: 'RE123', media_url: 'https://example.test/audio' }, {
                onConflict: 'source,external_id',
                ignoreDuplicates: true,
            });

        assert.equal(result.error, null);
        assert.match(database.calls[0].sql, /on conflict \("source", "external_id"\) do nothing$/);
    });

    test('serialises JSON arrays without breaking native PostgreSQL arrays', async () => {
        const jsonDatabase = capture([{ rows: [] }]);
        await createPostgresClient(jsonDatabase).from('recordings').insert({
            source: 'plaud',
            participant_identities: [{ identity_type: 'email', identity_value: 'alex@example.test' }],
        });
        assert.equal(jsonDatabase.calls[0].values[1], '[{"identity_type":"email","identity_value":"alex@example.test"}]');

        const arrayDatabase = capture([{ rows: [] }]);
        await createPostgresClient(arrayDatabase).from('contacts').insert({ name: 'Alex', tags: ['customer'] });
        assert.deepEqual(arrayDatabase.calls[0].values[1], ['customer']);
    });

    test('unwraps scalar RPCs and preserves set-returning RPC rows', async () => {
        const scalarDatabase = capture([{ rows: [{ resolve_communication_ask: { ask_id: 'ask_1' } }] }]);
        const scalar = await createPostgresClient(scalarDatabase).rpc('resolve_communication_ask', {
            p_ask_id: 'ask_1',
            p_communication_id: 'comm_1',
        });
        assert.deepEqual(scalar.data, { ask_id: 'ask_1' });
        assert.deepEqual(scalarDatabase.calls[0].values, ['ask_1', 'comm_1']);

        const identitiesDatabase = capture([{ rows: [{ create_communication_contact: { id: 'contact-1' } }] }]);
        await createPostgresClient(identitiesDatabase).rpc('create_communication_contact', {
            p_name: 'Alex',
            p_phone_number: '+61700000000',
            p_identities: [{ type: 'email', value: 'alex@example.test' }],
        });
        assert.equal(identitiesDatabase.calls[0].values[2], '[{"type":"email","value":"alex@example.test"}]');

        const setDatabase = capture([{ rows: [{ communication_id: 'comm_1' }] }]);
        const setResult = await createPostgresClient(setDatabase).rpc('search_communications', { p_query: 'hello' });
        assert.deepEqual(setResult.data, [{ communication_id: 'comm_1' }]);
    });
});
