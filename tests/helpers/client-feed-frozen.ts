import { z } from "zod";

/**
 * The archive feed as the chat extension FROZE it (its contracts v1.0.0,
 * packages/contracts/src/hub/feed.ts: `FeedQuerySchema`, `FeedItemSchema`,
 * `FeedSummarySchema`, `FeedPageSchema`, over `NativeIdSchema`,
 * `IsoTimestampSchema`, `OpenTokenSchema`, `CountSchema`, `MoneyMillsSchema`
 * and `HubCursorSchema`), restated in this repo's zod.
 *
 * Whatever the hub answers must parse here, and the hub must take every query
 * this accepts: a page the client's schema refuses is a preview the chatter
 * cannot open.
 */

const NATIVE_ID = /^[1-9]\d{0,29}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = z.string().max(40).regex(ISO_TIMESTAMP);
const openToken = z.string().min(1).max(64);
const count = z.int().min(0);
const moneyMills = z.int();
const hubCursor = z.string().min(1).max(2048);

/** Path `pageLabel` + `fanRef`; query `cursor`, `limit`, `summaryWindow`. */
export const frozenFeedQuerySchema = z.strictObject({
  pageLabel: z.string().min(1).max(120),
  fanRef: z.string().regex(NATIVE_ID),
  cursor: hubCursor.optional(),
  limit: z.int().min(1).max(100).optional(),
  summaryWindow: z.int().min(5).max(1500).optional(),
});

export const frozenFeedItemSchema = z.object({
  messageId: z.string(),
  at: isoTimestamp.nullable(),
  sender: openToken,
  text: z.string(),
  automatic: z.boolean().nullable(),
  deleted: z.boolean(),
  tipMills: moneyMills.nullable(),
  priceMills: moneyMills.nullable(),
  attachmentLabels: z.array(z.string().max(80)).max(50),
});

export const frozenFeedSummarySchema = z.object({
  pingSegment: openToken,
  fanSilenceDays: count.nullable(),
  window: z.object({ requested: count, served: count }),
  coverage: openToken,
  asOf: isoTimestamp,
});

export const frozenFeedPageSchema = z.object({
  target: z.object({ pageLabel: z.string(), fanRef: z.string().regex(NATIVE_ID) }),
  source: openToken,
  snapshotRevision: z.string(),
  asOf: isoTimestamp,
  coverage: openToken,
  head: z.object({ messageRef: z.string(), at: isoTimestamp.nullable(), sender: openToken }).nullable(),
  newestKnownAt: isoTimestamp.nullable(),
  nextOlderCursor: hubCursor.nullable(),
  items: z.array(frozenFeedItemSchema).max(100),
  summary: frozenFeedSummarySchema.nullable(),
});

/** The client's known values (`FEED_SENDERS`, `PING_SEGMENTS`, `FEED_LIMITS`). */
export const FROZEN_FEED_SENDERS = ["fan", "model", "system", "unknown"] as const;
export const FROZEN_PING_SEGMENTS = ["active", "segment-a", "segment-b", "unknown"] as const;
export const FROZEN_FEED_LIMITS = {
  defaultLimit: 50,
  maxLimit: 100,
  summaryWindowDefault: 100,
  summaryWindowMin: 5,
  summaryWindowMax: 1500,
} as const;
