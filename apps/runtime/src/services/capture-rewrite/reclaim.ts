// G5 slice 3c-2, step C — THE SPACE ACTUALLY COMES BACK.
//
// Steps A and B (index.ts) put every historical body in the catalog and proved
// the copy faithful. Nothing is smaller yet: the scope is BIGGER, because the
// backfill's UPDATE left a dead tuple behind every stamped row. This file is
// where those pages are handed back to the filesystem — and it is the only file
// in this slice that can lose data, so every act in it is owner-gated, every
// step is separately invocable, and the destructive one is a different command
// entirely.
//
// TWO TABLES, TWO MECHANISMS, AND THE ASYMMETRY IS THE DESIGN.
//
//   observations       — partitioned by `received_at`, so a closed month is a
//                        self-contained unit that nothing writes to any more.
//                        §9.1's ritual applies whole: skinny shadow → SHORT
//                        transactional detach/attach swap → park the original →
//                        grace → owner-gated DROP. The old bytes survive the
//                        swap, which is what makes the swap safe to attempt.
//
//   sync_raw_payloads  — NOT partitioned, with inbound foreign keys. §9.2 offers
//                        two routes and prefers the shadow swap "при достаточном
//                        временном headroom". THIS SLICE SHIPS THE OTHER ONE —
//                        the planned maintenance rewrite — and the three
//                        reasons are written out under "WHY sync_raw_payloads
//                        GETS THE MAINTENANCE REWRITE" below, next to the code
//                        that implements the alternative.
//
// WHAT NEVER HAPPENS HERE: no schedule, no config flag, no automatic drop, and
// no step that runs because a previous one succeeded. Every phase is its own
// invocation with its own preconditions, re-checked from the database each
// time, because the gap between two phases is measured in hours and the world
// moves in it.

import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";

import {
  type CaptureRewriteScope,
  captureRewriteScopeRef,
  censusCaptureRewriteScope,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  latestSettledCaptureRewriteRun,
  listActiveInstances,
  openCaptureRewriteRun,
  settleCaptureRewriteRun,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  CAPTURE_PARKING_SCHEMA,
  currentMonthVerdict,
  gib,
  type HeadroomVerdict,
  monthUtcRange,
  normalizeIndexDef,
  observationPartitionName,
  parkedRelationName,
  reclaimHeadroomVerdict,
  shadowRelationName,
  vacuumFullHeadroomVerdict,
  verifyVerdictFreshness,
} from "./scope.ts";

type Ctx = Pick<AppContext, "db" | "logger">;

/*
 * WHY `sync_raw_payloads` GETS THE MAINTENANCE REWRITE AND NOT THE SHADOW SWAP,
 * even though §9.2 names the swap as its preference.
 *
 * 1. TWO INBOUND FOREIGN KEYS. `transaction_tip_contexts` references
 *    `sync_raw_payloads(id)` twice (`source_raw_payload_id`,
 *    `tip_message_source_raw_payload_id`, both ON DELETE SET NULL, migration
 *    0122). A rename swap has to drop both and re-create them against the new
 *    relation, and re-creating a foreign key VALIDATES it — a full scan of the
 *    referencing table, inside the swap transaction, holding ACCESS EXCLUSIVE
 *    on `transaction_tip_contexts` as well. The property §9.2 wanted from the
 *    swap was a SHORT stop; this version does not have it, and it has it least
 *    exactly when the tip-context projection has grown.
 *
 * 2. THE OWNED SEQUENCE MOVES WITH THE TABLE. `sync_raw_payloads.id` is
 *    `bigserial`, so `sync_raw_payloads_id_seq` is OWNED BY that column.
 *    `ALTER TABLE … SET SCHEMA` carries an owned sequence into the new schema
 *    with it, while the shadow's copied default still says
 *    `nextval('sync_raw_payloads_id_seq')` — unqualified, resolved through
 *    `search_path`, which no longer finds it. The first capture after the swap
 *    fails. That is a DP 7 violation caused by a storage optimisation, which is
 *    the one outcome this whole project may not produce.
 *
 * 3. THE HEADROOM ASK IS THE WHOLE TABLE AT ONCE. Unpartitioned means there is
 *    no unit smaller than "everything". §9.1's headroom law would refuse the
 *    swap on the production box for the same reason the swap exists.
 *
 * So this table takes §9.2's first option — "planned maintenance rewrite
 * (`VACUUM FULL`/`CLUSTER`) с заранее измеренным lock budget" — in two explicit
 * phases: null the inline bodies that have a proven catalog copy, then rewrite
 * the relation with the writers stopped. THE COST IS STATED PLAINLY: there is
 * no parked copy and therefore NO GRACE WINDOW for this table. Once the bodies
 * are nulled, the catalog is their only home — which is exactly the state
 * #220 already sanctions for new captures, reached deliberately instead of
 * incidentally, and only over rows a fresh verify has blessed.
 */
export type CaptureReclaimPhase = "shadow" | "swap" | "null-bodies" | "vacuum-full";

export const CAPTURE_RECLAIM_PHASES: Record<CaptureRewriteScope["table"], CaptureReclaimPhase[]> = {
  observations: ["shadow", "swap"],
  sync_raw_payloads: ["null-bodies", "vacuum-full"],
};

export interface CaptureReclaimOptions {
  scope: CaptureRewriteScope;
  phase: CaptureReclaimPhase;
  dryRun: boolean;
  confirm: string | undefined;
  batch: number;
  pauseMs: number;
  lockTimeoutMs: number;
  /**
   * Pretend the volume has this many free bytes instead of measuring it.
   *
   * A DRILL SEAM, and a deliberate one rather than a test back door. The
   * headroom law is the precondition most likely to refuse a real run, and an
   * owner staring at a refusal needs to be able to ask "how much would I have
   * to free up" without waiting for a cleanup to finish first. It is journaled
   * in the run summary whenever it is used, so a run that skipped the real
   * measurement says so in its own tombstone forever.
   */
  freeBytesOverride?: number;
  now?: Date;
}

