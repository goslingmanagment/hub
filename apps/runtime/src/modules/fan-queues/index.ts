import { createHash } from "node:crypto";

import { routeSchemas } from "@agency_hub_core/contracts";

import {
  appendFanQueueForAgent,
  completeClientFanQueueItem,
  createFanQueue,
  FAN_QUEUE_AGENT_TIMEOUT_MS,
  getFanQueueForAgent,
  listFanQueuesForAgent,
  previewFanQueue,
  readClientFanQueues,
  releaseClientFanQueue,
  takeClientFanQueue,
  updateFanQueueForAgent,
  type FanQueuePage,
} from "../../services/fan-queues.ts";
import { beginAgentRequest, staticNotFound, withAgentTimeout, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Fan queues (docs/plans/2026-10-29-fan-queues/spec.md §13). An agent key
 * with write:fan_queues previews, creates, changes and reads the queues of its
 * pages under `/api/v1/agent/…/fan-queues`, each write on the word of the
 * person who asked; the extension lists a person's queues, takes a portion,
 * reports each fan and gives a portion back under
 * `/api/v1/client/pages/:pageLabel/fan-queues`. Nothing here talks to a
 * platform.
 */
export function registerFanQueueRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  // --- Agent keys ----------------------------------------------------------

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["write:fan_queues"] });
    const pages: FanQueuePage[] = scope.pages.map((page) => ({ id: page.id, label: page.pageLabel, platform: page.platform }));
    return { principal, scope, pages };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>, rows: (result: T) => number) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = rows(result);
      return result;
    } finally {
      await scope.finish(delivered);
    }
  }

  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

  server.post("/api/v1/agent/pages/:pageLabel/fan-queues/preview", { schema: routeSchemas.agentFanQueuePreview }, async (request) => {
    const { principal, scope, pages } = await agentScope(request, "agentFanQueuePreview");
    return settled(scope, async () => {
      const page = pages.find((candidate) => candidate.label === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const now = new Date();
      const preview = await withAgentTimeout(db, FAN_QUEUE_AGENT_TIMEOUT_MS, (tx) => previewFanQueue(tx, { page, body: request.body, now }), "agent_fan_queue_preview");
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentFanQueuePreview",
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: { ruleSha256: digest(request.body.rule ?? request.body.fans), fans: preview.count },
      });
      return preview;
    }, (result) => result.samples.length);
  });

  server.post("/api/v1/agent/pages/:pageLabel/fan-queues", { schema: routeSchemas.agentFanQueueCreate }, async (request) => {
    const { principal, scope, pages } = await agentScope(request, "agentFanQueueCreate");
    return settled(scope, async () => {
      const page = pages.find((candidate) => candidate.label === request.params.pageLabel);
      if (!page) throw staticNotFound();
      const now = new Date();
      const created = await withAgentTimeout(db, FAN_QUEUE_AGENT_TIMEOUT_MS, (tx) => createFanQueue(appContext, tx, {
        page, body: request.body, agentKeyId: principal.agentKeyId, now,
      }), "agent_fan_queue_create");
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentFanQueueCreate",
        pageIds: [page.id],
        verbatimText: false,
        requestSummary: {
          queueId: created.queue.queueId,
          created: !created.replayed,
          fans: created.added,
          ruleSha256: digest(request.body.rule ?? request.body.fans),
        },
      });
      return created.queue;
    }, () => 1);
  });

  server.get("/api/v1/agent/fan-queues", { schema: routeSchemas.agentFanQueueList }, async (request) => {
    const { scope, pages } = await agentScope(request, "agentFanQueueList");
    return settled(scope, async () => ({
      queues: await listFanQueuesForAgent(appContext, db, { pages, query: request.query, now: new Date() }),
    }), (result) => result.queues.length);
  });

  server.get("/api/v1/agent/fan-queues/:queueId", { schema: routeSchemas.agentFanQueueGet }, async (request) => {
    const { scope, pages } = await agentScope(request, "agentFanQueueGet");
    return settled(scope, async () => withAgentTimeout(db, FAN_QUEUE_AGENT_TIMEOUT_MS, (tx) => getFanQueueForAgent(appContext, tx, {
      queueId: request.params.queueId, pageIds: pages.map((page) => page.id), query: request.query, now: new Date(),
    }), "agent_fan_queue_get"), () => 1);
  });

  server.patch("/api/v1/agent/fan-queues/:queueId", { schema: routeSchemas.agentFanQueueUpdate }, async (request) => {
    const { principal, scope, pages } = await agentScope(request, "agentFanQueueUpdate");
    return settled(scope, async () => {
      const queue = await withAgentTimeout(db, FAN_QUEUE_AGENT_TIMEOUT_MS, (tx) => updateFanQueueForAgent(appContext, tx, {
        queueId: request.params.queueId, pageIds: pages.map((page) => page.id), body: request.body, now: new Date(),
      }), "agent_fan_queue_update");
      const page = pages.find((candidate) => candidate.label === queue.pageLabel);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentFanQueueUpdate",
        pageIds: page === undefined ? [] : [page.id],
        verbatimText: false,
        requestSummary: { queueId: queue.queueId, ...(request.body.status === undefined ? {} : { queueStatus: request.body.status }) },
      });
      return queue;
    }, () => 1);
  });

  server.post("/api/v1/agent/fan-queues/:queueId/fans", { schema: routeSchemas.agentFanQueueAppend }, async (request) => {
    const { principal, scope, pages } = await agentScope(request, "agentFanQueueAppend");
    return settled(scope, async () => {
      const appended = await withAgentTimeout(db, FAN_QUEUE_AGENT_TIMEOUT_MS, (tx) => appendFanQueueForAgent(appContext, tx, {
        queueId: request.params.queueId, pages, body: request.body, now: new Date(),
      }), "agent_fan_queue_append");
      const page = pages.find((candidate) => candidate.label === appended.queue.pageLabel);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentFanQueueAppend",
        pageIds: page === undefined ? [] : [page.id],
        verbatimText: false,
        requestSummary: { queueId: appended.queue.queueId, fans: appended.added, ruleSha256: digest(request.body.rule ?? request.body.fans) },
      });
      return appended;
    }, () => 1);
  });

  // --- The extension -------------------------------------------------------

  server.get("/api/v1/client/pages/:pageLabel/fan-queues", { schema: routeSchemas.clientFanQueues }, async (request) => {
    const principal = await requirePrincipal(request);
    return readClientFanQueues(appContext, principal, { pageLabel: request.params.pageLabel });
  });

  server.post("/api/v1/client/pages/:pageLabel/fan-queues/:queueId/take", { schema: routeSchemas.clientFanQueueTake }, async (request) => {
    const principal = await requirePrincipal(request);
    return takeClientFanQueue(appContext, principal, { pageLabel: request.params.pageLabel, queueId: request.params.queueId, body: request.body });
  });

  server.post("/api/v1/client/pages/:pageLabel/fan-queues/items/:itemId/done", { schema: routeSchemas.clientFanQueueItemDone }, async (request) => {
    const principal = await requirePrincipal(request);
    return completeClientFanQueueItem(appContext, request, principal, { pageLabel: request.params.pageLabel, itemId: request.params.itemId, body: request.body });
  });

  server.post("/api/v1/client/pages/:pageLabel/fan-queues/:queueId/release", { schema: routeSchemas.clientFanQueueRelease }, async (request) => {
    const principal = await requirePrincipal(request);
    return releaseClientFanQueue(appContext, principal, { pageLabel: request.params.pageLabel, queueId: request.params.queueId });
  });
}
