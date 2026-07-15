# Stage 5 — OnlyMonster full historical export

**Repo(s):** core · **Depends on:** Stage 1 · **Passport:** roadmap.md §4, stage 5

**Status header — SPEC SHRUNK per owner answers (flag for sign-off).**
The passport describes a *full, checksummed, off-box* export of everything OnlyMonster
holds. **Two owner answers of 2026-07-04 empty this stage of its original work:**

1. **Q1 (verified over SSH):** production runs **no OnlyMonster sync streams at all** and holds
   **zero OnlyMonster-sourced transaction rows**. Both OnlyFans pages (`lora-of`, `lora-vip-of`)
   are 100 % OFAPI-fed. There is therefore **nothing to export** — the vendor is already not the
   source of any production fact.
2. **Q3:** off-box storage was **declined** ("я бы не делал этого"). The archive destination the
   passport assumes does not exist.

Consequently this stage is **not** a data export. It is re-specified as a **verification-and-record
stage**: prove at execution time that Q1 still holds (nothing to lose), record the decision that
there is no export to run, and carry forward the two standing risks the collapse creates. This is
the shrink the master roadmap's own §8/§2 updates and the 3b prompt instruct; recorded here as a
**deviation from the pre-answer passport text** for owner sign-off. If, at execution time, the
verification query finds *any* OnlyMonster-sourced rows or live egress, **stop** — the passport's
full-export scope re-activates and Q3 (a destination) must be re-answered first.

## 1. Context

DP 2's owner condition was "full historical export before cancellation, lose nothing." That
condition presumed OnlyMonster was still a live source of truth. Q1 proved it is not: the
OnlyMonster→OFAPI transaction consolidation already happened in production (REST backfill history
back to 2025-09; `ofapiSpendTransactionIngestEnabled` running-on since 2026-06-19), and no
OnlyMonster stream has run in the 48 h `sync_runs` window. "Lose nothing" is satisfied vacuously
when there is nothing the vendor uniquely holds.

**State when it starts (verify, do not assume):**

- No OnlyMonster egress in production logs. Verify — see §5.
- Zero rows in `transactions` whose `raw_type` does not begin `ofapi:`. Verify — see §5.
- The OnlyMonster adapter code still compiles in the repo (`packages/onlyfans/src/adapter.ts`,
  `omapi.onlymonster.ai`) but is **dead in production**. It is deleted behind the seam in Stage 18,
  not here.

**Deliverable:** a short recorded finding in `docs/decisions.md` — "OnlyMonster export: nothing to
export (0 rows, 0 live streams, verified <date>); no off-box archive created (Q3 declined);
subscription cancellable at owner's discretion (tracked in Stage 15)" — plus the two standing-risk
entries in §7 carried into Stage 15 and Stage 28. No code, no data movement.

## 2. Changes

Grouped by repo/module.

**core — none (code).** No files are created, modified, or deleted. The deep-walk export job the
passport describes is **not built** (there is no source data to walk and no destination to write).

**core — docs only.**
- `docs/decisions.md` — append a numbered entry recording the vacuous-export finding, the
  verification queries run and their results, and the two standing risks. (Append-only; do not edit
  prior entries.)

If the §5 verification unexpectedly finds OnlyMonster data, this §2 is void and the full-export
passport is restored — halt and escalate before writing any export code.

## 3. Schema & data migration

**No schema change.** No data migration. No backfill.

The only database interaction is **read-only verification** (§5): counting rows by provenance
proxy and confirming the absence of OnlyMonster-sourced facts.

## 4. Client compatibility

- **Desktop:** no change; it consumes OnlyFans data via the hub, which is OFAPI-fed.
- **Extension:** no change (Fansly only).
- **Dashboard:** no change; revenue reporting already reads the OFAPI-fed `transactions`.
- **Workboard:** n/a.

No compatibility invariant (target §14) is touched — nothing serves or is retired here.

## 5. Tests & verification

**No new automated tests** (nothing is built). Production verification is the whole stage:

```sql
-- (V1) Provenance census: every OnlyFans transaction must be OFAPI-sourced.
SELECT p.label,
       SUM((t.raw_type LIKE 'ofapi:%')::int)     AS ofapi_rows,
       SUM((t.raw_type NOT LIKE 'ofapi:%')::int) AS onlymonster_rows,
       COUNT(*)                                   AS total_rows
FROM pages p
JOIN transactions t ON t.platform_account_id = p.id
WHERE p.platform = 'onlyfans'
GROUP BY p.label
ORDER BY p.label;
-- PASS iff onlymonster_rows = 0 for every page.
```

```sql
-- (V2) No OnlyMonster stream ran recently. Confirm the sync-run source set.
SELECT DISTINCT stream, source
FROM sync_runs
WHERE started_at > now() - interval '7 days'
ORDER BY stream;
-- PASS iff no row names an OnlyMonster/omapi light|transactions|fan_identities stream.
```

- **Egress check (ops):** grep the last 7 days of production logs for `omapi.onlymonster.ai` —
  PASS iff zero outbound calls.
- **Observation window:** none required; this is a point-in-time census.

If **V1 or V2 fails**, stop: the full-export passport re-activates and Q3 must be re-answered.

## 6. Rollback

Nothing to roll back — no code, schema, or data changed. If the decisions entry is written and
later found wrong (e.g. a page turns out dual-fed at execution time), supersede it with a new
append-only entry per family doc law; do not edit it.

## 7. Assumptions

Each stated so a later session can detect drift:

1. **Q1 still holds at execution time** — zero OnlyMonster rows, no live OnlyMonster streams. This
   is the load-bearing assumption; §5 verifies it rather than trusting it. Drift signal: V1/V2
   fail.
2. **No off-box storage exists (Q3 declined).** → **Standing risk, owner-accepted:** there is *no
   off-server backup of any kind*; if the VPS dies, all history dies with it
   (`docs/chatgoose-custody-go-live.md:81-83` already names this an infrastructure blocker).
   Carried into **Stage 28** (re-raise no later than the retention-tiering stage). This stage does
   **not** create a backup and must not be read as having done so.
3. **The OnlyMonster subscription, if still billed, is cancellable at will** and its cancellation
   is tracked in **Stage 15** (not here), after Stage 15's parity/verification. Drift signal: an
   owner intent to cancel *before* Stage 15 — allowed, but record it.
4. **The OnlyMonster adapter code is dead but present** and is removed only in **Stage 18** (behind
   the adapter seam). Drift signal: someone deletes it earlier and breaks the build.

## 8. Task breakdown

Collapsed stage — no build work. One ordered checklist for the execution session:

1. Run V1/V2 from §5 against production (zero OnlyMonster rows; no live OnlyMonster streams).
   Done-check: both queries return zero. *If either is non-zero, STOP — the collapse assumption
   failed; fall back to the full-export spec preserved in this file's git history and escalate.*
2. Record the census result and the "no export to run" decision in `docs/decisions.md`.
   Done-check: decision entry committed.
3. Carry the two standing risks forward explicitly: the no-off-box-backup risk into Stage 28
   (§7.2), the subscription-cancellation into Stage 15 (§7.3). Done-check: both noted where the
   later stages will see them.
