# C1 read-only observation — 12 September 05:07 UTC

All **36 retained reconcile requests** have later exact-generation completion;
none was requested with work already pending. Two additional incremental walks
exhausted pagination without meeting their known checkpoint, on Lilly-1 and
Lora-3. Subsequent reconcile chains remain compatible with absence grace.
Checkpoint deletion, a pagination defect or safe request suppression is not
established. The owner's diagnosis-only instruction remains in effect.

## Verified read and decision coverage

The cumulative window is 11 September 01:05:57.089215 through 12 September
05:07:43.409932 UTC. The reviewed reader returned **500 + 479 = 979 unique,
ordered runs**, with pinned `throughRunId=731029`, cursor 727169 and exhausted
pagination. Both raw receipts, counts, roles, transactions and report hashes
were checked. Their separate `asOf` values are 05:07:54.735624 and
05:08:41.972956 UTC. Each page is repeatable; the combined timeline is not one
atomic snapshot. Repeated aggregate sections are taken only from page one.

The report hashes recorded in the manifests are
`9b5dad01cb71555d24fbcf81331960387da174563b04111944715fd33b490b0a` and
`665aefffc23b7ece6be6c244df0c141f4be8b2f9c1fdaa50b9c4c42c76504f77`.
The prior 601 rows are unchanged; 378 were added. No returned run is unfinished
at the cutoff, and invalid/duplicate decision counts remain zero.

| countMismatch | exhaustedWithoutKnown | unchangedHeadWithRows | Valid decisions |
|---|---|---|---:|
| false | false | false | 133 |
| true | false | false | 33 |
| true | true | false | 3 |

The other combinations remain unobserved. All 36 requested decisions have
valid atomic queue receipts with no pending work. There are 39 certified
reconcile terminals: 36 linked to requests plus three scheduled revisions.
No non-destructive-close outcome is observed. Claimed revision, membership
generation, queue state and later incremental convergence remain separate facts.

The report also exposes **21 new partial incremental chunks without a decision
receipt**: six on Lilly-1 under leased sequence 3723 and 15 on Lora-3 under 3792.
Each episode ends with one valid decision. The handler emits the decision only
on completion; these 21 missing intermediate receipts are not 21 proven losses.
The old failed Lora-2 run 726189 still has no decision and remains unknown.
Failed reconcile chunk 724951 remains retained despite its later successful
revision. The incremental run denominator is therefore 191, not 169.

## New chains and the previous pending comparisons

- Lilly-1 run **728725** records count-plus-exhaustion at **3360/3358**, after
  seven incremental chunks. Revision 731/generation 682 completes in 728745
  with one deactivation candidate. A later mismatch requests 732/generation
  683; run 729576 then reports **3358/3358**, without another request.
  The prior revision 730 did not by itself establish convergence.
- Lora-3 run **730468** records count-plus-exhaustion at **7562/7561**, after
  16 incremental chunks. Revision 1522/generation 773 completes in 730505 with
  zero candidates. A later mismatch requests 1523/generation 774, completing
  in 731019 with one candidate. The next incremental comparison is not present.
- The expected Lora-2 post-check after 1617 shows **8134/8132** in 728818.
  Revisions 1618–1620 follow; run 730053 and subsequent decisions show
  **8132/8132**, without requesting more work.

These counts do not identify the absent checkpoint or actual deactivated IDs.
Candidate counts are pre-UPDATE diagnostics. Neither the successful terminal
nor a repeated mismatch proves that a walk was redundant. No policy fix was
selected or implemented during this observation.

## Physical attempts and runtime

| Source | Stream | Cumulative attempts | Retry ordinals |
|---|---|---:|---:|
| scheduled | followers | 451 | 2 |
| anomaly | followers_reconcile | 3347 | 23 |
| scheduled | followers_reconcile | 351 | 0 |

The 4,149 retained attempts have no terminal failed or HTTP 429 rows. Coverage
for these two streams has no reported unknown, boundary, lost or unfinished
attempt counters. This is not proof of a complete external request census.

All **378 new runs** have exactly one worker HTTP-summary log record. The
interval contributes 180 scheduled incremental, 1,507 anomaly reconcile and
78 scheduled reconcile attempts, with no retries or failed attempts. These
1,765 attempts are already included in the cumulative 4,149. The logs were read
in three non-overlapping intervals on the unchanged current container; there
are no missing/duplicate summary matches or malformed JSON lines in this read.

At **05:07:43 UTC**, all roles remained healthy on source `9597d9315111`, image
`754d3c1296c41853e353418ee720786ff6b83a0dbd427becc34921bb07a76b13`,
with unchanged starts and zero restarts. Ordinary health reported a 1 ms database
probe; 21.73 GiB remained free. The current release's deploy gate remains
unverified. The historical 66d6ac1a exit-zero receipt is not substituted for it.
The known projection-age P2 remains in this source; a missed live alarm has
not been established. No protected sync-health call was repeated.

[A0](../../fansly-a0-deploy-2026-09-11/OBSERVATION-20260912T050743Z.md) has 71
complete and two incomplete newly started sweeps, with zero unknown material
checks. Five new completed sweeps have a discrepancy below the proposed stop,
including a confirmed flags category. Observation quality improved; provider-
event freshness, physical savings and safe early stopping remain unproven.

The seven-day observation date and diagnosis-only scope are unchanged. No tests
were rerun for observation files; no product code, PR, deployment, flag, replay,
recovery or socket was changed. Independent evidence and document review is
recorded in `REVIEW.md`; raw receipts and per-page snapshot times are retained.
