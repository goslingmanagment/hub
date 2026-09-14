# A0 advertised-head reader state

Implementation prepared; independent review and final validation pending. No
production action, probe, flag change or gate advancement belongs to this topic.

The new counters describe exact advertised IDs under Agent transcript semantics,
separately from the existing hot-presence counter. Historical reader evidence
remains unknown. Polling/cadence and all original A0 gates remain unchanged.
Migration 0194 is additive; applied 0192 is unchanged. The new exact SQL requires
its own post-deployment read-only cost sample and future pre-apply observations.

Initial exploratory failures and their fixture corrections are retained in
`evidence/initial-results.json`; they are not final validation receipts.
