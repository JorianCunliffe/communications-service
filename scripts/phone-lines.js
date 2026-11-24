import 'dotenv/config';
import pg from 'pg';
import twilio from 'twilio';
import { E164 } from '../auth.js';

const [mode = '--inventory', tenant, number] = process.argv.slice(2);
if (
    !['--inventory', '--enable-client', '--restore-existing', '--caller-override'].includes(mode) ||
    (mode !== '--inventory' && (!tenant || !E164.test(number)))
) {
    throw Error(
        'Use --inventory, --enable-client TENANT +NUMBER or --restore-existing/--caller-override TENANT +NUMBER',
    );
}
const { DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_URL } = process.env;
if (!DATABASE_URL) throw Error('DATABASE_URL is required');
const db = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
await db.connect();
try {
    if (mode === '--restore-existing') {
        const result = await db.query(
            "update phone_configs set line_role='existing' where tenant_id=$1 and twilio_number=$2 and line_role in ('client','existing')",
            [tenant, number],
        );
        if (result.rowCount !== 1) throw Error('Configured line missing');
        console.log('Restored existing call routing for the selected line.');
    } else {
        if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_URL)
            throw Error('Twilio credentials and PUBLIC_URL are required');
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const configured = (
            await db.query(
                "select tenant_id,twilio_number,call_enabled,coalesce((to_jsonb(p)->>'sms_enabled')::boolean,true) sms_enabled from phone_configs p where coalesce(to_jsonb(p)->>'line_role','existing') <> 'caller_override'",
            )
        ).rows;
        const senders = (
            await db.query(`select distinct tenant_id, operation_type, audit_context->>'from' as sender from outbound_operations
            where operation_type in ('voice','sms') and audit_context->>'from' is not null`)
        ).rows;
        const services = new Map();
        for (const service of await client.messaging.v1.services.list()) {
            for (const phone of await client.messaging.v1.services(service.sid).phoneNumbers.list())
                services.set(phone.sid, service);
        }
        const reports = [];
        for (const phone of await client.incomingPhoneNumbers.list()) {
            const owners = configured.filter((row) => row.twilio_number === phone.phoneNumber);
            const service = services.get(phone.sid);
            const voiceApp = phone.voiceApplicationSid
                ? await client.applications(phone.voiceApplicationSid).fetch()
                : phone;
            const smsApp = phone.smsApplicationSid
                ? await client.applications(phone.smsApplicationSid).fetch()
                : phone;
            const smsUrl =
                service && !service.useInboundWebhookOnNumber ? service.inboundRequestUrl : smsApp.smsUrl;
            const expected = (path) => new URL(path, PUBLIC_URL).href;
            const checks = {
                uniqueOwner: owners.length === 1,
                voice: phone.capabilities.voice === true && owners[0]?.call_enabled === true,
                sms:
                    (phone.capabilities.sms ?? phone.capabilities.SMS) === true && owners[0]?.sms_enabled === true,
                voiceRoute: !phone.trunkSid && voiceApp.voiceUrl === expected('/incoming-call'),
                smsRoute: smsUrl === expected('/incoming-sms'),
                callStatus: voiceApp.statusCallback === expected('/call-status'),
            };
            reports.push({
                number: phone.phoneNumber,
                tenant: owners.length === 1 ? owners[0].tenant_id : null,
                checks,
            });
        }
        if (mode === '--inventory') {
            const unmappedSenders = senders.filter(
                (row) =>
                    !reports.some(
                        (r) =>
                            r.number === row.sender && r.tenant === row.tenant_id && r.checks[row.operation_type],
                    ),
            );
            const missingAtTwilio = configured.filter(
                (row) => !reports.some((r) => r.number === row.twilio_number),
            );
            console.log(JSON.stringify({ lines: reports, unmappedSenders, missingAtTwilio }, null, 2));
            if (unmappedSenders.length) process.exitCode = 2;
        } else if (mode === '--caller-override') {
            if (reports.some((row) => row.number === number) || senders.some((row) => row.sender === number))
                throw Error('This number belongs to Twilio or has outbound receipts; review ownership first');
            const result = await db.query(
                "update phone_configs set line_role='caller_override' where tenant_id=$1 and twilio_number=$2",
                [tenant, number],
            );
            if (result.rowCount !== 1) throw Error('Caller configuration missing');
            console.log('Excluded the caller override from the service line directory.');
        } else {
            const report = reports.find((row) => row.number === number && row.tenant === tenant);
            if (!report || Object.values(report.checks).some((value) => !value))
                throw Error('Line failed inventory checks: ' + JSON.stringify(report?.checks || {}));
            const result = await db.query(
                `update phone_configs set line_role='client' where tenant_id=$1 and twilio_number=$2
                and call_enabled and sms_enabled and (select count(*) from phone_configs where twilio_number=$2 and line_role <> 'caller_override')=1`,
                [tenant, number],
            );
            if (result.rowCount !== 1) throw Error('Line configuration changed during verification');
            console.log('Enabled client-facing calls on the verified line.');
        }
    }
} finally {
    await db.end();
}
