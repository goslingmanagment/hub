import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import {
  SYNC_OBSERVABILITY_PRUNE_BATCH_ROWS,
  SYNC_OBSERVABILITY_PRUNE_STATEMENT_TIMEOUT_MS,
} from "../sync.ts";

// Fansly Sync Engine telemetry retention (plan §11, design §2.9). It rides the
// nightly retention job next to `deleteExpiredSyncObservability` and keeps its
// shape: batched, index-backed, one transaction with its own statement_timeout
// per batch, a wall-clock budget that ends the sweep early and SAYS so.
//
// What expires (older than the observability window, prod 30 days):
//   - sync_work rows CLOSED before the cutoff (done / cancelled / superseded);
//     open, running and quarantined work never expires;
//   - sync_attempts rows that are terminal (an outcome, nothing left to apply)
//     and not coverage evidence. Evidence rows (request parameters a proof or
//     cursor must be re-derivable from), unfinished rows and quarantined
//     applies (the owner's requeue replays them from their observation) are
//     kept whatever their age.
// Neither table holds a captured fact: the raw responses live in
// `observations`, which nothing here touches.

/** Wall-clock budget of one night's engine-telemetry sweep. */
export const SYNC_ENGINE_TELEMETRY_PRUNE_BUDGET_MS = 120_000;

export interface SyncEngineTelemetryPruneStep {
  table: "sync_work" | "sync_attempts";
  deleted: number;
  batches: number;
  durationMs: number;
  /** The budget ran out while this table may still have had matching rows. */
  budgetExhausted: boolean;
}

export interface SyncEngineTelemetryPruneResult {
  cutoff: Date;
  steps: SyncEngineTelemetryPruneStep[];
  deletedWork: number;
  deletedAttempts: number;
  durationMs: number;
  budgetExhausted: boolean;
}

export async function deleteExpiredSyncEngineTelemetry(
  db: Database,
  cutoff: Date,
  options: {
    batchRows?: number;
    budgetMs?: number;
    statementTimeoutMs?: number;
    monotonicNowMs?: () => number;
  } = {},
): Promise<SyncEngineTelemetryPruneResult> {
  const batchRows = Math.max(1, options.batchRows ?? SYNC_OBSERVABILITY_PRUNE_BATCH_ROWS);
  const budgetMs = Math.max(0, options.budgetMs ?? SYNC_ENGINE_TELEMETRY_PRUNE_BUDGET_MS);
  const statementTimeoutMs = Math.max(
    1_000,
    options.statementTimeoutMs ?? SYNC_OBSERVABILITY_PRUNE_STATEMENT_TIMEOUT_MS,
  );
  const nowMs = options.monotonicNowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const deadlineMs = startedMs + budgetMs;

  const pruneTable = async (
    table: SyncEngineTelemetryPruneStep["table"],
    statement: SQL,
  ): Promise<SyncEngineTelemetryPruneStep> => {
    const tableStartedMs = nowMs();
    const step: SyncEngineTelemetryPruneStep = { table, deleted: 0, batches: 0, durationMs: 0, budgetExhausted: false };
    for (;;) {
      if (nowMs() >= deadlineMs) {
        step.budgetExhausted = true;
        break;
      }
      const deleted = await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = ${sql.raw(String(Math.trunc(statementTimeoutMs)))}`);
        const result = await tx.execute<{ n: string }>(statement);
        return Number(result.rows[0]?.n ?? 0);
      });
      step.batches += 1;
      step.deleted += deleted;
      if (deleted < batchRows) break;
    }
    step.durationMs = nowMs() - tableStartedMs;
    return step;
  };

  // sync_work_closed_at (closed_at) where closed_at is not null.
  const work = await pruneTable("sync_work", sql`
    with doomed as (
      select id from sync_work
       where closed_at < ${cutoff}
         and state in ('done', 'cancelled', 'superseded')
       limit ${batchRows}
    ), removed as (
      delete from sync_work w using doomed where w.id = doomed.id returning 1
    )
    select count(*)::text as n from removed
  `);
  // sync_attempts_retention (admitted_at) where not evidence; completed_at >=
  // admitted_at, so the second conjunct narrows nothing the index finds.
  const attempts = await pruneTable("sync_attempts", sql`
    with doomed as (
      select id from sync_attempts
       where not evidence
         and admitted_at < ${cutoff}
         and coalesce(completed_at, admitted_at) < ${cutoff}
         and outcome not in ('admitted', 'sent')
         and apply_state not in ('captured', 'deferred', 'quarantined')
       limit ${batchRows}
    ), removed as (
      delete from sync_attempts a using doomed where a.id = doomed.id returning 1
    )
    select count(*)::text as n from removed
  `);

  const steps = [work, attempts];
  return {
    cutoff,
    steps,
    deletedWork: work.deleted,
    deletedAttempts: attempts.deleted,
    durationMs: nowMs() - startedMs,
    budgetExhausted: steps.some((step) => step.budgetExhausted),
  };
}
