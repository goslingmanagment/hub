/**
 * `GET /api/v1/ops/live` — what Hub is doing right now, in one read-only
 * request for an operator screen (the server monitor): the requests sync has
 * just sent, what each page waits on, whether Hub's processes are alive, the
 * job queue and the open incidents.
 *
 * WHAT THE SCHEMA ENCODES: nothing here identifies a fan. An attempt carries
 * its page, registry key, wire operation and outcome — never its request
 * parameters, its work subject, a chat or fan id, a response body or an error
 * message; a hold carries its scope and kind, never its key. Every object is
 * strict, so a field added to the handler by mistake fails the response
 * instead of leaving with it.
 */

import { z } from "zod";

import { errorResponseSchema, isoTimestamp, platformEnum } from "./primitives.ts";
import { agentSyncWaitingReasonEnum, agentSyncWorkClassEnum } from "./routes-agent.ts";

const opsLiveCount = z.number().int().nonnegative();

/** The cursor an answer hands out: opaque, at most 200 characters. */
export const opsLiveCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

export const opsLiveQuerySchema = z.object({
  /** The `nextCursor` of the previous answer. Anything else — a cursor Hub
   *  cannot read, a repeated parameter — is answered as if it were absent,
   *  never with an error: hence `catch`, and no pattern here. */
  cursor: z.string().optional().catch(undefined),
});

export const opsLiveProcessSchema = z.object({
  role: z.string(),
  startedAt: isoTimestamp,
  lastSeenAt: isoTimestamp,
}).strict();

export const opsLiveHoldSchema = z.object({
  /** `page`, `route` or `resource`, as stored. */
  scope: z.string(),
  /** The stored kind (`network`, `auth`, `route_hold`, `route_budget`,
   *  `resource_breaker`, …). */
  kind: z.string(),
  /** null: a hold without an end. */
  until: isoTimestamp.nullable(),
}).strict();

export const opsLivePageSchema = z.object({
  label: z.string(),
  platform: platformEnum,
  /** The Fansly Sync Engine serves the page. */
  engine: z.boolean(),
  pausedAll: z.boolean(),
  pausedRequests: z.boolean(),
  pausedResources: z.array(z.string()),
  /** The holds in force now. */
  holds: z.array(opsLiveHoldSchema),
  /** Open, running and quarantined work rows. */
  openWork: opsLiveCount,
  /** Of them, open rows whose time has come: due, and not being served. */
  dueNow: opsLiveCount,
  /** The earliest future due time of an open row; null: none. */
  nextDueAt: isoTimestamp.nullable(),
  /** The open work by why it waits, in the engine's one closed dictionary —
   *  the same explanation as the owner's and the agents' sync status. */
  waiting: z.array(z.object({
    reason: agentSyncWaitingReasonEnum,
    count: z.number().int().positive(),
  }).strict()),
  /** The engine's last send for the page; null: none, or a page the engine
   *  does not serve. */
  lastSentAt: isoTimestamp.nullable(),
}).strict();

export const opsLiveAttemptSchema = z.object({
  /** Unique across both journals: `e…` the Sync Engine's, `l…` the older one. */
  id: z.string().regex(/^[el][1-9][0-9]*$/),
  page: z.string(),
  resource: z.string(),
  operation: z.string(),
  /** null in the older journal. */
  class: agentSyncWorkClassEnum.nullable(),
  sentAt: isoTimestamp,
  /** null while unanswered. */
  completedAt: isoTimestamp.nullable(),
  /** Ended without a usable answer. */
  failed: z.boolean(),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  responseBytes: z.number().int().nonnegative().nullable(),
}).strict();

export const opsLiveQueueSchema = z.object({
  /** Ready to run, not in a dead-letter queue. */
  waiting: opsLiveCount,
  active: opsLiveCount,
  failedLastHour: opsLiveCount,
  /** Parked in dead-letter queues. */
  deadLetters: opsLiveCount,
  oldestWaitingAgeMs: opsLiveCount.nullable(),
}).strict();

export const opsLiveIncidentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  stream: z.string().nullable(),
  openedAt: isoTimestamp,
  summary: z.string().max(160),
}).strict();

export const opsLiveResponseSchema = z.object({
  generatedAt: isoTimestamp,
  /** The source revision this Hub runs; null: the build does not say. */
  revision: z.string().nullable(),
  processes: z.array(opsLiveProcessSchema),
  /** The active, not deleted pages, by platform and label. */
  pages: z.array(opsLivePageSchema),
  /** Sent requests by send time, oldest first; at most 2000, the oldest
   *  dropped first. Merge by `id`: an unanswered request comes again,
   *  completed, in a later answer. */
  attempts: z.array(opsLiveAttemptSchema).max(2000),
  queue: opsLiveQueueSchema,
  incidents: z.array(opsLiveIncidentSchema),
  nextCursor: opsLiveCursorSchema,
}).strict();

export type OpsLiveResponse = z.infer<typeof opsLiveResponseSchema>;
export type OpsLivePage = z.infer<typeof opsLivePageSchema>;
export type OpsLiveAttempt = z.infer<typeof opsLiveAttemptSchema>;

export const opsLiveRouteSchemas = {
  opsLive: {
    // The monitoring token, or the owner's dashboard session — not the other
    // dashboard roles the `monitoring` kind admits: the answer covers every page.
    auth: { kind: "monitoring", roles: ["owner"] },
    tags: ["system"],
    summary:
      "What Hub is doing now: sync's sent requests since the cursor, each page's holds and why its work waits,"
      + " process heartbeats, the job queue and open incidents (read-only; nothing identifies a fan)",
    querystring: opsLiveQuerySchema,
    response: {
      200: opsLiveResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
} as const;
