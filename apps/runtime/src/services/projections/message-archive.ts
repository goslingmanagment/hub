// Message-archive projection driver (Stage 10). Minutely sweep advances each
// account's watermark over message.* events; rebuild = reset + the same
// sweep from seq 0 (the projection-rebuild template for later stages).

import {
  applyMessageEventsToArchive,
  getPageTransactionsWriterInfo,
  backfillArchiveFromDmMessageArchive,
  backfillArchiveFromHotTable,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  MESSAGE_ARCHIVE_PROJECTION,
  resetMessageArchiveProjection,
  setProjectionWatermark,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  reconcileRecentPpvPurchases,
  type PpvPurchaseApplyCounts,
} from "../ppv-purchase-backfill.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";

export const MESSAGE_ARCHIVE_SWEEP_QUEUE = "projections.message-archive.sweep";

const EVENT_PAGE_SIZE = 500;
/** Exported for the W10 shadow rebuild — one filter, two replay paths.
 * H2 (INC-001): message.ppv_unlocked joins, so a purchase reaches the archive
 * (is_opened, monotonic) on the live sweep AND on every rebuild replay. */
export const MESSAGE_EVENT_TYPES = new Set([
  "message.received",
  "message.sent",
  "message.deleted",
  "message.material_observed",
  "message.ppv_unlocked",
]);

export async function ensureMessageArchiveQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, MESSAGE_ARCHIVE_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureMessageArchiveSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(MESSAGE_ARCHIVE_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
}

async function platformForAccount(
  app: Pick<AppContext, "db">,
  cache: Map<number, string | null>,
  accountId: number,
) {
  if (!cache.has(accountId)) {
    const page = await getPageTransactionsWriterInfo(app.db, accountId);
    cache.set(accountId, page?.platform ?? null);
  }
  return cache.get(accountId) ?? null;
}

export interface MessageArchiveProjectionResult {
  accounts: number;
  eventsSeen: number;
  inserted: number;
  tombstoned: number;
  /** Rows a message.ppv_unlocked moved to is_opened = true. */
  opened: number;
  /**
   * H2 (INC-001): the recent-window purchase reconcile that closes every
   * sweep — an unlock that arrived BEFORE its message row (in any of the three
   * stores) is applied once the row exists. Zeros when nothing was late.
   */
  purchases: PpvPurchaseApplyCounts;
}

export async function runMessageArchiveProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<MessageArchiveProjectionResult> {
  const totals: MessageArchiveProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    inserted: 0,
    tombstoned: 0,
    opened: 0,
    purchases: { hotPurchasedMarked: 0, messageArchiveOpened: 0, dmArchiveOpened: 0 },
  };
  const platformCache = new Map<number, string | null>();
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);

  for (const accountId of accounts) {
    totals.accounts += 1;
    const platform = await platformForAccount(app, platformCache, accountId);
    if (platform === null) {
      // Events for an account the catalog no longer resolves — leave the
      // watermark parked; nothing is lost (events are the durable ledger).
      continue;
    }

    let watermark = await getProjectionWatermark(app.db, MESSAGE_ARCHIVE_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) {
        break;
      }
      totals.eventsSeen += events.length;
      const messageEvents = events
        .filter((event) => MESSAGE_EVENT_TYPES.has(event.type))
        .map((event) => ({
          id: event.id,
          accountSeq: event.accountSeq,
          type: event.type,
          occurredAt: event.occurredAt,
          fanIdentityRef: event.fanIdentityRef,
          conversationRef: event.conversationRef,
          messageRef: event.messageRef,
          data: event.data,
        }));
      const applied = await applyMessageEventsToArchive(app.db, {
        accountId,
        platform,
        events: messageEvents,
      });
      totals.inserted += applied.inserted;
      totals.tombstoned += applied.tombstoned;
      totals.opened += applied.opened;
      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, MESSAGE_ARCHIVE_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }
  // After this tick's events: a message row inserted above may be the late
  // twin of an unlock applied (to nothing) in an earlier tick.
  totals.purchases = await reconcileRecentPpvPurchases(app, { accountId: input?.accountId ?? null });
  return totals;
}

/** One-command rebuild: truncate scope + replay from the event ledger.
 *
 * W10 (decision #134): LOSSY by construction — the replay sees only attached
 * domain_events partitions and the reset destroys legacy-seed rows that have
 * no event counterpart. No CLI dispatches here anymore; the sanctioned path
 * is the staged shadow rebuild (message-archive-rebuild.ts). Kept because
 * the replay-convergence property it exercises is still pinned by tests. */
export async function rebuildMessageArchiveProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<MessageArchiveProjectionResult> {
  await resetMessageArchiveProjection(app.db, input?.accountId ?? null);
  return runMessageArchiveProjection(app, input);
}

/** Backfill sources 1+2, batched with checkpoints; both idempotent. */
export async function runMessageArchiveBackfills(
  app: Pick<AppContext, "db" | "logger">,
): Promise<{ archiveBatches: number; hotBatches: number }> {
  let archiveBatches = 0;
  let afterId: number | null = 0;
  while (afterId !== null) {
    const step: { lastId: number | null } = await backfillArchiveFromDmMessageArchive(app.db, { afterId });
    afterId = step.lastId;
    if (afterId !== null) {
      archiveBatches += 1;
    }
  }
  let hotBatches = 0;
  afterId = 0;
  while (afterId !== null) {
    const step: { lastId: number | null } = await backfillArchiveFromHotTable(app.db, { afterId });
    afterId = step.lastId;
    if (afterId !== null) {
      hotBatches += 1;
    }
  }
  return { archiveBatches, hotBatches };
}
