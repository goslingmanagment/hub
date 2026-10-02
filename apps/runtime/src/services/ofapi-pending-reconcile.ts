// W7.4 (A47, decision #132): OFAPI pending settle-or-expire.
//
// OFAPI pending intake is deliberate (a pending payment IS a business fact),
// but nothing ever revisited the rows: rollups and the dashboard breakdown
// carry no transaction_state filter, so a payment that silently died kept
// inflating displayed revenue forever (Stage-0 fact 2026-07-11: 156 rows
// older than 7 days, ~$2,804 net). Fansly has a pending-rescan anchor; this
// is the OFAPI mirror:
//   1. RESCAN — run the existing REST transactions backfill over each page
//      holding stale pendings, from the earliest stale row. Its upsert
//      settles pendings that completed (same transaction id transitions in
//      place) and mints guarded negatives for reversed ones.
//   2. EXPIRE — whatever is STILL active+pending after a fresh scan of its
//      window no longer exists on the platform: retire it exactly like the
//      Fansly anchor ('missing_from_sync_window' — a re-appearing row
//      reactivates through the normal upsert path).
// No expiry without fresh scan evidence: only a page whose rescan read the
// vendor feed to its end may retire rows (`rescanProvesWindow`); every other
// page is skipped whole and its stale rows wait for the next run.

