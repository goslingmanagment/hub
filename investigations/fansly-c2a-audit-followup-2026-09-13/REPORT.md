# C2a audit reader follow-up

The deployed audit in PR #178 verified Ari-1 (184 valid captures, 25 matched
rows). Lilly-1 and Lora-3 completed with 171 and 1,658 PostgreSQL-compressed
bodies unavailable. Lora-2 exported 40,000 of 61,213 frozen captures and Lilly-2
40,200 of 106,222 before the 120-second limit. Lora-1 failed its connection
before obtaining a snapshot. No monetary repair is justified by those results.

The two new forward migrations bound both JSONB copies before decompression,
comparison and parsing. Numeric expansion and the sanitized JSON have their
own limits. The PostgreSQL internal helper is private and pinned to version16
at installation and at each read. Account/access/codec and source checks remain.

The operator exporter sends eight individual statements per network exchange.
Each keeps its statement timeout and computes its page once; psql quotes the
continuation locally. Exact frozen counts, byte limits, cursors, exhaustion and
session cleanup remain mandatory before a completed report is written.

The final local validation passed on 12 September 2026:

- `pnpm check`: 3,269 tests in 297 files; nine existing skips. Typecheck,
  strictness ratchet, lint and dashboard build passed.
- Serial Docker Postgres16 integration: 58 tests in ten suites, zero skips.
  Includes parser/projector parity, TOAST inline/CAS and disagreement, numeric
  expansion, privileges, real psql pagination, interrupted exports, payload
  repository and erasure contracts.
- Actual psql export of 120,000 captures: 151 response groups, 30,900 ms with
  100 ms artificial delay per group. An intentionally absent projection keeps
  this fixture unverified. This is not a production latency measurement.

Independent correctness and quality reviewers reported no remaining findings.
The runtime version guard, lazy test-reader lifetime and wrong-role fixture
findings were fixed. Fixture captures now predate the exclusive audit cutoff;
explicit timestamp overrides and production logic are unchanged.

Deploy through the standard approved release, preserving all currently deployed
source and applied migrations. Repeat all six bounded production exports. A
read_only connection-limit failure is an incomplete attempt; wait for capacity
without increasing the role limit. Do not infer agency parity, C2b readiness,
HTTP savings or fresh-event latency from these local tests.

See `evidence/validation.json` for commands, timestamps, log hashes and source
hashes. Decision317 and the earnings-correctness runbook define bounds/rollback.
