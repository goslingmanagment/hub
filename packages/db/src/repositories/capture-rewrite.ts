// G5 slice 3c-2 — the HISTORICAL rewrite: the database half.
//
// WHAT THIS SLICE IS FOR. Slices 0–3c-1 built the content-addressed catalog,
// moved every reader onto it, gave the field-level queries typed columns,
// taught the erasure to reach the catalog, and finally stopped writing the
// inline body for NEW captures on a canary page. All of that only bends the
// growth curve forward: the ~35 GB of bodies already on disk are untouched, and
// every row of it still carries its body inline and no reference at all. This
// module is the machinery that walks that heap, puts each historical body in
// the catalog where the new ones live, and hands the reclaim step a scope it can
// prove is safe to compact.
//
// THE ONE LAWFUL UPDATE IN THIS PROJECT, and why it is lawful HERE.
// Every earlier slice refused to stamp a reference with an UPDATE, twice in
// writing: #215 rejected a post-commit UPDATE of the reference columns and #218
// rejected an UPDATE backfill of the typed columns, both for the same reason —
// an UPDATE mints a second heap tuple plus its WAL, per row, on the two largest
// tables in the system, and paying for a fresh row version per capture in order
// to record a DEDUPLICATION is self-defeating.
//
// That argument is about the STEADY STATE, and it does not apply to a one-time
// pass whose entire purpose is to be followed by a physical rewrite. Here the
// bloat this UPDATE creates is not a cost that accumulates — it is consumed:
// `capture:reclaim` copies the surviving tuples into a skinny relation and
// parks the old one, so the dead versions this pass leaves behind are exactly
// the pages that get dropped. Doing it any other way would mean rewriting the
// row twice (once to stamp, once to compact) or inventing a side table to hold
// the stamps until the compaction reads them, which is a second copy of the
// reference for no benefit.
//
// TWO CONSEQUENCES ARE ACCEPTED ON PURPOSE:
//   1. Between the backfill and the reclaim, the scope is BIGGER on disk than
//      it was. That is why §9.1's headroom precondition is a law and not a
//      warning, and why the reclaim refuses to start without it.
//   2. Backfilling a month the reclaim never gets to leaves that month with
//      permanent bloat until an ordinary vacuum reuses the pages. The runbook
//      therefore treats backfill → verify → reclaim as ONE ritual per month,
//      not three independent chores.
//
// THE CAPTURE INSTANT IS THE ROW'S OWN, NEVER `now()`. A historical body is
// stored under the month of `observations.received_at` / the month of
// `sync_raw_payloads.captured_at`, so it lands in the cohort it actually
// belongs to. Anything else would pile all of history into the current month
// and destroy the property migration 0123 calls a law — a closed capture month
// is a ref-closed, self-contained cohort. It also means a raw envelope and its
// paired observation, whose two timestamps straddle a UTC month boundary by
// milliseconds, get two objects instead of one; that is a handful of rows
// across the corpus and the honest price of using each row's own truth.
//
// NOTHING HERE DELETES ANYTHING. Not one statement in this file is a delete;
// the physical destruction is `capture:drop-parked` alone, in the runtime
// service, and it is pinned in tests/retention-deleters.test.ts.

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  CapturePayloadCodecError,
  canonicalizeCaptureJson,
} from "../capture-payload-codec.ts";
import {
  deriveObservationQueryableFields,
  deriveRawPayloadTipsSlice,
} from "../capture-queryable-fields.ts";
import type { Database } from "../client.ts";
import { loadPayloadBody } from "./capture-payloads.ts";

/**
 * The two envelope tables this slice rewrites. Not an open string: every
 * statement below interpolates a relation name, and the set of names it may
 * ever interpolate is this one plus a partition suffix that
 * `captureRewriteRelation` builds itself.
 */
export const CAPTURE_REWRITE_TABLES = ["observations", "sync_raw_payloads"] as const;
export type CaptureRewriteTable = (typeof CAPTURE_REWRITE_TABLES)[number];

/**
 * A scope is one relation: a monthly `observations` partition, or the whole of
 * the (unpartitioned) `sync_raw_payloads`.
 *
 * `month` is `YYYY-MM` and is REQUIRED for observations and FORBIDDEN for
 * sync_raw_payloads — the same shape migration 0129's CHECK enforces on the run
 * journal, for the same reason: a month-scoped verdict cannot bless a
 * whole-table act.
 */
