import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
  routeSchemas,
  type DomainEventsSnapshotRequired,
} from "@agency_hub_core/contracts";
import {
  getOfapiFanoutReplayWindow,
  listDomainEventAccountBounds,
  listDomainEventHighWaters,
  listEventsSince,
  listOfapiSyncEventsForReplay,
  listPageOfapiAccountRefs,
  type DomainEventRow,
} from "@agency_hub_core/db";
import type { FastifyReply } from "fastify";

import { pageScopeFor } from "../../api/request-auth.ts";
import {
  SESSION_COOKIE_NAME,
  authenticateBearerToken,
  authenticateSessionToken,
  requireApiKeyUser,
  type AuthPrincipal,
} from "../../services/auth.ts";
import { buildMessagePayloadEnrichments } from "../../services/domain-events-enrich.ts";
import {
  createAccountSeqGuards,
  createDomainEventHub,
  type DomainEventHub,
} from "../../services/domain-events-stream.ts";
import { BadRequestError, ForbiddenError } from "../../services/errors.ts";
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
  let domainEventHub: DomainEventHub | null = null;
  const activeSseStreams = new Set<FastifyReply["raw"]>();
  server.addHook("onClose", async () => {
    // Hijacked SSE responses would otherwise hold server.close() open forever.
    for (const stream of activeSseStreams) {
      stream.destroy();
    }
    activeSseStreams.clear();
    await syncEventHub?.close();
    await domainEventHub?.close();
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
          ? await authenticateBearerToken(appContext, apiKeyToken)
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

  // --- Event stream v2 (kernel Stage 21): domain_events, per-account order ---

  /** Granted account universe: undefined = every account (owner). */
  function grantedAccounts(principal: AuthPrincipal): ReadonlySet<number> | undefined {
    const scope = pageScopeFor(principal);
    return scope === undefined ? undefined : new Set(scope);
  }

  server.get("/api/v1/events/v2/stream", {
    schema: routeSchemas.eventsV2Stream,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const granted = grantedAccounts(principal);

    const authorization = request.headers.authorization;
    const bearerMatch = typeof authorization === "string"
      ? /^bearer\s+(.+)$/i.exec(authorization)
      : null;
    const apiKeyToken = bearerMatch?.[1]?.trim() ?? null;
    const sessionToken = request.cookies[SESSION_COOKIE_NAME] ?? null;

    const lastEventIdHeader = request.headers["last-event-id"];
    const cursorText = typeof lastEventIdHeader === "string" && lastEventIdHeader.length > 0
      ? lastEventIdHeader
      : request.query.cursor ?? null;

    // Resolve the starting watermarks: explicit cursor, or "now" (per-account
    // current high-waters over the granted universe).
    const heads = await listDomainEventHighWaters(appContext.db);
    const universe = granted === undefined
      ? new Set(heads.keys())
      : granted;

    let watermarks: Map<number, number>;
    if (cursorText !== null) {
      const decoded = decodeDomainEventCursor(cursorText);
      if (!decoded.ok) {
        throw new BadRequestError(`Invalid v2 cursor (${decoded.reason})`);
      }
      watermarks = decoded.watermarks;
      for (const accountId of watermarks.keys()) {
        if (granted !== undefined && !granted.has(accountId)) {
          throw new ForbiddenError("Cursor names an account outside the granted scope");
        }
      }
      // Granted accounts absent from the cursor start at "now" — a consumer
      // that gains a page mid-stream must not be forced through history.
      for (const accountId of universe) {
        if (!watermarks.has(accountId)) {
          watermarks.set(accountId, heads.get(accountId) ?? 0);
        }
      }
    } else {
      watermarks = new Map();
      for (const accountId of universe) {
        watermarks.set(accountId, heads.get(accountId) ?? 0);
      }
    }

    // Gap rule: a watermark ahead of the head never existed; one below the
    // account's retained floor cannot be replayed (floors become real with
    // Stage 28 tiering; the conformance test makes one synthetically).
    const bounds = await listDomainEventAccountBounds(appContext.db, [...watermarks.keys()]);
    const gapped: DomainEventsSnapshotRequired["accounts"] = [];
    for (const [accountId, watermark] of watermarks) {
      const bound = bounds.get(accountId)!;
      const ahead = watermark > bound.currentSeq;
      const floor = bound.oldestRetainedSeq ?? (bound.currentSeq + 1);
      const belowFloor = watermark < bound.currentSeq && watermark + 1 < floor;
      if (ahead || belowFloor) {
        gapped.push({
          accountId,
          requestedSeq: watermark,
          oldestAvailableSeq: bound.oldestRetainedSeq,
          currentSeq: bound.currentSeq,
        });
      }
    }
    if (gapped.length > 0) {
      return reply.code(409).send({
        error: "sync_snapshot_required",
        message: "Cursor cannot be replayed for one or more accounts",
        statusCode: 409,
        version: 2,
        accounts: gapped.sort((left, right) => left.accountId - right.accountId),
        snapshotPath: "/api/v1/events/v2/snapshot",
      });
    }

    domainEventHub ??= createDomainEventHub(appContext);
    await domainEventHub.ready().catch(() => undefined);

    // Stage 24: OFAPI-keyed clients (the desktop) filter frames by the
    // platform-native account ref; snapshot the mapping per connection (the
    // 15-min stream lifetime bounds staleness).
    const ofapiAccountRefs = await listPageOfapiAccountRefs(appContext.db);

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

    const guards = createAccountSeqGuards(watermarks);

    function writeV2Frame(event: DomainEventRow, payload?: unknown) {
      if (raw.writableEnded || raw.destroyed) {
        return;
      }
      const verdict = guards.advance(event.accountId, event.accountSeq);
      if (!verdict.deliver) {
        return;
      }
      if (verdict.gap) {
        // Gapless per account by construction (Stage 8) — a jump is a bug
        // signal, surfaced loudly, never a normal condition.
        request.log.error({
          accountId: event.accountId,
          accountSeq: event.accountSeq,
        }, "domain-event stream observed an account_seq gap");
      }
      if (raw.writableLength > SSE_MAX_BUFFERED_BYTES) {
        request.log.warn("v2 SSE client not consuming; dropping connection");
        raw.destroy();
        return;
      }
      const frame = {
        accountId: event.accountId,
        accountSeq: event.accountSeq,
        type: event.type,
        occurredAt: event.occurredAt.toISOString(),
        data: event.data,
        // Stage 24 serve-time fields (see domainEventFrameSchema).
        fanRef: event.fanIdentityRef,
        conversationRef: event.conversationRef,
        messageRef: event.messageRef,
        accountRef: ofapiAccountRefs.get(event.accountId) ?? null,
        ...(payload !== undefined ? { payload } : {}),
      };
      raw.write(`id: ${encodeDomainEventCursor(guards.watermarks())}\nevent: domain\ndata: ${JSON.stringify(frame)}\n\n`);
    }

    /** Live-path frame write: enrich one event, then write. Enrichment
     * failure degrades to an unenriched frame (the desktop falls back to its
     * reconciliation path), never a dropped connection. */
    async function writeV2FrameEnriched(event: DomainEventRow) {
      let enrichment: unknown;
      try {
        enrichment = (await buildMessagePayloadEnrichments(appContext, [event])).get(event.id);
      } catch (error) {
        request.log.warn({ err: error, eventId: event.id }, "v2 frame enrichment failed; serving thin frame");
      }
      writeV2Frame(event, enrichment);
    }

    // Subscribe before the replay so live frames buffer until replay flushes.
    // Live enrichment is async — chain deliveries so frames keep per-account
    // order even when observation fetches interleave.
    let replayDone = false;
    const bufferedLive: DomainEventRow[] = [];
    let liveChain: Promise<void> = Promise.resolve();
    const unsubscribe = domainEventHub.subscribe({
      accountIds: granted,
      deliver(event) {
        if (!replayDone) {
          bufferedLive.push(event);
          return;
        }
        liveChain = liveChain.then(() => writeV2FrameEnriched(event));
      },
    });

    // Stage 24 ephemeral lane: typing indicators are deliberately NOT
    // ledgered (append-only forever is the wrong home for a 5-second UI
    // hint), so the v2 stream forwards them from the v1 fanout hub as
    // `event: ephemeral` frames — no id line, never advancing the cursor.
    // Live-only by design: a missed typing hint has no replay value.
    syncEventHub ??= createSyncEventHub(appContext);
    const ephemeralPages: ReadonlySet<number> = granted ?? new Set(ofapiAccountRefs.keys());
    const unsubscribeEphemeral = syncEventHub.subscribe({
      pageIds: ephemeralPages,
      deliver(frame) {
        if (frame.syncEvent.type !== "typing" || raw.writableEnded || raw.destroyed) {
          return;
        }
        raw.write(`event: ephemeral\ndata: ${JSON.stringify(frame.syncEvent)}\n\n`);
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
          ? await authenticateBearerToken(appContext, apiKeyToken)
          : sessionToken
            ? await authenticateSessionToken(appContext, sessionToken)
            : null;
        if (!refreshed) {
          request.log.warn("v2 SSE credential no longer authenticates; closing stream");
          raw.end();
          return;
        }
        const refreshedGranted = grantedAccounts(refreshed);
        const changed = (granted === undefined) !== (refreshedGranted === undefined)
          || (granted !== undefined && refreshedGranted !== undefined
            && !sameNumberSet(granted, refreshedGranted));
        if (changed) {
          request.log.warn("v2 SSE grant set changed; closing stream for re-auth");
          raw.end();
        }
      })().catch((error) => {
        request.log.warn({ err: error }, "v2 SSE auth revalidation failed; closing stream");
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
      unsubscribeEphemeral();
      activeSseStreams.delete(raw);
    }

    request.raw.on("close", cleanup);
    if (request.raw.destroyed) {
      cleanup();
      raw.destroy();
      return;
    }

    // Per-account replay, batched; ordering is per account only (accounts are
    // independent streams multiplexed on one connection).
    try {
      for (const [accountId, watermark] of watermarks) {
        const bound = bounds.get(accountId)!;
        if (bound.currentSeq <= watermark) {
          continue;
        }
        let afterSeq = watermark;
        for (;;) {
          const rows = await listEventsSince(appContext.db, {
            accountId,
            afterSeq,
            limit: SSE_REPLAY_BATCH_SIZE,
          });
          const enrichments = await buildMessagePayloadEnrichments(appContext, rows)
            .catch((error) => {
              request.log.warn({ err: error }, "v2 replay enrichment failed; serving thin frames");
              return new Map<number, unknown>();
            });
          for (const row of rows) {
            writeV2Frame(row, enrichments.get(row.id));
          }
          const lastRow = rows.at(-1);
          if (lastRow) {
            afterSeq = lastRow.accountSeq;
          }
          if (rows.length < SSE_REPLAY_BATCH_SIZE) {
            break;
          }
        }
      }
    } catch (error) {
      request.log.warn({ err: error }, "v2 SSE replay failed; closing stream");
      cleanup();
      raw.end();
      return;
    }

    replayDone = true;
    const buffered = [...bufferedLive];
    bufferedLive.length = 0;
    for (const event of buffered) {
      liveChain = liveChain.then(() => writeV2FrameEnriched(event));
    }
  });

  server.get("/api/v1/events/v2/snapshot", {
    schema: routeSchemas.eventsV2Snapshot,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const granted = grantedAccounts(principal);
    const heads = await listDomainEventHighWaters(appContext.db);

    let accountIds: number[];
    if (request.query.accounts !== undefined) {
      accountIds = request.query.accounts.split(",").map((id) => Number(id));
      for (const accountId of accountIds) {
        if (granted !== undefined && !granted.has(accountId)) {
          throw new ForbiddenError("Requested account is outside the granted scope");
        }
      }
    } else {
      accountIds = granted === undefined ? [...heads.keys()] : [...granted];
    }

    const watermarks = new Map<number, number>();
    const accounts = accountIds
      .sort((left, right) => left - right)
      .map((accountId) => {
        const currentSeq = heads.get(accountId) ?? 0;
        watermarks.set(accountId, currentSeq);
        return { accountId, currentSeq };
      });

    return {
      cursor: encodeDomainEventCursor(watermarks),
      accounts,
    };
  });
}
