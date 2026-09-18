# Root SQL-equivalence follow-up

Original query extracted from agent06 actual-function SQL trace; proposed SELECT unchanged except parameter name. Tests run against isolated local PostgreSQL16, network disabled, no host port, temporary data. 55 page scenarios including empty/all-null/future/reversed/UTC-boundary plus seeded corpora, repeated in4session timezones. This checks query output equality, not production performance, tables/schema integration, lease/erasure concurrency or provider correctness.

## Result

PostgreSQL16.15: all220 comparisons equal;1928fixture rows. See results.json and run-probe.py. First attempt observed pg_isready on the temporary initdb server, which then shut down; that output is preserved in attempt1-init-race.json. Runner now waits for final PID1 postgres. Successful temporary container removed; no product code/production changed. This is SQL-equivalence evidence, not a performance benchmark.
