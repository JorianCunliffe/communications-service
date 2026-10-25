# Live HyperFlow briefing tools

Coaching and daily briefing calls receive `hyperflow_briefing` when HyperFlow integration is configured and the call has a trusted contact identity. Authorised primary-caller inbound routing also retains it across project selection. HyperFlow's enrolment, SMS verification and capability checks determine access; advertising a tool does not grant it authority.

The tool calls the signed HyperFlow `/api/agent/briefing` endpoint using the existing HyperFlow origin and Communications webhook secret. Model arguments cannot select the tenant, caller, thread, communication, service identity, endpoint or confirmation evidence. No arbitrary HTTP or code-execution tool is exposed.

The conversation requests a verification code, verifies it, then reads current tasks, approvals and reports. Reports support a selected user or all users permitted by HyperFlow. Lists expose pagination and incomplete-source notices. Writes use exact-version preparation, verbatim readback, completed Twilio playback, a later caller confirmation and a saved result. On timeout, query the existing operation result; never repeat an uncertain effect.

Input transcription and assistant output events supply trusted turn evidence. Twilio playback marks establish when a full readback finished; interrupted readbacks cannot authorise a mutation. Verification codes are redacted from tool audit arguments and verification SMS history. Briefing-capable calls are marked private to general conversation memory, including after outcome classification, because their contents can span projects and users. Authorised call records and HyperFlow post-call extraction remain available.

Health advertises `liveBriefing` and `briefingProtocol: briefing-tool.v1`. The runtime fingerprint includes the briefing and audit modules. HyperFlow enrolment defaults off and must be configured before a live acceptance call. No new database migration or provider credential is introduced.

Verification covers trusted request signing, argument stripping, purpose-specific tool exposure, inbound retention and secret redaction. Full live acceptance also requires matching deployed HyperFlow routes/rules, enrolment, a verified caller, real tool results, confirmed source changes and post-call processing. Repository tests alone do not prove that acceptance.