import {
  countActivePendingTransactionsByIds,
  listStalePendingOfapiTransactions,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  retireStalePendingTransactionsById,
  withOfapiSpendTransactionPageLock,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { isOfapiSpendTransactionIngestEnabled } from "./ofapi-spend-transaction-ingest.ts";
import {
  runOfapiTransactionsBackfill,
  type OfapiTransactionsBackfillPageResult,
} from "./ofapi-transactions-backfill.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OFAPI_PENDING_RECONCILE_QUEUE = "ofapi.pending.reconcile";

/** A pending older than this is stale — OFAPI payments settle in minutes;
 * a week covers every observed legitimate straggler. */
export const STALE_PENDING_AGE_DAYS = 7;

/**
 * Whether one page's rescan may justify expiry: it sent at least one request,
 * read the feed to its end and got rows back. A refused first reservation
 * (credit floor, day budget), a capped or budget-cut walk and an empty feed
 * prove nothing about the stale rows. 2026-09-06: a 479-credit balance under
 * the 500 floor made zero requests, the page still reported `written`, and 21
 * payments that OnlyFans still counts were retired.
 */
export function rescanProvesWindow(page: OfapiTransactionsBackfillPageResult): boolean {
  return page.status !== "blocked" &&
    page.pageId !== null &&
    page.apiPages > 0 &&
    page.rawRows > 0 &&
    (page.paginationStopReason === "completed" ||
      page.paginationStopReason === "reached_window_end");
}

export interface OfapiPendingReconcileResult {
  stalePendings: number;
  pagesTouched: number;
  expired: number;
  /** Stale rows no longer pending after the rescan (settled or negated). */
  settledByRescan: number;
  /** Rows on proven pages STILL active+pending after rescan+retire — must
   * be 0; nonzero means something re-asserts pending (see the ingest
   * supersession fix). */
  unresolved: number;
  /** Stale rows on blocked or unscanned pages, left for the next run. */
  deferred: number;
  blockedPages: string[];
  /** Pages that were not blocked, but whose rescan proved nothing. */
  unscannedPages: string[];
  skipped: "disabled" | null;
}

export async function runOfapiPendingReconcile(
  app: AppContext,
  options: { mode?: "write" | "dry-run"; now?: Date } = {},
): Promise<OfapiPendingReconcileResult> {
  const empty: OfapiPendingReconcileResult = {
    stalePendings: 0,
    pagesTouched: 0,
    expired: 0,
    settledByRescan: 0,
    unresolved: 0,
    deferred: 0,
    blockedPages: [],
    unscannedPages: [],
    skipped: null,
  };
  // Same master switch as every writer into the transactions truth table
  // (Audit B2); also bounds REST credit spend to explicitly-enabled setups.
  if (!isOfapiSpendTransactionIngestEnabled(app.config)) {
    return { ...empty, skipped: "disabled" };
  }

  const mode = options.mode ?? "write";
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - STALE_PENDING_AGE_DAYS * 86_400_000);
  const stale = await listStalePendingOfapiTransactions(app.db, { olderThan });
  if (stale.length === 0) {
    return empty;
  }

  const byPage = new Map<number, typeof stale>();
  for (const row of stale) {
    const rows = byPage.get(row.platformAccountId) ?? [];
    rows.push(row);
    byPage.set(row.platformAccountId, rows);
  }
  const pageLabels = Array.from(new Set(stale.map((row) => row.pageLabel)));
  const from = new Date(
    Math.min(...stale.map((row) => row.occurredAt.getTime())) - 86_400_000,
  );

  const backfill = await runOfapiTransactionsBackfill(app, {
    pageLabels,
    from,
    mode: mode === "write" ? "write" : "dry-run",
  });
  const blockedPages = backfill.pages
    .filter((page) => page.status === "blocked")
    .map((page) => page.pageLabel);
  const unscanned = backfill.pages.filter(
    (page) => page.status !== "blocked" && !rescanProvesWindow(page),
  );
  if (unscanned.length > 0) {
    app.logger.warn({
      pages: unscanned.map((page) => ({
        page: page.pageLabel,
        apiPages: page.apiPages,
        rawRows: page.rawRows,
        stopReason: page.paginationStopReason,
        budgetBlock: page.budgetBlock,
      })),
    }, "OFAPI pending reconcile: rescan proved nothing, expiry deferred");
  }
  const provenPageIds = new Set(
    backfill.pages.filter(rescanProvesWindow).map((page) => page.pageId),
  );

  let expired = 0;
  let pagesTouched = 0;
  if (mode === "write") {
    for (const [platformAccountId, rows] of byPage) {
      if (!provenPageIds.has(platformAccountId)) {
        continue;
      }
      pagesTouched += 1;
      const dirtyFrom = new Date(
        Math.min(...rows.map((row) => row.occurredAt.getTime())),
      );
      await withOfapiSpendTransactionPageLock(app.db, platformAccountId, async (db) => {
        const retired = await retireStalePendingTransactionsById(db, {
          platformAccountId,
          ids: rows.map((row) => row.id),
        });
        expired += retired;
        if (retired > 0) {
          await rebuildSpenderProjections(db, platformAccountId, dirtyFrom);
          await rebuildRevenueRollups(db, platformAccountId, dirtyFrom);
        }
      });
    }
  }

  // Honest accounting: re-read the original rows instead of arithmetic —
  // the first prod run "reported" 156 settled while an ingest loop was
  // quietly re-asserting pending underneath.
  const provenRows = stale.filter((row) => provenPageIds.has(row.platformAccountId));
  const unresolved = mode === "write"
    ? await countActivePendingTransactionsByIds(app.db, provenRows.map((row) => row.id))
    : 0;
  const result: OfapiPendingReconcileResult = {
    stalePendings: stale.length,
    pagesTouched,
    expired,
    settledByRescan: mode === "write"
      ? Math.max(0, provenRows.length - expired - unresolved)
      : 0,
    unresolved,
    deferred: stale.length - provenRows.length,
    blockedPages,
    unscannedPages: unscanned.map((page) => page.pageLabel),
    skipped: null,
  };
  app.logger.info(result, "OFAPI pending reconcile complete");
  return result;
}

export async function ensureOfapiPendingReconcileQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(
    boss,
    OFAPI_PENDING_RECONCILE_QUEUE,
    { policy: "exclusive" },
    createdQueues,
  );
}

export async function ensureOfapiPendingReconcileSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Daily at 03:25 UTC — after the 03:10 chargebacks reconcile so the day's
  // negatives exist before pendings are judged.
  await boss.schedule(OFAPI_PENDING_RECONCILE_QUEUE, "25 3 * * *", null, { tz: "UTC" });
}

export async function startOfapiPendingReconcileWorker(
  app: AppContext,
  boss: {
    work: (
      queue: string,
      options: { batchSize: number },
      handler: () => Promise<void>,
    ) => Promise<unknown>;
  },
) {
  await boss.work(OFAPI_PENDING_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    await runOfapiPendingReconcile(app);
  });
}
