// D-6 / DMWS-01 / F32: Fansly DM deletions reported by the account socket
// become platform-deletion MARKS on the rows Hub holds (deleted_at in
// page_dm_messages and message_archive), with text and attachments kept. The
// fact definition and the writers live in packages/db (fansly-ws-deletions.ts);
// this module runs them in two shapes.
//
// 1. The GOING-FORWARD reconcile, run by the minutely message-archive sweep.
//    It applies the receipts the hint projector FILED in the last
//    RECENT_WS_DELETION_WINDOW_MS (one hour). A receipt is filed within
//    minutes of its frame, but the archive row of a message captured just
//    before its deletion can appear after that (its dm_messages observation is
//    canonicalized asynchronously: up to 90 s later in production on
//    2026-09-28). Re-applying the recently filed receipts to whatever rows
//    exist now marks such a row within a minute of it appearing, the way the
//    PPV purchase reconcile heals an unlock that beat its message. The hour is
//    sized to that lag, not to history: the first sweep after deploy reaches
//    only the receipts filed in the hour before it, and everything older is
//    left to the owner-run backfill below. A canonicalization backlog longer
//    than the hour is healed by re-running that idempotent backfill.
//    Each pass also re-derives the stored window of a thread whose window a
//    concurrent conversation-list write reverted after a mark
//    (listFanslyWsDeletionWindowDrift).
//
// 2. The HISTORY backfill (`archive:backfill-fansly-ws-deletions`) for the
//    receipts filed before the going-forward reconcile reached them. Owner-run,
//    never scheduled: dry-run is the DEFAULT and is provably read-only (a READ
//    ONLY transaction); `--execute` opts in; a re-run reports zeros.
//
// On a page the Fansly Sync Engine owns (`handover`/`live`, step-3 design
// §3.1 item 12) both shapes still write the marks — sticky and idempotent, the
// same `markFanslyWsHotDeletion` the engine's `dm-live.deletions` uses. The
// hint projector keeps filing `mutation_debt` receipts on those pages, so a
// deletion frame the legacy socket captured before the switch (acked in
// shadow, where the engine writes nothing) is marked even when its receipt is
// filed after the switch, and a switch reverted in phase B still gets its
// handover hour's deletions. They never write a thread's stored window there:
// on those pages the window is the engine's
// (`syncLegacyThreadSummaryAfterDeletion`, I9).
//
// Neither shape inserts a row or calls Fansly: they read Hub's own receipts.
// A mark is sticky. A later REST read of the message cannot clear it
// (upsertPageDmMessages skips marked rows), as with OnlyFans tombstones, and
// no code path unmarks a row.

import { sql } from "drizzle-orm";

