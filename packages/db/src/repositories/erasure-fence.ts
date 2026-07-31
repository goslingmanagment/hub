// Fast-reply freshness PR4 — the erasure non-resurrection fence (spec v7
// amendment 4, v8 refinements, owner decision 2026-07-10). Retained
// ofapi_webhook_events payloads and REST readthrough observations can
// RECREATE erased dm_message_archive / page_dm_messages rows when a sweep
// replays them after an erasure. Every archive material writer (webhook,
// REST, tombstone) and the page_dm projection writer checks the executed
// erasure tombstones before writing, and serializes that check-then-write
// against a running erasure through a shared advisory lock — a check
// without serialization still races the erasure's own transaction.
//
// Semantics are MATERIAL-TIME-BOUNDED (owner, 2026-07-10): the fence blocks
// only material whose source_received_at / message_created_at is at or
// before the erasure's started_at. Erasure cleans the PAST; a still-active
// erased fan's NEW messages are captured normally (DP-7 preserved).
// PERMANENT fencing (erasure as a de-facto fan block) was considered and
// NOT chosen.
//
// The predicate matches dry_run = false REGARDLESS of completed_at: a
// mid-flight-died run stays fenced fail-closed; pending/failed journal rows
// retry post-completion and then hit the fence terminally.
//
// scope_ref fragility: pages.label is mutable, so a page fence must never
// resolve through the label at check time — executeErasure stores the
// RESOLVED page ids in the plan jsonb (plan.resolvedPageIds) and the check
// matches page/model scopes by page id; fan scopes match by the fan's
// immutable platform ref. This helper lives in the repo layer so the Wave-2
// reducer inherits it unchanged.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/** Dedicated two-int advisory-lock namespace for the fence (M5). Distinct
 * from every other advisory key in the codebase (the staged-config mutex
 * uses the single-bigint form). Key = (namespace, page id). */
export const DM_ARCHIVE_ERASURE_FENCE_LOCK_NS = 815_402;

/**
 * Writer side: transaction-scoped SHARED try-lock on (ns, pageId). Returns
 * false when an erasure holds the exclusive lock — the caller must DEFER
 * (skip the write, leave its journal row/observation retryable) rather than
 * block: the cold-archive writer runs inline in the singleton settle loop
 * and blocking would stall settle+fanout. NO memoization — every write
 * attempt re-checks. MUST be called inside a transaction.
 */
export async function tryAcquireDmArchiveWriterFenceLock(
  db: Database,
  pageId: number,
): Promise<boolean> {
  const result = await db.execute<{ locked: boolean }>(sql`
    select pg_try_advisory_xact_lock_shared(${DM_ARCHIVE_ERASURE_FENCE_LOCK_NS}, ${pageId}) as locked
  `);
  return result.rows[0]?.locked === true;
}

/**
 * Erasure side: EXCLUSIVE transaction-scoped locks over every resolved page
 * id, sorted (stable order prevents deadlocks between two erasures), taken
 * at the top of the delete transaction. Blocks until in-flight writer
 * transactions commit; writers arriving later fail their try-lock and defer.
 */
export async function acquireErasureFenceExclusiveLocks(
  db: Database,
  pageIds: readonly number[],
): Promise<void> {
  const sorted = [...pageIds].sort((a, b) => a - b);
  for (const pageId of sorted) {
    await db.execute(sql`
      select pg_advisory_xact_lock(${DM_ARCHIVE_ERASURE_FENCE_LOCK_NS}, ${pageId})
    `);
  }
}

export interface DmArchiveFenceCheckInput {
  pageId: number;
  /** Fan-scope tombstones include the platform in their immutable scope ref.
   * Existing DM callers are OnlyFans by default; Fansly writers must opt in. */
  platform?: "onlyfans" | "fansly";
  /** The incoming row's fan-side identifiers (fan ref, conversation ref,
   * sender ref) — matched against fan-scope erasures by immutable ref. */
  refs: readonly (string | null | undefined)[];
  /** Earliest material timestamp of the incoming write (min of
   * message_created_at and source/observation received_at). The fence blocks
   * only material at or before the erasure's started_at. */
  materialAt: Date;
}

/**
 * True when an executed (non-dry-run) erasure covers this write: a fan-scope
 * erasure matching any of the refs, or a page/model-scope erasure whose
 * resolved page ids (plan.resolvedPageIds) contain the page — and the
 * incoming material is not newer than the erasure's started_at.
 */
export async function isDmArchiveScopeFenced(
  db: Database,
  input: DmArchiveFenceCheckInput,
): Promise<boolean> {
  const refs = [...new Set(input.refs.filter((ref): ref is string => !!ref))];
  const fanScopeRefs = refs.map((ref) => `fan:${input.platform ?? "onlyfans"}:${ref}`);
  const fanArm = fanScopeRefs.length > 0
    ? sql`(e.scope_type = 'fan' and e.scope_ref in (${sql.join(fanScopeRefs.map((ref) => sql`${ref}`), sql`, `)}))`
    : sql`false`;
  const result = await db.execute<{ fenced: boolean }>(sql`
    select exists (
      select 1 from erasure_log e
      where e.dry_run = false
        and e.started_at >= ${input.materialAt}
        and (
          ${fanArm}
          or (e.scope_type in ('page', 'model')
              and e.plan->'resolvedPageIds' @> to_jsonb(${input.pageId}::bigint))
        )
    ) as fenced
  `);
  return result.rows[0]?.fenced === true;
}
