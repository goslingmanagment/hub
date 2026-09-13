# C2a bounded export query plans

PR179 made ordinary compressed snapshots readable. Four production pages passed
comparison; Lora-1 and Lilly-2 still reached the 120-second export limit. A local
120,000-row fixture compared the same keyset predicates, ordering and limit with
a reduced ID/timestamp projection. Results matched in both plan modes. For the
late cursor, generic planning filtered 105,000 rows and touched 2,658 buffer blocks;
custom planning filtered one and touched 22. The saved plans show the cursor
bound in the custom index condition. This is a local mechanism reproduction,
not a capture of production's internal PL/pgSQL plan.

A separate production diagnostic using deployed source 74aac5093cfc and a
session-only custom-plan setting exported 107,196 Lilly-2 observations and 2,462
projection rows in 46.817 seconds. At that frozen snapshot, 22 captures awaited
parsing and 46 fan/window rows awaited projection; 2,416 matched. It correctly
remained unverified. The retained manifest hash and actual role/isolation/mode
are in evidence/production-diagnostic.json.

The local operator exporter now sets and verifies force_custom_plan within its
existing read-only transaction. This is four added production-code lines.
No runtime deployment, migration, provider call, flag, repair or polling change
is required. Production readers and all limits remain unchanged.

Validation after rebasing onto main `605b931f`: pnpm check passed 3,364
tests/300 files with nine existing skips;
typecheck, lint and build passed. Ten serial real Docker Postgres suites passed
61 tests with zero skips in 54.3 seconds. Coverage includes same-session reset
of an inherited generic mode after rollback, missing/wrong mode refusal, exact
hashes/private files, parser/projector parity, actual psql pagination, TOAST,
interruption, source guards and erasure. Commands/log hashes/source hashes are
in evidence/validation.json.

Independent correctness and quality reviewers approved the implementation and
tests. The correctness review clarified that the local plan fixture uses a
reduced projection. No remaining finding. Decision 318 and the correctness
runbook document scope and rollback.

After merge, repeat the two incomplete page exports using the published local
exporter and retain any live parse/projection debt. A completed export is not
parity. Physical HTTP savings, quiet-correction coverage and fresh-event latency
remain unmeasured; C2b acceptance has not been established.
