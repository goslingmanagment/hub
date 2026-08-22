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

/** WP-F6 (schema v3). Every one must be PRESENT on a v3 event — absent is a
 *  malformed event, not a null value — because the whole promise of the v6
 *  re-parse is that the column is filled from the journal rather than left null
 *  by an event that quietly stopped carrying it. */
const POST_V3_FIELDS = [
  "likeCount",
  "mediaLikeCount",
  "replyCount",
  "fypFlags",
  "expiresAt",
  "inReplyToRef",
  "inReplyToRootRef",
  "wallRefs",
  "accountMentionRefs",
  "attachmentRefs",
  "hashtags",
  "hashtagsNormalized",
  "hashtagParserVersion",
] as const;

function nullableCount(value: unknown, field: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`post.observed ${field} must be a non-negative safe integer or null`);
  }
  return BigInt(value);
}

function nullableInt(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`post.observed ${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function nullableDate(value: unknown, field: string): Date | null {
  if (value === null) return null;
  return requiredDate(value, field);
}

function nullableRefArray(value: unknown, field: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`post.observed ${field} must be an array or null`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`post.observed ${field} must hold non-empty string refs`);
    }
    return item;
  });
}

/** The attachment id-relations, re-validated on the way OUT of the ledger.
 *  A URL-bearing key cannot arrive here — the canonicalizer copies three keys
 *  by name — and this rebuilds the row from those three so an event authored by
 *  some future writer cannot smuggle a fourth into a serving column. */
function nullableAttachmentRefs(value: unknown, eventId: number): unknown[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`post.observed event ${eventId} has an invalid attachmentRefs`);
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`post.observed event ${eventId} has an invalid attachment ref`);
    }
    const ref = item as Record<string, unknown>;
    return {
      pos: nullableInt(ref.pos ?? null, "attachmentRefs.pos"),
      contentType: nullableInt(ref.contentType ?? null, "attachmentRefs.contentType"),
      contentId: nullableRef(ref.contentId ?? null, "attachmentRefs.contentId"),
    };
  });
}

const EMPTY_POST_ENGAGEMENT = {
  likeCount: null,
  mediaLikeCount: null,
  replyCount: null,
  fypFlags: null,
  expiresAt: null,
  inReplyToRef: null,
  inReplyToRootRef: null,
  wallRefs: null,
  accountMentionRefs: null,
  hashtags: null,
  hashtagsNormalized: null,
  hashtagParserVersion: null,
  attachmentRefs: null,
  engagementObservedAt: null,
} as const;

/**
 * The WP-F6 half of the head, read from a schema-v3 `post.observed`.
 *
 * `engagementObservedAt` is DERIVED, not carried: it is the event's own
 * `observedAt` whenever the event carried at least one counter. That is what
 * makes it survive a rebuild — a capture lane stamping it directly onto this
 * rebuildable projection would have it wiped by the next `projection:rebuild`,
 * and the timeline sighting that ALSO carries `likeCount` would not set it at
 * all. Zero counters (a pre-widening response replayed at v6) leaves it null
 * rather than claiming an observation that never looked.
 */
function postEngagementFromEvent(
  event: { id: number; schemaVersion: number },
  data: Record<string, unknown>,
  observedAt: Date,
) {
  if (event.schemaVersion < 3) {
    return { ...EMPTY_POST_ENGAGEMENT };
  }
  requiredNullableFields(data, POST_V3_FIELDS, event.id);
  const likeCount = nullableCount(data.likeCount, "likeCount");
  const mediaLikeCount = nullableCount(data.mediaLikeCount, "mediaLikeCount");
  const replyCount = nullableCount(data.replyCount, "replyCount");
  const hashtags = nullableRefArray(data.hashtags, "hashtags");
  const hashtagsNormalized = nullableRefArray(data.hashtagsNormalized, "hashtagsNormalized");
  const hashtagParserVersion = nullableInt(data.hashtagParserVersion, "hashtagParserVersion");
  if (
    (hashtags === null) !== (hashtagsNormalized === null)
    || (hashtags === null) !== (hashtagParserVersion === null)
    || (hashtags !== null && hashtags.length !== hashtagsNormalized!.length)
  ) {
    throw new Error(`post.observed event ${event.id} has unpaired hashtag columns`);
  }
  const observedAnyCounter = likeCount !== null || mediaLikeCount !== null || replyCount !== null;
  return {
    likeCount,
    mediaLikeCount,
    replyCount,
    fypFlags: nullableInt(data.fypFlags, "fypFlags"),
    expiresAt: nullableDate(data.expiresAt, "expiresAt"),
    inReplyToRef: nullableRef(data.inReplyToRef, "inReplyToRef"),
    inReplyToRootRef: nullableRef(data.inReplyToRootRef, "inReplyToRootRef"),
    wallRefs: nullableRefArray(data.wallRefs, "wallRefs"),
    accountMentionRefs: nullableRefArray(data.accountMentionRefs, "accountMentionRefs"),
    hashtags,
    hashtagsNormalized,
    hashtagParserVersion,
    attachmentRefs: nullableAttachmentRefs(data.attachmentRefs, event.id),
    engagementObservedAt: observedAnyCounter ? observedAt : null,
  };
}

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
  /** WP-F6: heads whose `reply_count` moved, each of which marked its
   *  `post_replies` walk row dirty in the SAME transaction as the head. */
  replyWalksMarkedDirty: number;
}

export async function runCreatorPostsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<CreatorPostsProjectionResult> {
  const totals: CreatorPostsProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    upserted: 0,
    replyWalksMarkedDirty: 0,
  };
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
      let deferredBehindErasure = false;

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
            (event.schemaVersion !== 1 && event.schemaVersion !== 2 && event.schemaVersion !== 3)
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
          const tipGoalRef = event.schemaVersion >= 2
            ? nullableRef(data.tipGoalRef, "tipGoalRef")
            : null;
          let tipGoalAttribution: "goal" | "direct" | "unknown" = event.schemaVersion === 1
            ? "unknown"
            : tipGoalRef === null
              ? "direct"
              : "goal";
          if (event.schemaVersion >= 3) {
            const observedTipGoalAttribution = data.tipGoalAttribution;
            if (
              observedTipGoalAttribution !== "goal"
              && observedTipGoalAttribution !== "direct"
              && observedTipGoalAttribution !== "unknown"
            ) {
              throw new Error(
                `post.tip_observed event ${event.id} has invalid tipGoalAttribution`,
              );
            }
            if (
              (observedTipGoalAttribution === "goal") !== (tipGoalRef !== null)
            ) {
              throw new Error(
                `post.tip_observed event ${event.id} has incoherent goal attribution`,
              );
            }
            tipGoalAttribution = observedTipGoalAttribution;
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
            // Schema v3 records whether the source proved a goal, proved a
            // direct tip, or supplied no per-tip goal discriminator. The
            // current serving table deliberately stores only exact goal refs;
            // an unknown sighting preserves older exact evidence, while a
            // newer explicit direct/goal sighting remains last-writer-wins.
            tipGoalRef,
            tipGoalAttribution,
            tipMessageText,
            contentHash,
            sourceEventId: event.id,
            sourceObservationId: event.observationId,
            sourceAccountSeq: event.accountSeq,
          });
          if (result.status === "deferred") {
            // Do not cross this event with the durable watermark. The next
            // minutely sweep retries after the erasure releases its exclusive
            // page lock; earlier idempotent writes in this batch may replay.
            deferredBehindErasure = true;
            app.logger.info(
              { accountId, eventId: event.id },
              "Creator post-tip projection deferred behind erasure fence",
            );
            break;
          }
          if (result.applied) totals.upserted += 1;
          continue;
        }

        if (
          event.schemaVersion !== 1 && event.schemaVersion !== 2 && event.schemaVersion !== 3
        ) {
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
        const observedAt = requiredDate(data.observedAt, "observedAt");
        const engagement = postEngagementFromEvent(event, data, observedAt);
        const result = await upsertCreatorPost(app.db, {
          accountId,
          platform,
          platformPostId: event.postRef,
          textPlain: data.textPlain,
          publishedAt: requiredDate(data.publishedAt, "publishedAt"),
          observedAt,
          contentHash: data.contentHash,
          attachmentCount: Number(data.attachmentCount),
          ...monetization,
          ...engagement,
          sourceEventId: event.id,
          sourceObservationId: event.observationId,
          sourceAccountSeq: event.accountSeq,
        });
        if (result.applied) totals.upserted += 1;
        if (result.replyCountChanged) totals.replyWalksMarkedDirty += 1;
      }

      if (deferredBehindErasure) break;
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