export interface CaptureReclaimResult {
  runId: number | null;
  scopeRef: string;
  phase: CaptureReclaimPhase;
  dryRun: boolean;
  verdict: "ok" | "refused";
  refusals: string[];
  /** What the phase would do / did do — shape depends on the phase. */
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Preconditions

interface PreconditionContext {
  refusals: string[];
  detail: Record<string, unknown>;
}

interface ErasureQuietProbe {
  midFlightRuns: number;
  midFlightIds: string | null;
  fenceLocksHeld: number;
  refusals: string[];
}

/**
 * "Is an erasure running right now?"
 *
 * Two independent signals, because they fail in different directions. The
 * erasure_log row is durable and survives a crash (a run that died mid-flight
 * has `completed_at` null forever, and #219 says such a run must be re-run to
 * convergence — reclaiming underneath it would move the rows it still has to
 * reach). The advisory locks are live and catch a run that started one second
 * ago and has not journaled anything the reclaim can see yet.
 *
 * Either one refuses. The interaction that makes this necessary is specific:
 * an erasure deletes from the ATTACHED partition, and a shadow built before it
 * — or a copy still running while it commits — would carry the erased rows into
 * the relation that replaces it. That is resurrection, the exact failure the
 * G3 fence exists to prevent, arriving through a different door.
 *
 * IT TAKES A HANDLE, NOT THE APP, because decision #222 runs it TWICE: once as
 * an ordinary precondition and once more INSIDE the swap transaction, after the
 * table locks are held. A precondition answers "is it safe to start"; only the
 * re-check under lock answers "is it still true now that nothing else can
 * move", and the gap between those two questions is where the P2 lived.
 */
async function probeErasureQuiet(db: Ctx["db"]): Promise<ErasureQuietProbe> {
  const midFlight = await db.execute<{ n: string; ids: string | null }>(sql`
    select count(*)::text as n,
           string_agg(e.id::text, ',' order by e.id) as ids
    from erasure_log e
    where e.dry_run = false and e.completed_at is null
  `);
  const midFlightRuns = Number(midFlight.rows[0]?.n ?? 0);
  const held = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from pg_locks l
    where l.locktype = 'advisory'
      and l.classid = ${DM_ARCHIVE_ERASURE_FENCE_LOCK_NS}
      and l.objsubid = 2
      and l.granted
  `);
  const fenceLocksHeld = Number(held.rows[0]?.n ?? 0);

  const refusals: string[] = [];
  if (midFlightRuns > 0) {
    refusals.push(
      `${midFlightRuns} executed erasure run(s) have not completed `
        + `(erasure_log ids ${midFlight.rows[0]?.ids ?? "?"}) — an erasure that has not converged `
        + "still has rows to reach in this scope",
    );
  }
  if (fenceLocksHeld > 0) {
    refusals.push(`${fenceLocksHeld} erasure fence lock(s) are held right now`);
  }
  return { midFlightRuns, midFlightIds: midFlight.rows[0]?.ids ?? null, fenceLocksHeld, refusals };
}

async function checkErasureQuiet(app: Ctx, ctx: PreconditionContext): Promise<void> {
  const probe = await probeErasureQuiet(app.db);
  ctx.detail.erasureMidFlightRuns = probe.midFlightRuns;
  ctx.detail.erasureFenceLocksHeld = probe.fenceLocksHeld;
  ctx.refusals.push(...probe.refusals);
}

/** The verify blessing, and that it still describes today's scope. */
async function checkVerifyBlessing(
  app: Ctx,
  scope: CaptureRewriteScope,
  now: Date,
  ctx: PreconditionContext,
): Promise<void> {
  const verify = await latestSettledCaptureRewriteRun(app.db, { operation: "verify", scope });
  const backfill = await latestSettledCaptureRewriteRun(app.db, { operation: "backfill", scope });
  const freshness = verifyVerdictFreshness({
    verifiedAt: verify?.completedAt ?? null,
    verifyVerdict: verify?.verdict ?? null,
    backfillCompletedAt: backfill?.completedAt ?? null,
    now,
  });
  ctx.detail.verifyRunId = verify?.id ?? null;
  ctx.detail.verifyVerdict = verify?.verdict ?? null;
  ctx.detail.verifiedAt = verify?.completedAt?.toISOString() ?? null;
  if (!freshness.ok) {
    ctx.refusals.push(freshness.reason);
  }
}

/** The Postgres backends and the runtime processes that could still be writing. */
async function checkWritersStopped(app: Ctx, ctx: PreconditionContext): Promise<void> {
  const instances = await listActiveInstances(app.db);
  const roles = instances.map((row) => `${row.role}/${row.instanceId}`);
  ctx.detail.activeRuntimeInstances = roles;
  if (roles.length > 0) {
    ctx.refusals.push(
      `${roles.length} runtime instance(s) are still heartbeating (${roles.join(", ")}) — `
        + "stop the worker and the scheduler first (the G4 phase-2 ritual)",
    );
  }

  const busy = await app.db.execute<{ n: string; sample: string | null }>(sql`
    select count(*)::text as n,
           string_agg(distinct a.state, ',') as sample
    from pg_stat_activity a
    where a.datname = current_database()
      and a.pid <> pg_backend_pid()
      and a.backend_type = 'client backend'
      and a.state is not null
      and a.state <> 'idle'
  `);
  const busyCount = Number(busy.rows[0]?.n ?? 0);
  ctx.detail.busyBackends = busyCount;
  if (busyCount > 0) {
    ctx.refusals.push(
      `${busyCount} other client backend(s) are not idle (states: ${busy.rows[0]?.sample ?? "?"}) — `
        + "a VACUUM FULL under live writers is the operation §13 of the architecture doc forbids",
    );
  }
}

async function relationSizes(
  app: Ctx,
  relation: string,
  schema = "public",
): Promise<{ total: number; indexes: number } | null> {
  const rows = await app.db.execute<{ total: string; indexes: string }>(sql`
    select pg_total_relation_size(c.oid)::text as total,
           pg_indexes_size(c.oid)::text as indexes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname = ${relation}
  `);
  const row = rows.rows[0];
  return row === undefined ? null : { total: Number(row.total), indexes: Number(row.indexes) };
}

/**
 * Free bytes on the volume Postgres lives on.
 *
 * `statfs` on the runtime's own root, exactly as the hourly disk gauge measures
 * it (services/db-alert): the worker's filesystem and the Postgres volume are
 * the same VPS disk. Reading it from Node rather than from Postgres is
 * deliberate — `pg_stat_file` and friends need superuser, and the number this
 * law needs is the one the disk alert has been trending all along.
 */
async function freeBytesOnDataVolume(override?: number): Promise<number> {
  if (override !== undefined) {
    return override;
  }
  const { statfs } = await import("node:fs/promises");
  const stats = await statfs("/");
  return Number(stats.bavail) * Number(stats.bsize);
}

// ---------------------------------------------------------------------------
// observations

/**
 * A precondition that was true before the swap took its locks and is no longer
 * true now that it holds them (decision #222). Thrown inside the transaction so
 * PostgreSQL rolls the swap back, caught outside it so the run settles as
 * `refused` — the verdict that means "nothing was touched" — rather than as a
 * failure with a stack trace.
 */
class SwapRefused extends Error {
  override readonly name = "SwapRefused";
}

/**
 * How long the under-lock re-verification may take before the swap gives up.
 *
 * The swap is supposed to be a SHORT stop, and the recount is the only thing in
 * it that reads data. A minute is generous for two counts over one closed month
 * and still far short of "the capture path noticed"; anything slower means the
 * partition is not in a state where this act should be attempted right now.
 */
const SWAP_STATEMENT_TIMEOUT_MS = 60_000;

async function countRelation(db: Ctx["db"], relation: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql.raw(`select count(*)::text as n from "${relation}"`),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function observationPartitionState(
  db: Ctx["db"],
  partition: string,
): Promise<{ exists: boolean; attached: boolean; schema: string | null }> {
  const rows = await db.execute<{ schema: string; attached: boolean }>(sql`
    select n.nspname as schema,
           exists (
             select 1 from pg_inherits i
             join pg_class p on p.oid = i.inhparent
             where i.inhrelid = c.oid and p.relname = 'observations'
           ) as attached
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = ${partition} and c.relkind = 'r'
    order by n.nspname
    limit 1
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return { exists: false, attached: false, schema: null };
  }
  return { exists: true, attached: row.attached, schema: row.schema };
}

