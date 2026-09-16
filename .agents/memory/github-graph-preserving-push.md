---
name: GitHub graph-preserving fallback
description: Safely publishing exact local-only Git history when shell Git authentication is unavailable.
---

When a branch contains Replit publication commits that GitHub does not yet have, preserve the exact graph rather than replacing it with file-content commits.

**Why:** Shell HTTPS credentials can be stale while the GitHub connector still has repository access. Updating files through the Contents API would flatten local merge and publication history.

**How to apply:** Upload every missing ancestor in topological order through GitHub's Git Data API. Use full blob IDs, preserve raw commit-message trailing newlines and author/committer metadata, and verify each returned tree and commit SHA. Re-read the remote head immediately before updating the ref, and update it only with `force: false`.