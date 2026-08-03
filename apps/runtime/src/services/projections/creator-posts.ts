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
  upsertCreatorPostTip,
} from "@agency_hub_core/db";
import { millsFromInteger, type Platform } from "@agency_hub_core/shared";
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

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`post event ${field} must be a string or null`);
  }
  return value;
}

function nullableRef(value: unknown, field: string): string | null {
  const parsed = nullableString(value, field);
  if (parsed !== null && parsed.length === 0) {
    throw new Error(`post event ${field} must not be empty`);
  }
  return parsed;
}

function nullableMills(value: unknown, field: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`post event ${field} must be non-negative safe-integer mills or null`);
  }
  return millsFromInteger(value);
}

function requiredMills(value: unknown, field: string): bigint {
  const parsed = nullableMills(value, field);
  if (parsed === null) {
    throw new Error(`post event ${field} must be non-null mills`);
  }
  return parsed;
}

function requiredNullableFields(
  data: Record<string, unknown>,
  fields: readonly string[],
  eventId: number,
) {
  for (const field of fields) {
    if (!Object.hasOwn(data, field)) {
      throw new Error(`post.observed event ${eventId} has no ${field}`);
    }
  }
}

const POST_V2_FIELDS = [
  "tipAmountMills",
  "attachmentTipAmountMills",
  "postTipTotalMills",
  "tipGoalLinked",
  "tipGoalRef",
  "tipGoalLabel",
  "tipGoalTargetMills",
  "tipGoalCurrentMills",
  "tipGoalAmountsHidden",
] as const;