/** Every column of the source partition, in ordinal order. Read from the
 *  catalog rather than hard-coded so a column added by a later migration is
 *  copied without anyone remembering to edit this file. */
async function relationColumns(app: Ctx, relation: string): Promise<string[]> {
  const rows = await app.db.execute<{ column_name: string }>(sql`
    select a.attname as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = ${relation}
      and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  `);
  return rows.rows.map((row) => row.column_name);
}

async function relationIndexDefs(
  app: Ctx,
  relation: string,
  schema = "public",
): Promise<Array<{ name: string; def: string }>> {
  const rows = await app.db.execute<{ indexname: string; indexdef: string }>(sql`
    select i.indexname, i.indexdef
    from pg_indexes i
    where i.schemaname = ${schema} and i.tablename = ${relation}
    order by i.indexname
  `);
  return rows.rows.map((row) => ({ name: row.indexname, def: row.indexdef }));
}

interface ShadowBuildDetail extends Record<string, unknown> {
  partition: string;
  shadow: string;
  copiedRows: number;
  sourceRows: number;
  bodiesDropped: number;
  bodiesKept: number;
  indexesAdded: string[];
  headroom: HeadroomVerdict | null;
}

/**
 * PHASE `shadow` — build the skinny twin beside the live partition.
 *
 * NO LOCK ON THE LIVE TABLE beyond an ordinary read: this phase creates a NEW
 * relation and copies into it. It can take hours, it can be interrupted, and it
 * can be re-run — the copy resumes from the highest id already present, because
 * the shadow carries the same primary key as its source.
 *
 * WHAT THE COPY DOES TO THE BODY, and it is the entire point of the exercise:
 *
 *     case when payload_object_id is null then payload else null end
 *
 * A row whose body is in the catalog arrives WITHOUT its inline copy. A row the
 * codec refused — the rows that legitimately have no reference — arrives WITH
 * it, because for that row the inline column is the only copy there is and
 * 0128's CHECK is what says so. This is the same conditional the pointer-only
 * writer applies to new captures, applied to old ones; nothing is dropped that
 * is not provably somewhere else.
 *
 * THE PARTITION-BOUND CHECK IS ADDED HERE, NOT AT THE SWAP. Without a CHECK
 * that implies the partition's range, `ATTACH PARTITION` scans the whole
 * relation to prove every row belongs — under ACCESS EXCLUSIVE, in the swap
 * transaction, which is exactly the lock this operation is shaped to keep
 * short. Adding it now costs a scan nobody is waiting on.
 */
