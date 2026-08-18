# Historical capture rewrite — reclaiming the bodies already on disk (G5 3c-2, decision #221)

The ritual that turns one month of `observations` — or the whole of
`sync_raw_payloads` — from "every body stored twice" into "every body stored
once, in the content-addressed catalog", and then hands the pages back to the
filesystem.

Everything here is owner-initiated from the CLI. There is no schedule and no
config flag: the acts below walk tens of GB on the box whose free space is the
reason G5 exists, and each one must run with someone watching.

**Run the four steps for ONE month as one sitting.** Between the backfill and
the reclaim the scope is BIGGER on disk than it was — the backfill leaves a dead
tuple behind every row it stamps, and the reclaim is what consumes them. A month
that is backfilled and never reclaimed is a month with permanent bloat.

## Preconditions (all of them, every prod run)

1. **Migration 0129 applied** (creates `capture_rewrite_runs`, the tombstone
   journal every step reads and writes).
2. **The month is CLOSED.** The current UTC month is refused by the code, and
   the reason is not bureaucratic: the skinny copy is a snapshot, and rows
   landing between the copy and the swap would be in the parked partition and
   not in the attached twin.
3. **No erasure in flight.** `capture:reclaim` refuses on an `erasure_log` row
   with `dry_run = false AND completed_at IS NULL`, and on a held erasure fence
   lock. Finish or postpone an erasure; do not race it.
4. **No tiering run in the window.** The tiering job runs 04:40 UTC and detaches
   aged partitions; a detached partition is refused, but do not invite the race.
5. **Headroom.** §9.1's law: free space must hold the source partition AGAIN,
   plus the skinny twin, plus its WAL. Check it first with a dry run; it is the
   precondition most likely to say no.
6. **First prod run on the SMALLEST closed month**, output reviewed before the
   next one.

Check the disk before you start:

    df -h /
    psql -c "select pg_size_pretty(pg_total_relation_size('observations_2026_07'))"

---

## Part 1 — `observations`, one month at a time

### O0 — census (read-only, writes nothing at all)

    pnpm cli capture:backfill --table observations --month 2026-07

Prints the scope census: total rows, how many already carry a catalog
reference, and how many carry a body and no reference (the work). A dry run
leaves **no** journal row — an act that did not happen must not be readable
later as one that did.

**Abort if:** `census.rows` is 0 (wrong month), or the month is not the one you
meant. Nothing was written, so there is nothing to undo.

### O1 — backfill (writes references; adds no bodies to the heap)

    pnpm cli capture:backfill --table observations --month 2026-07 \
      --batch 200 --pause-ms 250 --execute

Per row: canonicalize the inline body with the frozen codec, store it in the
catalog under **the row's own `received_at` month** (creating that monthly
catalog partition if 0123 never made it — production data starts 2026-07 and
0123 starts 2026-08), then stamp `(payload_bucket_month, payload_object_id)`
and the slice-3a typed columns onto the row in one UPDATE.

Expected output:

    referenced 41213 (deduped 9877), codec-refused 3, raced 0, in 207 batches;
    stopped: scope_complete

- **`deduped`** is the point of the exercise: two envelopes carrying the same
  bytes collapsed onto one object.
