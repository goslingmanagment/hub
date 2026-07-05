import { routeSchemas } from "@agency_hub_core/contracts";
import {
  getOfapiFanoutReplayWindow,
  listOfapiSyncEventsForReplay,
} from "@agency_hub_core/db";
import type { FastifyReply } from "fastify";

import {
  authenticateApiKeyToken,
  requireApiKeyUser,
} from "../../services/auth.ts";
import {
  createMonotonicSeqGuard,
  createSyncEventHub,
  type SyncEventFrame,
  type SyncEventHub,
} from "../../services/events-stream.ts";
import { getOfapiSyncSnapshot } from "../../services/ofapi-sync-snapshot.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Events module (target §6.1): the SSE stream + snapshot pair (§6.5). Handlers
// and the hub/stream lifecycle state relocated verbatim from server.ts
// (Stage 19 Task 3) — including the onClose teardown that keeps hijacked SSE
// responses from holding server.close() open.

export function registerEventsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  let syncEventHub: SyncEventHub | null = null;
  const activeSseStreams = new Set<FastifyReply["raw"]>();
  server.addHook("onClose", async () => {
    // Hijacked SSE responses would otherwise hold server.close() open forever.
    for (const stream of activeSseStreams) {
      stream.destroy();
    }
    activeSseStreams.clear();
    await syncEventHub?.close();
  });

  const SSE_REPLAY_BATCH_SIZE = 500;
  const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
  const SSE_AUTH_REVALIDATE_INTERVAL_MS = 60_000;
  // Streams are bounded so revoked keys / changed page assignments take effect:
  // clients transparently reconnect (retry: 3000) and re-authenticate, resuming
  // via Last-Event-ID.
  const SSE_MAX_LIFETIME_MS = 15 * 60 * 1000;
  // A client this far behind is not consuming; drop it and let replay catch it up.
  const SSE_MAX_BUFFERED_BYTES = 1_000_000;

  function sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>) {
    if (left.size !== right.size) {
      return false;
    }
    for (const value of left) {
      if (!right.has(value)) {
        return false;
      }
    }
    return true;
  }

  server.get("/api/v1/events/stream", {
    schema: routeSchemas.eventsStream,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    const pageIds: ReadonlySet<number> = new Set(principal.assignedPageIds);
    const authorization = request.headers.authorization;
    const bearerMatch = typeof authorization === "string"
      ? /^bearer\s+(.+)$/i.exec(authorization)
      : null;
    const apiKeyToken = bearerMatch?.[1]?.trim() ?? null;

    const lastEventIdHeader = request.headers["last-event-id"];
    const headerLastEventId = typeof lastEventIdHeader === "string"
      ? Number.parseInt(lastEventIdHeader, 10)
      : Number.NaN;
    const lastEventId = Number.isInteger(headerLastEventId) && headerLastEventId >= 0
      ? headerLastEventId
      : request.query.lastEventId ?? null;

    if (lastEventId !== null) {
      const replayWindow = await getOfapiFanoutReplayWindow(appContext.db);
      if (lastEventId > replayWindow.latestSeq) {
        return reply.code(409).send({
          error: "sync_snapshot_required",
          message: "Requested event cursor is ahead of the current replay sequence",
          statusCode: 409,
          version: 1,
          requestedSeq: lastEventId,
          oldestAvailableSeq: replayWindow.oldestRetainedSeq,
          currentSeq: replayWindow.latestSeq,
          snapshotPath: "/api/v1/events/snapshot",
        });
      }
      const replayGap = replayWindow.latestSeq > lastEventId
        && (
          replayWindow.oldestRetainedSeq === null
          || lastEventId < replayWindow.oldestRetainedSeq - 1
        );
      if (replayGap) {
        return reply.code(409).send({
          error: "sync_snapshot_required",
          message: "Requested event cursor is older than the retained replay window",
          statusCode: 409,
          version: 1,
          requestedSeq: lastEventId,
          oldestAvailableSeq: replayWindow.oldestRetainedSeq,
          currentSeq: replayWindow.latestSeq,
          snapshotPath: "/api/v1/events/snapshot",
        });
      }
    }

    // Wait for the shared LISTEN connection before the replay query so no frame
    // settles between journal catch-up and live delivery. Failure is tolerable:
    // the hub reconnects with its own journal catch-up.
    syncEventHub ??= createSyncEventHub(appContext);
    await syncEventHub.ready().catch(() => undefined);

    // Everything below bypasses fastify's serializer; errors must not bubble out.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write("retry: 3000\n\n");
    activeSseStreams.add(raw);

    // Monotonic seq guard: every frame write — replay, buffered flush, live —
    // goes through writeFrame, which drops anything at or below the highest id
    // already written (seeded from Last-Event-ID). A frame seen by both the
    // replay and a live broadcast goes out exactly once, and ids on the wire are
    // strictly increasing, which the strict `> Last-Event-ID` resume relies on.
    const seqGuard = createMonotonicSeqGuard(lastEventId);

    function writeFrame(frame: SyncEventFrame) {
      if (raw.writableEnded || raw.destroyed) {
        return;
      }
      if (!seqGuard.advance(frame.id)) {
        return;
      }
      if (raw.writableLength > SSE_MAX_BUFFERED_BYTES) {
        request.log.warn("SSE client not consuming; dropping connection");
        raw.destroy();
        return;
      }
      raw.write(`id: ${frame.id}\nevent: sync\ndata: ${JSON.stringify(frame.syncEvent)}\n\n`);
    }

    // Subscribe before the replay query; live frames buffer until replay
    // finishes, then flush through the seq guard.
    let replayDone = false;
    const bufferedLive: SyncEventFrame[] = [];
    const unsubscribe = syncEventHub.subscribe({
      pageIds,
      deliver(frame) {
        if (!replayDone) {
          bufferedLive.push(frame);
          return;
        }
        writeFrame(frame);
      },
    });

    const heartbeat = setInterval(() => {
      if (!raw.writableEnded && !raw.destroyed) {
        raw.write(": keep-alive\n\n");
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    const authRevalidate = setInterval(() => {
      void (async () => {
        if (raw.writableEnded || raw.destroyed) {
          return;
        }
        const refreshed = apiKeyToken
          ? await authenticateApiKeyToken(appContext, apiKeyToken)
          : null;
        if (!refreshed) {
          request.log.warn("SSE API key no longer authenticates; closing stream");
          raw.end();
          return;
        }
        const refreshedPageIds = new Set(refreshed.assignedPageIds);
        if (!sameNumberSet(pageIds, refreshedPageIds)) {
          request.log.warn("SSE page assignment changed; closing stream for re-auth");
          raw.end();
        }
      })().catch((error) => {
        request.log.warn({ err: error }, "SSE auth revalidation failed; closing stream");
        raw.end();
      });
    }, SSE_AUTH_REVALIDATE_INTERVAL_MS);
    authRevalidate.unref?.();
    const lifetimeTimer = setTimeout(() => {
      if (!raw.writableEnded && !raw.destroyed) {
        raw.end();
      }
    }, SSE_MAX_LIFETIME_MS);
    lifetimeTimer.unref?.();

    function cleanup() {
      clearInterval(heartbeat);
      clearInterval(authRevalidate);
      clearTimeout(lifetimeTimer);
      unsubscribe();
      activeSseStreams.delete(raw);
    }

    request.raw.on("close", cleanup);
    if (request.raw.destroyed) {
      // The client disconnected before the listener was registered.
      cleanup();
      raw.destroy();
      return;
    }

    let replayCursor = lastEventId;
    if (replayCursor !== null && pageIds.size > 0) {
      try {
        for (;;) {
          const rows = await listOfapiSyncEventsForReplay(appContext.db, {
            afterSeq: replayCursor,
            pageIds: [...pageIds],
            limit: SSE_REPLAY_BATCH_SIZE,
          });
          for (const row of rows) {
            writeFrame(row);
          }
          const lastRow = rows.at(-1);
          if (lastRow) {
            replayCursor = lastRow.id;
          }
          if (rows.length < SSE_REPLAY_BATCH_SIZE) {
            break;
          }
        }
      } catch (error) {
        request.log.warn({ err: error }, "SSE replay failed; closing stream");
        cleanup();
        raw.end();
        return;
      }
    }

    replayDone = true;
    for (const frame of bufferedLive) {
      writeFrame(frame);
    }
    bufferedLive.length = 0;
  });

  server.get("/api/v1/events/snapshot", {
    schema: routeSchemas.eventsSnapshot,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);
    return getOfapiSyncSnapshot(appContext, {
      assignedPageIds: principal.assignedPageIds,
      accountId: request.query.accountId,
      afterSeq: request.query.afterSeq,
      snapshotCursor: request.query.snapshotCursor,
      pageCursor: request.query.pageCursor,
      limit: request.query.limit,
    });
  });
}