async function buildObservationShadow(
  app: Ctx,
  options: CaptureReclaimOptions,
  ctx: PreconditionContext,
): Promise<ShadowBuildDetail> {
  const month = options.scope.month!;
  const partition = observationPartitionName(month);
  const shadow = shadowRelationName(partition);
  const range = monthUtcRange(month);

  const census = await censusCaptureRewriteScope(app.db, options.scope);
  const detail: ShadowBuildDetail = {
    partition,
    shadow,
    copiedRows: 0,
    sourceRows: census.rows,
    bodiesDropped: census.referenced,
    bodiesKept: census.rows - census.referenced,
    indexesAdded: [],
    headroom: null,
  };

  const sizes = await relationSizes(app, partition);
  if (sizes === null) {
    ctx.refusals.push(`partition ${partition} does not exist`);
    return detail;
  }
  const headroom = reclaimHeadroomVerdict({
    freeBytes: await freeBytesOnDataVolume(options.freeBytesOverride),
    sourceTotalBytes: sizes.total,
    sourceIndexBytes: sizes.indexes,
    referencedFraction: census.rows === 0 ? 1 : census.referenced / census.rows,
  });
  detail.headroom = headroom;
  if (!headroom.ok) {
    ctx.refusals.push(`§9.1 headroom: ${headroom.reason}`);
  }

  if (ctx.refusals.length > 0 || options.dryRun) {
    return detail;
  }

  await app.db.execute(sql.raw(`
    create table if not exists "${shadow}" (like "observations" including all)
  `));

  const columns = await relationColumns(app, partition);
  const projected = columns
    .map((column) =>
      column === "payload"
        ? `case when s.payload_object_id is null then s.payload else null end`
        : `s."${column}"`
    )
    .join(", ");
  const columnList = columns.map((column) => `"${column}"`).join(", ");

  const resumeRows = await app.db.execute<{ max_id: string | null }>(sql.raw(`
    select max(id)::text as max_id from "${shadow}"
  `));
  let afterId = Number(resumeRows.rows[0]?.max_id ?? 0);

  for (;;) {
    const inserted = await app.db.execute<{ id: string }>(sql.raw(`
      insert into "${shadow}" (${columnList})
      overriding system value
      select ${projected}
      from (
        select * from "${partition}" p
        where p.id > ${afterId}
        order by p.id asc
        limit ${Math.max(1, options.batch)}
      ) s
      on conflict do nothing
      returning id::text as id
    `));
    if (inserted.rows.length === 0) {
      // `on conflict do nothing` can swallow a whole batch on a resumed run, so
      // an empty RETURNING is not proof the source is exhausted — ask the
      // source directly before stopping.
      const more = await app.db.execute<{ id: string | null }>(sql.raw(`
        select min(p.id)::text as id from "${partition}" p where p.id > ${afterId}
      `));
      const next = more.rows[0]?.id;
      if (next == null) {
        break;
      }
      afterId = Number(next) - 1;
      continue;
    }
    detail.copiedRows += inserted.rows.length;
    afterId = inserted.rows.reduce((max, row) => Math.max(max, Number(row.id)), afterId);
    app.logger.info(
      { partition, shadow, copied: detail.copiedRows, lastId: afterId },
      "capture:reclaim shadow copy batch",
    );
    if (options.pauseMs > 0) {
      await sleep(options.pauseMs);
    }
  }

  // The bound CHECK, so ATTACH skips its validation scan.
  await app.db.execute(sql.raw(`
    alter table "${shadow}" drop constraint if exists "${shadow}_partition_bound_check"
  `));
  await app.db.execute(sql.raw(`
    alter table "${shadow}" add constraint "${shadow}_partition_bound_check"
    check (received_at >= '${range.from}'::timestamptz and received_at < '${range.to}'::timestamptz)
  `));

  // Index reconciliation: `LIKE observations INCLUDING ALL` brought the parent's
  // declared indexes, but 0096's and 0126's partial expression indexes are
  // created `ON ONLY observations` and attached per leaf, so the leaf-level
  // index has to exist BEFORE the attach or PostgreSQL builds it during the
  // attach, holding ACCESS EXCLUSIVE for a full heap scan.
  const sourceIndexes = await relationIndexDefs(app, partition);
  const shadowIndexes = await relationIndexDefs(app, shadow);
  const have = new Set(shadowIndexes.map((index) => normalizeIndexDef(index.def, partition, shadow)));
  for (const index of sourceIndexes) {
    const normalized = normalizeIndexDef(index.def, partition, shadow);
    if (have.has(normalized)) {
      continue;
    }
    const name = `${shadow}_${index.name}`.slice(0, 63);
    const statement = index.def
      .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+/i, (match) =>
        match.replace(/INDEX\s+\S+\s+ON/i, `INDEX "${name}" ON`))
      .replace(new RegExp(`(public\\.)?"?${partition}"?`), `"${shadow}"`);
    await app.db.execute(sql.raw(statement));
    detail.indexesAdded.push(name);
    have.add(normalized);
  }

  const finalRows = await app.db.execute<{ n: string }>(sql.raw(`
    select count(*)::text as n from "${shadow}"
  `));
  const shadowRows = Number(finalRows.rows[0]?.n ?? 0);
  detail.copiedRows = shadowRows;
  if (shadowRows !== census.rows) {
    ctx.refusals.push(
      `shadow holds ${shadowRows} rows and ${partition} holds ${census.rows} — the copy is `
        + "incomplete; re-run this phase, it resumes",
    );
  }
  return detail;
}

