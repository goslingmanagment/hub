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

import {
  applyCaptureBackfillRef,
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
  ensureCapturePayloadCatalogPartitions,
  latestSettledCaptureRewriteRun,
  listCaptureBackfillCandidates,
  openCaptureRewriteRun,
  putPayloadObject,
  sampleCaptureRewriteParity,
  settleCaptureRewriteRun,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

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

export interface CaptureBackfillOptions {
  scope: CaptureRewriteScope;
  dryRun: boolean;
  batch: number;
  pauseMs: number;
  /** Maximum batches this invocation may run; 0 = until the scope is done. */
  maxBatches: number;
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
  stoppedBecause: "scope_complete" | "batch_limit";
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
  };

  if (options.dryRun) {
    // A dry run reports EXACTLY what the real one would touch and writes
    // nothing at all — not even a journal row. A tombstone for an act that did
    // not happen is the kind of evidence that later gets misread as one that
    // did (which is why latestSettledCaptureRewriteRun filters dry runs out).
    app.logger.info(
      { scope: scopeRef, relation, wouldStamp: census.unreferencedWithBody },
      "capture:backfill dry run",
    );
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

  try {
    for (;;) {
      if (options.maxBatches > 0 && result.batches >= options.maxBatches) {
        result.stoppedBecause = "batch_limit";
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

    await settleCaptureRewriteRun(app.db, {
      id: result.runId,
      verdict: "ok",
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
  };
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
