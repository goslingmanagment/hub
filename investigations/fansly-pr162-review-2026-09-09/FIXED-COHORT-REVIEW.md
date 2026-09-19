# Independent review of the fixed pre-A0 head capture comparison

No acceptance defect found in the completed comparison. This is an offline audit of stored production read-only evidence; the reviewer made no production calls and changed no source or measurement files.

## Cohort and window identity

The `list_bodies` and `heads` CTE text in freeze-head-cohort.sql matches the original baseline-fixed-cohort.sql exactly. The seven executed list segments (one 30-minute segment plus six 15-minute segments) partition receipt interval `[2026-09-07T23:45Z, 2026-09-08T01:45Z)` without gaps or overlaps. Head creation bounds remain `[2026-09-07T01:45Z, 2026-09-08T00:45Z)`, preserving the original numeric-createdAt condition, tuple fields and DISTINCT semantics.

Reconstructed the union independently from all seven successful result files: 1,447 list observations yield exactly 7,427 unique `(account_id, group_id, message_id, created_at)` tuples in frozen-head-cohort.json. All 7,427 `(account_id, message_id)` keys are also unique in this cohort. The per-account original cohort counts are 43, 21, 13, 1,671, 5,615, 64 for accounts 1, 2, 3, 4, 5, 10 respectively. Every input read reports role read_only, transaction_read_only on, zero unavailable bodies, an empty stderr, and successful COMMIT.

## Capture comparison

All eleven expected materialized capture result windows exist and completed. They partition `[2026-09-07T01:45Z, 2026-09-09T18:09:10.055267Z)` without gaps or overlaps, using ten six-hour segments and one final partial segment. The lower bound is the original baseline lower bound; the original moving `now()` upper bound is frozen to the explicit later measurement cutoff above, rather than claiming the prior snapshot cutoff is unchanged. Every segment was measured after its upper bound.

Verified each embedded wanted corpus equals the complete original page/message key set. Aside from the frozen literal cohort and receipt bounds, all eleven executed SQL statements are identical. They retain Fansly/dm_messages predicates, account IDs and payload/hot-body resolution. `message_ids AS MATERIALIZED` expands and deduplicates retained message IDs before joining by both account_id and message_id; this is semantically equivalent to the original baseline comparison. It avoids expanding each body repeatedly after joining only on account, as shown by the failed matcher's saved estimated plan. That EXPLAIN is estimated-plan evidence, not a measurement of actual expansion counts or complete timeout attribution.

Recomputed the union from all completed parts: 8,939 message observations, zero unavailable bodies, zero unmatched foreign wanted keys, no duplicated seen IDs within a part. Missing SQL NULL bodies are checked and stop processing rather than being counted as missing messages. The final parts, per-account counts and exact missing tuples in fixed-head-capture-result.json equal the independent reconstruction.

| Account | Original heads | Captured heads | Missing raw message capture |
|---|---:|---:|---:|
| 1 (lora-1) | 43 | 42 | 1 |
| 2 (lora-2) | 21 | 21 | 0 |
| 3 (lora-3) | 13 | 13 | 0 |
| 4 (lilly-1) | 1671 | 1667 | 4 |
| 5 (lilly-2) | 5615 | 5615 | 0 |
| 10 (ari-1) | 64 | 64 | 0 |
| Total | 7427 | 7422 | 5 |

## Limits and operational gates

These results establish retained raw capture for the fixed cohort, across separate bounded read snapshots. They do not establish transcript/source material or reply-link acceptance, current provider head correctness, freshness, an atomic serving census, savings, or attribution to an activated recovery job. In particular, lilly-2's 5,615/5,615 raw head capture count does not authorize or prove completion of its serving acceptance or replay work. Five original heads still lack matching retained raw capture and require classification; this audit does not close broader pre-A0 acceptance or classify them as provider deletions. No deployment, recovery activation or other production exception is authorized by this review.

Machine-readable independent totals: fixed-cohort-audit.json.
