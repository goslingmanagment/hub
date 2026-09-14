The ordinary OFAPI credits fixture seeded entries at 00:01–00:06 UTC even when the report ran earlier. C1 CI therefore correctly excluded a future 40-credit entry and returned 92 rather than the fixture's expected 132.

Cap fixture offsets at one captured instant. Five deterministic day/month boundary cases exercise the real summary service and PostgreSQL. Production query windows, ordering and the separate intentional future-entry test remain unchanged. Decision 324 records this test-only correction; no flag is introduced.

Validation on the final main composition `4c1ac492` (main `b78752d0`):
- `pnpm check`: 3,420 unit tests passed, nine existing skips, 304 files; lint, strictness and build passed.
- Serial Docker-Postgres credits suite: 26 passed, no skips (21 existing plus five boundary cases).
- Negative control using the old fixture reproduced exactly 132 versus 92 at 00:02:30.
- Independent source and main-composition reviews have no outstanding findings.

The investigation retains the original failing CI log, negative control, exact commands, compressed logs and stable source hashes. No runtime or production operation is included.
