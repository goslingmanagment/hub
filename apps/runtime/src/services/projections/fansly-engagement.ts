// WP-F2 — the engagement projector.
//
// ONE projector, ONE watermark, a reducer per table, exactly as the statistics
// projector is shaped. What is different here is the PRECEDENCE RULE, and it is
// different for a physical reason worth stating before the code:
//
//   THE DEEP BACKFILL WALKS BACKWARDS. It appends OLDER facts at HIGHER
//   `account_seq` and at a LATER observation instant. So the two orderings
//   every other projector in this tree can use — ledger order, and "latest
//   capture wins" — are both guaranteed WRONG here. Rows are ordered by the
//   PROVIDER's `occurred_at`, with `notification_ref` as the deterministic
//   tie-break, and the guard lives in the repository's upsert so no caller can
//   forget it. `tests/endpoint-scour-projections.integration.test.ts` pins that
//   a higher-seq, older-`occurred_at` event cannot regress the head.
//
// THREE RULES IT SHARES WITH EVERY OTHER PROJECTOR IN THIS TREE:
//
// 1. Projectors read EVENTS only — never `observations.payload`, never
//    `sync_raw_payloads`.
// 2. Rows are dated from `data`, NEVER from `event.occurredAt`. The events are
//    receipt-time by construction (§3.2b); `occurredAt` is when we LOOKED, and
//    dating a notification from it would stamp last month's purchase with
//    today's date.
// 3. `applied` counts real writes, so an idle tick logs nothing.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
// - Fansly events write NOTHING to `post_likes`. No Fansly like code is live-confirmed
//   ([E4]); the table ships schema-complete and EMPTY, and the OF `posts.liked`
//   webhook is its only writer through ofapi.post_like_observed. A test pins that a 2007 purchase leaves
//   it empty.
// - It never truncates `subject_refresh_state`. That table is capture-plane
//   OPERATIONAL STATE (§3.4): a rebuild that reset it would re-trigger
//   first-sight backfills across the whole catalogue. `rebuild` below deletes
//   `platform_notifications` and `post_likes` and nothing else, and the
//   registry's `OPERATIONAL_STATE_TABLES` is what makes that checkable rather
//   than promised.
//
// THE COMMERCE SIGNAL, and its whole extent: a 2007/2008/32007/45012 event
// marks the purchased media DIRTY in `subject_refresh_state`
// (`plane='media_stats'`, `next_due_at = now`). It FETCHES NOTHING. WP-F4 owns
// the fetching; this is the "somebody bought this, its counters moved" note.

import {
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  markSubjectRefreshDirty,
  setProjectionWatermark,
  upsertPlatformNotification,
  upsertPostLike,
  type EngagementPlatform,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const FANSLY_ENGAGEMENT_PROJECTION = "fansly_engagement";

const EVENT_PAGE_SIZE = 500;

const FANSLY_ENGAGEMENT_EVENT_TYPES = new Set([
  "ofapi.post_like_observed",
  "notification.observed",
  "media.purchase_notification_observed",
]);

/**
 * The tables this projector truncates on rebuild.
 *
 * `subject_refresh_state` is ABSENT and must stay absent (§3.4). `post_likes`
 * IS here: it is a fact projection whose Fansly half happens to be empty, and
 * omitting it would make a rebuild silently keep OF rows that the replay would
 * then re-derive — the "empty because nothing wrote it" and "empty because it
 * was truncated" states have to stay distinguishable.
 */
export const FANSLY_ENGAGEMENT_PROJECTION_TABLES = [
  "platform_notifications",
  "post_likes",
] as const;

/** Where a purchase signal lands. WP-F4 reads this plane. */
const PURCHASE_SIGNAL_PLANE = "media_stats" as const;
const PURCHASE_SIGNAL_REASON = "purchase_notification" as const;

export interface FanslyEngagementProjectionResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  applied: number;
  notifications: number;
  purchaseSignals: number;
}