/**
 * PHASE `swap` — the short transaction.
 *
 * ONE TRANSACTION, and that is the crash-safety proof: a process killed at any
 * instant inside it leaves the OLD partition attached, because PostgreSQL rolls
 * the whole thing back. There is no window in which the parent has no partition
 * for this month — the state the architecture doc names as the thing that must
 * never happen, and the reason a detach-then-attach pair may not be two
 * statements in two transactions.
 *
 * `lock_timeout` bounds the wait, not the work. Almost every statement inside is
 * catalog-only (the bound CHECK built in the shadow phase is what keeps ATTACH
 * from scanning), so once the locks are granted the transaction is milliseconds
 * plus the recount below. If a lock is NOT granted in time the whole thing
 * aborts and nothing changed — which is the correct outcome and the reason this
 * is not run under a `lock_timeout` of zero.
 *
 * THE SHADOW TAKES THE PARTITION'S NAME. `observations_2026_07` must keep
 * meaning "July's rows" to everything that reads a partition name: the tiering
 * job's regex, the replay guards, the erasure's parked scan. The superseded
 * original is renamed out of the way first, so the two never collide.
 *
 * EVERY PRECONDITION IS RE-PROVED INSIDE, AFTER THE LOCKS (decision #222). The
 * counts above and `checkErasureQuiet` in the caller both read a world that is
 * still moving: an erasure can execute in the seconds between them and the
 * moment this transaction actually holds its locks, and then the swap would park
 * a post-erasure source and attach a PRE-erasure shadow — RESURRECTING every row
 * that erasure deleted, through the one door the G3 fence does not watch. So the
 * transaction takes its table locks EXPLICITLY and FIRST, and only then asks
 * again: is an erasure quiet, is the shadow still a detached row-for-row twin of
 * the still-attached source. Any answer that changed aborts the transaction, and
 * an aborted swap has changed nothing at all.
 *
 * THE RECOUNT IS THE PRIMARY GUARD AND THE ERASURE PROBE IS THE NAMED ONE. An
 * erasure that COMMITTED its deletes shows up as a count mismatch (the shadow
 * kept the rows the source lost; nothing writes into a closed month, so the
 * counts cannot drift back into agreement). An erasure that has NOT committed
 * them is invisible to any count — MVCC hides it — which is exactly what the
 * mid-flight `erasure_log` probe and the held-fence probe are for. Neither
 * subsumes the other.
 */
async function swapObservationPartition(
  app: Ctx,
  options: CaptureReclaimOptions,
  ctx: PreconditionContext,
): Promise<Record<string, unknown>> {
  const month = options.scope.month!;
  const partition = observationPartitionName(month);
  const shadow = shadowRelationName(partition);
  const range = monthUtcRange(month);
  const parked = parkedRelationName(partition, options.now ?? new Date());

  // These two are the CHEAP, lock-free version of the check — they read a world
  // that is still moving, so they exist to refuse early and to give the operator
  // real numbers in a dry run. The verdict that actually gates the swap is taken
  // again inside the transaction, under the locks (#222).
  const shadowState = await observationPartitionState(app.db, shadow);
  const shadowCount = shadowState.exists ? await countRelation(app.db, shadow) : 0;
  const sourceCount = await countRelation(app.db, partition);

  const detail: Record<string, unknown> = {
    partition,
    shadow,
    parked: `${CAPTURE_PARKING_SCHEMA}.${parked}`,
    shadowRows: shadowCount,
    sourceRows: sourceCount,
    lockTimeoutMs: options.lockTimeoutMs,
  };

  if (!shadowState.exists) {
    ctx.refusals.push(`shadow ${shadow} does not exist — run --phase shadow first`);
  } else if (shadowState.attached) {
    ctx.refusals.push(`${shadow} is already attached to observations — the swap already happened`);
  } else if (shadowCount !== sourceCount) {
    ctx.refusals.push(
      `shadow holds ${shadowCount} rows and ${partition} holds ${sourceCount} — refusing to swap `
        + "a copy that is not row-for-row the original",
    );
  }

  if (options.confirm !== partition) {
    ctx.refusals.push(
      `--confirm must be the exact partition name '${partition}' (got: ${options.confirm ?? "nothing"})`,
    );
  }

  if (ctx.refusals.length > 0 || options.dryRun) {
    return detail;
  }

  try {
    await app.db.transaction(async (tx) => {
      const handle = tx as unknown as Ctx["db"];
      await tx.execute(sql.raw(`set local lock_timeout = '${Math.max(1, options.lockTimeoutMs)}ms'`));
      // The recount is the only statement in here that reads DATA, and it runs
      // under ACCESS EXCLUSIVE on the whole of `observations`. If it cannot
      // finish inside this budget the stall is worse than the swap is worth:
      // abort, change nothing, and let the operator retry when the partition is
      // vacuumed (an index-only count) or at a quieter hour.
      await tx.execute(sql.raw(`set local statement_timeout = '${SWAP_STATEMENT_TIMEOUT_MS}ms'`));

      // Take the swap's locks EXPLICITLY, in the order the DDL below would take
      // them anyway (parent, source, shadow), so that everything after this line
      // is being asked of a world that can no longer change under us. `ONLY` on
      // the parent matters: without it PostgreSQL would lock every monthly
      // partition of observations, which is a far bigger stop than this act
      // needs.
      await tx.execute(sql.raw(`lock table only "observations" in access exclusive mode`));
      await tx.execute(sql.raw(`lock table "${partition}" in access exclusive mode`));
      await tx.execute(sql.raw(`lock table "${shadow}" in access exclusive mode`));

      const quiet = await probeErasureQuiet(handle);
      if (quiet.refusals.length > 0) {
        throw new SwapRefused(
          `${quiet.refusals.join("; ")} — an erasure moved between this run's preconditions and `
            + "its locks; a swap now would attach a shadow built before those deletions and "
            + "resurrect the rows they removed",
        );
      }

      const lockedSource = await observationPartitionState(handle, partition);
      const lockedShadow = await observationPartitionState(handle, shadow);
      if (!lockedSource.attached) {
        throw new SwapRefused(`${partition} is no longer an attached partition of observations`);
      }
      if (lockedShadow.attached) {
        throw new SwapRefused(`${shadow} became attached to observations while we waited`);
      }

      const lockedSourceRows = await countRelation(handle, partition);
      const lockedShadowRows = await countRelation(handle, shadow);
      detail.lockedSourceRows = lockedSourceRows;
      detail.lockedShadowRows = lockedShadowRows;
      if (lockedSourceRows !== lockedShadowRows) {
        throw new SwapRefused(
          `under lock the shadow holds ${lockedShadowRows} rows and ${partition} holds `
            + `${lockedSourceRows} (they agreed at ${shadowCount}/${sourceCount} moments ago) — `
            + "something deleted from one of them since the shadow was built; rebuild the shadow "
            + `(drop "${shadow}" and re-run --phase shadow) rather than swapping a copy that is `
            + "not row-for-row the original",
        );
      }

      await tx.execute(sql.raw(`create schema if not exists ${CAPTURE_PARKING_SCHEMA}`));
      await tx.execute(sql.raw(`alter table "observations" detach partition "${partition}"`));
      await tx.execute(sql.raw(`alter table "${partition}" rename to "${parked}"`));
      await tx.execute(
        sql.raw(`alter table "${parked}" set schema ${CAPTURE_PARKING_SCHEMA}`),
      );
      await tx.execute(sql.raw(`alter table "${shadow}" rename to "${partition}"`));
      await tx.execute(sql.raw(`
        alter table "observations" attach partition "${partition}"
        for values from ('${range.from}') to ('${range.to}')
      `));
      // Redundant once the partition bound enforces the same predicate, and a
      // partition carrying a duplicate of its own bound is a puzzle for the next
      // reader. Catalog-only; the lock is already held.
      await tx.execute(sql.raw(`
        alter table "${partition}" drop constraint if exists "${shadow}_partition_bound_check"
      `));
    });
  } catch (error) {
    // A re-verification that said no is a REFUSAL, not a crash: the transaction
    // rolled back, the partition is exactly where it was, and the run's tombstone
    // should say "refused" with the reason rather than "failed" with a stack.
    if (!(error instanceof SwapRefused)) {
      throw error;
    }
    ctx.refusals.push(error.message);
    detail.refusedUnderLock = true;
    app.logger.warn({ ...detail, reason: error.message }, "capture:reclaim swap refused under lock");
    return detail;
  }

  app.logger.info(detail, "capture:reclaim swapped a skinny partition in");
  return detail;
}