import {
  countFanslyWsDeletionsByPage,
  listEngineOwnedFanslyPages,
  listFanslyWsDeletionWindowDrift,
  listFanslyWsHotDeletionTargets,
  markFanslyWsArchiveDeletions,
  markFanslyWsHotDeletion,
  refreshPageDmConversationWindow,
  type Database,
  type FanslyWsDeletionPageCount,
  type FanslyWsDeletionScope,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * How far back, by receipt FILING time, the minutely reconcile looks. A
 * deletion can only name a message captured before it, so a late row is one
 * whose capture was still being canonicalized when the receipt was filed:
 * about 90 s in production. The hour covers that lag with room to spare and
 * keeps the scheduled sweep from applying the receipts filed before the
 * reconcile existed; those, and anything a longer backlog left behind, are the
 * owner-run history backfill's.
 */
export const RECENT_WS_DELETION_WINDOW_MS = 60 * 60 * 1000;

export interface FanslyWsDeletionApplyCounts {
  /** page_dm_messages rows marked deleted (thread window refreshed, except on
   * a page the Fansly Sync Engine owns). */
  hotMarked: number;
  /** message_archive rows marked deleted. */
  archiveMarked: number;
  /** Thread windows re-derived because they still counted a marked row after
   * a concurrent conversation-list write (listFanslyWsDeletionWindowDrift). */
  windowsRepaired: number;
}

export interface FanslyWsDeletionBackfillOptions {
  /** Default true: count what WOULD be marked, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface FanslyWsDeletionBackfillResult extends FanslyWsDeletionApplyCounts {
  dryRun: boolean;
  /** Distinct exact deletion addresses in scope. */
  deletions: number;
  /** Per page, before any write: addresses and live rows they name. */
  pages: FanslyWsDeletionPageCount[];
}

async function applyFanslyWsDeletions(
  db: Database,
  scope: FanslyWsDeletionScope,
): Promise<FanslyWsDeletionApplyCounts> {
  let hotMarked = 0;
  // The engine's pages, read once per pass: their marks are written, their
  // windows are not (see the header).
  const engineOwned = new Set((await listEngineOwnedFanslyPages(db)).map((page) => page.pageId));
  // One short transaction per row: the mark and the stored-window bookkeeping
  // (count, newest/oldest ids, last fan/model times) commit together, and no
  // thread lock is held across rows. The thread HEAD is left alone: the
  // Fansly conversation list is its only writer. That list can keep naming a
  // deleted message as the head (13 threads in production on 2026-09-28,
  // rewritten by later scans); its preview then keeps the deleted text,
  // unmarked, while the conversation view hides the message.
  for (const target of await listFanslyWsHotDeletionTargets(db, scope)) {
    const marked = await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      if (!await markFanslyWsHotDeletion(database, target)) {
        return false;
      }
      if (!engineOwned.has(target.pageId)) {
        await refreshPageDmConversationWindow(database, { conversationId: target.conversationId });
      }
      return true;
    });
    if (marked) {
      hotMarked += 1;
    }
  }
  const archiveMarked = await markFanslyWsArchiveDeletions(db, scope);
  // The refreshes above run outside the page sync lease; a list chunk that
  // read the thread before a mark writes the old window back. Re-derive any
  // window that still counts a marked row (a no-op when nothing raced; never
  // a thread of a page the engine owns — the drift list leaves those out).
  let windowsRepaired = 0;
  for (const conversationId of await listFanslyWsDeletionWindowDrift(db, scope)) {
    await refreshPageDmConversationWindow(db, { conversationId });
    windowsRepaired += 1;
  }
  return { hotMarked, archiveMarked, windowsRepaired };
}

export async function runFanslyWsDeletionBackfill(
  app: Pick<AppContext, "db" | "logger">,
  options: FanslyWsDeletionBackfillOptions = {},
): Promise<FanslyWsDeletionBackfillResult> {
  const dryRun = options.dryRun !== false;
  const scope: FanslyWsDeletionScope = { accountId: options.accountId ?? null };

  if (dryRun) {
    return app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const database = tx as unknown as Database;
      const pages = await countFanslyWsDeletionsByPage(database, scope);
      return {
        dryRun,
        deletions: pages.reduce((sum, page) => sum + page.deletions, 0),
        hotMarked: pages.reduce((sum, page) => sum + page.hot, 0),
        archiveMarked: pages.reduce((sum, page) => sum + page.archive, 0),
        // Windows of threads already marked that drifted; the rows this run
        // would mark get their window refreshed with the mark.
        windowsRepaired: (await listFanslyWsDeletionWindowDrift(database, scope)).length,
        pages,
      };
    });
  }

  const db = app.db as Database;
  const pages = await countFanslyWsDeletionsByPage(db, scope);
  const applied = await applyFanslyWsDeletions(db, scope);
  const result = {
    dryRun,
    deletions: pages.reduce((sum, page) => sum + page.deletions, 0),
    ...applied,
    pages,
  };
  app.logger.info(result, "Fansly WS deletion backfill complete");
  return result;
}

/** The minutely going-forward pass (see the header, shape 1). */
export async function reconcileRecentFanslyWsDeletions(
  app: Pick<AppContext, "db">,
  input?: { accountId?: number | null; now?: Date },
): Promise<FanslyWsDeletionApplyCounts> {
  const now = input?.now ?? new Date();
  return applyFanslyWsDeletions(app.db as Database, {
    accountId: input?.accountId ?? null,
    filedSince: new Date(now.getTime() - RECENT_WS_DELETION_WINDOW_MS),
  });
}
