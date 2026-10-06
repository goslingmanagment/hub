import { z } from "zod";

/**
 * The "new subscribers" list's query and answer as the chat extension FROZE
 * them (its contracts, packages/contracts/src/hub/newcomers.ts:
 * `AudienceNewQuerySchema` and `AudienceNewPageSchema`, with its primitives),
 * restated in this repo's zod. The hub must take every query the client's
 * schema lets out, and answer only what the client's schema reads. Shared by
 * the contract test and the route test of H-7c.
 */
const frozenNativeId = z.string().regex(/^[1-9]\d{0,29}$/);
const frozenCount = z.int().gte(0);
const frozenToken = z.string().min(1).max(64);
const frozenInstant = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const frozenCursor = z.string().min(1).max(2048);

/** The client's query: the page label rides the path, the rest the query string. */
export const frozenAudienceNewQuerySchema = z.strictObject({
  pageLabel: z.string().min(1).max(120),
  windowHours: z.int().gte(1).lte(720),
  cursor: frozenCursor.optional(),
  limit: z.int().gte(1).lte(100).optional(),
});

export const frozenClaimSummarySchema = z.object({
  greeting: z.enum(["none", "confirmed"]),
  lease: z.enum(["none", "owned", "held", "expired", "released"]),
  heldBy: z.enum(["you-elsewhere", "someone-else"]).nullable(),
  custody: z.enum(["dispatching", "sent", "failed", "uncertain-held", "resolved-sent", "resolved-not-sent"]).nullable(),
});

export const frozenAudienceNewItemSchema = z.object({
  eventRef: z.string(),
  fanRef: frozenNativeId,
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  kind: frozenToken,
  trial: z.boolean(),
  subscribedAt: frozenInstant,
  subscribedAtSource: frozenToken,
  status: z.object({
    isSubscriber: z.boolean().nullable(),
    subscriptionStatus: frozenToken,
    endsAt: frozenInstant.nullable(),
    asOf: frozenInstant.nullable(),
    source: frozenToken,
  }),
  thread: z.object({
    lastMessageAt: frozenInstant.nullable(),
    lastFanMessageAt: frozenInstant.nullable(),
    lastModelMessageAt: frozenInstant.nullable(),
    storedMessageCount: frozenCount,
    coverage: frozenToken,
    backfillComplete: z.boolean(),
  }).nullable(),
  claim: frozenClaimSummarySchema,
});

export const frozenAudienceNewPageSchema = z.object({
  pageLabel: z.string(),
  window: z.object({
    hours: z.int().gte(1),
    from: frozenInstant,
    to: frozenInstant,
    snapshotAt: frozenInstant,
  }),
  serverNow: frozenInstant,
  coverage: z.object({
    state: frozenToken,
    deliveryFrontier: frozenInstant.nullable(),
    lastAudienceSweepAt: frozenInstant.nullable(),
    reasons: z.array(frozenToken),
  }),
  unknownCount: frozenCount,
  welcomeTemplate: z.object({
    ref: z.string(),
    observedAt: frozenInstant,
    enabled: z.boolean().nullable(),
    hasText: z.boolean(),
    hasMedia: z.boolean(),
    priceMills: z.int().nullable(),
  }).nullable(),
  items: z.array(frozenAudienceNewItemSchema),
  nextCursor: frozenCursor.nullable(),
});

/** The known values the client narrows the list's open tokens to (its `AUDIENCE_KINDS`, `SUBSCRIBED_AT_SOURCES`). */
export const FROZEN_AUDIENCE_KINDS = ["new", "returning"] as const;
export const FROZEN_SUBSCRIBED_AT_SOURCES = ["subscribeAt", "notification"] as const;
/** The client's `AUDIENCE_LIMITS`. */
export const FROZEN_AUDIENCE_LIMITS = { defaultWindowHours: 48, maxWindowHours: 720, defaultLimit: 50, maxLimit: 100 } as const;
