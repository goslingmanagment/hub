# Metrics central validation follow-up

Original candidate output parity passes, but real non-vacuum 50k integration fixture visits 2971 tuples instead of <500. Full plan in metrics-plan-failure.json: prefix enumeration uses series_time_idx correctly; equality LATERAL selects global sampled_at_idx and filters 266 rows per loop across10loops. Main wave: 79/80 passed, sole failure this plan budget.

A one-million-row populated migration/rerun control passes, indexvalid=true, exact results match; warm legacy83.6-84.2ms/1,000,002tuples, new0.47-0.50ms/617tuples. This vacuumed fixture alone hides fresh-heap wrong-index selection.

Root experimental source saved as metrics-range-candidate.ts. It reads >=series prefix ordered by full composite key, LIMIT N, then filters the bounded result back to exact series outside LIMIT. This allows up to N rows read even for sparse series (may read a following prefix, then discard it) and preserves one snapshot/newest ordering. It prevents optimizing away the prefix order and choosing the global time index. All5 original metric integration tests pass (metrics-range-control.log). Original release source restored; candidate is NOT yet accepted/committed.

Author must inspect/adopt or improve this solution and explain sparse-series limit semantics. Independent reviewer must re-review final source. Need rerun combined tests, original benchmark and populated migration control on final code.
