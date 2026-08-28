import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventDedupeOptions } from '../eventOutbox.js';

describe('tenant-safe terminal event delivery', () => {
    test('deduplicates outbound events with the tenant-scoped unique key', () => {
        assert.deepEqual(eventDedupeOptions('call-terminal:comm_1'), {
            onConflict: 'tenant_id,dedupe_key',
            ignoreDuplicates: true,
        });
        assert.equal(eventDedupeOptions(null), null);
    });

    test('requeues terminal outcomes stranded by the obsolete conflict target', () => {
        const migration = readFileSync(new URL('../migrations/011_terminal_event_recovery.sql', import.meta.url), 'utf8');
        assert.match(migration, /business_status in \('success','failed'\)/);
        assert.match(migration, /terminal_event_emitted_at is null/);
        assert.match(migration, /on conflict\(call_id\) do update/);
        assert.match(migration, /status='pending',attempts=0/);
    });

    test('uses a non-partial composite index PostgreSQL can infer for ON CONFLICT', () => {
        const migration = readFileSync(new URL('../migrations/012_outbound_event_conflict_target.sql', import.meta.url), 'utf8');
        assert.match(migration, /on public\.outbound_events\(tenant_id,dedupe_key\)/);
        assert.doesNotMatch(migration, /dedupe_key is not null/);
        assert.match(migration, /terminal_event_emitted_at is null/);
        assert.match(migration, /status='pending',attempts=0/);
    });
});
