The deployed dashboard contains five reviewed control and navigation patches absent from main. This restores their feature explanations, page context, reviewed mutation targets, explicit webhook reconciliation and export recovery, so a future main deployment preserves those workflows.

The original 103 topic paths are retained: 102 match production `38032636` byte for byte; the remaining file only expands two 2,000+ character JSX lines. Canonical emitted JavaScript AST comparison verifies identical behavior and rendered text. Historical D296–300 and new D323 explain the restoration. No new flag or backend behavior is introduced.

Validation against the composed main candidate:
- `pnpm check`: 3,574 unit tests passed, nine existing skips, 315 files; lint, strictness and build passed.
- Twelve serial Docker-Postgres suites: 153 passed, no skips. They exercise config updates/gate wakeup, workboard mutations, notifications/incidents, webhook recovery/lifecycle and typed exports.
- Independent review closed the long-line finding and found no remaining actionable issues; source hashes were stable throughout validation.

The committed investigation contains exact commands, complete logs, transfer/source manifests, formatting proof and the independent review. This PR does not deploy or change event-migration acceptance gates. C1 and provider cooldown remain separate PR topics.