// ---------------------------------------------------------------------------
// sync_raw_payloads

async function nullSyncRawPayloadBodies(
  app: Ctx,
  options: CaptureReclaimOptions,
  ctx: PreconditionContext,
): Promise<Record<string, unknown>> {
  const census = await censusCaptureRewriteScope(app.db, options.scope);
  const detail: Record<string, unknown> = {
    relation: "sync_raw_payloads",
    rows: census.rows,
    referenced: census.referenced,
    alreadyPointerOnly: census.pointerOnly,
    wouldNull: census.referenced - census.pointerOnly,
    nulled: 0,
  };

  if (ctx.refusals.length > 0 || options.dryRun) {
    return detail;
  }

  let afterId = 0;
  let nulled = 0;
  for (;;) {
    // The 0128 CHECK is what makes this statement safe rather than merely
    // careful: `response_payload IS NOT NULL OR payload_object_id IS NOT NULL`
    // means PostgreSQL itself rejects any row this would leave with no body
    // anywhere. The `payload_object_id is not null` predicate is therefore
    // belt to the database's braces, not the other way round.
    const updated = await app.db.execute<{ id: string }>(sql`
      update sync_raw_payloads t
      set response_payload = null
      where t.id in (
        select r.id from sync_raw_payloads r
        where r.id > ${afterId}
          and r.payload_object_id is not null
          and r.response_payload is not null
        order by r.id asc
        limit ${Math.max(1, options.batch)}
      )
      returning t.id::text as id
    `);
    if (updated.rows.length === 0) {
      break;
    }
    nulled += updated.rows.length;
    afterId = updated.rows.reduce((max, row) => Math.max(max, Number(row.id)), afterId);
    app.logger.info({ nulled, lastId: afterId }, "capture:reclaim null-bodies batch");
    if (options.pauseMs > 0) {
      await sleep(options.pauseMs);
    }
  }

  detail.nulled = nulled;
  return detail;
}

async function vacuumFullSyncRawPayloads(
  app: Ctx,
  options: CaptureReclaimOptions,
  ctx: PreconditionContext,
): Promise<Record<string, unknown>> {
  const before = await relationSizes(app, "sync_raw_payloads");
  const detail: Record<string, unknown> = {
    relation: "sync_raw_payloads",
    totalBytesBefore: before?.total ?? null,
    totalBytesAfter: null,
  };

  if (before === null) {
    ctx.refusals.push("sync_raw_payloads does not exist");
    return detail;
  }

  const headroom = vacuumFullHeadroomVerdict({
    freeBytes: await freeBytesOnDataVolume(options.freeBytesOverride),
    relationTotalBytes: before.total,
  });
  detail.headroom = headroom;
  if (!headroom.ok) {
    ctx.refusals.push(`§9.2 headroom: ${headroom.reason}`);
  }

  const remaining = await app.db.execute<{ n: string }>(sql`
    select count(*)::text as n from sync_raw_payloads t
    where t.payload_object_id is not null and t.response_payload is not null
  `);
  const stillInline = Number(remaining.rows[0]?.n ?? 0);
  detail.rowsStillCarryingBothCopies = stillInline;
  if (stillInline > 0) {
    ctx.refusals.push(
      `${stillInline} rows still carry BOTH copies — run --phase null-bodies first, or this `
        + "rewrite copies the bytes it was meant to remove",
    );
  }

  if (options.confirm !== "sync_raw_payloads") {
    ctx.refusals.push(
      `--confirm must be 'sync_raw_payloads' (got: ${options.confirm ?? "nothing"})`,
    );
  }

  if (ctx.refusals.length > 0 || options.dryRun) {
    return detail;
  }

  app.logger.warn(
    { before: gib(before.total) },
    "capture:reclaim starting VACUUM FULL on sync_raw_payloads — ACCESS EXCLUSIVE until it ends",
  );
  await app.db.execute(sql.raw("vacuum (full, analyze) sync_raw_payloads"));
  const after = await relationSizes(app, "sync_raw_payloads");
  detail.totalBytesAfter = after?.total ?? null;
  detail.reclaimedBytes = after === null ? null : before.total - after.total;
  return detail;
}

