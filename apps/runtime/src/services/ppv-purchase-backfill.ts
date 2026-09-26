// H2 (INC-001) — carrying PPV PURCHASES into every hub store that keeps
// purchase state: page_dm_messages.purchased_at, message_archive.is_opened and
// dm_message_archive.is_opened. The fact definition and the set-based writers
// live in packages/db (ppv-purchase-facts.ts); this module runs them in two
// shapes.
//
// 1. The one-off HISTORY backfill (`archive:backfill-ppv-purchases`). Until H2
//    a purchase landed only in the hot table: the event-fed message_archive
//    treated message.ppv_unlocked as a no-op and the OF material head never
//    heard of it, so both archives — and every reader overlaying them (the
//    desktop snapshot serves the dm_message_archive row in preference to the
//    hot one) — showed bought PPVs as unbought. Facts: every non-superseded
//    unlock event plus every hot purchased_at. Dry-run is the DEFAULT and is
//    provably read-only (a READ ONLY transaction).
//
// 2. The RECENT-WINDOW reconcile, run by the minutely message-archive sweep.
//    Live, a purchase is applied the moment it arrives — to rows that exist.
//    When the unlock arrives BEFORE its message row (messages.sent lost in an
//    outage and brought back by auto-redelivery minutes later; or simply two
//    webhooks committing in parallel), every store's insert path would leave
//    the row "unbought" forever. This pass re-applies the unlocks of the last
//    RECENT_PURCHASE_WINDOW_MS to whatever rows exist now, so such a row is
//    healed within a minute of appearing. It was chosen over hooking every
//    insert path because (a) there are many — five message_archive arms plus
//    lift/backfill copies, three dm_message_archive candidate sources, the
//    webhook projection and the REST reconcile for the hot table; (b) an
//    insert-time lookup by message ref needs a new index on domain_events
//    (5.3 GB, 6.5 M rows, 16 partitions in production on 2026-09-26), built in
//    a startup migration under a lock that stalls appends; and (c) an
//    insert-time lookup still misses the parallel-commit race, which a later
//    pass closes by construction. The window rides the (type, occurred_at)
//    index — ~130 unlocks per 8 days in production — and each join is a
//    unique-index probe, so an idle pass costs a few index reads.
//
// Both shapes are monotonic and idempotent (a re-run reports zeros) and never
// insert. No OFAPI call anywhere — this reads the hub's own tables.

import { sql } from "drizzle-orm";

import {
  applyDmMessagePurchaseFact,
  countArchivePurchasesToOpen,
  countHotPurchasesToMark,
  countPurchaseFacts,
  listDmArchivePurchaseCandidates,
  markHotPurchasesFromLedger,
  openArchivePurchases,
  type Database,
  type PurchaseFactScope,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * How far back the minutely reconcile looks. Auto-redelivery refuses attempts
 * older than 7 days (ofapi-webhook-recovery.ts), so a late message row lands
 * at most ~7 days after its unlock; one more day is margin. Rows older than
 * that come from REST reads, which carry their own isOpened, or from the
 * one-off history backfill.
 */
export const RECENT_PURCHASE_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

export interface PpvPurchaseBackfillOptions {
  /** Default true: count what WOULD change, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface PpvPurchaseApplyCounts {
  /** Hot rows whose purchased_at was (or would be) filled from an unlock. */
  hotPurchasedMarked: number;
  /** message_archive rows moved (or that would move) to is_opened = TRUE. */
  messageArchiveOpened: number;
  /** dm_message_archive rows moved (or that would move) to is_opened = TRUE. */
  dmArchiveOpened: number;
}

export interface PpvPurchaseBackfillResult extends PpvPurchaseApplyCounts {
  dryRun: boolean;
  /** Distinct (page, message) purchase facts in scope. */
  facts: number;
}

async function applyPurchases(
  db: Database,
  scope: PurchaseFactScope,
): Promise<PpvPurchaseApplyCounts> {
  // Hot first: in the history scope its purchased_at is itself a fact source
  // for the archives.
  const hotPurchasedMarked = await markHotPurchasesFromLedger(db, scope);
  const messageArchiveOpened = await openArchivePurchases(db, scope);
  // The material head goes row by row through the same writer the live
  // projection uses: it owns the fingerprint bookkeeping (no superseding
  // message.* event per healed row — see applyDmMessagePurchaseFact).
  let dmArchiveOpened = 0;
  for (const candidate of await listDmArchivePurchaseCandidates(db, scope)) {
    const result = await applyDmMessagePurchaseFact(db, {
      platform: "onlyfans",
      ofapiAccountId: candidate.ofapiAccountId,
      platformMessageId: candidate.platformMessageId,
    });
    if (result.status === "written") {
      dmArchiveOpened += 1;
    }
  }
  return { hotPurchasedMarked, messageArchiveOpened, dmArchiveOpened };
}

export async function runPpvPurchaseBackfill(
  app: Pick<AppContext, "db" | "logger">,
  options: PpvPurchaseBackfillOptions = {},
): Promise<PpvPurchaseBackfillResult> {
  const dryRun = options.dryRun !== false;
  const scope: PurchaseFactScope = { accountId: options.accountId ?? null, includeHot: true };

  if (dryRun) {
    return app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const db = tx as unknown as Database;
      return {
        dryRun,
        facts: await countPurchaseFacts(db, scope),
        hotPurchasedMarked: await countHotPurchasesToMark(db, scope),
        messageArchiveOpened: await countArchivePurchasesToOpen(db, scope),
        dmArchiveOpened: (await listDmArchivePurchaseCandidates(db, scope)).length,
      };
    });
  }

  const db = app.db as Database;
  const applied = await applyPurchases(db, scope);
  const result = { dryRun, facts: await countPurchaseFacts(db, scope), ...applied };
  app.logger.info(result, "PPV purchase backfill complete");
  return result;
}

/** The minutely recent-window pass (see the header, shape 2). */
export async function reconcileRecentPpvPurchases(
  app: Pick<AppContext, "db">,
  input?: { accountId?: number | null; now?: Date },
): Promise<PpvPurchaseApplyCounts> {
  const now = input?.now ?? new Date();
  return applyPurchases(app.db as Database, {
    accountId: input?.accountId ?? null,
    since: new Date(now.getTime() - RECENT_PURCHASE_WINDOW_MS),
    includeHot: false,
  });
}