export interface CaptureRewriteScope {
  table: CaptureRewriteTable;
  month: string | null;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The relation a scope names, and the ONLY place a relation name is built.
 *
 * Every caller interpolates the result into SQL, so this function is the injection
 * boundary: the month is re-validated here even though the CLI already parsed it,
 * because "the caller checked" is not a property the compiler enforces.
 */
export function captureRewriteRelation(scope: CaptureRewriteScope): string {
  if (scope.table === "sync_raw_payloads") {
    if (scope.month !== null) {
      throw new Error("sync_raw_payloads is not partitioned and takes no month scope");
    }
    return "sync_raw_payloads";
  }
  if (scope.month === null || !MONTH_PATTERN.test(scope.month)) {
    throw new Error(`observations scope needs a YYYY-MM month (got: ${scope.month ?? "nothing"})`);
  }
  return `observations_${scope.month.replace("-", "_")}`;
}

/** The `YYYY-MM-01` date the run journal stores for a scope, or null. */
export function captureRewriteScopeMonthDate(scope: CaptureRewriteScope): string | null {
  return scope.month === null ? null : `${scope.month}-01`;
}

/** Human scope ref, and the string `--confirm` is compared against for a swap. */
export function captureRewriteScopeRef(scope: CaptureRewriteScope): string {
  return scope.month === null ? scope.table : `${scope.table}:${scope.month}`;
}

// ---------------------------------------------------------------------------
// The backfill scan

/** One historical row that carries a body and no reference. */
export interface CaptureBackfillCandidate {
  /** Primary-key id. For observations the PK is composite; `receivedAt` is the
   *  other half and both are needed to address the row. */
  id: number;
  /** `observations.received_at` / `sync_raw_payloads.captured_at` — the row's
   *  OWN capture instant, which fixes the object's month cohort. */
  captureInstant: Date;
  /** `observations.account_id` / `sync_raw_payloads.page_id` — the same id
   *  space (`platform_accounts.id`) the live dual write scopes objects by. Null
   *  is legal and STAYS null: the catalog's identity is NULLS NOT DISTINCT
   *  precisely so unmapped capture dedups like everything else. */
  platformAccountId: number | null;
  /** The inline body, exactly as stored. */
  payload: unknown;
  /** Slice-3a derivation inputs. Observations: producer + kind. Raw payloads:
   *  endpoint + payload_kind. */
  derivationA: string;
  derivationB: string;
}

type RawCandidateRow = {
  id: string;
  capture_instant: Date | string;
  platform_account_id: string | null;
  payload: unknown;
  derivation_a: string;
  derivation_b: string;
};

/**
 * One bounded, keyset-ordered page of rows that still need a reference.
 *
 * THE PREDICATE IS THE RESUME POINT. `payload_object_id is null and payload is
 * not null` excludes, by construction: rows an earlier run already stamped,
 * rows written by the live dual write, and pointer-only rows (3c-1) that have
 * no inline body to canonicalize. So a re-run after a crash simply finds fewer
 * rows, and there is no cursor to persist and no "already done" case to handle.
 *
 * The walk rides the primary-key index (`id` leading on both tables) and
 * filters per tuple. There is deliberately NO index on the predicate: it would
 * have to be built CONCURRENTLY across every partition of the largest table in
 * the system, to serve a walk that runs ONCE and then never again — and it
 * would then have to be justified forever after. The same rule 0124 applied to
 * the reference columns, applied to their inverse.
 */
export async function listCaptureBackfillCandidates(
  db: Database,
  input: { scope: CaptureRewriteScope; afterId: number; limit: number },
): Promise<CaptureBackfillCandidate[]> {
  const relation = captureRewriteRelation(input.scope);
  const query = input.scope.table === "observations"
    ? sql`
      select e.id::text as id,
             e.received_at as capture_instant,
             e.account_id::text as platform_account_id,
             e.payload as payload,
             e.producer as derivation_a,
             e.kind as derivation_b
      from ${sql.raw(`"${relation}"`)} e
      where e.id > ${input.afterId}
        and e.payload_object_id is null
        and e.payload is not null
      order by e.id asc
      limit ${input.limit}
    `
    : sql`
      select e.id::text as id,
             e.captured_at as capture_instant,
             e.page_id::text as platform_account_id,
             e.response_payload as payload,
             e.endpoint as derivation_a,
             e.payload_kind as derivation_b
      from ${sql.raw(`"${relation}"`)} e
      where e.id > ${input.afterId}
        and e.payload_object_id is null
        and e.response_payload is not null
      order by e.id asc
      limit ${input.limit}
    `;

  const rows = await db.execute<RawCandidateRow>(query);
  return rows.rows.map((row) => ({
    id: Number(row.id),
    captureInstant: new Date(row.capture_instant),
    platformAccountId: row.platform_account_id === null ? null : Number(row.platform_account_id),
    payload: row.payload,
    derivationA: row.derivation_a,
    derivationB: row.derivation_b,
  }));
}

/**
 * Stamp ONE historical row with the reference to its catalog object, and fill
 * the slice-3a typed columns while the tuple is being rewritten anyway.
 *
 * THIS IS THE UPDATE the module header licenses, and everything about its shape
 * is defensive:
 *
 *   * `payload_object_id is null` in the WHERE makes it idempotent and
 *     concurrency-safe without a lock: a row another runner (or the live dual
 *     write, on a page in the canary) already stamped is not matched, so a
 *     reference can never be overwritten with a different object.
 *   * The typed columns use `coalesce(column, $new)`, never a bare assignment —
 *     a value written at capture time by slice 3a is the value derived from the
 *     same object in the same statement as the body, and this pass has no
 *     standing to disagree with it.
 *   * The inline `payload` column is NOT TOUCHED. This pass adds an address; it
 *     never removes a body. Removing the body is the reclaim's job and it does
 *     it by copying the row without it, which is a different act with a
 *     different gate.
 *
 * Returns whether the row was still eligible when the statement ran.
 */
export async function applyCaptureBackfillRef(
  db: Database,
  input: {
    scope: CaptureRewriteScope;
    id: number;
    bucketMonth: string;
    objectId: number;
    /** The candidate this reference was derived from — the typed columns come
     *  from the same object whose bytes went into the catalog. */
    candidate: CaptureBackfillCandidate;
  },
): Promise<boolean> {
  const relation = captureRewriteRelation(input.scope);

  if (input.scope.table === "observations") {
    const queryable = deriveObservationQueryableFields({
      producer: input.candidate.derivationA,
      kind: input.candidate.derivationB,
      payload: input.candidate.payload,
    });
    const result = await db.execute<{ id: string }>(sql`
      update ${sql.raw(`"${relation}"`)} e
      set payload_bucket_month = ${input.bucketMonth}::date,
          payload_object_id = ${input.objectId},
          harvest_machine_id = coalesce(e.harvest_machine_id, ${queryable.harvestMachineId}),
          harvest_tx_id = coalesce(e.harvest_tx_id, ${queryable.harvestTxId}),
          harvest_tx_amount = coalesce(e.harvest_tx_amount, ${queryable.harvestTxAmount}),
          harvest_tx_created_at = coalesce(e.harvest_tx_created_at, ${queryable.harvestTxCreatedAt})
      where e.id = ${input.id}
        and e.payload_object_id is null
      returning e.id::text as id
    `);
    return result.rows.length > 0;
  }

  const tips = deriveRawPayloadTipsSlice({
    endpoint: input.candidate.derivationA,
    payloadKind: input.candidate.derivationB,
    responsePayload: input.candidate.payload,
  });
  const result = await db.execute<{ id: string }>(sql`
    update ${sql.raw(`"${relation}"`)} e
    set payload_bucket_month = ${input.bucketMonth}::date,
        payload_object_id = ${input.objectId},
        response_tips = coalesce(
          e.response_tips,
          ${tips === undefined ? null : JSON.stringify(tips)}::jsonb
        )
    where e.id = ${input.id}
      and e.payload_object_id is null
    returning e.id::text as id
  `);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Scope census — the totals half of the verification

export interface CaptureRewriteScopeCensus {
  relation: string;
  /** Every row in the scope. */
  rows: number;
  /** Rows carrying a catalog reference. */
  referenced: number;
  /** Rows with a body and NO reference — the backfill's remaining work, and the
   *  one number that can refuse a scope. */
  unreferencedWithBody: number;
  /** Rows already pointer-only (3c-1): reference set, inline body already NULL.
   *  They are finished, not pending. */
  pointerOnly: number;
  /** Lowest and highest primary-key id present, for the sampler's probes. */
  minId: number | null;
  maxId: number | null;
}

export async function censusCaptureRewriteScope(
  db: Database,
  scope: CaptureRewriteScope,
): Promise<CaptureRewriteScopeCensus> {
  const relation = captureRewriteRelation(scope);
  const body = scope.table === "observations"
    ? sql.raw("e.payload")
    : sql.raw("e.response_payload");

  const rows = await db.execute<{
    rows: string;
    referenced: string;
    unreferenced_with_body: string;
    pointer_only: string;
    min_id: string | null;
    max_id: string | null;
  }>(sql`
    select count(*)::text as rows,
           count(*) filter (where e.payload_object_id is not null)::text as referenced,
           count(*) filter (
             where e.payload_object_id is null and ${body} is not null
           )::text as unreferenced_with_body,
           count(*) filter (
             where e.payload_object_id is not null and ${body} is null
           )::text as pointer_only,
           min(e.id)::text as min_id,
           max(e.id)::text as max_id
    from ${sql.raw(`"${relation}"`)} e
  `);
  const row = rows.rows[0];
  return {
    relation,
    rows: Number(row?.rows ?? 0),
    referenced: Number(row?.referenced ?? 0),
    unreferencedWithBody: Number(row?.unreferenced_with_body ?? 0),
    pointerOnly: Number(row?.pointer_only ?? 0),
    minId: row?.min_id == null ? null : Number(row.min_id),
    maxId: row?.max_id == null ? null : Number(row.max_id),
  };
}

/**
 * How many references in the scope point at a catalog row that is not there.
 *
 * This is the check the deliberately-absent foreign key (#215) does not make.
 * It is an anti-join over one relation's references against the catalog's
 * primary key, so every probe is an index lookup; on a scope the size of one
 * monthly partition that is a bounded, if not free, cost — and it is the whole
 * point of the verification step. ANY nonzero result refuses the scope: a
 * dangling reference plus a removed inline body is an unreachable captured
 * fact, and the reclaim is the act that would make it unreachable.
 */
export async function countCaptureRewriteDanglingRefs(
  db: Database,
  scope: CaptureRewriteScope,
): Promise<number> {
  const relation = captureRewriteRelation(scope);
  const rows = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from ${sql.raw(`"${relation}"`)} e
    left join capture_payload_objects c
      on c.bucket_month = e.payload_bucket_month and c.object_id = e.payload_object_id
    where e.payload_object_id is not null and c.object_id is null
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Scope census — the sample half

export type CaptureRewriteSampleReason =
  | "object_missing"
  | "body_missing"
  | "representation_mismatch"
  | "inline_uncanonicalizable"
  | "content_mismatch";

export interface CaptureRewriteSampleMismatch {
  id: number;
  bucketMonth: string;
  objectId: number;
  reason: CaptureRewriteSampleReason;
  inlineDigest: string | null;
  storedDigest: string | null;
}

export interface CaptureRewriteSampleReport {
  /** Distinct rows actually compared. Lower than the requested sample when the
   *  scope holds fewer eligible rows, or when two random probes landed on the
   *  same row. */
  compared: number;
  matched: number;
  mismatched: number;
  /** Bounded — an anomaly report stays readable even if everything disagrees. */
  mismatches: CaptureRewriteSampleMismatch[];
}

export const CAPTURE_REWRITE_SAMPLE_MISMATCH_LIMIT = 5;

/**
 * Compare the inline body against the catalog copy for a BOUNDED RANDOM SAMPLE
 * of the scope's dual-carrying rows.
 *
 * HOW THE SAMPLE IS DRAWN, and its honest bias. `order by random()` over a
 * monthly partition of the largest table in the system is a full scan plus a
 * sort — the one thing a verification step on a disk-starved box must not do.
 * Instead each draw picks a random id inside the scope's [min, max] range and
 * takes the FIRST eligible row at or after it, which is one index probe. Rows
 * that follow a long gap of ineligible ids are therefore slightly
 * over-represented. That bias is real and it is stated rather than hidden; it
 * is also harmless for what this sample is for, which is catching a SYSTEMATIC
 * divergence (a codec change, a wrong month, a crossed scope), not estimating a
 * rate.
 *
 * Equality is decided by comparing the FULL canonical octets, never the
 * digests — jsonb preserves neither key order nor insignificant whitespace, so
 * only the frozen codec can say two stored bodies are the same content. The
 * digests travel in the report as a fingerprint only, the #215 rule.
 *
 * It reads bodies, so it lives in packages/db beside the parity verifier and
 * for the same reason: `loadPayloadBody` is deliberately off the barrel, and
 * what crosses the package boundary here is a REPORT, never a body.
 */
export async function sampleCaptureRewriteParity(
  db: Database,
  input: { scope: CaptureRewriteScope; sample: number; census: CaptureRewriteScopeCensus },
): Promise<CaptureRewriteSampleReport> {
  const empty: CaptureRewriteSampleReport = {
    compared: 0,
    matched: 0,
    mismatched: 0,
    mismatches: [],
  };
  if (input.sample <= 0 || input.census.minId === null || input.census.maxId === null) {
    return empty;
  }

  const relation = captureRewriteRelation(input.scope);
  const body = input.scope.table === "observations"
    ? sql.raw("c.payload")
    : sql.raw("c.response_payload");

  const rows = await db.execute<{
    id: string;
    bucket_month: string;
    object_id: string;
    inline: unknown;
  }>(sql`
    with point as (
      -- One random probe point PER draw. random() sits in the target list of a
      -- plain SELECT over generate_series, where volatility is evaluated per
      -- output row — the one placement PostgreSQL cannot collapse. The first
      -- version of this query put the whole expression inside an UNCORRELATED
      -- lateral; the planner is allowed to satisfy the rescans of such a
      -- lateral from a Materialize node, and a Materialize rescan does NOT
      -- re-execute volatile functions — every "probe" silently reused the ONE
      -- point the first execution drew, and when that single point landed in
      -- the gap above the last eligible id, the whole sample came back empty
      -- (caught by CI as compared=0 at 1-in-6 odds on the seeded fixture).
      select probe.n,
             (floor(random() * (${input.census.maxId}::bigint - ${input.census.minId}::bigint + 1))
               + ${input.census.minId}::bigint)::bigint as pt
      from generate_series(1, ${input.sample}) as probe(n)
    )
    select distinct on (hit.id)
           hit.id::text as id,
           to_char(hit.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
           hit.payload_object_id::text as object_id,
           hit.inline as inline
    from point
    cross join lateral (
      -- Correlated on point.pt, so each draw is its own index probe. The
      -- second arm is the WRAP-AROUND: a point above the last eligible id
      -- falls back to the first eligible row instead of yielding nothing —
      -- over-representing the scope's first row by exactly the dead-zone
      -- fraction, which is the same honest, stated bias as the gap-skipping
      -- above (this sample catches systematic divergence, it does not
      -- estimate a rate).
      select * from (
        (select c.id, c.payload_bucket_month, c.payload_object_id, ${body} as inline
         from ${sql.raw(`"${relation}"`)} c
         where c.id >= point.pt
           and c.payload_object_id is not null
           and ${body} is not null
         order by c.id asc
         limit 1)
        union all
        (select c.id, c.payload_bucket_month, c.payload_object_id, ${body} as inline
         from ${sql.raw(`"${relation}"`)} c
         where c.payload_object_id is not null
           and ${body} is not null
         order by c.id asc
         limit 1)
      ) arms
      limit 1
    ) hit
  `);

  const report: CaptureRewriteSampleReport = { ...empty, mismatches: [] };
  for (const row of rows.rows) {
    report.compared += 1;
    const verdict = await compareSampledRow(db, {
      id: Number(row.id),
      bucketMonth: row.bucket_month,
      objectId: Number(row.object_id),
      inline: row.inline,
    });
    if (verdict === null) {
      report.matched += 1;
      continue;
    }
    report.mismatched += 1;
    if (report.mismatches.length < CAPTURE_REWRITE_SAMPLE_MISMATCH_LIMIT) {
      report.mismatches.push(verdict);
    }
  }
  return report;
}

async function compareSampledRow(
  db: Database,
  row: { id: number; bucketMonth: string; objectId: number; inline: unknown },
): Promise<CaptureRewriteSampleMismatch | null> {
  const ref = { bucketMonth: row.bucketMonth, objectId: row.objectId };
  const base = {
    id: row.id,
    bucketMonth: row.bucketMonth,
    objectId: row.objectId,
    inlineDigest: null,
    storedDigest: null,
  };

  const stored = await loadPayloadBody(db, ref);
  if (stored === null) {
    return { ...base, reason: "object_missing" };
  }
  if (stored.representation !== "canonical_json") {
    return { ...base, reason: "representation_mismatch" };
  }

  let inlineBytes: Buffer;
  try {
    inlineBytes = canonicalizeCaptureJson(row.inline);
  } catch (error) {
    if (!(error instanceof CapturePayloadCodecError)) {
      throw error;
    }
    return { ...base, reason: "inline_uncanonicalizable" };
  }

  const storedBytes = canonicalizeCaptureJson(stored.json);
  if (Buffer.compare(storedBytes, inlineBytes) === 0) {
    return null;
  }
  return {
    ...base,
    reason: "content_mismatch",
    inlineDigest: sha256Hex(inlineBytes),
    storedDigest: sha256Hex(storedBytes),
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// The run journal (migration 0129)

export const CAPTURE_REWRITE_OPERATIONS = [
  "backfill",
  "verify",
  "reclaim",
  "drop_parked",
] as const;
export type CaptureRewriteOperation = (typeof CAPTURE_REWRITE_OPERATIONS)[number];

export type CaptureRewriteVerdict = "running" | "ok" | "refused" | "failed";

export interface CaptureRewriteRunRow {
  id: number;
  operation: CaptureRewriteOperation;
  scopeTable: CaptureRewriteTable;
  scopeMonth: string | null;
  phase: string | null;
  dryRun: boolean;
  verdict: CaptureRewriteVerdict;
  summary: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
}

/** Opens a run row BEFORE the work starts, so a process that dies mid-flight
 *  leaves a `running` tombstone rather than no evidence at all. */
export async function openCaptureRewriteRun(
  db: Database,
  input: {
    operation: CaptureRewriteOperation;
    scope: CaptureRewriteScope;
    phase?: string | null;
    dryRun: boolean;
    summary?: Record<string, unknown>;
  },
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into capture_rewrite_runs (operation, scope_table, scope_month, phase, dry_run, summary)
    values (
      ${input.operation},
      ${input.scope.table},
      ${captureRewriteScopeMonthDate(input.scope)}::date,
      ${input.phase ?? null},
      ${input.dryRun},
      ${JSON.stringify(input.summary ?? {})}::jsonb
    )
    returning id::text as id
  `);
  return Number(rows.rows[0]!.id);
}

export async function settleCaptureRewriteRun(
  db: Database,
  input: { id: number; verdict: Exclude<CaptureRewriteVerdict, "running">; summary: Record<string, unknown> },
): Promise<void> {
  await db.execute(sql`
    update capture_rewrite_runs
    set verdict = ${input.verdict},
        summary = ${JSON.stringify(input.summary)}::jsonb,
        completed_at = now()
    where id = ${input.id}
  `);
}

/**
 * The most recent SETTLED run of one operation over one scope.
 *
 * `running` rows are excluded: an unfinished run is not a verdict, and a
 * verify that died halfway must never look like a blessing to the reclaim that
 * reads it. Dry runs are excluded for the same class of reason — a dry run
 * reports what WOULD happen and changes nothing, so it cannot be evidence that
 * anything did.
 */
export async function latestSettledCaptureRewriteRun(
  db: Database,
  input: { operation: CaptureRewriteOperation; scope: CaptureRewriteScope; phase?: string | null },
): Promise<CaptureRewriteRunRow | null> {
  const rows = await db.execute<{
    id: string;
    operation: string;
    scope_table: string;
    scope_month: string | null;
    phase: string | null;
    dry_run: boolean;
    verdict: string;
    summary: Record<string, unknown>;
    started_at: Date | string;
    completed_at: Date | string | null;
  }>(sql`
    select r.id::text as id, r.operation, r.scope_table,
           to_char(r.scope_month, 'YYYY-MM-DD') as scope_month,
           r.phase, r.dry_run, r.verdict, r.summary, r.started_at, r.completed_at
    from capture_rewrite_runs r
    where r.operation = ${input.operation}
      and r.scope_table = ${input.scope.table}
      and r.scope_month is not distinct from ${captureRewriteScopeMonthDate(input.scope)}::date
      and r.dry_run = false
      and r.verdict <> 'running'
      and (${input.phase ?? null}::text is null or r.phase = ${input.phase ?? null})
    order by r.started_at desc, r.id desc
    limit 1
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: Number(row.id),
    operation: row.operation as CaptureRewriteOperation,
    scopeTable: row.scope_table as CaptureRewriteTable,
    scopeMonth: row.scope_month,
    phase: row.phase,
    dryRun: row.dry_run,
    verdict: row.verdict as CaptureRewriteVerdict,
    summary: row.summary ?? {},
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
  };
}
