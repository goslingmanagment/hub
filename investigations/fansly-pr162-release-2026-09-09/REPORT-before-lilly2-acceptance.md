# PR162 deployed; lora-1 accepted; Lilly replay in progress

PR162 (https://github.com/goslingmanagment/core/pull/162) merged on 9 September
2026 at 18:09:54 UTC as `8b25d57e5d1343271177426ee9caf644cb1ee5c0`.
Independent review found no outstanding issues after the evidence whitespace and
filename pointer were corrected. The clean worktree is pinned to this merge;
its tree equals independently confirmed head `641d7a4fba1f439062ab5ca05b35bdb86ea5ca27`.
The owner approved deployment to all Hub production roles with «Да деплой на все».
The exact procedure and rollback remain in [DEPLOY-APPROVAL.md](DEPLOY-APPROVAL.md).

The first attempt ran 18:27:49–18:37:41 UTC and exited 1 when the remote
BuildKit candidate build reported `forwarding Ping: no such job`. It stopped
before release sync or container recreation. Read-only verification at 18:38
confirmed the original PR161 image, all roles healthy, zero restarts, 29 GiB
free and API health ok. The default Docker builder reports running. Daemon
logs retain the no-such-job/session-healthcheck errors; no OOM log entries were
found in the inspected kernel interval, which does not prove a complete cause.

The deliberate retry ran 18:39:20–19:06:20 UTC and completed with exit 0.
All roles passed health and image-label gates; dashboard delivery passed.
Sync-health had three 150-second client timeouts before the fourth request
returned HTTP 200 in 144.240260678 seconds (API request log). This latency
remains unresolved. The production-pinned CLI was rebuilt at the exact merge;
capabilities/contract validation passed. At 19:06:42 all three roles ran image
`sha256:893cc4cc7fd2fadfd0afa204dd10c188b62449201adf4e668c7c1e2fd597a513`,
healthy with zero restarts; disk remained 29 GiB free. API health passed with
DB latency 1 ms. The 19:07:52 authenticated UI read confirmed catch-up `none`.

The three original blocked lora-1 reads all passed at 19:07, in 5.725, 2.965
and 1.785 seconds including CLI wall time. No serving exception or timeout
increase was used. The complete original 143-ID cohort was accepted at 19:09:02:
143/143 archive rows, parent/root links, normalized text, media count, stable
media metadata and raw media references match retained source. A fresh census
confirmed all 170 original observations at v6 with zero unavailable bodies.
140 earlier successful read timestamps are retained; this is not a fresh atomic
143-ID snapshot or proof of complete threads. No lora-1 replay was repeated.

Existing sequential Lilly reply permission is now unblocked. Lilly-2/account 5
preflight confirmed exactly 826 pull/v5 observations with bodies and attached
event partitions. Dry-run completed in 69.007 s with zero errors/conflicts/skips
and no budget truncation. After another successful fresh preflight, its scoped
replay completed at19:30:18 UTC: all826 stamped,9963 appended,14127 deduplicated,
zero errors/skips/partitions/binding conflicts. Full serving now finds409/409
archive IDs and parents. Five roots and four normalized-text values remain
unconfirmed as of19:53; no lilly-1 replay or head-recovery activation has started.
See `evidence/retry-1/` and the five-page reply operation evidence.

## What validation establishes

Before opening the PR, `pnpm check` passed: 3,110 unit tests, nine existing skips,
280 files; lint and dashboard build passed, with the existing strictness budget
unchanged. Five real Docker-Postgres suites passed all 122 tests without skips.
They cover tombstone isolation by platform/current binding, chatless deletion,
source precedence, counts, windows/keysets, purchases and Read Plane evidence/auth.
The independent reviewer reran two focused Postgres suites: five passing tests,
zero skips. All five final-head CI checks passed in run 34386000613. Production
build passed both before the PR and again on the exact merged revision.

The code changes only the chatless cold-archive tombstone lookup. It introduces
no flag, schema, index, timeout or runtime privilege change. On the retained local
mixed-platform fixture, unrelated cold rows visited fell from 300,000 to zero;
EXPLAIN ANALYZE was 29.017 to 0.550 ms and repository list 37.392 to 5.156 ms.
These single local samples are not production latency predictions or percentiles.

## Production evidence, 9 September UTC

At 18:21:11 all three roles were healthy on the unchanged PR161 image
`sha256:52709520fffe658bc65a9e71266b368b908bd232e2b7330980cced181f86dddf`,
with zero restarts and 29 GiB free (64% used). `/api/v1/health` returned status ok
at 18:21:15.255, DB latency 0 ms. The authenticated Configuration UI read at
18:21:53 showed `FANSLY_DM_HEAD_CATCHUP_PAGE_ALLOWLIST=none`, all processes active
and Save disabled. No setting was edited. The UI snapshot did not expose a
configuration version; obtain it before any separately approved flag activation.

The original 7,427-head cohort was reconstructed from seven disjoint bounded
list-receipt reads. Eleven completed message-receipt reads matched retained
capture through the frozen cutoff **2026-09-09 18:09:10.055267 UTC**. They examined
8,939 message observations with zero unavailable bodies. An independent offline
review reconstructed the input sets, window coverage, counts and exact missing IDs.

| Page | Original heads captured in retained raw responses | Missing |
|---|---:|---:|
| lora-1 | 42/43 | 1 |
| lora-2 | 21/21 | 0 |
| lora-3 | 13/13 | 0 |
| lilly-1 | 1667/1671 | 4 |
| lilly-2 | 5615/5615 | 0 |
| ari-1 | 64/64 | 0 |
| Total | 7422/7427 | 5 |

This measures raw capture across bounded snapshots. It does not prove archive or
serving acceptance, freshness, or attribution to a recovery activation. Failed
bounded query attempts are retained, and no timeout was raised. The successful
matcher restored `message_ids AS MATERIALIZED` before joining the frozen IDs;
that diagnostic SQL change did not change production runtime or configuration.

At 18:21:58, ordinary `read_only` / READ ONLY debt classification completed:
the four missing lilly-1 heads are visible, identity-resolved, unexcluded pending
debts with zero recovery attempts despite complete history coverage. The missing
lora-1 head is excluded with `partner_missing_from_aggregation_accounts`, zero
attempts and partial-window coverage. None is classified as a provider deletion.
Exact IDs and evidence are in `evidence/missing-head-classification.txt`.
At the earlier 17:54 snapshot lilly-2 had zero eligible pending debts, while one
ari debt outside these remaining raw gaps was still eligible. Live debt and the
original raw cohort have different scopes; neither substitutes for the other.

The 17:53:55 reply preflight found all original lilly-2 826 and lilly-1 1695
observations still at parser v5, with all bodies present. Lora-1/2/3 were
170/43/31 at v6. That earlier preflight preceded the approved deployment. Current acceptance is
269/994 original positive targets: lora-1 143/143 accepted; 725 Lilly targets
await their scoped replay/serving gates. The prepared
`after-tombstone-fix/` pass preserves all 143 original lora-1 IDs and material
checks. It ran and passed after the verified deployment. Existing Lilly reply replay
permission now proceeds sequentially; do not repeat the already-v6 lora-1 replay.

## Migration state and uncovered scope

| Stage | State | Measured result / remaining gate |
|---|---|---|
| Pre-A0 stale follow-up / known-head debt | PR157 deployed; acceptance incomplete | Original lilly-2 raw heads 5615/5615; five raw gaps elsewhere; archive/serving and remaining debt acceptance open. Recovery has not been activated for lilly-2 by this task. |
| Pre-A0 reply links / honest sweep | PR158–162 deployed; lora-1 accepted; lilly-2 reply replay in progress | 269/994 original reply targets verified across timestamped reads; Lilly sequence is now unblocked and in progress. |
| A0 + T0 | Not started | Pre-A0 exit, offline corpus, default-off shadow/report and >=7 full days on all six pages; physical-attempt baseline absent. |
| C1 | Not started | Diagnostic counts of three anomaly branches before narrow fixes. |
| C2a | Not started | Earnings identity correctness and versioned replay/repair. |
| C2b | Not started | Dirty/receipt shadow with daily rotation retained. |
| C2c | Gated | Coverage, costs and per-fan max-age before rotation/selection changes. |
| W0 | Not started | Offline fixtures, then separately approved live probes through a Management Session. |
| B0 | Gated by W0 | Capture-only receiver; >=7 days and sufficient event variety. |
| B1 | Gated by B0/T0 | Measured delivery lag, added physical attempts and history fairness. |
| A1 | Owner/calendar/evidence gated | Separate yes after A0/T0 and freshness gates. |
| B2 | Not authorized | Separate decision; build only if B1 measurements justify it. |

No physical HTTP savings or fresh-event latency distribution has been measured;
the >=50% goal is not claimed. Historical sampled replay confirmation bounds:
ari <=14m39s, lora-3 <=7m05s, lora-2 <=4m20s from write start. These are repair
bounds, not event-latency percentiles. The last PR161 exact serving read still
returned 503 in 14.545 s; the last successful sync-health deploy gate took
105.498 s after two 150-second client timeouts. These are historical PR161 measurements. PR162 subsequently passed the same
normal gate in144.240s after three150-second client timeouts; rollback remained enabled.

Still uncovered: six original diagnostic ID rereads (ari9 was refreshed), full994 positive
and 27 attachment cohorts, unresolved known heads, source/serving freshness,
outage recovery, old edits/deletions, quiet-state changes, and Management Session
WebSocket scope. Provider-deleted-head repair stays outside A0; A0 counts it.
No A0/T0 clock or A1/B2 advancement occurred. The full implementation goal remains
active; this query fix does not redefine completion.

Evidence: `evidence/merged-tree-verification.json`, `merged-production-build.log`,
`pr162-green-before-merge.json`, `runtime-final.txt`, `config-final.json`,
`fixed-head-capture-result.json`, `missing-head-classification.txt` and the
[independent cohort review](../fansly-pr162-review-2026-09-09/FIXED-COHORT-REVIEW.md).

## Additional pre-A0 verification after deployment

Fresh ari-1 serving and material verification passed at 19:16–19:17 UTC for all
9 original reply IDs. All archive, parent/root, normalized text and media/raw-ref
checks passed; five exact source observations were v6. This refreshes the older
ari evidence without changing the overall original cohort denominator.

Five selected known-head IDs were checked through the ordinary Hub CLI with
2 ms windows and one read in flight. Three lilly-2 heads with hot capture receipts
after their debt observation, plus the previously recovered ari head, were found
in `message_archive`. These are selected-ID proofs, not an all-head archive census
or attribution to lilly-2 activation (which was never performed by this task).

Ari head 953208142580178944 remains unconfirmed after four completed recovery
attempts. At its exact timestamp (7 September 04:06:06 UTC), the Read Plane returns
a different archive ID, 953195879781658624, with no further cursor. The expected ID
was not returned. This does not establish deletion or prove the IDs are aliases.
The bounded read_only raw-identity query hit its five-second statement limit and
returned no result; no privileged exception or timeout increase was used. Preserve
this unresolved identity case separately from the repaired reply-link cohort.
Evidence: `known-head-serving-result.json`, `ari-unconfirmed-row.json`, and the
failed `ari-head-source-identity` query/output under `evidence/`.


At19:50:59 the full Lilly-2 retained-material comparison passed all409 canonical
parent/root pairs from162 exact v6 source observations. The serving result matched
all409 archive IDs, parents, media counts and stable/raw media refs (13 attached
messages). Five roots and four normalized-text values remained stale. The first
pass had one transport failure; after health recovered, only unmatched/unread
groups were continued. No SQL timeout increase or repeated replay was used.
A local checker falsely distinguished a null root from null replyMetadata for
one message; separate check-material-v2 normalizes that nullable representation
while keeping missing-row/non-null-root failures. Original evidence is retained.

The earlier five-second Ari raw query was refined into a1ms metadata lookup and
a single exact retained-body read. Both passed as read_only with the same5s cap.
Observation2286645 confirms raw ID953195879781658624, the ID returned by the
archive. No alternate message/bulk/broadcast ID was present. Expected head
953208142580178944 remains unresolved; this proves neither alias nor deletion.
See evidence/ari-head-identity-status.json.
