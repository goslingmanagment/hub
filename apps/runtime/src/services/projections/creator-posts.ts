// creator_posts current-head projection. It consumes projection-only
// post.observed events behind the standard per-account sequence watermark.
// Absence from a timeline page is deliberately a no-op: only an explicit,
// separately-designed tombstone event could ever represent deletion.

import {
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  upsertCreatorPost,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const CREATOR_POSTS_PROJECTION = "creator_posts";
const EVENT_PAGE_SIZE = 500;

function eventData(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("post.observed data must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`post.observed ${field} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`post.observed ${field} must be an ISO timestamp`);
  }
  return parsed;
}

function platformFromData(value: unknown): Platform {
  if (value !== "fansly" && value !== "onlyfans") {
    throw new Error("post.observed platform must be fansly or onlyfans");
  }
  return value;
}

export interface CreatorPostsProjectionResult {
  accounts: number;
  eventsSeen: number;
  upserted: number;
}

export async function runCreatorPostsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<CreatorPostsProjectionResult> {
  const totals: CreatorPostsProjectionResult = { accounts: 0, eventsSeen: 0, upserted: 0 };
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);

  for (const accountId of accounts) {
    totals.accounts += 1;
    const page = await getPageTransactionsWriterInfo(app.db, accountId);
    if (!page) {
      // Keep the watermark parked: a later catalog repair makes the immutable
      // events projectable without replaying/re-writing facts.
      continue;
    }

    let watermark = await getProjectionWatermark(app.db, CREATOR_POSTS_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) break;
      totals.eventsSeen += events.length;

      for (const event of events) {
        if (event.type !== "post.observed") continue;
        if (!event.postRef) {
          throw new Error(`post.observed event ${event.id} has no post_ref`);
        }
        const data = eventData(event.data);
        const platform = platformFromData(data.platform);
        if (platform !== page.platform) {
          throw new Error(
            `post.observed event ${event.id} platform ${platform} does not match page ${page.platform}`,
          );
        }
        if (typeof data.textPlain !== "string") {
          throw new Error(`post.observed event ${event.id} has no textPlain`);
        }
        if (typeof data.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(data.contentHash)) {
          throw new Error(`post.observed event ${event.id} has invalid contentHash`);
        }
        if (!Number.isInteger(data.attachmentCount) || Number(data.attachmentCount) < 0) {
          throw new Error(`post.observed event ${event.id} has invalid attachmentCount`);
        }
        const result = await upsertCreatorPost(app.db, {
          accountId,
          platform,
          platformPostId: event.postRef,
          textPlain: data.textPlain,
          publishedAt: requiredDate(data.publishedAt, "publishedAt"),
          observedAt: requiredDate(data.observedAt, "observedAt"),
          contentHash: data.contentHash,
          attachmentCount: Number(data.attachmentCount),
          sourceEventId: event.id,
          sourceObservationId: event.observationId,
          sourceAccountSeq: event.accountSeq,
        });
        if (result.applied) totals.upserted += 1;
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, CREATOR_POSTS_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) break;
    }
  }

  return totals;
}

/** Current-head rows have no direct/backfill-only seeds, so the standard
 * projection reset is lossless: clear the requested scope and its watermark
 * atomically, then replay immutable post.observed events. */
export async function rebuildCreatorPostsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<CreatorPostsProjectionResult> {
  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      await tx.execute(sql`delete from creator_posts where account_id = ${input.accountId}`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${CREATOR_POSTS_PROJECTION} and account_id = ${input.accountId}
      `);
    } else {
      await tx.execute(sql`delete from creator_posts`);
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${CREATOR_POSTS_PROJECTION}
      `);
    }
  });
  return runCreatorPostsProjection(app, input);
}
