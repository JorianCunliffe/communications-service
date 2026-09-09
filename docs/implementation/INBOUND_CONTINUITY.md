# Inbound conversation continuity

Voice uses tenant-bound incoming From/To resolution. A call reuses a semantic conversation only when there is one eligible recent ordinary candidate for the resolved contact. Multiple candidates and Ask/workflow threads are not guessed. New call/session identifiers remain distinct; fallback semantic IDs are deterministic for the incoming communication. Existing persisted call communications retain their thread on replay. Inbound correlation uses a new agent-conversation run, not an inherited workflow task.

HyperFlow owns the shared/channel prompt settings and permission-filtered operational context. Existing Communications memory remains in this app. The integration retains scoped context and disables unrestricted legacy history. Source fingerprint now includes both the inbound resolver and HyperFlow voice adapter.

Local acceptance: inbound database test passed for email-to-voice continuity, ambiguous projects and distinct people. Full suites before final package/fingerprint metadata passed 263 unit and 41 database tests. Production/provider acceptance must be recorded separately after release. No migrations required.
