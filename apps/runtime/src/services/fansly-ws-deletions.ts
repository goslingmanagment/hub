// D-6 / DMWS-01 / F32: Fansly DM deletions reported by the account socket
// become platform-deletion MARKS on the rows Hub holds (deleted_at in
// page_dm_messages and message_archive), with text and attachments kept. The
// fact definition and the writers live in packages/db (fansly-ws-deletions.ts);
// this module runs them in two shapes.
//
// 1. The RECENT-WINDOW reconcile, run by the minutely message-archive sweep.
//    The hint projector files each deletion receipt within minutes, but the
//    archive row of a message captured just before its deletion can appear
//    after that (its dm_messages observation is canonicalized asynchronously:
//    up to 90 s later in production on 2026-09-28). Re-applying the receipts
//    of the last RECENT_WS_DELETION_WINDOW_MS to whatever rows exist now marks
//    such a row within a minute of it appearing, the way the PPV purchase
//    reconcile heals an unlock that beat its message. The window rides the
//    partial index on exact deletion receipts (~1,400 per week).
//
// 2. The one-off HISTORY backfill (`archive:backfill-fansly-ws-deletions`) for
//    the receipts journaled before this reconcile existed. Owner-run, never
//    scheduled: dry-run is the DEFAULT and is provably read-only (a READ ONLY
//    transaction); `--execute` opts in; a re-run reports zeros.
//
// Neither shape inserts a row or calls Fansly: they read Hub's own receipts.
// A mark is sticky. A later REST read of the message cannot clear it
// (upsertPageDmMessages skips marked rows), as with OnlyFans tombstones.

import { sql } from "drizzle-orm";

import {
  countFanslyWsDeletionsByPage,
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
 * How far back the minutely reconcile looks. A deletion can only name a
 * message captured before it, so a late row is one whose capture was still
 * being canonicalized when the receipt arrived: minutes normally. A week
 * covers a long canonicalization backlog; anything older is what the history
 * backfill is for.
 */
export const RECENT_WS_DELETION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface FanslyWsDeletionApplyCounts {
  /** page_dm_messages rows marked deleted (thread window refreshed). */
  hotMarked: number;
  /** message_archive rows marked deleted. */
  archiveMarked: number;
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
  // One short transaction per row: the mark and the stored-window bookkeeping
  // (count, newest/oldest ids, last fan/model times) commit together, and no
  // thread lock is held across rows. The thread HEAD is left alone: the
  // Fansly conversation list is its only writer and moves it back when the
  // platform deleted the head message.
  for (const target of await listFanslyWsHotDeletionTargets(db, scope)) {
    const marked = await db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      if (!await markFanslyWsHotDeletion(database, target)) {
        return false;
      }
      await refreshPageDmConversationWindow(database, { conversationId: target.conversationId });
      return true;
    });
    if (marked) {
      hotMarked += 1;
    }
  }
  const archiveMarked = await markFanslyWsArchiveDeletions(db, scope);
  return { hotMarked, archiveMarked };
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
      const pages = await countFanslyWsDeletionsByPage(tx as unknown as Database, scope);
      return {
        dryRun,
        deletions: pages.reduce((sum, page) => sum + page.deletions, 0),
        hotMarked: pages.reduce((sum, page) => sum + page.hot, 0),
        archiveMarked: pages.reduce((sum, page) => sum + page.archive, 0),
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

/** The minutely recent-window pass (see the header, shape 1). */
export async function reconcileRecentFanslyWsDeletions(
  app: Pick<AppContext, "db">,
  input?: { accountId?: number | null; now?: Date },
): Promise<FanslyWsDeletionApplyCounts> {
  const now = input?.now ?? new Date();
  return applyFanslyWsDeletions(app.db as Database, {
    accountId: input?.accountId ?? null,
    since: new Date(now.getTime() - RECENT_WS_DELETION_WINDOW_MS),
  });
}
