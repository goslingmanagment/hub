# Final combined candidate validation

Local commit `02d70db5d9dde9127a0b17c8e75b616429f62c99`, tree
`372b84f04df46c3cb607d5d5eef9c8a7c401bb62`, composes main `00e13cf1`
and PR189 head `812834bc`. The local merge was not pushed; GitHub CI retains
its published PR head. Final main `4e18d130ea6ca4b834141789265cce8442f8fcae`,
merged at 02:14:22 UTC, was independently verified to have exactly this tree;
see `../final-pr-receipts/` for the GitHub merge and check receipts.

14 September 2026, 02:06:13–02:07:24 UTC:

- `NODE_OPTIONS=--max-old-space-size=4096 pnpm check`: 3,751 passed, nine existing
  skips, 324 unit files; strictness, lint and build passed, 45.936 seconds.
- Thirteen mandatory serial Docker-Postgres suites: 96 passed, no skips,
  24.460 seconds. They cover DM metadata/history, earnings capture/claims/
  completion/identity/projection/audit, receipts, lease fencing, probe context
  and fan erasure together.
- All tracked source hashes remained unchanged. Command/cwd/environment/head
  and original-log hashes are in each receipt. Gzip preserves the raw bytes;
  the copy manifest and decompressed hashes were independently checked by root.

This is a local combined-code verification. It does not deploy, enable a gate,
prove provider event coverage or measure production savings/latency.
