/**
 * Стирание фана, the ledger's side: the ledger keeps its own copies of what Hub served it (report lines and their
 * notes, «мимо площадки», the old decisions' and questions' words, its sales' payloads), which Hub's erasure cannot
 * reach. This feed serves, after a cursor, every fan erasure Hub has completed, with what the ledger needs to find its
 * rows — the platform and the fan's ref, exactly as Hub's tombstone (`erasure_log`) keeps them — and nothing more: no
 * name, no sale ids (Hub keeps no list of the erased fan's sales: the anonymized sales are not tied back to him, and a
 * list here would tie them again). The ledger finds his sales by the fan id its own sales carry, and blanks the words.
 */
import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";

export const agentErasuresFeedQuerySchema = z.object({
  /** The `next` of the previous answer; absent — from the first erasure. */
  since: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const agentErasuresFeedItemSchema = z.object({
  /** The erasure's id in Hub (its tombstone); the feed's order and its cursor. */
  id: intId,
  platform: z.enum(["onlyfans", "fansly"]),
  /** The fan's platform id, as the fan scope named him (`fans.platform_user_id`). */
  fanRef: z.string(),
  /** When the erasure completed in Hub. */
  erasedAt: isoTimestamp,
});

export const agentErasuresFeedResponseSchema = z.object({
  erasures: z.array(agentErasuresFeedItemSchema),
  /** Ask again with `since` = this (the last erasure looked at, served or not); the same as asked when nothing is new. */
  next: z.string(),
  serverNow: isoTimestamp,
});

export type AgentErasuresFeedResponse = z.infer<typeof agentErasuresFeedResponseSchema>;
export type AgentErasuresFeedItem = z.infer<typeof agentErasuresFeedItemSchema>;

const errors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema,
  503: errorResponseSchema,
} as const;

export const erasureRouteSchemas = {
  agentErasuresFeed: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Every fan erasure Hub completed, after a cursor: the platform and the fan's ref, for the ledger to blank its own copies (needs read:team and read:money)",
    description: "Database only. An erasure is served once it completed (dry runs, page and model scopes never); erasures run "
      + "one at a time under one lock, so they complete in the order of their ids and `next` never passes one not served "
      + "yet. An erasure none of whose pages is in the key's grant is left out, and `next` moves past it.",
    querystring: agentErasuresFeedQuerySchema,
    response: { 200: agentErasuresFeedResponseSchema, ...errors },
  },
} as const;
