---
name: Git cherry-pick identity
description: Replit Git recovery when an upstream cherry-pick stops because no committer identity is configured.
---

When a cherry-pick fails because Git cannot determine a committer identity, inspect the index before retrying: the upstream patch may already be staged even though no commit was created.

**Why:** Retrying the cherry-pick blindly can fail with “local changes would be overwritten,” because the first attempt may have populated the index before stopping.

**How to apply:** Verify the staged diff matches the intended upstream commit, then complete it with command-scoped `git -c user.name=... -c user.email=... commit -C <upstream>` so repository and global Git configuration remain unchanged.