// ---------------------------------------------------------------------------
// The entry point

export async function runCaptureReclaim(
  app: Ctx,
  options: CaptureReclaimOptions,
): Promise<CaptureReclaimResult> {
  const now = options.now ?? new Date();
  const scopeRef = captureRewriteScopeRef(options.scope);
  const allowed = CAPTURE_RECLAIM_PHASES[options.scope.table];
  if (!allowed.includes(options.phase)) {
    throw new Error(
      `--phase ${options.phase} is not a phase of ${options.scope.table} `
        + `(expected: ${allowed.join(" | ")})`,
    );
  }

  const ctx: PreconditionContext = { refusals: [], detail: {} };

  // Preconditions common to every phase that touches capture data.
  await checkVerifyBlessing(app, options.scope, now, ctx);
  await checkErasureQuiet(app, ctx);

  if (options.scope.table === "observations") {
    const month = options.scope.month!;
    const partition = observationPartitionName(month);
    const monthOk = currentMonthVerdict(month, now);
    if (!monthOk.ok) {
      ctx.refusals.push(monthOk.reason);
    }
    const state = await observationPartitionState(app.db, partition);
    ctx.detail.partitionSchema = state.schema;
    ctx.detail.partitionAttached = state.attached;
    if (!state.exists) {
      ctx.refusals.push(`partition ${partition} does not exist`);
    } else if (!state.attached) {
      ctx.refusals.push(
        `partition ${partition} is DETACHED (schema ${state.schema}) — it has been tiered or `
          + "parked; re-attach it through the Stage 28 restore path before rewriting it",
      );
    }
  } else {
    // The maintenance rewrite is the only route for this table, and both of its
    // phases mutate rows the capture path is still writing. Writers must be down
    // for both, not only for the VACUUM FULL: nulling a body under a live writer
    // is safe for the row but pointless for the disk (new bodies arrive behind
    // the sweep), and it widens the window in which a crash leaves the job half
    // done.
    await checkWritersStopped(app, ctx);
  }

  const runId = options.dryRun
    ? null
    : await openCaptureRewriteRun(app.db, {
      operation: "reclaim",
      scope: options.scope,
      phase: options.phase,
      dryRun: false,
      summary: {
        scopeRef,
        phase: options.phase,
        freeBytesOverride: options.freeBytesOverride ?? null,
      },
    });

  // A common precondition that already said no ends the run HERE. The phase
  // bodies below take a census and read relation sizes before they add their
  // own refusals, and against a partition that has been detached (or a month
  // that does not exist) those reads THROW — turning a clean "refused" into a
  // crash. More importantly it is what "refused" is supposed to mean: nothing
  // was touched, nothing was even looked at.
  const blocked = ctx.refusals.length > 0;

  let detail: Record<string, unknown> = {};
  try {
    if (blocked) {
      detail = {};
    } else if (options.phase === "shadow") {
      detail = await buildObservationShadow(app, options, ctx);
    } else if (options.phase === "swap") {
      detail = await swapObservationPartition(app, options, ctx);
    } else if (options.phase === "null-bodies") {
      detail = await nullSyncRawPayloadBodies(app, options, ctx);
    } else {
      detail = await vacuumFullSyncRawPayloads(app, options, ctx);
    }
  } catch (error) {
    if (runId !== null) {
      await settleCaptureRewriteRun(app.db, {
        id: runId,
        verdict: "failed",
        summary: {
          ...ctx.detail,
          ...detail,
          error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {});
    }
    throw error;
  }

  const verdict = ctx.refusals.length === 0 ? "ok" : "refused";
  if (runId !== null) {
    await settleCaptureRewriteRun(app.db, {
      id: runId,
      verdict,
      summary: { ...ctx.detail, ...detail, refusals: ctx.refusals },
    });
  }

  return {
    runId,
    scopeRef,
    phase: options.phase,
    dryRun: options.dryRun,
    verdict,
    refusals: ctx.refusals,
    detail: { ...ctx.detail, ...detail },
  };
}

// ---------------------------------------------------------------------------
// The one destructive command

export interface ParkedRelation {
  relation: string;
  rows: number;
  totalBytes: number;
  parkedAt: Date | null;
}

/** Everything currently sitting in the parking schema. Read-only. */
export async function listCaptureParkedRelations(app: Ctx): Promise<ParkedRelation[]> {
  const rows = await app.db.execute<{ relname: string; total: string }>(sql`
    select c.relname, pg_total_relation_size(c.oid)::text as total
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${CAPTURE_PARKING_SCHEMA} and c.relkind = 'r'
    order by c.relname
  `);

  const parked: ParkedRelation[] = [];
  for (const row of rows.rows) {
    const count = await app.db.execute<{ n: string }>(sql.raw(`
      select count(*)::text as n from ${CAPTURE_PARKING_SCHEMA}."${row.relname}"
    `));
    const journal = await app.db.execute<{ completed_at: Date | string | null }>(sql`
      select r.completed_at
      from capture_rewrite_runs r
      where r.operation = 'reclaim' and r.phase = 'swap' and r.verdict = 'ok'
        and r.summary->>'parked' = ${`${CAPTURE_PARKING_SCHEMA}.${row.relname}`}
      order by r.completed_at desc
      limit 1
    `);
    const completedAt = journal.rows[0]?.completed_at ?? null;
    parked.push({
      relation: row.relname,
      rows: Number(count.rows[0]?.n ?? 0),
      totalBytes: Number(row.total),
      parkedAt: completedAt === null ? null : new Date(completedAt),
    });
  }
  return parked;
}

export interface DropParkedOptions {
  relation: string;
  confirm: string | undefined;
  dryRun: boolean;
  minGraceHours: number;
  now?: Date;
}

export interface DropParkedResult {
  runId: number | null;
  dryRun: boolean;
  verdict: "ok" | "refused";
  refusals: string[];
  detail: Record<string, unknown>;
}

/**
 * THE ONLY THING IN THIS SLICE THAT DESTROYS BYTES.
 *
 * It drops one relation, and the relation it drops can only ever be one that
 * lives inside `capture_pending_drop` — a schema nothing but the swap above
 * ever puts anything into, holding only superseded copies whose rows are all
 * present in the attached twin. That is the statement-level licence
 * tests/retention-deleters.test.ts pins, and it is what makes this a sanctioned
 * deleter rather than a hole in DP 7: the fact is not being deleted, a
 * duplicate of its physical residue is.
 *
 * FOUR GATES, and none of them is redundant:
 *   1. The relation must be IN the parking schema. A name is not enough —
 *      resolution is by catalog lookup, so `public.observations_2026_07` cannot
 *      be reached by any spelling.
 *   2. `--confirm` must equal the relation name EXACTLY. The erasure's ritual.
 *   3. The grace window must have elapsed since the swap that parked it. A
 *      parked partition is the rollback for a swap that turns out wrong, and
 *      the value of a rollback is entirely in how long it stays available.
 *   4. `--execute`. Dry-run prints what would go and touches nothing.
 */
export async function runCaptureDropParked(
  app: Ctx,
  options: DropParkedOptions,
): Promise<DropParkedResult> {
  const now = options.now ?? new Date();
  const refusals: string[] = [];
  const parked = await listCaptureParkedRelations(app);
  const target = parked.find((row) => row.relation === options.relation);

  const detail: Record<string, unknown> = {
    schema: CAPTURE_PARKING_SCHEMA,
    relation: options.relation,
    rows: target?.rows ?? null,
    totalBytes: target?.totalBytes ?? null,
    totalBytesHuman: target === undefined ? null : gib(target.totalBytes),
    parkedAt: target?.parkedAt?.toISOString() ?? null,
    minGraceHours: options.minGraceHours,
  };

  if (target === undefined) {
    refusals.push(
      `${options.relation} is not a relation in ${CAPTURE_PARKING_SCHEMA} — this command can `
        + "destroy nothing else, by construction",
    );
  }
  if (options.confirm !== options.relation) {
    refusals.push(
      `--confirm must be the exact relation name '${options.relation}' `
        + `(got: ${options.confirm ?? "nothing"})`,
    );
  }
  if (target?.parkedAt != null) {
    const ageHours = (now.getTime() - target.parkedAt.getTime()) / 3_600_000;
    detail.ageHours = Math.round(ageHours * 10) / 10;
    if (ageHours < options.minGraceHours) {
      refusals.push(
        `parked ${Math.round(ageHours * 10) / 10}h ago, below the ${options.minGraceHours}h grace `
          + "window — a parked partition IS the rollback for its swap",
      );
    }
  } else if (target !== undefined && options.minGraceHours > 0) {
    refusals.push(
      "no swap run in capture_rewrite_runs claims this relation, so its age cannot be proved — "
        + "pass --min-grace-hours 0 to state that you accept dropping it anyway",
    );
  }

  if (options.dryRun) {
    return {
      runId: null,
      dryRun: true,
      verdict: refusals.length === 0 ? "ok" : "refused",
      refusals,
      detail,
    };
  }

  // A name that does not decode into a month cannot be journaled under a scope,
  // and it is also not a relation this command can reach — so it never gets
  // past the refusal above and never needs a tombstone for an act that had no
  // scope to happen in.
  let scope: CaptureRewriteScope;
  try {
    scope = observationMonthOfParked(options.relation);
  } catch (error) {
    refusals.push(error instanceof Error ? error.message : String(error));
    return { runId: null, dryRun: false, verdict: "refused", refusals, detail };
  }
  const runId = await openCaptureRewriteRun(app.db, {
    operation: "drop_parked",
    scope,
    dryRun: false,
    summary: detail,
  });

  if (refusals.length > 0) {
    await settleCaptureRewriteRun(app.db, {
      id: runId,
      verdict: "refused",
      summary: { ...detail, refusals },
    });
    return { runId, dryRun: false, verdict: "refused", refusals, detail };
  }

  // THE DELETION. `capture_pending_drop` is hard-coded, never interpolated from
  // a caller — the schema half of this statement cannot be influenced from
  // outside this file, and the relation half was resolved out of that schema's
  // own catalog listing above.
  await app.db.execute(sql.raw(`drop table ${CAPTURE_PARKING_SCHEMA}."${options.relation}"`));
  app.logger.warn(detail, "capture:drop-parked destroyed a parked partition");

  await settleCaptureRewriteRun(app.db, { id: runId, verdict: "ok", summary: detail });
  return { runId, dryRun: false, verdict: "ok", refusals, detail };
}

/** The month a parked relation's name encodes, for the journal row's scope. */
function observationMonthOfParked(relation: string): CaptureRewriteScope {
  const match = /^observations_(\d{4})_(\d{2})/.exec(relation);
  if (match === null) {
    throw new Error(
      `${relation} is not a parked observations partition; nothing else is parked here`,
    );
  }
  return { table: "observations", month: `${match[1]}-${match[2]}` };
}