function postMonetizationFromEvent(
  event: { id: number; schemaVersion: number },
  data: Record<string, unknown>,
) {
  if (event.schemaVersion < 2) {
    return {
      tipAmountMills: null,
      attachmentTipAmountMills: null,
      postTipTotalMills: null,
      tipGoalLinked: null,
      tipGoalRef: null,
      tipGoalLabel: null,
      tipGoalTargetMills: null,
      tipGoalCurrentMills: null,
      tipGoalAmountsHidden: null,
    };
  }

  requiredNullableFields(data, POST_V2_FIELDS, event.id);
  const tipAmountMills = nullableMills(data.tipAmountMills, "tipAmountMills");
  const attachmentTipAmountMills = nullableMills(
    data.attachmentTipAmountMills,
    "attachmentTipAmountMills",
  );
  const postTipTotalMills = nullableMills(data.postTipTotalMills, "postTipTotalMills");
  const expectedTotal = tipAmountMills === null && attachmentTipAmountMills === null
    ? null
    : (tipAmountMills ?? 0n) + (attachmentTipAmountMills ?? 0n);
  if (postTipTotalMills !== expectedTotal) {
    throw new Error(`post.observed event ${event.id} has inconsistent postTipTotalMills`);
  }

  const tipGoalLinked = data.tipGoalLinked === null
    ? null
    : typeof data.tipGoalLinked === "boolean"
      ? data.tipGoalLinked
      : (() => { throw new Error(`post.observed event ${event.id} has invalid tipGoalLinked`); })();
  const tipGoalRef = nullableRef(data.tipGoalRef, "tipGoalRef");
  const tipGoalLabel = nullableString(data.tipGoalLabel, "tipGoalLabel");
  const tipGoalTargetMills = nullableMills(data.tipGoalTargetMills, "tipGoalTargetMills");
  const tipGoalCurrentMills = nullableMills(data.tipGoalCurrentMills, "tipGoalCurrentMills");
  const tipGoalAmountsHidden = data.tipGoalAmountsHidden === null
    ? null
    : typeof data.tipGoalAmountsHidden === "boolean"
      ? data.tipGoalAmountsHidden
      : (() => {
        throw new Error(`post.observed event ${event.id} has invalid tipGoalAmountsHidden`);
      })();
  if (tipGoalLinked === true && tipGoalRef === null) {
    throw new Error(`post.observed event ${event.id} links a goal without tipGoalRef`);
  }
  if (
    tipGoalLinked !== true
    && [tipGoalRef, tipGoalLabel, tipGoalTargetMills, tipGoalCurrentMills, tipGoalAmountsHidden]
      .some((value) => value !== null)
  ) {
    throw new Error(`post.observed event ${event.id} has goal details without a linked goal`);
  }
  return {
    tipAmountMills,
    attachmentTipAmountMills,
    postTipTotalMills,
    tipGoalLinked,
    tipGoalRef,
    tipGoalLabel,
    tipGoalTargetMills,
    tipGoalCurrentMills,
    tipGoalAmountsHidden,
  };
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
        if (event.type !== "post.observed" && event.type !== "post.tip_observed") continue;
        if (!event.postRef) {
          throw new Error(`${event.type} event ${event.id} has no post_ref`);
        }
        const data = eventData(event.data);
        const platform = platformFromData(data.platform);
        if (platform !== page.platform) {
          throw new Error(
            `post.observed event ${event.id} platform ${platform} does not match page ${page.platform}`,
          );
        }

        if (event.type === "post.tip_observed") {
          if (
            (event.schemaVersion !== 1 && event.schemaVersion !== 2)
            || platform !== "fansly"
          ) {
            throw new Error(`post.tip_observed event ${event.id} has unsupported schema/platform`);
          }
          const tipId = nullableRef(data.tipId, "tipId");
          const senderPlatformUserId = nullableRef(
            data.senderPlatformUserId,
            "senderPlatformUserId",
          );
          if (tipId === null || senderPlatformUserId === null) {
            throw new Error(`post.tip_observed event ${event.id} has incomplete identity`);
          }
          if (event.fanIdentityRef !== senderPlatformUserId) {
            throw new Error(`post.tip_observed event ${event.id} fan identity mismatch`);
          }
          const receiverTransactionRef = nullableRef(
            data.receiverTransactionRef,
            "receiverTransactionRef",
          );
          if (event.transactionRef !== receiverTransactionRef) {
            throw new Error(`post.tip_observed event ${event.id} transaction mismatch`);
          }
          const contentHash = nullableRef(data.contentHash, "contentHash");
          if (contentHash === null || !/^[0-9a-f]{64}$/.test(contentHash)) {
            throw new Error(`post.tip_observed event ${event.id} has invalid contentHash`);
          }
          let tipMessageText: string | null = null;
          if (event.schemaVersion >= 2) {
            requiredNullableFields(data, ["tipMessageText"], event.id);
            tipMessageText = nullableString(data.tipMessageText, "tipMessageText");
          }
          const result = await upsertCreatorPostTip(app.db, {
            accountId,
            platform,
            platformPostId: event.postRef,
            platformTipId: tipId,
            tipSenderPlatformUserId: senderPlatformUserId,
            postTipAmountMills: requiredMills(data.amountMills, "amountMills"),
            occurredAt: requiredDate(data.occurredAt, "occurredAt"),
            observedAt: requiredDate(data.observedAt, "observedAt"),
            receiverTransactionRef,
            senderTransactionRef: nullableRef(data.senderTransactionRef, "senderTransactionRef"),
            // Schema v1 accepted the optional top-level tipGoalId without an
            // authoritative type-7100 target. Do not upgrade that historical
            // correlation into exact donor-to-goal evidence. V2 replays the
            // retained raw response and restores a goal only when its target
            // proves it.
            tipGoalRef: event.schemaVersion >= 2
              ? nullableRef(data.tipGoalRef, "tipGoalRef")
              : null,
            tipMessageText,
            contentHash,
            sourceEventId: event.id,
            sourceObservationId: event.observationId,
            sourceAccountSeq: event.accountSeq,
          });
          if (result.applied) totals.upserted += 1;
          continue;
        }

        if (event.schemaVersion !== 1 && event.schemaVersion !== 2) {
          throw new Error(`post.observed event ${event.id} has unsupported schema version`);
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
        const monetization = postMonetizationFromEvent(event, data);
        const result = await upsertCreatorPost(app.db, {
          accountId,
          platform,
          platformPostId: event.postRef,
          textPlain: data.textPlain,
          publishedAt: requiredDate(data.publishedAt, "publishedAt"),
          observedAt: requiredDate(data.observedAt, "observedAt"),
          contentHash: data.contentHash,
          attachmentCount: Number(data.attachmentCount),
          ...monetization,
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
      await tx.execute(sql`delete from creator_post_tips where account_id = ${input.accountId}`);
      await tx.execute(sql`delete from creator_posts where account_id = ${input.accountId}`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${CREATOR_POSTS_PROJECTION} and account_id = ${input.accountId}
      `);
    } else {
      await tx.execute(sql`delete from creator_post_tips`);
      await tx.execute(sql`delete from creator_posts`);
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${CREATOR_POSTS_PROJECTION}
      `);
    }
  });
  return runCreatorPostsProjection(app, input);
}
