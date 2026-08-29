// G5 slice 3c-2 — the historical rewrite, steps A and B: BACKFILL and VERIFY.
//
// Step C (the physical reclaim) lives next door in reclaim.ts, because it is a
// different kind of act: this file only ever ADDS a reference to a row that
// already has its body, while that one moves relations around and hands the
// owner a gun. Keeping them apart makes the diff between "additive" and
// "destructive" a file boundary rather than a code-reading exercise.
//
// NOTHING HERE IS SCHEDULED. Both are CLI commands, owner-initiated, dry-run by
// default — the erasure's governance, applied to the other one-time act this
// system has. A schedule was never considered: a backfill that walks itself
// across a disk-starved box at 04:00 with nobody watching is how a containment
// project becomes an incident.

import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";

import {
  applyCaptureBackfillRef,
  applyCaptureTypedColumnCatchUp,
  type CaptureBackfillCandidate,
  type CaptureRewriteScope,
  CapturePayloadCodecError,
  capturePayloadBucketMonth,
  captureRewriteRelation,
  captureRewriteScopeRef,
  censusCaptureRewriteScope,
  type CaptureRewriteScopeCensus,
  type CaptureRewriteSampleReport,
  canonicalizeCaptureJson,
  countCaptureRewriteDanglingRefs,
  deriveObservationQueryableFields,
  deriveRawPayloadTipsSlice,
  ensureCapturePayloadCatalogPartitions,
  latestSettledCaptureRewriteRun,
  listCaptureBackfillCandidates,
  listCaptureTypedColumnCandidates,
  openCaptureRewriteRun,
  putPayloadObject,
  sampleCaptureRewriteParity,
  settleCaptureRewriteRun,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { readDiskFreeBytes } from "../db-disk-alert.ts";
import { type SettleGuardHooks, settleRunOnSignal } from "./settle-on-signal.ts";
import {
  type BackfillCopyMeasurement,
  measureBackfillCopy,
  readWalEnvironment,
} from "./measure.ts";
import {
  type CaptureRewriteForecast,
  backfillHeadroomVerdict,
  captureBackfillMidRunVerdict,
  captureRewriteForecast,
  headroomRecheckDue,
  type HeadroomVerdict,
} from "./scope.ts";

type Ctx = Pick<AppContext, "db" | "logger">;

/** Hard ceiling on `--batch`: this pass writes a second heap tuple per row on
 *  the largest tables in the system, and an operator typing a large number must
 *  not be able to turn a paced walk into a WAL flood. */
export const CAPTURE_BACKFILL_MAX_BATCH = 2000;

/**
 * Above this many unreferenced rows, `capture:verify-backfill` refuses to walk
 * them one by one to prove each is a codec refusal — it just says "run the
 * backfill first".
 *
 * The bound is what makes the honest check affordable. Proving that every
 * remaining null-ref row is one the codec REFUSES (rather than one the backfill
 * simply has not reached) means re-canonicalizing each one, and that is the
 * right check precisely because a stored count from an earlier run is a claim,
 * not evidence. It is cheap when the remainder is what it should be — a handful
 * of lone surrogates — and pointless when the remainder is an unrun backfill.
 */
export const CAPTURE_VERIFY_REFUSED_RESCAN_LIMIT = 10_000;

/**
 * How often the walk re-asks the volume how much room is left, WHEN THE VOLUME
 * HAS ROOM.
 *
 * Every batch would be a syscall per 200 rows for a number that moves in
 * minutes, not milliseconds; never would be the bug this constant exists to
 * close. Ten batches is at most a few thousand rows of exposure between checks
 * — small beside the floor the check defends.
 *
 * BELOW `CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES` THIS CADENCE IS ABANDONED
 * and the walk reads the volume every batch (`headroomRecheckDue`). Near the
 * floor the exposure between two readings stops being small beside anything,
 * and the mid-walk floor check is the HARD BACKSTOP behind every estimate in
 * this slice — the WAL term and the copy ratio are budgets, this is the thing
 * that actually stops the walk.
 */
export const CAPTURE_BACKFILL_HEADROOM_RECHECK_BATCHES = 10;

/** The walk's most recent reading of the volume, shared by both scans so the
 *  cadence decision does not reset when the typed-column catch-up starts. */
interface FreeSpaceTracker { lastFreeBytes: number | null }

export interface CaptureBackfillOptions {
  scope: CaptureRewriteScope;
  dryRun: boolean;
  batch: number;
  pauseMs: number;
  /** Maximum batches this invocation may run; 0 = until the scope is done. */
  maxBatches: number;
  /**
   * Test seam for the headroom law: the free-bytes reader.
   *
   * NOT a drill flag and deliberately NOT reachable from the CLI. `capture:
   * reclaim`'s `--assume-free-bytes` is the operator-facing drill and #223
   * confined it to dry runs precisely because a figure typed by a human must
   * never be what an EXECUTED run's admission gate believes. A test needs to
   * drive the gate to both verdicts, so it injects the reader instead of
   * inventing a flag that would also exist in production.
   */
  readFreeBytes?: () => Promise<number>;
  /** Test seam for the #239 signal settle: a test cannot send its own process a
   *  real SIGTERM and survive to assert on it. Not reachable from the CLI. */
  settleGuardHooks?: SettleGuardHooks;
}

export interface CaptureBackfillResult {
  runId: number | null;
  scopeRef: string;
  relation: string;
  dryRun: boolean;
  census: CaptureRewriteScopeCensus;
  batches: number;
  scanned: number;
  /** Rows that got a reference on this pass. */
  referenced: number;
  /** Of those, the ones whose body was ALREADY in the catalog (the dedup
   *  collapsing two envelopes onto one object — the point of the exercise). */
  deduped: number;
  /** Rows the frozen codec refuses to encode. They keep their inline body
   *  FOREVER: 0128's CHECK allows it, and there is nothing else to do with a
   *  body that cannot be canonicalized. */
  codecRefused: number;
  /** Bounded sample of refused ids, for the report. */
  codecRefusedIds: number[];
  /** Rows another writer stamped between our read and our update. Not an error
   *  — the UPDATE's `payload_object_id is null` guard doing its job. */
  raced: number;
  /** Catalog months this run had to create (historical months 0123 never
   *  pre-created). */
  monthsCreated: string[];
  lastId: number;
  stoppedBecause:
    | "scope_complete"
    | "batch_limit"
    | "headroom_exhausted"
    | "refused"
    /** #239: SIGTERM/SIGINT reached the walk; the ledger row is settled `failed`. */
    | "signalled";
  /** #223: rows the typed-column catch-up walked (the slice-1-to-slice-3a
   *  cohort, which the reference scan cannot see). */
  typedColumnsScanned: number;
  /** Of those, the ones whose typed columns this pass actually filled. */
  typedColumnsFilled: number;
  /** #239: what the two bounded probes measured, so the tombstone carries the
   *  inputs to the verdict and not only its answer. */
  copyMeasurement: BackfillCopyMeasurement | null;
  /** #239: what finishing the whole ritual for this scope is worth. */
  forecast: CaptureRewriteForecast | null;
  /** The §9.1-shaped admission verdict. Null only when the scope's relation
   *  could not be sized (which is itself a refusal). */
  headroom: HeadroomVerdict | null;
  /** Why the run refused to start, or to continue. Empty on a clean pass. */
  refusals: string[];
}

export const CAPTURE_BACKFILL_REFUSED_ID_SAMPLE = 25;

/**
 * Walk a scope's historical rows, put each body in the catalog, stamp the row
 * with its address.
 *
 * RESUMABLE WITH NO CURSOR. The scan predicate excludes rows that already carry
 * a reference, so a re-run after a crash (or after a `--limit`ed pass) simply
 * finds what is left. There is no watermark to persist, nothing to reconcile,
 * and no "already done" error to handle.
 *
 * BOUNDED AND PACED. `batch` rows per keyset page, `pauseMs` between pages. The
 * pause is not decoration: this pass writes a second heap tuple per row on the
 * largest tables in the system, and running it flat out would spike WAL and
 * autovacuum on a box chosen for this project because its disk is nearly full.
 */
export async function runCaptureBackfill(
  app: Ctx,
  options: CaptureBackfillOptions,
): Promise<CaptureBackfillResult> {
  const scopeRef = captureRewriteScopeRef(options.scope);
  const relation = captureRewriteRelation(options.scope);
  const batch = Math.min(CAPTURE_BACKFILL_MAX_BATCH, Math.max(1, options.batch));
  const readFreeBytes = options.readFreeBytes ?? (() => readDiskFreeBytes());

  const census = await censusCaptureRewriteScope(app.db, options.scope);

  const result: CaptureBackfillResult = {
    runId: null,
    scopeRef,
    relation,
    dryRun: options.dryRun,
    census,
    batches: 0,
    scanned: 0,
    referenced: 0,
    deduped: 0,
    codecRefused: 0,
    codecRefusedIds: [],
    raced: 0,
    monthsCreated: [],
    lastId: 0,
    stoppedBecause: "scope_complete",
    typedColumnsScanned: 0,
    typedColumnsFilled: 0,
    copyMeasurement: null,
    forecast: null,
    headroom: null,
    refusals: [],
  };

  // ---------------------------------------------------------------------
  // #223 — THE ADMISSION GATE, and it runs before anything is written.
  // ---------------------------------------------------------------------
  // This is a growth-producing act on a disk-starved box, and until #223 it was
  // the ONLY step of the ritual with no headroom law at all: the observation
  // check lived at `shadow` and the raw one after `null-bodies`, both of which
  // run hours later, by which time the bytes are already on the volume.
  const sizes = await relationSizeBytes(app, relation);
  if (sizes === null) {
    result.refusals.push(`${relation} does not exist`);
  } else {
    // #239: the two terms that used to be assumed are measured here. Both
    // probes are bounded and the whole pair costs a fraction of a second on the
    // 21 GB table — a gate that cost more than the batch it admits would be
    // its own reason to skip the gate.
    const copy = await measureBackfillCopy(
      app.db,
      options.scope,
      relation,
      census.unreferencedWithBody,
    );
    const wal = await readWalEnvironment(app.db);
    result.copyMeasurement = copy;
    result.headroom = backfillHeadroomVerdict({
      freeBytes: await readFreeBytes(),
      sourceTotalBytes: sizes.total,
      inlineBytesToCopy: copy.inlineBytesToCopy,
      copyRatio: copy.copyRatio,
      maxWalSizeBytes: wal.maxWalSizeBytes,
      walKeepSizeBytes: wal.walKeepSizeBytes,
      archiveModeOff: wal.archiveModeOff,
      replicationSlots: wal.replicationSlots,
    });
    result.forecast = captureRewriteForecast({
      table: options.scope.table,
      census,
      copyBytes: result.headroom.shadowEstimateBytes,
      sourceTotalBytes: sizes.total,
      sourceIndexBytes: sizes.indexes,
    });
    if (!result.headroom.ok) {
      result.refusals.push(`§9.1 headroom: ${result.headroom.reason}`);
    }
  }

  if (options.dryRun) {
    // A dry run reports EXACTLY what the real one would touch and writes
    // nothing at all — not even a journal row. A tombstone for an act that did
    // not happen is the kind of evidence that later gets misread as one that
    // did (which is why latestSettledCaptureRewriteRun filters dry runs out).
    app.logger.info(
      {
        scope: scopeRef,
        relation,
        wouldStamp: census.unreferencedWithBody,
        wouldFillTypedColumns: census.typedColumnGaps,
        copyMeasurement: result.copyMeasurement,
        forecast: result.forecast,
        headroom: result.headroom,
      },
      "capture:backfill dry run",
    );
    if (result.refusals.length > 0) {
      result.stoppedBecause = "refused";
    }
    return result;
  }

  if (result.refusals.length > 0) {
    // A refusal before the first write leaves a tombstone that says so — unlike
    // a dry run, an EXECUTED invocation happened, and "I was asked and I said
    // no" is exactly the kind of evidence the journal exists to hold.
    result.stoppedBecause = "refused";
    const runId = await openCaptureRewriteRun(app.db, {
      operation: "backfill",
      scope: options.scope,
      dryRun: false,
      summary: { relation, censusAtStart: census },
    });
    result.runId = runId;
    await settleCaptureRewriteRun(app.db, {
      id: runId,
      verdict: "refused",
      summary: backfillSummary(result),
    });
    return result;
  }

  result.runId = await openCaptureRewriteRun(app.db, {
    operation: "backfill",
    scope: options.scope,
    dryRun: false,
    summary: { relation, censusAtStart: census },
  });

  const ensuredMonths = new Set<string>();
  let afterId = 0;
  // Seeded from the pre-flight's own reading, so batch 1 already knows whether
  // it is on a roomy volume or a tight one.
  const freeSpace: FreeSpaceTracker = {
    lastFreeBytes: result.headroom?.freeBytes ?? null,
  };

  // #239: run 1 died `running` because the #87 deploy recreated its container,
  // and eight days later the ledger still said a backfill was in flight. A
  // signal is not a throw and never reaches the catch below; this does.
  const settleGuard = settleRunOnSignal(app, {
    runId: result.runId,
    scopeRef,
    summary: () => backfillSummary(result),
  }, options.settleGuardHooks ?? {});

  try {
    for (;;) {
      if (settleGuard.stopRequested()) {
        result.stoppedBecause = "signalled";
        break;
      }
      if (options.maxBatches > 0 && result.batches >= options.maxBatches) {
        result.stoppedBecause = "batch_limit";
        break;
      }
      if (
        headroomRecheckDue({
          batchesDone: result.batches,
          lastFreeBytes: freeSpace.lastFreeBytes,
          cadenceBatches: CAPTURE_BACKFILL_HEADROOM_RECHECK_BATCHES,
        })
        && !(await stillHasHeadroom(app, readFreeBytes, result, freeSpace))
      ) {
        break;
      }

      const candidates = await listCaptureBackfillCandidates(app.db, {
        scope: options.scope,
        afterId,
        limit: batch,
      });
      if (candidates.length === 0) {
        result.stoppedBecause = "scope_complete";
        break;
      }

      result.batches += 1;
      for (const candidate of candidates) {
        result.scanned += 1;
        afterId = candidate.id;
        result.lastId = candidate.id;
        await backfillOne(app, options.scope, candidate, ensuredMonths, result);
      }

      app.logger.info(
        {
          scope: scopeRef,
          batch: result.batches,
          scanned: result.scanned,
          referenced: result.referenced,
          deduped: result.deduped,
          codecRefused: result.codecRefused,
          lastId: result.lastId,
        },
        "capture:backfill batch",
      );

      if (options.pauseMs > 0) {
        await sleep(options.pauseMs);
      }
    }

    if (result.stoppedBecause === "scope_complete") {
      await runTypedColumnCatchUp(app, options, batch, readFreeBytes, result, freeSpace);
    }

    // Disarm BEFORE the settle, not in the `finally` after it. The walk is over
    // and its verdict is about to be written; a signal from here on is the
    // process's own business, and the handler racing this statement is exactly
    // the window that would rewrite a completed run as `failed`. The handler's
    // own `where verdict = 'running'` predicate is the second lock on that door
    // — belt and braces, because a signal delivered one instruction before this
    // line is still possible.
    settleGuard.release();

    await settleCaptureRewriteRun(app.db, {
      id: result.runId,
      verdict: result.stoppedBecause === "signalled"
        ? "failed"
        : result.refusals.length === 0 ? "ok" : "refused",
      summary: backfillSummary(result),
    });
  } catch (error) {
    await settleCaptureRewriteRun(app.db, {
      id: result.runId,
      verdict: "failed",
      summary: {
        ...backfillSummary(result),
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => {});
    throw error;
  } finally {
    settleGuard.release();
  }

  return result;
}

function backfillSummary(result: CaptureBackfillResult): Record<string, unknown> {
  return {
    relation: result.relation,
    batches: result.batches,
    scanned: result.scanned,
    referenced: result.referenced,
    deduped: result.deduped,
    codecRefused: result.codecRefused,
    codecRefusedIds: result.codecRefusedIds,
    raced: result.raced,
    monthsCreated: result.monthsCreated,
    lastId: result.lastId,
    stoppedBecause: result.stoppedBecause,
    typedColumnsScanned: result.typedColumnsScanned,
    typedColumnsFilled: result.typedColumnsFilled,
    copyMeasurement: result.copyMeasurement,
    forecast: result.forecast,
    headroom: result.headroom,
    refusals: result.refusals,
  };
}

/** `pg_total_relation_size` / `pg_indexes_size` for one relation in `public`,
 *  or null when it is not there. The reclaim has the same reader; this one is
 *  the backfill's, because the two files are deliberately separable (additive
 *  vs destructive) and a shared private helper would tie them together for four
 *  lines of SQL. */
async function relationSizeBytes(
  app: Ctx,
  relation: string,
): Promise<{ total: number; indexes: number } | null> {
  const rows = await app.db.execute<{ total: string; indexes: string }>(sql`
    select pg_total_relation_size(c.oid)::text as total,
           pg_indexes_size(c.oid)::text as indexes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = ${relation}
  `);
  const row = rows.rows[0];
  return row === undefined ? null : { total: Number(row.total), indexes: Number(row.indexes) };
}

/** The mid-run half of the headroom law. Records the refusal and the stop
 *  reason on the result; the caller breaks out of its loop on `false`. */
async function stillHasHeadroom(
  app: Ctx,
  readFreeBytes: () => Promise<number>,
  result: CaptureBackfillResult,
  freeSpace: FreeSpaceTracker,
): Promise<boolean> {
  const freeBytes = await readFreeBytes();
  freeSpace.lastFreeBytes = freeBytes;
  const verdict = captureBackfillMidRunVerdict(freeBytes);
  if (verdict.ok) {
    return true;
  }
  result.stoppedBecause = "headroom_exhausted";
  result.refusals.push(`§9.1 headroom: ${verdict.reason}`);
  app.logger.warn(
    { scope: result.scopeRef, reason: verdict.reason, lastId: result.lastId },
    "capture:backfill stopped mid-walk: the volume reached the floor",
  );
  return false;
}

/**
 * THE SECOND SCAN: rows that already carry a reference and are missing a typed
 * column the derivation would fill (decision #223).
 *
 * It runs only after the reference walk has reported `scope_complete`, and for
 * the same reason the reference walk is paced: this is the same UPDATE cost on
 * the same tables, and doing both at once would double the WAL rate an operator
 * carefully chose a `--batch` and a `--pause-ms` for. It is resumable with no
 * cursor by exactly the property the first walk has — a filled row stops
 * matching the predicate — so an interrupted run is simply a shorter one.
 */
async function runTypedColumnCatchUp(
  app: Ctx,
  options: CaptureBackfillOptions,
  batch: number,
  readFreeBytes: () => Promise<number>,
  result: CaptureBackfillResult,
  freeSpace: FreeSpaceTracker,
): Promise<void> {
  let afterId = 0;
  for (;;) {
    if (options.maxBatches > 0 && result.batches >= options.maxBatches) {
      result.stoppedBecause = "batch_limit";
      return;
    }
    if (
      headroomRecheckDue({
        batchesDone: result.batches,
        lastFreeBytes: freeSpace.lastFreeBytes,
        cadenceBatches: CAPTURE_BACKFILL_HEADROOM_RECHECK_BATCHES,
      })
      && !(await stillHasHeadroom(app, readFreeBytes, result, freeSpace))
    ) {
      return;
    }

    const candidates = await listCaptureTypedColumnCandidates(app.db, {
      scope: options.scope,
      afterId,
      limit: batch,
    });
    if (candidates.length === 0) {
      return;
    }

    result.batches += 1;
    for (const candidate of candidates) {
      afterId = candidate.id;
      result.typedColumnsScanned += 1;
      if (await applyCaptureTypedColumnCatchUp(app.db, { scope: options.scope, candidate })) {
        result.typedColumnsFilled += 1;
      }
    }

    app.logger.info(
      {
        scope: result.scopeRef,
        typedColumnsScanned: result.typedColumnsScanned,
        typedColumnsFilled: result.typedColumnsFilled,
        lastId: afterId,
      },
      "capture:backfill typed-column catch-up batch",
    );
    if (options.pauseMs > 0) {
      await sleep(options.pauseMs);
    }
  }
}

/**
 * One row: canonicalize, store, stamp.
 *
 * THE CODEC REFUSAL IS A NORMAL OUTCOME, NOT AN ERROR. A body the frozen codec
 * cannot encode (a lone surrogate, a NUL escape, a value that is not plain
 * JSON) keeps its inline copy forever, and that is a legal permanent state:
 * 0128's CHECK asks for at least one body, not for a catalog one. The row is
 * counted, its id is logged, and the walk moves on. The alternative — refusing
 * the whole scope over one unencodable row — would mean a single malformed
 * capture from months ago could hold the entire compaction hostage.
 *
 * THE OBJECT IS WRITTEN BEFORE THE REFERENCE, in that order and not the other
 * way round, for the reason #215 fixed for the live path: the worst case must be
 * an orphaned OBJECT (harmless, unreachable, collapsed onto by the next
 * identical body), never a reference to something that is not there.
 */
async function backfillOne(
  app: Ctx,
  scope: CaptureRewriteScope,
  candidate: CaptureBackfillCandidate,
  ensuredMonths: Set<string>,
  result: CaptureBackfillResult,
): Promise<void> {
  const bucketMonth = capturePayloadBucketMonth(candidate.captureInstant);
  if (!ensuredMonths.has(bucketMonth)) {
    const created = await ensureCapturePayloadCatalogPartitions(app.db, bucketMonth);
    ensuredMonths.add(bucketMonth);
    if (created.length > 0) {
      result.monthsCreated.push(bucketMonth);
    }
  }

  let stored;
  try {
    // Canonicalized here first so a refusal is caught as a refusal rather than
    // as "the catalog write failed" — the two have different meanings and only
    // one of them is normal.
    canonicalizeCaptureJson(candidate.payload);
    stored = await putPayloadObject(app.db, {
      representation: "canonical_json",
      json: candidate.payload,
      // THE ROW'S OWN INSTANT, never now(): a historical body belongs to the
      // month it was captured in, which is what makes a closed month a
      // self-contained cohort (0123's month-scope law).
      captureInstant: candidate.captureInstant,
      // Every envelope this slice rewrites is ordinary, fan-bearing platform
      // capture — the same lane the live dual write assigns, so a historical
      // body and its live twin land in ONE object instead of two. The lane is
      // NOT derived from `source`/`kind`: `system` would put the body outside
      // the reach of the erasure's catalog scan (#219 never gives that domain
      // to a subject sweep), and narrowing erasure reach on a one-way pass over
      // history is not a trade this slice is allowed to make.
      lane: "platform_capture",
      platformAccountId: candidate.platformAccountId,
    });
  } catch (error) {
    if (error instanceof CapturePayloadCodecError) {
      result.codecRefused += 1;
      if (result.codecRefusedIds.length < CAPTURE_BACKFILL_REFUSED_ID_SAMPLE) {
        result.codecRefusedIds.push(candidate.id);
      }
      app.logger.warn(
        { scope: captureRewriteScopeRef(scope), id: candidate.id, reason: error.message },
        "capture:backfill codec refused a historical body; it keeps its inline copy",
      );
      return;
    }
    throw error;
  }

  const applied = await applyCaptureBackfillRef(app.db, {
    scope,
    id: candidate.id,
    bucketMonth: stored.bucketMonth,
    objectId: stored.objectId,
    candidate,
  });
  if (!applied) {
    result.raced += 1;
    return;
  }
  result.referenced += 1;
  if (!stored.created) {
    result.deduped += 1;
  }
}

// ---------------------------------------------------------------------------
// B — verify

export interface CaptureVerifyOptions {
  scope: CaptureRewriteScope;
  sample: number;
}

export interface CaptureVerifyResult {
  runId: number;
  scopeRef: string;
  relation: string;
  verdict: "ok" | "refused";
  census: CaptureRewriteScopeCensus;
  /** References pointing at a catalog row that is not there. ANY is fatal. */
  danglingRefs: number;
  /** Null-ref rows proved to be codec refusals by re-canonicalizing them. */
  provedCodecRefused: number;
  /** Null-ref rows that canonicalize fine — i.e. the backfill has not reached
   *  them. ANY is fatal. */
  unexplainedUnreferenced: number;
  /** Bounded sample of unexplained ids, so the owner can look at one. */
  unexplainedIds: number[];
  /** What the backfill run itself recorded, for cross-reading. Null when no
   *  settled backfill run exists for this scope. */
  backfillReportedRefused: number | null;
  sample: CaptureRewriteSampleReport;
  refusals: string[];
}

/**
 * Bless a scope, or say precisely why it cannot be blessed.
 *
 * NO `--dry-run`, and the omission is deliberate rather than an oversight. This
 * command reads capture data and writes NOTHING to it; the single row it does
 * write is its own verdict, which IS its product. A "dry" verify would perform
 * every read and then throw the answer away, and the reclaim it gates would
 * still have nothing to read — so the flag could only ever be a way to
 * accidentally run the useless half.
 *
 * THREE PROOFS, and any one of them can refuse:
 *
 *   1. EVERY ROW HAS A REFERENCE — except rows whose body the codec refuses,
 *      and those are not taken on trust from an earlier run's count. Each
 *      remaining null-ref row is re-canonicalized here and must actually
 *      refuse. The backfill's own recorded count is printed beside the proved
 *      number as a cross-check, never as the authority.
 *   2. EVERY REFERENCE RESOLVES — an anti-join against the catalog's primary
 *      key over the whole scope. This is the check the deliberately-absent
 *      foreign key (#215) does not make, and it has to be a total, not a
 *      sample: one dangling reference plus a reclaimed body is one captured
 *      fact gone.
 *   3. THE BODIES AGREE — full canonical octets, on a bounded random sample.
 *      A sample and not a total, because comparing every body in a monthly
 *      partition means detoasting the entire partition, and the failure this
 *      catches (a systematic divergence) shows up in the first handful.
 */
export async function runCaptureVerifyBackfill(
  app: Ctx,
  options: CaptureVerifyOptions,
): Promise<CaptureVerifyResult> {
  const scopeRef = captureRewriteScopeRef(options.scope);
  const relation = captureRewriteRelation(options.scope);
  const runId = await openCaptureRewriteRun(app.db, {
    operation: "verify",
    scope: options.scope,
    dryRun: false,
    summary: { relation, sample: options.sample },
  });

  const census = await censusCaptureRewriteScope(app.db, options.scope);
  const refusals: string[] = [];

  const backfillRun = await latestSettledCaptureRewriteRun(app.db, {
    operation: "backfill",
    scope: options.scope,
  });
  const backfillReportedRefused = backfillRun === null
    ? null
    : Number(backfillRun.summary.codecRefused ?? 0);

  let provedCodecRefused = 0;
  let unexplainedUnreferenced = 0;
  const unexplainedIds: number[] = [];

  if (census.unreferencedWithBody > CAPTURE_VERIFY_REFUSED_RESCAN_LIMIT) {
    unexplainedUnreferenced = census.unreferencedWithBody;
    refusals.push(
      `${census.unreferencedWithBody} rows still carry a body and no reference `
        + `(over the ${CAPTURE_VERIFY_REFUSED_RESCAN_LIMIT} rescan bound) — run capture:backfill first`,
    );
  } else if (census.unreferencedWithBody > 0) {
    const walked = await proveRemainingAreCodecRefusals(app, options.scope);
    provedCodecRefused = walked.refused;
    unexplainedUnreferenced = walked.encodable;
    unexplainedIds.push(...walked.encodableIds);
    if (walked.encodable > 0) {
      refusals.push(
        `${walked.encodable} rows have an ENCODABLE body and no reference — the backfill has `
          + `not finished this scope (first ids: ${walked.encodableIds.join(", ")})`,
      );
    }
  }

  const danglingRefs = await countCaptureRewriteDanglingRefs(app.db, options.scope);
  if (danglingRefs > 0) {
    refusals.push(
      `${danglingRefs} references point at a catalog object that does not exist — `
        + "reclaiming this scope would make those captured facts unreachable",
    );
  }

  const sample = await sampleCaptureRewriteParity(app.db, {
    scope: options.scope,
    sample: options.sample,
    census,
  });
  if (sample.mismatched > 0) {
    refusals.push(
      `${sample.mismatched} of ${sample.compared} sampled bodies do not match their catalog copy `
        + `(first reason: ${sample.mismatches[0]?.reason ?? "unknown"})`,
    );
  }

  const verdict = refusals.length === 0 ? "ok" : "refused";
  const result: CaptureVerifyResult = {
    runId,
    scopeRef,
    relation,
    verdict,
    census,
    danglingRefs,
    provedCodecRefused,
    unexplainedUnreferenced,
    unexplainedIds,
    backfillReportedRefused,
    sample,
    refusals,
  };

  await settleCaptureRewriteRun(app.db, {
    id: runId,
    verdict,
    summary: {
      relation,
      census,
      danglingRefs,
      provedCodecRefused,
      unexplainedUnreferenced,
      unexplainedIds,
      backfillReportedRefused,
      sampleCompared: sample.compared,
      sampleMatched: sample.matched,
      sampleMismatched: sample.mismatched,
      sampleMismatches: sample.mismatches,
      refusals,
    },
  });

  return result;
}

// ---------------------------------------------------------------------------
// The typed-column completeness proof (decision #223)

/**
 * Above this many typed-column gaps the reclaim stops trying to prove anything
 * and just says "run the backfill". Same bound, same reasoning as
 * CAPTURE_VERIFY_REFUSED_RESCAN_LIMIT: the honest per-row check is affordable
 * when the remainder is what it should be (zero, or a handful of pathological
 * bodies) and pointless when the remainder is a catch-up that was never run.
 */
export const CAPTURE_TYPED_COLUMN_RESCAN_LIMIT = 10_000;

export interface TypedColumnGapProof {
  /** The census count — rows matching the SQL derivability mirror. */
  counted: number;
  /** Rows this proof actually walked and re-derived. */
  walked: number;
  /** Of those, the ones the TypeScript derivation really does fill. ANY is
   *  fatal to a phase that removes bodies. */
  derivable: number;
  /** Bounded sample, so the owner can look at one. */
  derivableIds: number[];
  /** True when `counted` was over the rescan bound and nothing was walked. */
  overRescanBound: boolean;
}

/**
 * PROVE, don't infer — the same rule verify applies to codec refusals.
 *
 * The census predicate is a MIRROR of the derivation written in SQL, and a
 * mirror can be wrong in one direction: `jsonb_typeof` says `number` for a
 * literal like `1e999`, which `JSON.parse` hands back as `Infinity` and
 * `jsonMemberText` therefore renders as NULL. Such a row would match the census
 * filter forever and the catch-up would fill nothing — a permanent refusal
 * built out of a value nobody can do anything about.
 *
 * So the count is the CHEAP SCREEN and this walk is the VERDICT: each counted
 * row is re-derived in the same TypeScript the capture path runs, and only a row
 * that really does produce a value it is missing can refuse a reclaim.
 */
export async function proveCaptureTypedColumnGaps(
  app: Ctx,
  scope: CaptureRewriteScope,
  counted: number,
): Promise<TypedColumnGapProof> {
  const proof: TypedColumnGapProof = {
    counted,
    walked: 0,
    derivable: 0,
    derivableIds: [],
    overRescanBound: false,
  };
  if (counted === 0) {
    return proof;
  }
  if (counted > CAPTURE_TYPED_COLUMN_RESCAN_LIMIT) {
    proof.overRescanBound = true;
    proof.derivable = counted;
    return proof;
  }

  let afterId = 0;
  for (;;) {
    const candidates = await listCaptureTypedColumnCandidates(app.db, {
      scope,
      afterId,
      limit: 500,
    });
    if (candidates.length === 0) {
      return proof;
    }
    for (const candidate of candidates) {
      afterId = candidate.id;
      proof.walked += 1;
      if (!derivationFillsSomething(scope, candidate)) {
        continue;
      }
      proof.derivable += 1;
      if (proof.derivableIds.length < UNEXPLAINED_ID_SAMPLE) {
        proof.derivableIds.push(candidate.id);
      }
    }
  }
}

/** Whether the slice-3a derivation returns anything at all for this candidate.
 *  The candidate only reaches here because SQL believes one of its typed
 *  columns is null and fillable, so "the derivation produces a value" is the
 *  whole question. */
function derivationFillsSomething(
  scope: CaptureRewriteScope,
  candidate: CaptureBackfillCandidate,
): boolean {
  if (scope.table === "sync_raw_payloads") {
    return deriveRawPayloadTipsSlice({
      endpoint: candidate.derivationA,
      payloadKind: candidate.derivationB,
      responsePayload: candidate.payload,
    }) !== undefined;
  }
  const fields = deriveObservationQueryableFields({
    producer: candidate.derivationA,
    kind: candidate.derivationB,
    payload: candidate.payload,
  });
  return Object.values(fields).some((value) => value !== null);
}

const UNEXPLAINED_ID_SAMPLE = 10;

/**
 * Walk every remaining null-ref row and decide, per row, whether the codec
 * really refuses it.
 *
 * This is the whole reason `verify` is not a formality. The alternative — "the
 * backfill said it refused N, and N rows are left, so they must be the same N"
 * — is an inference over two numbers produced hours apart by different
 * processes, and it would pass just as happily if the backfill had crashed
 * mid-scope and left N unreached rows behind.
 *
 * Bounded by the caller (CAPTURE_VERIFY_REFUSED_RESCAN_LIMIT); it never sees a
 * scope where this walk would be large.
 */
async function proveRemainingAreCodecRefusals(
  app: Ctx,
  scope: CaptureRewriteScope,
): Promise<{ refused: number; encodable: number; encodableIds: number[] }> {
  let afterId = 0;
  let refused = 0;
  let encodable = 0;
  const encodableIds: number[] = [];

  for (;;) {
    const candidates = await listCaptureBackfillCandidates(app.db, {
      scope,
      afterId,
      limit: 500,
    });
    if (candidates.length === 0) {
      break;
    }
    for (const candidate of candidates) {
      afterId = candidate.id;
      try {
        canonicalizeCaptureJson(candidate.payload);
        encodable += 1;
        if (encodableIds.length < UNEXPLAINED_ID_SAMPLE) {
          encodableIds.push(candidate.id);
        }
      } catch (error) {
        if (!(error instanceof CapturePayloadCodecError)) {
          throw error;
        }
        refused += 1;
      }
    }
  }

  return { refused, encodable, encodableIds };
}
