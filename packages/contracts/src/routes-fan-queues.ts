import {
  agentFanQueueAppendBodySchema,
  agentFanQueueAppendResponseSchema,
  agentFanQueueCreateBodySchema,
  agentFanQueueDetailSchema,
  agentFanQueueGetQuerySchema,
  agentFanQueueListQuerySchema,
  agentFanQueueListResponseSchema,
  agentFanQueuePageParamsSchema,
  agentFanQueueParamsSchema,
  agentFanQueuePreviewBodySchema,
  agentFanQueuePreviewResponseSchema,
  agentFanQueueSchema,
  agentFanQueueUpdateBodySchema,
  clientFanQueueItemDoneBodySchema,
  clientFanQueueItemDoneResponseSchema,
  clientFanQueueItemParamsSchema,
  clientFanQueueParamsSchema,
  clientFanQueueReleaseBodySchema,
  clientFanQueueReleaseResponseSchema,
  clientFanQueuesResponseSchema,
  clientFanQueueTakeBodySchema,
  clientFanQueueTakeResponseSchema,
} from "./fan-queues.ts";
import { errorResponseSchema } from "./primitives.ts";
import { clientPageParamsSchema } from "./routes-client.ts";

// Fan queues (docs/plans/2026-10-29-fan-queues/spec.md §13). An agent key with
// write:fan_queues previews, creates, changes and reads queues of its pages,
// each write on the word of the person who asked; the extension (a device
// token, capability `fan-queues-v1`) lists a person's queues, takes a portion
// of up to 10 fans and reports each fan's outcome. Database only: nothing here
// asks a platform or sends anything.

const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  // fan_queue_not_editable | requester_not_granted | person_not_granted
  409: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema,
} as const;
const clientErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema,
} as const;

export const fanQueueRouteSchemas = {
  agentFanQueuePreview: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "Count the fans a rule (or a list) puts in a queue of a granted page, what it leaves out and why, and say the rule in"
      + " Hub's own words, with a few fans for a look: nothing is written (needs write:fan_queues)",
    params: agentFanQueuePageParamsSchema,
    body: agentFanQueuePreviewBodySchema,
    response: { 200: agentFanQueuePreviewResponseSchema, ...agentErrors },
  },
  agentFanQueueCreate: {
    auth: { kind: "agentKey", scope: "page" }, tags: ["agent"],
    summary: "Create a fan queue on a granted page on the word of `requestedBy`, who must have the page: the rule's fans (or the"
      + " list's) in order, each with why; a fan already in an open queue of the page is left out. Replayable by idempotencyKey"
      + " (needs write:fan_queues)",
    params: agentFanQueuePageParamsSchema,
    body: agentFanQueueCreateBodySchema,
    response: { 200: agentFanQueueSchema, ...agentErrors },
  },
  agentFanQueueList: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The fan queues of the key's pages with their progress today and what is left (needs write:fan_queues)",
    querystring: agentFanQueueListQuerySchema,
    response: { 200: agentFanQueueListResponseSchema, ...agentErrors },
  },
  agentFanQueueGet: {
    // An id path, so no declarative page scope: the handler checks the grant.
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "One fan queue with its results: sent, answered within 72 hours, bought within 7 days, spent within 30 days, by person,"
      + " and skips and drops by reason (needs write:fan_queues)",
    params: agentFanQueueParamsSchema,
    querystring: agentFanQueueGetQuerySchema,
    response: { 200: agentFanQueueDetailSchema, ...agentErrors },
  },
  agentFanQueueUpdate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Change a fan queue on the word of `requestedBy` (its asker, the owner or a team lead): pause, resume or finish it,"
      + " its limits, people, goal or scenario, or hand one person's untouched fans to another (needs write:fan_queues)",
    params: agentFanQueueParamsSchema,
    body: agentFanQueueUpdateBodySchema,
    response: { 200: agentFanQueueSchema, ...agentErrors },
  },
  agentFanQueueAppend: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Add fans to a fan queue by a rule or a list, on the word of `requestedBy`; fans already queued on the page are left"
      + " out (needs write:fan_queues)",
    params: agentFanQueueParamsSchema,
    body: agentFanQueueAppendBodySchema,
    response: { 200: agentFanQueueAppendResponseSchema, ...agentErrors },
  },
  clientFanQueues: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "The caller's fan queues on the page: progress today, goal, scenario, who is in them, and the fans who answered the"
      + " caller's message from a queue within 72 hours",
    description: "Database only. A device token's, for an active page granted to the caller (else 409 `client_feature_disabled`"
      + " / `not_granted`). Active and paused queues the caller may work: pool queues open to every chatter of the page or naming"
      + " the caller, and people queues with fans of the caller. A standing queue refills from its rule once a Moscow day, on"
      + " the first take.",
    params: clientPageParamsSchema,
    response: { 200: clientFanQueuesResponseSchema, ...clientErrors },
  },
  clientFanQueueTake: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "Take a portion of a fan queue: the caller's untouched items first (their lease renewed), then the next ones, each"
      + " re-checked against what Hub knows now",
    description: "Database only. A fan who wrote, bought, was written to personally since he was queued, cannot be reached or is"
      + " marked «Не предлагать» leaves the queue with the reason; one another chatter is talking to, or written to within 48"
      + " hours, or from «Онлайн», a queue or an outreach within 21 days without an answer, waits. A portion is the caller's for 30 minutes,"
      + " renewed by each take; an expired one goes back to the queue. `stopped` says why nothing more came: the queue is"
      + " paused or done, the caller's portion for the day is done (`more` takes past it), the page's limit for the day is"
      + " reached, or nothing is left.",
    params: clientFanQueueParamsSchema,
    body: clientFanQueueTakeBodySchema,
    response: { 200: clientFanQueueTakeResponseSchema, ...clientErrors },
  },
  clientFanQueueItemDone: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "Report a fan of the caller's portion: sent (with what) or skipped (why); journaled first",
    description: "Database only. The item must be in the caller's portion (else 409 `fan_queue_item_not_leased`). A send whose"
      + " outcome is not known counts as sent. «Позже» puts the fan back in 3 days; «Не предлагать» also marks him for the team,"
      + " as «Онлайн» does; «Не подходит» and «Уже общаемся» take him out of the queue.",
    params: clientFanQueueItemParamsSchema,
    body: clientFanQueueItemDoneBodySchema,
    response: { 200: clientFanQueueItemDoneResponseSchema, ...clientErrors },
  },
  clientFanQueueRelease: {
    auth: { kind: "apiKey", scope: "page" }, tags: ["client"],
    summary: "Give the caller's untouched portion of a fan queue back (the window closed)",
    params: clientFanQueueParamsSchema,
    body: clientFanQueueReleaseBodySchema,
    response: { 200: clientFanQueueReleaseResponseSchema, ...clientErrors },
  },
} as const;
