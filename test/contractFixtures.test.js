import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const fixtures = JSON.parse(readFileSync(
    new URL('../contracts/communications-events.v2.json', import.meta.url), 'utf8',
));

describe('Communications v2 shared contract fixtures', () => {
    test('defines the canonical inbound and terminal fixture set', () => {
        assert.deepEqual(fixtures.map((fixture) => fixture.name), [
            'inbound_email', 'inbound_sms', 'inbound_voice', 'ask_response', 'call_completed', 'call_failed',
        ]);
    });

    test('keeps every fixture tenant scoped and terminal calls fully correlated', () => {
        for (const { name, event } of fixtures) {
            assert.equal(event.contract_version, '2.0', name);
            assert.equal(event.tenant_id, 'tenant_fixture', name);
            assert.equal(event.correlation.tenant_id, event.tenant_id, name);
            assert.ok(event.event_id, name);
            assert.ok(event.communication_id, name);
            if (event.type === 'call.completed' || event.type === 'call.failed') {
                assert.ok(event.correlation.project_id, name);
                assert.ok(event.correlation.run_id, name);
                assert.ok(event.correlation.task_id, name);
            }
        }
    });

    test('marks voicemail as unsuccessful and memory-ineligible', () => {
        const failed = fixtures.find((fixture) => fixture.name === 'call_failed').event;
        assert.equal(failed.payload.disposition, 'voicemail');
        assert.equal(failed.payload.successful, false);
        assert.equal(failed.payload.memory_eligible, false);
    });
});
