---
name: Outlook body verification
description: Provider body representations can prevent otherwise valid reviewed draft recovery from being verified.
---

Treat Outlook's returned body representation as independent of the representation used in an update. A text-only update may be returned as HTML by a default Graph read. Mixed text and HTML updates use HTML as their effective body.

**Why:** Comparing a stored plain-text request with Graph's default HTML projection can leave a successful update permanently uncertain. Treating an incomplete response as sufficient proof can instead replace a valid saved version with a missing version.

**How to apply:** Verify text-only outcomes with a text-preferred provider read; verify HTML-effective outcomes as HTML. If verification requires another read, require the same provider change key before finalization. Retain the prior saved version and revision whenever the resource, version, or content cannot be verified.