function eventData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function runFanslyEngagementProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyEngagementProjectionResult> {
  const totals: FanslyEngagementProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    applied: 0,
    notifications: 0,
    purchaseSignals: 0,
  };
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  const platformCache = new Map<number, string | null>();

  for (const accountId of accounts) {
    totals.accounts += 1;
    if (!platformCache.has(accountId)) {
      const page = await getPageTransactionsWriterInfo(app.db, accountId);
      platformCache.set(accountId, page?.platform ?? null);
    }
    const platform = platformCache.get(accountId) ?? null;
    if (platform !== "fansly" && platform !== "onlyfans") {
      // No page, no platform: the rows would be unattributable. The events stay
      // in the ledger and project the moment the page mapping lands.
      continue;
    }
    const engagementPlatform: EngagementPlatform = platform;

    let watermark = await getProjectionWatermark(
      app.db,
      FANSLY_ENGAGEMENT_PROJECTION,
      accountId,
    );
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

      for (const event of events) {
        if (!FANSLY_ENGAGEMENT_EVENT_TYPES.has(event.type)) {
          continue;
        }
        const data = eventData(event.data);
        const contentHash = asText(data.contentHash) ?? "";
        if (contentHash.length !== 64) {
          continue;
        }
        const notificationRef = asText(data.notificationRef);
        if (notificationRef === null) {
          continue;
        }

        switch (event.type) {
          case "ofapi.post_like_observed": {
            const sourceAt=isoDate(data.sourceAt), observedAt=isoDate(data.observedAt);
            const subjectRef=asText(data.postRef), fanRef=asText(data.likerRef);
            if(platform!=="onlyfans" || !sourceAt || !observedAt || !subjectRef || !fanRef || event.fanIdentityRef!==fanRef || event.postRef!==subjectRef) continue;
            const result=await upsertPostLike(app.db,{pageId:accountId,platform:"onlyfans",subjectKind:"post",subjectRef,
              likerPlatformUserId:fanRef,state:"active",occurredAt:sourceAt,notificationRef,discoveredVia:"ofapi_webhook",
              observedAt,contentHash,sourceEventId:event.id,sourceObservationId:event.observationId,sourceAccountSeq:event.accountSeq});
            if(result.applied) totals.applied++;
            continue;
          }

          case "notification.observed": {
            const typeCode = asInt(data.rawTypeCode);
            // The provider's own instant. A row with no `createdAt` has no
            // place on a time-ordered head, and a fabricated one would order
            // the state machine by a lie — so the row is skipped and the event
            // stays in the ledger for a parser that can date it.
            const occurredAt = isoDate(data.occurredAtSeconds);
            if (typeCode === null || occurredAt === null) {
              continue;
            }
            const metadata = eventData(data.metadataJson);
            const result = await upsertPlatformNotification(app.db, {
              pageId: accountId,
              platform: engagementPlatform,
              notificationRef,
              // RAW. Never a label, never filtered against a known set.
              typeCode,
              correlationRef: asText(data.correlationRef),
              correlationGroupRef: asText(data.correlationGroupRef),
              metadata,
              // Dated from `data`, never from event.occurredAt.
              occurredAt,
              acknowledgedAt: isoDate(data.acknowledgedAtSeconds),
              observedAt: event.occurredAt,
              contentHash,
              sourceEventId: event.id,
              sourceObservationId: event.observationId,
              sourceAccountSeq: event.accountSeq,
            });
            if (result.applied) {
              totals.notifications += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "media.purchase_notification_observed": {
            // THE COMMERCE SIGNAL. The bought media's statistics moved, so the
            // media-stats lane should visit it next. Nothing is fetched here
            // and nothing lands in `post_likes`.
            //
            // `correlationRef` is the media/bundle the purchase was against. No
            // ref, no subject: without it there is nothing to mark, and marking
            // the page as a whole would queue the entire catalogue.
            const subjectRef = asText(data.correlationRef);
            if (subjectRef === null) {
              continue;
            }
            const occurredAt = isoDate(data.occurredAtSeconds);
            const result = await markSubjectRefreshDirty(app.db, {
              pageId: accountId,
              plane: PURCHASE_SIGNAL_PLANE,
              subjectRef,
              dirtyReason: PURCHASE_SIGNAL_REASON,
              // Due NOW. A purchase is the strongest freshness signal this
              // system has: somebody paid, and the counters behind that number
              // are what the creator will ask about.
              nextDueAt: occurredAt ?? event.occurredAt,
            });
            if (result.applied) {
              totals.purchaseSignals += 1;
              totals.applied += 1;
            }
            continue;
          }

          default:
            continue;
        }
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(
        app.db,
        FANSLY_ENGAGEMENT_PROJECTION,
        accountId,
        watermark,
      );
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }

  return totals;
}

/**
 * One-command rebuild: truncate scope + reset watermark ATOMICALLY, then
 * replay. The deletes run in ONE transaction (the decision #134 rule): a crash
 * between them would leave an empty projection behind a stale high watermark —
 * permanently and silently empty.
 *
 * These deletes are a PROJECTION RESET — rebuildable state only, never
 * scheduled, which is the justification `tests/retention-deleters.test.ts`
 * carries for this file. `subject_refresh_state` is NOT in the list and must
 * never be added: it is capture-plane operational state (§3.4), and truncating
 * it would drop every pending refresh the capture plane paid egress to learn
 * about and re-trigger the whole first-sight backfill set.
 *
 * The §3.2c(i) detached-partition preflight runs in the projection registry, in
 * front of every rebuild.
 */
export async function rebuildFanslyEngagementProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyEngagementProjectionResult> {
  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      const pageId = input.accountId;
      for (const table of FANSLY_ENGAGEMENT_PROJECTION_TABLES) {
        await tx.execute(sql`delete from ${sql.identifier(table)} where page_id = ${pageId}`);
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${FANSLY_ENGAGEMENT_PROJECTION} and account_id = ${pageId}
      `);
    } else {
      for (const table of FANSLY_ENGAGEMENT_PROJECTION_TABLES) {
        await tx.execute(sql`delete from ${sql.identifier(table)}`);
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${FANSLY_ENGAGEMENT_PROJECTION}
      `);
    }
  });
  return runFanslyEngagementProjection(app, input);
}
