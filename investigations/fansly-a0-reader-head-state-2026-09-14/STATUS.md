# A0 advertised-head reader state

Implementation, independent review and local validation are complete. The tested
source is 5f247b43 over main 4d9cac4a; the publication commit adds evidence only.
Full check passed 3762 tests with 9 existing skips; all 84 serial Docker-Postgres
cases passed. REVIEW.md verifies source, composition and exact log hashes.

The counters describe exact advertised IDs under Agent transcript semantics,
separately from hot presence. Historical reader evidence remains unknown.
Polling/cadence and all original A0 gates remain unchanged. Migration 0194 is
additive; applied 0192 is unchanged. The new SQL requires a separate post-deploy
read-only cost sample and future pre-apply observations.

No production action, provider request, flag flip or gate advancement was
performed for this topic. Merge and deployment remain separate from local
implementation completion. Initial unsuccessful runs and their corrections are
retained; final results and scope are in REPORT.md.
