/**
 * Fansly Sync Engine — the owner's routes (design §7.4).
 *
 * WHY A SEPARATE MODULE: these are owner-session routes with no agent envelope
 * (`delivery`/`capture`/`conclusion`), and the read plane's pins say every 200
 * of `agentRouteSchemas` carries one. The owner's history requests mirror the
 * agent operations in `routes-agent.ts` and share their wire shapes, so an
 * owner and an agent read the same request the same way (plan §4.1: agents and
 * the owner are equal requesters).
 *
 * `routes.ts` spreads `syncRouteSchemas` into `routeSchemas`; the dashboard and
 * the owner console reach them through the generated SDK with a cookie.
 */

import { z } from "zod";

import { errorResponseSchema } from "./primitives.ts";
import {
  agentHistoryFanIssues,
  agentHistoryItemSchema,
  agentHistoryItemStateEnum,
  agentHistoryPageParamsSchema,
  agentHistoryRequestBodyShape,
  agentHistoryRequestParamsSchema,
  agentHistoryRequestSchema,
  agentHistoryRequestStateEnum,
} from "./routes-agent.ts";

/** The agent create body without the agent-plane claim. */
export const syncHistoryRequestCreateBodySchema = z.object({
  ...agentHistoryRequestBodyShape,
}).strict().superRefine((value, ctx) => {
  for (const issue of agentHistoryFanIssues(value)) {
    ctx.addIssue({ code: "custom", ...issue });
  }
});

/** Paging over a request's fans: the ordinal after which the next page starts
 *  (the previous response's `nextAfterOrdinal`). */
const syncHistoryItemsPageShape = {
  limit: z.coerce.number().int().min(1).max(200).default(200),
  afterOrdinal: z.coerce.number().int().min(0).optional(),
};

export const syncHistoryRequestCreateResponseSchema = z.object({
  disposition: z.enum(["created", "coalesced"]),
  request: agentHistoryRequestSchema,
  items: z.array(agentHistoryItemSchema).max(200),
  /** null: every fan is in `items`. */
  nextAfterOrdinal: z.number().int().nonnegative().nullable(),
}).strict();

export const syncHistoryRequestGetQuerySchema = z.object({
  state: agentHistoryItemStateEnum.optional(),
  ...syncHistoryItemsPageShape,
}).strict();

export const syncHistoryRequestGetResponseSchema = z.object({
  request: agentHistoryRequestSchema,
  items: z.array(agentHistoryItemSchema).max(200),
  nextAfterOrdinal: z.number().int().nonnegative().nullable(),
}).strict();

export const syncHistoryRequestCancelBodySchema = z.object({
  /** Stored as a digest only. */
  reason: z.string().min(1).max(1000).optional(),
}).strict();

export const syncHistoryRequestCancelResponseSchema = z.object({
  disposition: z.enum(["cancelled", "already_cancelled", "already_done"]),
  request: agentHistoryRequestSchema,
}).strict();

export const syncHistoryRequestsQuerySchema = z.object({
  pageLabel: z.string().min(1).optional(),
  state: agentHistoryRequestStateEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const syncHistoryRequestsResponseSchema = z.object({
  requests: z.array(agentHistoryRequestSchema).max(200),
}).strict();

export const syncRouteSchemas = {
  syncHistoryRequests: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "History requests of every requester, newest first (Fansly Sync Engine)",
    querystring: syncHistoryRequestsQuerySchema,
    response: {
      200: syncHistoryRequestsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  syncHistoryRequestCreate: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary:
      "File a history request as the owner: 1..1000 fans of one page and a depth. Database only;"
      + " 409 history_requests_unavailable_on_page on a page not switched to the Fansly Sync Engine",
    params: agentHistoryPageParamsSchema,
    body: syncHistoryRequestCreateBodySchema,
    response: {
      200: syncHistoryRequestCreateResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      // history_requests_unavailable_on_page | idempotency_mismatch
      409: errorResponseSchema,
    },
  },
  syncHistoryRequestGet: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "One history request: counts, reads, ETA, why it waits, and a page of its fans",
    params: agentHistoryRequestParamsSchema,
    querystring: syncHistoryRequestGetQuerySchema,
    response: {
      200: syncHistoryRequestGetResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  syncHistoryRequestCancel: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Cancel a history request: its fans stop being read; loaded messages and chains stay",
    params: agentHistoryRequestParamsSchema,
    body: syncHistoryRequestCancelBodySchema,
    response: {
      200: syncHistoryRequestCancelResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
} as const;

export type SyncHistoryRequestCreateBody = z.infer<typeof syncHistoryRequestCreateBodySchema>;
export type SyncHistoryRequestCreateResponse = z.infer<typeof syncHistoryRequestCreateResponseSchema>;
export type SyncHistoryRequestGetQuery = z.infer<typeof syncHistoryRequestGetQuerySchema>;
export type SyncHistoryRequestGetResponse = z.infer<typeof syncHistoryRequestGetResponseSchema>;
export type SyncHistoryRequestCancelBody = z.infer<typeof syncHistoryRequestCancelBodySchema>;
export type SyncHistoryRequestCancelResponse = z.infer<typeof syncHistoryRequestCancelResponseSchema>;
export type SyncHistoryRequestsQuery = z.infer<typeof syncHistoryRequestsQuerySchema>;
export type SyncHistoryRequestsResponse = z.infer<typeof syncHistoryRequestsResponseSchema>;
