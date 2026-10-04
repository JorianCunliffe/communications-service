---
name: Outlook body verification
description: Provider body representations can prevent otherwise valid reviewed draft recovery from being verified.
---

Treat Outlook's returned body representation as independent of the representation used in an update. A text-only update may be returned as HTML by a default Graph read. Mixed text and HTML updates use HTML as their effective body.

**Why:** Comparing a stored plain-text request with Graph's default HTML projection can leave a successful update permanently uncertain. Treating an incomplete response as sufficient proof can instead replace a valid saved version with a missing version.

**How to apply:** Verify text-only outcomes with a text-preferred provider read; verify HTML-effective outcomes as HTML. If verification requires another read, require the same provider change key before finalization. Retain the prior saved version and revision whenever the resource, version, or content cannot be verified.

Compare recipient destinations separately from provider-supplied display names; do not normalize stored receipt values or review hashes to achieve that comparison.

**Why:** Outlook may add a display name to a bare requested address while leaving the subject and body exactly unchanged. Comparing formatted recipient strings can falsely hold a successful update; rewriting stored fields would instead invalidate the original idempotency binding.

**How to apply:** Parse only unambiguous supported mailbox addresses for comparison, preserve recipient multiplicity, and reject malformed addresses. Keep text comparisons exact unless an actual provider difference proves a narrower harmless normalization is required.