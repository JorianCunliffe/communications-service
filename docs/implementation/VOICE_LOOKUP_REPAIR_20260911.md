# Voice lookup deadline repair — 11 September 2026

## Confirmed failure

The post-farewell-repair call comm_dd6d4d61af53ee8060bc7b43dba096ac had a select_hyperflow_project timeout at 5001ms, followed by a successful identical lookup in 2850ms. The tool wrapper allowed 5000ms while the HTTP request independently allowed 8000ms. Promise.race rejected the tool without cancelling its still-running HTTP request.

## Change

Commit 6156f94 uses one shared 8000ms budget and passes the wrapper's AbortSignal into the HTTP request, including body reading. The tool can consume a valid response between five and eight seconds; an actual deadline cancels the client request instead of leaving it detached. Standalone initial-context requests retain the same eight-second fallback. Duration/outcome/request-ID logging contains no conversation contents or credentials.

This does not cache permission decisions, broaden context access, change HyperFlow ownership, or create a new memory layer. Cancellation closes client transport; it does not claim to cancel work HyperFlow has already started. It is a premature-timeout fix, not a claim that context assembly now takes less time.

## Validation

274 unit tests pass, including three new cases: six-second success without a retry, cancellation while reading the HTTP body, and clearing a successful request's deadline. Existing 41 database tests passed on the preceding voice lifecycle repair; this timeout-only change did not modify database behavior or rerun that suite.

Three real tool invocations from the Replit workspace used the repaired code, existing approved person/call/thread scope, and production HyperFlow endpoint. They created context-read receipts but no calls, messages or workflow tasks. All returned routed project 1787628008985 and current history with 16 sources:

| Sample | Tool duration | HTTP duration | Result |
|---|---:|---:|---|
| 1 | 5654ms | 5563ms | PASS; previously exceeded the five-second tool ceiling |
| 2 | 3786ms | 3786ms | PASS |
| 3 | 3352ms | 3350ms | PASS |

Request IDs: voice_ctx_01f90e6610af4b3b8a499734ed93a49d, voice_ctx_7f5a831e684b47f88576cb572c877c13, voice_ctx_867715512e8044ce93b31042bd69933f.

An earlier browser typing/paste interruption produced a malformed path on the same approved host and returned HTTP404 in 654ms. It was a diagnostic input error, excluded from the three valid measurements. No provider operation was dispatched.

Runtime fingerprint expected after production promotion: 9e3e2d0ae799. Release verification pending. Handset end-to-end timing remains a separate retest; three samples do not establish p95 or isolate cold-start cost.

## Production verification — 12 September 2026

Live /health now returns status ok and build 9e3e2d0ae799, exactly matching implementation commit 6156f94. The earlier HTTP500 during promotion has cleared. Release verified. The three live context checks above passed against production HyperFlow using this implementation; no new call or message was dispatched. UAT-023 premature-timeout regression is resolved at the tool/HTTP boundary. Broader voice latency and handset retest remain separately open.
