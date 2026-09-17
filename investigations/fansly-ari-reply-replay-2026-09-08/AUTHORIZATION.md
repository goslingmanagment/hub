# Approved ari-1 scoped replay

The owner replied "давай ага" to the concrete request for preview and one replay of 128 retained DM observations on ari-1 (account 10), received window [2026-09-07T01:45:00Z, 2026-09-08T01:45:00Z), parser v6. This authorizes the exact Gate 2 operation prepared in ../fansly-pr160-deploy-2026-09-08/ARI-REPLAY-APPROVAL.md, followed by read-only acceptance. No wider replay, lilly-2 recovery, flag change, deployment, socket probe or A0/A1 action is included.

Fresh preflight at 18:47:17 UTC: exact approved image 18649bd95f3b, all roles healthy with zero restarts, 30 GiB free, /health OK; 128 pull observations at v5, no other sources in the command scope, zero unavailable bodies; inspected event partitions attached. SQL used read_only / BEGIN READ ONLY / 15-second timeout and committed. The clean local deployment worktree and production-pinned CLI both still match full commit 18649bd95f3bedb812847343d27fdeedf8b5d32f.
