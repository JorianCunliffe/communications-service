# Communications Service — user acceptance test

Test site: https://communications-service.replit.app/console

Use one designated tester, a test phone, a test mailbox and one selected project. Record the build from `/health`, the date, and the communication/call IDs for each result. The browser console supports calls and SMS; the other workflows use the authenticated API or the connected Hyperflow review interface.

## Verified on 21 September 2026

- Selected HyperFlow project: communications test (`1787628008985`), timezone Australia/Brisbane. Tenant Promise policy enabled for this project and the designated owner; authenticated review-owner binding remains to be verified.
- Build `2a5348d7282f`: 387 isolated regression tests passed; 79/79 deployed HTTP checks passed.
- SMS delivery confirmed by Twilio. Inbound reply remains to be checked.
- The initial real call failed with Twilio 31920. The deployed signature guard now validates the WebSocket URL as well as the HTTPS URL, while rejecting unsigned upgrades and unapproved call IDs.
- The subsequent call completed normally after 36 seconds, exercised interruption and `end_call`, and saved its transcript and summary. The tester reported poor audio quality. Its model was the old `gpt-realtime` with `alloy`; this is not an audio-quality acceptance pass.
- Upgraded defaults to `gpt-realtime-2.1` with `marin` and an explicit English-language default. A real provider session accepted the upgraded model and voice; 85 affected regression tests passed. Receiving-device quality validation of this configuration remains required.
- Mailbox connection, email delivery/reply, inbound calling, owner review and downstream action execution remain acceptance gates. HyperFlow scheduler HTTP 500 errors require investigation before full readiness.

## Setup to complete

- Identify the test owner and resolve their canonical contact ID; select the allowed project IDs.
- Provide a receiving phone number and email address, plus the configured Twilio From number.
- Connect the chosen Gmail or Microsoft mailbox using the service OAuth flow. Do not paste passwords or OAuth secrets into this document.
- Set the tenant Promise policy with its current revision, owner, timezone and selected projects; enable operational intelligence and voice review for that scope.
- Bind the actual authenticated review client/user to that owner using `/v1/review/owners`.
- For review actions executed in Hyperflow, verify its deployment, owner mapping, callback capabilities and dispatch/execution configuration. An enabled API alone does not prove downstream execution.
- Keep email draft-only for the first review. Switch to the intended send policy for the designated test mailbox when testing delivery.

The owner, recipients and mailbox are required inputs; broad project access or an arbitrary customer recipient is not a substitute. Mailbox/provider credentials must exist in the deployment as well as the development workspace.

## Test script

| # | Action | Expected result |
| --- | --- | --- |
| 1 | Open the console; check `/health` | Correct deployed build; database healthy; page loads without browser errors |
| 2 | Try blank and malformed call/SMS fields | Clear validation; nothing sent |
| 3 | Place an outbound call to the test phone | Phone rings; correct assistant/voice; two-way audio; no unexpected hangup |
| 4 | Interrupt the assistant, then resume speaking | Playback stops promptly; next answer follows the new turn without duplicate speech |
| 5 | Call the configured service number from the test phone | Correct tenant/person/project context; no unrelated conversation exposed |
| 6 | End a call normally, then test a missed call | Status/duration recorded correctly; no false successful-conversation memory for the missed call |
| 7 | Review transcript, summary and recording where enabled | Correct speakers/content; accessible record belongs to the tester's call |
| 8 | Send one uniquely labelled SMS and reply from the phone | One delivery each way; correct person/thread; status visible; no duplicate send on retry |
| 9 | Connect the mailbox and draft a uniquely labelled test email | Correct sender/recipient/body; draft-only mode does not send |
| 10 | Approve one test email and reply | Provider acceptance followed by actual inbox receipt; reply threaded correctly; no duplicate delivery |
| 11 | Make a promise, a conditional promise and an offer | Promise/condition/offer remain distinct, with correct actor and date |
| 12 | Send a reply containing a quoted old promise | Quoted text creates no new commitment |
| 13 | Report that a document should be attached | Status report remains unverified until actual attachment evidence is available |
| 14 | Amend, snooze and complete a test commitment | Revision checks work; history preserves changes; completion has evidence; snooze survives reload |
| 15 | Run owner review in web and voice | Only the selected owner's projects appear; unknown/stale calendar or attachment coverage stays explicit |
| 16 | Request a reminder, test email and calendar change in review | Clarification/confirmation occurs as needed; approved action executes once; receipt is reflected in review |
| 17 | Search the tester's contact, conversation and project memory | Relevant results link to source records; unrelated/private tenant data is absent |
| 18 | Reopen the app and retry the same action/request ID | State persists; idempotent operations do not create duplicates |

## Pass criteria and evidence

Record Pass/Fail/Blocked for every row, with a short observation and relevant request/communication ID. Do not count an HTTP 200 as proof that an email arrived or a call sounded correct. Full acceptance requires real receiving-device/inbox checks, correct tenant/owner scope and successful configured downstream actions.

Run `npm test` for the isolated regression suite. `npm run test:live` expects a running server and provider credentials; it is an explicit live integration command. `node scripts/evaluate-operational.js --live` measures the small synthetic classifier corpus and is not a substitute for representative user examples.

If a security, cross-tenant, duplicate-send or incorrect-recipient issue occurs, stop that affected test flow and retain the request IDs. Do not remove customer data to reset the test; use labelled test records and the supported lifecycle operations.
