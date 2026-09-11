# Voice turn repair — 11 September 2026

Production evidence: inbound comm_2e508d048dd027de1c61b871e5389e23, provider CAa88c4ab56d54f2ca858d56ef9ff28312, 08:32:03–08:33:22 UTC. Caller named communications test on the first question; the assistant asked for selection again. After repetition, one select_hyperflow_project tool resolved the exact authorized project with confidence 0.99 and recalled the latest SMS code correctly. Two identical assistant farewell transcript segments appeared at 71872ms and 73292ms. User also heard duplicated speech. Earlier outbound comm_90b08b83aa284ce3aa48e81d3e77292e omitted the farewell entirely, confirmed by the user.

## Causes and limits

- end_call description requested goodbye before the tool, while its result requested goodbye again. The bridge requested another response unconditionally and treated any response.done as the farewell. The conflicting instruction is confirmed; historical response IDs were not retained to prove exact race ordering.
- Initial awaiting-project instructions remained in session instructions after tool selection; returned selected-project instructions only appeared inside a tool result. The generic demo persona also encouraged jokes despite the tenant's concise business style.
- Caller transcript correctly included the project name. No evidence that the project router rejected the name: the sole audited lookup succeeded. Initial unnecessary clarification was model/prompt behavior.
- Callback request remained spoken evidence, not a created HyperFlow callback task. Do not claim receptionist intake passed.

## Repair

Communications owns call transport and applies HyperFlow's returned prompt/context. It now processes completed tool responses once, issues one continuation after their tools settle, and drains already-generated closing speech without asking for it again. A missing closing speech requests one separately tagged farewell with tools disabled; only that response completion can begin hang-up drainage. Cancelled responses and interrupted tool work cannot generate stale continuations. Playback marks have unique names so echoes flushed by interruption cannot acknowledge new audio.

Project selection replaces old session context using the original base instructions. Caller naming a project in a question counts as selection, rather than requiring a separate repetition. Generic default joke persona is removed for HyperFlow calls; explicit custom line instructions are retained. No permissions, memory extraction, email policy, HyperFlow task creation, or provider credentials change.

Validation: 271 unit tests and 41 database tests passed; syntax and whitespace checks passed. Eight new behavioral regressions cover spoken/silent farewell, response correlation, duplicate completed events, multi-tool continuation, interruptions, failed farewell and project-context replacement.

Provider event contract: https://platform.openai.com/docs/api-reference/realtime-server-events/response/function_call_arguments/done documents that arguments.done also occurs on cancellation; response.done contains output items and final status. https://platform.openai.com/docs/api-reference/realtime-client-events/conversation/item/create documents response metadata used to correlate a separately requested farewell.

Release and live retest pending. Ask the latest SMS code for communications test once, allow an answer, then say goodbye. Acceptance requires one relevant answer and one audible complete farewell; correct recall alone is insufficient. No extra outbound call dispatched during repair.

## Production verification

Released Communications implementation commit 20bb468 to origin/main. Replit deployment 1027190d reports healthy production build d4459236f6c3, exactly matching the tested local runtime fingerprint. Brief HTTP 500 responses occurred during process promotion; the subsequent health check returned status ok on the new build. Human inbound retest is pending. No additional outbound calls or messages dispatched.