- **`codec-refused`** rows keep their inline body FOREVER. That is legal
  (0128's CHECK asks for at least one body, not for a catalog one) and the
  refused ids are logged and journaled.
- **`raced`** should be 0 or tiny; it counts rows another writer stamped between
  the read and the update.

**Resumable with no cursor.** `--limit N` stops after N batches; a re-run finds
what is left, because the scan predicate (`payload_object_id is null and payload
is not null`) IS the resume point. A crash is the same story. Re-run freely.

**Abort if:** `stoppedBecause` is not `scope_complete` and you did not pass
`--limit` (something threw — read the `failed` row in `capture_rewrite_runs`).

### O2 — verify (read-only over capture data; writes only its verdict)

    pnpm cli capture:verify-backfill --table observations --month 2026-07 --sample 500

Three proofs, any one of which refuses:

1. **Every row referenced** — except rows the codec refuses, and those are not
   taken on trust: each remaining null-ref row is re-canonicalized here and must
   actually refuse. The backfill's own count is printed beside the proved number
   as a cross-check, never as the authority.
2. **Every reference resolves** — a total anti-join against the catalog, not a
   sample. This is the check the deliberately-absent foreign key (#215) does not
   make, and one dangling reference plus a reclaimed body is one captured fact
   gone.
3. **The bodies agree** — full canonical octets on a bounded random sample.

Expected output:

    VERDICT OK for observations:2026-07: 41216 rows, 41213 referenced,
    3 proved codec-refused, 0 unexplained, 0 dangling; sample 500/500 matched

**Exit code 1 on any refusal**, with the reason on its own `REFUSED:` line.

**Abort criteria:**

| Refusal | What it means | What to do |
|---|---|---|
| `N rows have an ENCODABLE body and no reference` | The backfill did not finish | Re-run O1 |
| `N rows still carry a body and no reference (over the … rescan bound)` | The backfill barely started | Run O1 |
| `N references point at a catalog object that does not exist` | A dangling reference | **STOP.** Do not reclaim. Investigate — this is the `capture_payload_parity` failure class |
| `N of M sampled bodies do not match` | The catalog copy diverged | **STOP.** Do not reclaim |

**The verdict expires.** The reclaim refuses a verdict older than 24h, and one
that a later backfill has overtaken. If you pause overnight, re-run O2.

### O3 — build the skinny shadow (no lock on the live table)

    pnpm cli capture:reclaim --table observations --month 2026-07 --phase shadow
    pnpm cli capture:reclaim --table observations --month 2026-07 --phase shadow \
      --batch 2000 --pause-ms 250 --execute

Creates `observations_2026_07__skinny` beside the live partition and copies
every row into it **without the inline body wherever a reference exists** —
and WITH it for the rows the codec refused, because for those the inline column
is the only copy there is. Then it adds the partition-bound CHECK (so the later
ATTACH skips its validation scan) and reconciles the index set against the
source partition's real `pg_indexes`.

Long, interruptible, resumable: a re-run continues from the highest id already
copied. The live partition is not touched and takes no lock beyond an ordinary
read.

The dry run prints the headroom verdict. To ask "what if I free up more first":

    pnpm cli capture:reclaim --table observations --month 2026-07 --phase shadow \
      --assume-free-bytes 80000000000

(recorded in the tombstone whenever used).

**Abort if:** the final check says `shadow holds N rows and observations_2026_07
holds M` — the copy is incomplete; re-run the phase, it resumes.

### O4 — the swap (SHORT transaction, ACCESS EXCLUSIVE, owner-gated)

    pnpm cli capture:reclaim --table observations --month 2026-07 --phase swap
    pnpm cli capture:reclaim --table observations --month 2026-07 --phase swap \
      --execute --confirm 'observations_2026_07'

One transaction under `lock_timeout` (default 3s, `--lock-timeout-ms`):

    detach observations_2026_07
      → rename it to observations_2026_07__pre_g5_<ts>
      → move it to schema capture_pending_drop
      → rename the skinny twin to observations_2026_07
      → attach it for the month's range

**Crash safety is the transaction.** A process killed at any instant leaves the
OLD partition attached, because PostgreSQL rolls the whole thing back. There is
no state in which the parent has no partition for this month.

Every statement inside is catalog-only, so once the lock is granted the
transaction is milliseconds. `lock_timeout` bounds the WAIT, not the work — if
the lock is not granted in time, the swap aborts and nothing changed. That is
the correct outcome; re-run it in a quieter minute.

Verify immediately:

    psql -c "select count(*), count(*) filter (where payload is not null)
             from observations
             where received_at >= '2026-07-01' and received_at < '2026-08-01'"

Row count must equal the pre-swap count; `payload is not null` must equal the
codec-refused count from O1.

**Rollback before the drop:** the original is intact in `capture_pending_drop`.
Reverse it by hand in one psql transaction (detach the skinny, rename it away,
move the parked copy back to `public`, rename it to `observations_2026_07`,
attach it).

### O5 — grace, then the drop (SEPARATE command, exact name required)

    pnpm cli capture:drop-parked --list

Prints the parking inventory: relation, rows, size, when it was parked.

**Wait out the grace window** (24h by default). A parked partition IS the
rollback for its swap, and the value of a rollback is entirely in how long it
stays available. During that window the erasure still reaches it — the module
sweeps `capture_pending_drop` alongside Stage 28's `tiered_pending_drop` — so an
erasure executed in the window does not silently under-erase.

    pnpm cli capture:drop-parked --relation observations_2026_07__pre_g5_20260818040506
    pnpm cli capture:drop-parked --relation observations_2026_07__pre_g5_20260818040506 \
      --execute --confirm 'observations_2026_07__pre_g5_20260818040506'

Four gates, none of them redundant: the relation must be resolvable **inside**
`capture_pending_drop` (a name is not enough — it is looked up in that schema's
own catalog listing, so nothing in `public` can be reached by any spelling),
`--confirm` must equal the name exactly, the grace window must have elapsed, and
`--execute` must be given.

This is the only command in the slice that destroys bytes, and it is pinned as
such in `tests/retention-deleters.test.ts`.

Confirm the space came back:

    df -h /

---

## Part 2 — `sync_raw_payloads` (the maintenance-rewrite route)

This table is NOT partitioned and has two inbound foreign keys, so it does not
get the shadow swap §9.2 preferred — see decision #221 and the
`SYNC_RAW_PAYLOADS_SHADOW_REJECTION` note in
`apps/runtime/src/services/capture-rewrite/reclaim.ts` for the three reasons.
It takes §9.2's other sanctioned option instead: null the bodies, then rewrite
the relation.

**THERE IS NO PARKED COPY AND THEREFORE NO GRACE WINDOW HERE.** Once R2 has run,
the catalog is the only home those bodies have. That is the state #220 already
sanctions for new captures — reached deliberately, over rows a fresh verify has
blessed, instead of incidentally.

### R0/R1 — backfill and verify (whole table; `--month` is refused)

    pnpm cli capture:backfill --table sync_raw_payloads
    pnpm cli capture:backfill --table sync_raw_payloads --batch 200 --pause-ms 250 --execute
    pnpm cli capture:verify-backfill --table sync_raw_payloads --sample 500

Same three proofs, same abort criteria as O2. `--month` is rejected rather than
ignored: a month-scoped verdict cannot gate a whole-table act.

### R2 — stop the writers, then null the bodies

**On the VPS, the G4 phase-2 ritual:**

    docker compose stop worker scheduler

Both phases refuse while any runtime instance is heartbeating
(`runtime_instances`, 3-minute TTL — allow a few minutes after the stop) or any
other client backend is non-idle.

    pnpm cli capture:reclaim --table sync_raw_payloads --phase null-bodies
    pnpm cli capture:reclaim --table sync_raw_payloads --phase null-bodies \
      --batch 2000 --pause-ms 250 --execute

Batched, resumable, predicate-driven. 0128's CHECK (`response_payload IS NOT
NULL OR payload_object_id IS NOT NULL`) is what makes this safe rather than
merely careful: PostgreSQL itself rejects any row this would leave with no body
anywhere.

### R3 — the rewrite

    pnpm cli capture:reclaim --table sync_raw_payloads --phase vacuum-full
    pnpm cli capture:reclaim --table sync_raw_payloads --phase vacuum-full \
      --execute --confirm 'sync_raw_payloads'

Refuses unless every referenced row has already had its body nulled (otherwise
the rewrite copies the bytes it was meant to remove), unless free space holds
the whole relation twice over, and unless `--confirm` names the table.

`VACUUM FULL` holds ACCESS EXCLUSIVE for the whole rewrite. Measure the table
first and budget the window:

    psql -c "select pg_size_pretty(pg_total_relation_size('sync_raw_payloads'))"

### R4 — restart

    docker compose start worker scheduler
    pnpm cli status

---

## Reading the journal

Every real run leaves a row in `capture_rewrite_runs` (dry runs deliberately do
not):

    select id, operation, scope_table, scope_month, phase, verdict,
           started_at, completed_at, summary
    from capture_rewrite_runs
    order by id desc
    limit 20;

`verdict = 'running'` on an old row means that process died mid-flight. A
`running` row is never read as a blessing by anything.

## What this ritual does NOT do

- It does not touch `ofapi_webhook_events` — those envelopes need the
  `exact_bytes` seam first.
- It does not remove the slice-3a `CAS-INLINE-FALLBACK:` arms. Those may go only
  once every month in production has been through this ritual.
- It does not run the cold tier. Bodies land in `capture_*_hot_bodies`; moving
  them off the box is S6.
