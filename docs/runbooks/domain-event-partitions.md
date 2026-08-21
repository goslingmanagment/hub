# Runbook — `partitionBlocked`: no attached `domain_events` partition for a target month

**When you see this.** A canonicalization run (the minutely sweep or an
`events:replay` drain) reports `partition-blocked N > 0`, or the CLI refuses
before dispatching any work with `REFUSED before dispatching work: domain_events
has no attached partition for target month(s): 2026_03 (detached)`. A
`projection:rebuild` may refuse for the *read-side* twin of the same fact.

**What it means.** `domain_events` is monthly-partitioned by `occurred_at`. Two
lanes are deliberately dated at PROVIDER time — `message.material_observed` (the
archive's `occurred_at` IS the message time) and `post.observed` (`publishedAt`)
— so a drain across history aims appends at old months. An append whose target
month has no ATTACHED partition fails `ExecFindPartition` (23514) **per row,
forever**: the observation is never stamped, so every later sweep retries it.
The engine refuses instead, before any write.

**Nothing is lost while it is blocked.** The observation keeps its parse debt on
purpose — that is what makes the recovery replayable. `partitionBlocked` is
counted apart from `errored` because nothing failed; the engine declined. **A run
reporting `partitionBlocked > 0` is a SKIPPED step, not a passed one.**

## The two shapes, and why the recovery differs

The anomaly names the shape. Read it before doing anything — the wrong recovery
for the wrong shape destroys facts.

| shape | what it means | recovery |
|---|---|---|
| `detached` | The partition EXISTS and holds rows; tiering detached it. | **Re-attach it** — the 0077 ritual, `DETACH`/`ATTACH` only, **NEVER `DROP`**. The detached table holds the facts. Alternatively replay hot + lake for the range. |
| `absent` | No partition was ever created for that month. `ensureDomainEventPartitions` creates the current month + 3 and no historical month is ever auto-created, so this is construction, not forgetfulness. | **Create the missing monthly partition**, then re-run. Correct ONLY for this shape. |

> Creating a "missing" partition when the census says **detached** silently
> orphans the detached table's rows behind an empty new one. That is the one
> mistake this runbook exists to prevent.

## Recovery

1. **Read the anomaly.** It carries `family`, `month` (`YYYY_MM`), `shape`, the
   detached relation names when there are any, and the recovery text.
2. **Confirm from the catalog**, do not trust memory:

   ```sql
   select c.relname,
          (i.inhrelid is not null) as attached
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   left join pg_inherits i
     on i.inhrelid = c.oid
    and i.inhparent = 'domain_events'::regclass
   where c.relname like 'domain\_events\_2%'
   order by c.relname;
   ```

3. **If `detached`** — re-attach the month (adjust the bounds to the month named):

   ```sql
   alter table domain_events
     attach partition domain_events_2026_03
     for values from ('2026-03-01 00:00:00+00') to ('2026-04-01 00:00:00+00');
   ```

4. **If `absent`** — create it:

   ```sql
   create table domain_events_2026_03 partition of domain_events
     for values from ('2026-03-01 00:00:00+00') to ('2026-04-01 00:00:00+00');
   ```

5. **Re-run the same command.** The blocked observations were never stamped, so
   they are picked up again with no repair pass and no re-walk of the platform.

## What NOT to do

- **Never `DROP` a detached partition to "clear" the block.** It holds the only
  copy of those events (DP 7: nothing that captured a fact is deleted on a
  schedule; the only sanctioned deleters are pinned by
  `tests/retention-deleters.test.ts`).
- **Never stamp the observations past the block** (`--parse-version`) to make the
  count go to zero. That converts a recoverable skip into permanent silence.
- **Never widen the census's 2026–2030 scope to make a message "go away".** Every
  other regime is covered by construction: `domain_events_pre_2024` spans
  MINVALUE → 2024-01-01; `domain_events_2024` and `_2025` are YEARLY partitions
  migration 0077 named so tiering cannot re-detach them; the 0082 catch-all
  covers 2031+.

## Before a historical drain (the precondition, not an afterthought)

Order for any `events:replay` pass over history — a v5/v6 canonicalizer bump
included:

1. run the census (the query above, or let the CLI refuse for you: it checks the
   `--from/--to` window up front and exits non-zero);
2. re-attach or create anything the census reports **for the target range**;
3. drain, newest window first.

`tiering:run` is ungated on the CLI, so a single manual run re-opens the exposure
the day after any census. The engine gate inside `runCanonicalization` is what
makes that survivable — it covers the steady-state sweep too, not just the
deliberate drain.

## Related

- `docs/runbooks/message-archive-rebuild.md` — the READ-side twin: a rebuild
  refuses when a detached partition holds the account's events, because
  `listEventsSince` sees only attached partitions and would otherwise produce a
  truncated projection and call it authoritative.
- Migration 0077 — the incident that made 2024/2025 yearly.
