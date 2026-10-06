import { z } from "zod";

/**
 * The awaiting-reply queue as the chat extension froze it (its contracts v1,
 * packages/contracts/src/hub/spenders.ts: QueueQuerySchema, QueuePageSchema),
 * restated here. The answer's schema is stricter than the hub's own response
 * schema (instants by pattern, a fan id that is a platform number, tokens of 1
 * to 64 characters), and a body it refused would be lost on the client: one
 * row it does not take costs it the whole page.
 */
const frozenInstant = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const frozenToken = z.string().min(1).max(64);
const frozenCount = z.number().int().min(0);
/** Signed whole mills within the safe-integer range. */
const frozenMills = z.number().int();
/** The client's NativeId: a platform numeric id, no leading zero, at most 30 digits. */
const frozenNativeId = z.string().regex(/^[1-9]\d{0,29}$/);
/** The client's HubCursor: opaque, 1 to 2048 characters. */
const frozenCursor = z.string().min(1).max(2048);

export const frozenClientSpenderAwaitingReplySchema = z.object({
  items: z.array(z.object({
    fanRef: frozenNativeId,
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    lifetimeGrossMills: frozenMills,
    lastFanMessageAt: frozenInstant,
    lastModelMessageAt: frozenInstant.nullable(),
    unreadCount: frozenCount.nullable(),
    readState: frozenToken,
  })),
  total: frozenCount,
  loaded: frozenCount,
  unknown: frozenCount,
  nextCursor: frozenCursor.nullable(),
  asOf: frozenInstant,
});

/** The query the client may build, beside the page of the path: a cursor it was handed, and 1 to 100 rows. */
export const frozenClientSpenderAwaitingReplyQuerySchema = z.object({
  cursor: frozenCursor.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
