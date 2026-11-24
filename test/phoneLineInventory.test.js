import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import twilio from 'twilio';
import { createPhase02Database } from './fixtures/phase02Database.js';

test('activation checks effective Messaging Service routing and restores the existing role', async (t) => {
    const tenant = 'inventory_fixture';
    const number = '+15550000003';
    const fixture = await createPhase02Database(tenant, 'inventory-key');
    t.after(() => fixture.close());
    const base = 'https://fixture.invalid';
    Object.assign(process.env, {
        DATABASE_URL: 'postgres://fixture.invalid/local',
        TWILIO_ACCOUNT_SID: 'AC' + '3'.repeat(32),
        TWILIO_AUTH_TOKEN: 'test',
        PUBLIC_URL: base,
    });
    t.mock.method(pg.Client.prototype, 'connect', async () => {});
    t.mock.method(pg.Client.prototype, 'end', async () => {});
    t.mock.method(pg.Client.prototype, 'query', async (...args) => {
        const result = await fixture.sql.query(...args);
        return { ...result, rowCount: result.affectedRows };
    });
    const phoneSid = 'PN' + '4'.repeat(32),
        serviceSid = 'MG' + '3'.repeat(32);
    let serviceUrl = base + '/wrong';
    t.mock.method(twilio.Twilio.prototype, 'request', async ({ method, uri }) => {
        assert.equal(method, 'get');
        let body;
        if (uri.endsWith('/Services'))
            body = {
                meta: { key: 'services' },
                services: [
                    { sid: serviceSid, use_inbound_webhook_on_number: false, inbound_request_url: serviceUrl },
                ],
            };
        else if (uri.endsWith('/PhoneNumbers'))
            body = { meta: { key: 'phone_numbers' }, phone_numbers: [{ sid: phoneSid }] };
        else if (uri.endsWith('/IncomingPhoneNumbers.json'))
            body = {
                incoming_phone_numbers: [
                    {
                        phone_number: number,
                        sid: phoneSid,
                        capabilities: { voice: true, SMS: true },
                        voice_url: base + '/incoming-call',
                        sms_url: base + '/incoming-sms',
                        status_callback: base + '/call-status',
                    },
                ],
            };
        else throw Error('Unexpected Twilio endpoint');
        return { statusCode: 200, body: JSON.stringify(body) };
    });
    await fixture.sql.query('insert into phone_configs(tenant_id,twilio_number) values($1,$2)', [tenant, number]);
    const originalArgv = process.argv;
    t.after(() => {
        process.argv = originalArgv;
    });
    const invoke = async (mode, run) => {
        process.argv = [...originalArgv.slice(0, 2), mode, tenant, number];
        return import('../scripts/phone-lines.js?test=' + run);
    };
    const role = async () =>
        (await fixture.sql.query('select line_role from phone_configs where twilio_number=$1', [number])).rows[0]
            .line_role;
    await assert.rejects(invoke('--enable-client', 1), /Line failed inventory checks/);
    assert.equal(await role(), 'existing');
    serviceUrl = base + '/incoming-sms';
    await invoke('--enable-client', 2);
    assert.equal(await role(), 'client');
    await invoke('--restore-existing', 3);
    assert.equal(await role(), 'existing');
});
