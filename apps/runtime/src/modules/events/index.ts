import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
  routeSchemas,
  type DomainEventCursorRecovery,
  type DomainEventsSnapshotRequired,
} from "@agency_hub_core/contracts";
import {
  getOfapiFanoutReplayWindow,
  getMaxOfapiFanoutSeq,
  getOfapiSyncReplayFloor,
  getDomainEventErasureEpoch,
  listOfapiStateSafeDomainEventWatermarks,
  listDomainEventAccountBounds,
  listDomainEventContiguousReplayEnds,
  listDomainEventHighWaters,
  listDomainEventRecoveryRetainedCounts,
  listDomainEventSnapshotRecoveryFloors,
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
import {
  BadRequestError,
  ForbiddenError,
  ServiceUnavailableError,
} from "../../services/errors.ts";
import {
  createMonotonicSeqGuard,
  createSyncEventHub,
  type SyncEventFrame,
  type SyncEventHub,
} from "../../services/events-stream.ts";
import { getOfapiSyncSnapshot } from "../../services/ofapi-sync-snapshot.ts";
import {
  createBoundedSseReplayBuffer,
  estimatedSseReplayItemBytes,
  projectionCheckpointHiddenCount,
  subscribeBeforeReplayBoundary,
  validateV2DeliverableReplayBatch,
} from "../../services/sse-replay-buffer.ts";
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
  // Separate from raw.writableLength: these objects arrive while the durable
  // replay query is still running and have not reached the socket yet.
  const SSE_MAX_PRE_REPLAY_BUFFERED_BYTES = 1_000_000;
  // TEMPORARY tourniquet, incident 2026-07-15 (decision #155): desktop ≤0.1.42
  // deterministically rejects message.ppv_unlocked frames (the canonicalizer
  // shipped the creator id as conversationRef) and wedges its cursor in a
  // reconnect loop that burns paid OFAPI reads (~14k credits/night). Suppressing
  // the frame at serve time — the account watermark still advances with the next
  // delivered frame — unwedges the whole fleet with one deploy and loses nothing
  // consumers use: the ledgered event is wrong-ref'd anyway and its projections
  // are v1 no-ops. REMOVE once x-client-version on the read gateway shows the
  // fleet on a desktop whose ppvUnlocked handler is non-rejecting (its D17).
  const SUPPRESSED_V2_FRAME_TYPES: ReadonlySet<string> = new Set(["message.ppv_unlocked"]);

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
      const replayFloor = await getOfapiSyncReplayFloor(appContext.db);
      if (lastEventId < replayFloor) {
        return reply.code(409).send({
          error: "sync_snapshot_required",
          message: `Requested event cursor is below replay continuity floor ${replayFloor}`,
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
    try {
      await syncEventHub.ready();
    } catch (error) {
      request.log.warn({ err: error }, "SSE LISTEN lane unavailable; rejecting stream");
      throw new ServiceUnavailableError("Event stream is temporarily unavailable");
    }

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
    let continuityCursor = lastEventId;

    function writeFrame(frame: SyncEventFrame) {
      if (raw.writableEnded || raw.destroyed) {
        return;
      }
      if (!seqGuard.advance(frame.id)) {
        return;
      }
      continuityCursor = continuityCursor === null
        ? frame.id
        : Math.max(continuityCursor, frame.id);
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
    const bufferedLive = createBoundedSseReplayBuffer<SyncEventFrame>({
      maxBytes: SSE_MAX_PRE_REPLAY_BUFFERED_BYTES,
      sizeOf: (frame) => estimatedSseReplayItemBytes(frame),
      onOverflow: () => {
        request.log.warn("SSE pre-replay live buffer exceeded; dropping connection for lossless resume");
        raw.destroy();
      },
    });
    let replayCeiling: number | null;
    let unsubscribe: () => void;
    try {
      const captured = await subscribeBeforeReplayBoundary({
        subscribe: () => syncEventHub!.subscribe({
          pageIds,
          continuityLost(replayFloor) {
            if (continuityCursor === null || continuityCursor >= replayFloor) {
              return;
            }
            request.log.warn(
              { replayFloor, continuityCursor },
              "SSE live continuity was lost; closing stream for snapshot recovery",
            );
            raw.end();
          },
          deliver(frame) {
            if (!replayDone) {
              bufferedLive.push(frame);
              return;
            }
            writeFrame(frame);
          },
        }),
        loadBoundary: async () => ({
          replayWindow: await getOfapiFanoutReplayWindow(appContext.db),
          // Unlike sequence.last_value, this cannot include an uncommitted
          // settle. Commits after subscribe are already in the live buffer.
          committedHighWater: await getMaxOfapiFanoutSeq(appContext.db),
        }),
      });
      unsubscribe = captured.unsubscribe;
      replayCeiling = lastEventId === null ? null : captured.boundary.committedHighWater;
      continuityCursor ??= captured.boundary.committedHighWater;
      const replayFloor = lastEventId === null || replayCeiling === null
        ? null
        : await getOfapiSyncReplayFloor(appContext.db);
      if (
        lastEventId !== null
        && (
          (replayFloor !== null && lastEventId < replayFloor)
          || (
            captured.boundary.committedHighWater > lastEventId
            && (
              captured.boundary.replayWindow.oldestRetainedSeq === null
              || lastEventId < captured.boundary.replayWindow.oldestRetainedSeq - 1
            )
          )
        )
      ) {
        request.log.warn(
          { replayFloor },
          "SSE replay continuity moved after validation; closing stream for snapshot recovery",
        );
        unsubscribe();
        activeSseStreams.delete(raw);
        raw.destroy();
        return;
      }
    } catch (error) {
      request.log.warn({ err: error }, "SSE replay boundary capture failed; closing stream");
      activeSseStreams.delete(raw);
      raw.destroy();
      return;
    }

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
    if (request.raw.destroyed || raw.destroyed || raw.writableEnded) {
      // The client disconnected before the listener was registered.
      cleanup();
      if (!raw.destroyed) {
        raw.destroy();
      }
      return;
    }

    let replayCursor = lastEventId;
    if (replayCursor !== null && replayCeiling !== null && pageIds.size > 0) {
      try {
        for (;;) {
          if (bufferedLive.overflowed || raw.destroyed || raw.writableEnded) {
            return;
          }
          const rows = await listOfapiSyncEventsForReplay(appContext.db, {
            afterSeq: replayCursor,
            throughSeq: replayCeiling,
            pageIds: [...pageIds],
            limit: SSE_REPLAY_BATCH_SIZE,
          });
          const replayFloor = await getOfapiSyncReplayFloor(appContext.db);
          if (replayCursor < replayFloor) {
            throw new Error(`SSE replay cursor is below continuity floor ${replayFloor}`);
          }
          for (const row of rows) {
            writeFrame(row);
          }
          const lastRow = rows.at(-1);
          if (lastRow) {
            replayCursor = lastRow.id;
          }
          if (replayCursor >= replayCeiling || rows.length < SSE_REPLAY_BATCH_SIZE) {
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

    if (bufferedLive.overflowed || raw.destroyed || raw.writableEnded) {
      return;
    }
    if (replayCursor !== null) {
      const replayFloor = await getOfapiSyncReplayFloor(appContext.db);
      if (replayCursor < replayFloor) {
        request.log.warn(
          { replayFloor },
          "SSE replay continuity changed before live flush; closing stream",
        );
        cleanup();
        raw.end();
        return;
      }
    }
    replayDone = true;
    for (const frame of bufferedLive.drain()) {
      writeFrame(frame);
    }
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
      pageCursor: request.query.pageCursor,
      limit: request.query.limit,
      messageLimit: request.query.messageLimit,
      ...(request.query.snapshotCursor === undefined
        ? {}
        : { snapshotCursor: request.query.snapshotCursor }),
      ...(request.query.pageMode === undefined ? {} : { pageMode: request.query.pageMode }),
      ...(request.query.stateCursor === undefined
        ? {}
        : { stateCursor: request.query.stateCursor }),
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
    let grantScopeBound = false;
    let snapshotRecoveryReplay = false;
    let snapshotRecovery: DomainEventCursorRecovery | null = null;
    if (cursorText !== null) {
      const decoded = decodeDomainEventCursor(cursorText);
      if (!decoded.ok) {
        throw new BadRequestError(`Invalid v2 cursor (${decoded.reason})`);
      }
      watermarks = decoded.watermarks;
      grantScopeBound = decoded.scope === "granted";
      snapshotRecovery = decoded.recovery;
      snapshotRecoveryReplay = snapshotRecovery?.kind === "snapshot";
      for (const accountId of watermarks.keys()) {
        if (granted !== undefined && !granted.has(accountId)) {
          throw new ForbiddenError("Cursor names an account outside the granted scope");
        }
      }
      if (!grantScopeBound) {
        // Legacy and explicitly subset-scoped cursors retain the additive
        // behavior. Fresh full-scope snapshot cursors below are marked and
        // must never be widened this way: doing so could skip an event between
        // a consumer's state walk and its reconnect.
        for (const accountId of universe) {
          if (!watermarks.has(accountId)) {
            watermarks.set(accountId, heads.get(accountId) ?? 0);
          }
        }
      }
    } else {
      // Cursorless "now" also captures the complete current grant universe.
      // Mark every cursor subsequently emitted by this connection so a later
      // auth-driven grant change cannot widen it at a new account's head.
      grantScopeBound = true;
      watermarks = new Map();
      for (const accountId of universe) {
        watermarks.set(accountId, heads.get(accountId) ?? 0);
      }
    }

    // Gap rule: a watermark ahead of the head never existed; one below the
    // account's retained floor cannot be replayed (floors become real with
    // Stage 28 tiering; the conformance test makes one synthetically). If a
    // hole lies after a retained contiguous prefix, let the stream deliver
    // that prefix first. It may contain behavior that the state snapshot does
    // not materialize; the stream closes at the prefix ceiling and the next
    // request receives 409 at the now-immediate hole.
    const cursorAccounts = new Set(watermarks.keys());
    const addedGrantAccounts = grantScopeBound
      ? [...universe].filter((accountId) => !cursorAccounts.has(accountId))
      : [];
    const validationBounds = await listDomainEventAccountBounds(
      appContext.db,
      [...new Set([...watermarks.keys(), ...addedGrantAccounts])],
    );
    const validationReplayEnds = await listDomainEventContiguousReplayEnds(
      appContext.db,
      [...watermarks].map(([accountId, afterSeq]) => ({
        accountId,
        afterSeq,
        throughSeq: validationBounds.get(accountId)!.currentSeq,
      })),
      { excludeProjectionOnly: true },
    );
    const recoveryErasureState = snapshotRecoveryReplay
      ? await getDomainEventErasureEpoch(appContext.db)
      : null;
    const recoveryRetainedCounts = snapshotRecovery === null
      ? null
      : await listDomainEventRecoveryRetainedCounts(
        appContext.db,
        [...snapshotRecovery.base].map(([accountId, baseSeq]) => ({
          accountId,
          baseSeq,
          targetSeq: snapshotRecovery!.targets.get(accountId)!,
        })),
      );
    const recoveryTopologyChanged = snapshotRecovery !== null && (
      [...snapshotRecovery.targets].some(([accountId, targetSeq]) => (
        (validationBounds.get(accountId)?.currentSeq ?? -1) < targetSeq
        || recoveryRetainedCounts?.get(accountId) !== snapshotRecovery!.retainedCounts.get(accountId)
      ))
    );
    const snapshotRecoveryInvalid = recoveryErasureState !== null && (
      recoveryErasureState.incomplete
      || recoveryErasureState.epoch !== snapshotRecovery!.erasureEpoch
      || recoveryTopologyChanged
    );
    const gapped: DomainEventsSnapshotRequired["accounts"] = [];
    // A full-grant snapshot cursor commits its exact account keyset. If a page
    // was granted after minting, force another state snapshot rather than
    // manufacturing the missing watermark at the current head.
    for (const accountId of addedGrantAccounts) {
      const bound = validationBounds.get(accountId)!;
      gapped.push({
        accountId,
        requestedSeq: 0,
        oldestAvailableSeq: bound.oldestRetainedSeq,
        currentSeq: bound.currentSeq,
      });
    }
    for (const [accountId, watermark] of watermarks) {
      const bound = validationBounds.get(accountId)!;
      const ahead = watermark > bound.currentSeq;
      const floor = bound.oldestRetainedSeq ?? (bound.currentSeq + 1);
      const belowFloor = watermark < bound.currentSeq && watermark + 1 < floor;
      const immediateHole = watermark < bound.currentSeq
        && (validationReplayEnds.get(accountId) ?? watermark) <= watermark;
      if (
        snapshotRecoveryInvalid
        || ahead
        || (!snapshotRecoveryReplay && (belowFloor || immediateHole))
      ) {
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
    try {
      await domainEventHub.ready();
    } catch (error) {
      request.log.warn({ err: error }, "v2 SSE LISTEN lane unavailable; rejecting stream");
      throw new ServiceUnavailableError("Event stream is temporarily unavailable");
    }

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

    function encodedConnectionCursor() {
      return encodeDomainEventCursor(guards.watermarks(), {
        ...(grantScopeBound ? { scope: "granted" as const } : {}),
        ...(snapshotRecoveryReplay
          ? {
            recovery: snapshotRecovery!,
          }
          : {}),
      });
    }

    function writeV2Frame(
      event: DomainEventRow,
      payload?: unknown,
      allowSnapshotGap = false,
    ) {
      if (raw.writableEnded || raw.destroyed) {
        return;
      }
      const hiddenCount = projectionCheckpointHiddenCount(event);
      const verdict = allowSnapshotGap
        ? { ...guards.advanceAfterSnapshot(event.accountId, event.accountSeq), gap: false }
        : hiddenCount === null
          ? guards.advance(event.accountId, event.accountSeq)
          : guards.advanceProjectionCheckpoint(
            event.accountId,
            event.accountSeq,
            hiddenCount,
          );
      if (verdict.gap) {
        request.log.error({
          accountId: event.accountId,
          accountSeq: event.accountSeq,
        }, "domain-event stream observed an account_seq gap; closing at safe cursor");
        raw.end();
        return;
      }
      if (!verdict.deliver) {
        return;
      }
      if (SUPPRESSED_V2_FRAME_TYPES.has(event.type)) {
        return; // watermark advanced above; the next frame's id carries it
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
      raw.write(`id: ${encodedConnectionCursor()}\nevent: domain\ndata: ${JSON.stringify(frame)}\n\n`);
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
    const bufferedLive = createBoundedSseReplayBuffer<DomainEventRow>({
      maxBytes: SSE_MAX_PRE_REPLAY_BUFFERED_BYTES,
      sizeOf: (event) => estimatedSseReplayItemBytes(event),
      onOverflow: () => {
        request.log.warn("v2 SSE pre-replay live buffer exceeded; dropping connection for lossless resume");
        raw.destroy();
      },
    });
    let liveChain: Promise<void> = Promise.resolve();
    let replayBounds: Awaited<ReturnType<typeof listDomainEventAccountBounds>>;
    const replayThroughByAccount = new Map<number, number>();
    let closeAfterReplayPrefix = false;
    let unsubscribe: () => void;
    try {
      const captured = await subscribeBeforeReplayBoundary({
        subscribe: () => domainEventHub!.subscribe({
          accountIds: granted,
          continuityLost(accountId, _afterSeq, throughSeq) {
            const watermark = guards.watermarks().get(accountId) ?? 0;
            if (watermark >= throughSeq) {
              return;
            }
            request.log.warn(
              { accountId, watermark, throughSeq },
              "v2 SSE live continuity was lost; closing stream for snapshot recovery",
            );
            raw.end();
          },
          deliver(event) {
            if (!replayDone) {
              bufferedLive.push(event);
              return;
            }
            liveChain = liveChain.then(() => writeV2FrameEnriched(event));
          },
        }),
        loadBoundary: () => listDomainEventAccountBounds(
          appContext.db,
          [...watermarks.keys()],
        ),
      });
      unsubscribe = captured.unsubscribe;
      replayBounds = captured.boundary;
      const replayEnds = await listDomainEventContiguousReplayEnds(
        appContext.db,
        [...watermarks].map(([accountId, afterSeq]) => ({
          accountId,
          afterSeq,
          throughSeq: replayBounds.get(accountId)?.currentSeq ?? 0,
        })),
        { excludeProjectionOnly: true },
      );
      for (const [accountId, watermark] of watermarks) {
        const bound = replayBounds.get(accountId);
        const floor = bound?.oldestRetainedSeq ?? ((bound?.currentSeq ?? 0) + 1);
        const replayThrough = snapshotRecoveryReplay
          ? snapshotRecovery!.targets.get(accountId) ?? watermark
          : replayEnds.get(accountId) ?? watermark;
        if (
          bound === undefined
          || watermark > bound.currentSeq
          || (!snapshotRecoveryReplay && watermark < bound.currentSeq && watermark + 1 < floor)
          || (!snapshotRecoveryReplay && watermark < bound.currentSeq && replayThrough <= watermark)
        ) {
          request.log.warn(
            { accountId },
            "v2 SSE replay bounds moved after validation; closing stream",
          );
          unsubscribe();
          activeSseStreams.delete(raw);
          raw.destroy();
          return;
        }
        replayThroughByAccount.set(accountId, replayThrough);
        closeAfterReplayPrefix ||= !snapshotRecoveryReplay && replayThrough < bound.currentSeq;
      }
    } catch (error) {
      request.log.warn({ err: error }, "v2 SSE replay boundary capture failed; closing stream");
      activeSseStreams.delete(raw);
      raw.destroy();
      return;
    }

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
    if (request.raw.destroyed || raw.destroyed || raw.writableEnded) {
      cleanup();
      if (!raw.destroyed) {
        raw.destroy();
      }
      return;
    }

    // Per-account replay, batched; ordering is per account only (accounts are
    // independent streams multiplexed on one connection).
    try {
      for (const [accountId, watermark] of watermarks) {
        const bound = replayBounds.get(accountId)!;
        const replayThrough = replayThroughByAccount.get(accountId) ?? bound.currentSeq;
        if (replayThrough <= watermark) {
          continue;
        }
        let afterSeq = watermark;
        for (;;) {
          if (bufferedLive.overflowed || raw.destroyed || raw.writableEnded) {
            return;
          }
          const rows = await listEventsSince(appContext.db, {
            accountId,
            afterSeq,
            throughSeq: replayThrough,
            limit: SSE_REPLAY_BATCH_SIZE,
            excludeProjectionOnly: true,
          });
          const continuity = snapshotRecoveryReplay
            ? null
            : validateV2DeliverableReplayBatch({
              rows,
              afterSeq,
              throughSeq: replayThrough,
              limit: SSE_REPLAY_BATCH_SIZE,
            });
          if (continuity !== null && !continuity.ok) {
            throw new Error(`domain-event replay interval contains a gap for account ${accountId}`);
          }
          const enrichments = await buildMessagePayloadEnrichments(appContext, rows)
            .catch((error) => {
              request.log.warn({ err: error }, "v2 replay enrichment failed; serving thin frames");
              return new Map<number, unknown>();
            });
          for (const row of rows) {
            writeV2Frame(row, enrichments.get(row.id), snapshotRecoveryReplay);
          }
          if (snapshotRecoveryReplay) {
            const lastRetainedSeq = rows.at(-1)?.accountSeq;
            if (lastRetainedSeq === undefined || lastRetainedSeq >= replayThrough) {
              break;
            }
            afterSeq = lastRetainedSeq;
            continue;
          }
          afterSeq = continuity!.nextSeq;
          if (continuity!.done) {
            break;
          }
        }
        if (snapshotRecoveryReplay) {
          // A tail hole has no retained row whose frame could carry the captured
          // high-water. Advance only the in-memory recovery guard; the explicit
          // completion frame below publishes this watermark atomically after
          // every account's retained rows have been delivered.
          guards.advanceAfterSnapshot(accountId, replayThrough);
        }
      }
    } catch (error) {
      request.log.warn({ err: error }, "v2 SSE replay failed; closing stream");
      cleanup();
      raw.end();
      return;
    }

    if (bufferedLive.overflowed || raw.destroyed || raw.writableEnded) {
      return;
    }
    if (closeAfterReplayPrefix) {
      request.log.warn(
        "v2 SSE drained the retained prefix before an erased sequence hole; closing for recovery",
      );
      cleanup();
      raw.end();
      return;
    }
    let completedSnapshotRecovery = false;
    if (snapshotRecoveryReplay) {
      // v0.1.41 does not send sourceCursor back to the snapshot endpoint. Its
      // opaque v4 cursor is persisted only after the complete state walk, so it
      // authorizes replaying every retained behavioral event across erased
      // account_seq values. Publish one ignored-but-valid domain frame with a
      // normal cursor only after every account reached the captured boundary;
      // a crash before this frame resumes in recovery mode, while live fan-out
      // after it is strict and gapless again.
      const completionErasureState = await getDomainEventErasureEpoch(appContext.db);
      const completionRetainedCounts = await listDomainEventRecoveryRetainedCounts(
        appContext.db,
        [...snapshotRecovery!.base].map(([accountId, baseSeq]) => ({
          accountId,
          baseSeq,
          targetSeq: snapshotRecovery!.targets.get(accountId)!,
        })),
      );
      if (
        completionErasureState.incomplete
        || completionErasureState.epoch !== snapshotRecovery!.erasureEpoch
        || [...snapshotRecovery!.retainedCounts].some(
          ([accountId, retainedCount]) => completionRetainedCounts.get(accountId) !== retainedCount,
        )
      ) {
        request.log.warn(
          {
            cursorErasureEpoch: snapshotRecovery!.erasureEpoch,
            currentErasureEpoch: completionErasureState.epoch,
            incompleteErasure: completionErasureState.incomplete,
          },
          "v2 snapshot recovery invalidated by erasure; closing before ordinary checkpoint",
        );
        cleanup();
        raw.end();
        return;
      }
      const checkpoint = [...guards.watermarks()].find(([, seq]) => seq > 0);
      snapshotRecoveryReplay = false;
      completedSnapshotRecovery = true;
      if (checkpoint !== undefined) {
        const [accountId, accountSeq] = checkpoint;
        const frame = {
          accountId,
          accountSeq,
          type: "stream.snapshot_replay_completed",
          occurredAt: new Date().toISOString(),
          data: null,
          accountRef: ofapiAccountRefs.get(accountId) ?? null,
        };
        // Same closed-stream guard as writeV2Frame: the awaits above race
        // lifetime/auth/gap raw.end() calls, and an unlistened write-after-end
        // is a process-fatal stream error.
        if (!raw.writableEnded && !raw.destroyed) {
          raw.write(`id: ${encodedConnectionCursor()}\nevent: domain\ndata: ${JSON.stringify(frame)}\n\n`);
        }
      }
    }
    if (completedSnapshotRecovery) {
      // Events committed after snapshot mint but before the subscribe boundary
      // are outside the marker's immutable target. Catch them up only after the
      // ordinary checkpoint, using the normal gapless proof. A hole here closes
      // at the target cursor and forces a new state recovery on reconnect.
      try {
        for (const [accountId, afterRecoverySeq] of guards.watermarks()) {
          const throughSeq = replayBounds.get(accountId)?.currentSeq ?? afterRecoverySeq;
          if (throughSeq <= afterRecoverySeq) continue;
          let afterSeq = afterRecoverySeq;
          for (;;) {
            // The completion-marker awaits above race lifetime/auth raw.end();
            // a dead connection must not keep paying for batch reads and
            // enrichment it can never deliver (writeV2Frame would only skip
            // each frame after the work was already done).
            if (raw.writableEnded || raw.destroyed) {
              cleanup();
              return;
            }
            const rows = await listEventsSince(appContext.db, {
              accountId,
              afterSeq,
              throughSeq,
              limit: SSE_REPLAY_BATCH_SIZE,
              excludeProjectionOnly: true,
            });
            const continuity = validateV2DeliverableReplayBatch({
              rows,
              afterSeq,
              throughSeq,
              limit: SSE_REPLAY_BATCH_SIZE,
            });
            if (!continuity.ok) {
              throw new Error(`post-snapshot replay interval contains a gap for account ${accountId}`);
            }
            // The stream may have died during the batch read itself — recheck
            // before paying for enrichment whose frames would all be skipped.
            if (raw.writableEnded || raw.destroyed) {
              cleanup();
              return;
            }
            const enrichments = await buildMessagePayloadEnrichments(appContext, rows)
              .catch((error) => {
                request.log.warn(
                  { err: error },
                  "v2 post-snapshot replay enrichment failed; serving thin frames",
                );
                return new Map<number, unknown>();
              });
            for (const row of rows) {
              writeV2Frame(row, enrichments.get(row.id));
            }
            afterSeq = continuity.nextSeq;
            if (continuity.done) break;
          }
        }
      } catch (error) {
        request.log.warn({ err: error }, "v2 post-snapshot replay failed; closing stream");
        cleanup();
        raw.end();
        return;
      }
    }
    replayDone = true;
    // A connection that died during the replay awaits must stop here: the
    // marker write would be a stream error and the buffered flush would pay
    // for enrichment it can never deliver.
    if (raw.writableEnded || raw.destroyed) {
      cleanup();
      return;
    }
    // Live/replay boundary for clients (desktop notification gate): every
    // frame after this marker on this connection is live delivery, not
    // catch-up. Written before the buffered flush so frames that arrived
    // during replay correctly land on the live side. A dedicated `control`
    // SSE event keeps the marker outside the DomainEventFrame contract:
    // SDK subscribers skip non-domain event names by design (the
    // `event: ephemeral` rule), so no synthetic accountId/accountSeq ever
    // reaches their frame validation.
    raw.write(
      `id: ${encodedConnectionCursor()}\nevent: control\ndata: ${JSON.stringify({
        type: "replay_completed",
      })}\n\n`,
    );
    const buffered = bufferedLive.drain();
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

    let sourceCursor: Extract<ReturnType<typeof decodeDomainEventCursor>, { ok: true }> | null = null;
    if (request.query.sourceCursor !== undefined) {
      const decoded = decodeDomainEventCursor(request.query.sourceCursor);
      if (!decoded.ok) {
        throw new BadRequestError(`Invalid v2 source cursor (${decoded.reason})`);
      }
      sourceCursor = decoded;
    }
    // A source cursor is supplied only after the caller has durably applied
    // every frame through those watermarks and is about to replace older
    // state with the per-account snapshot walk. An account absent from an
    // exact-grant cursor is newly granted and baselines at the head captured
    // above; absence from a subset/legacy cursor proves nothing and stays at
    // zero. An ahead-of-head source is not a trustworthy applied watermark,
    // so it also falls back to zero instead of skipping retained blockers.
    // Legacy callers have no source cursor; starting them at zero preserves
    // the old barrier behavior while still advancing beyond an immediate
    // deleted prefix/internal/tail hole.
    const recoveryFloors = await listDomainEventSnapshotRecoveryFloors(
      appContext.db,
      accountIds.map((accountId) => {
        const throughSeq = heads.get(accountId) ?? 0;
        const sourceSeq = sourceCursor?.watermarks.get(accountId);
        const afterSeq = sourceCursor === null
          ? 0
          : sourceSeq === undefined
            ? sourceCursor.scope === "granted" ? throughSeq : 0
            : sourceSeq <= throughSeq ? sourceSeq : 0;
        return { accountId, afterSeq, throughSeq };
      }),
    );

    const stateSafe = await listOfapiStateSafeDomainEventWatermarks(
      appContext.db,
      accountIds,
      recoveryFloors,
    );
    const watermarks = new Map<number, number>();
    const accounts = accountIds
      .sort((left, right) => left - right)
      .map((accountId) => {
        const accountWatermark = stateSafe.get(accountId);
        const currentSeq = accountWatermark?.currentSeq ?? 0;
        watermarks.set(accountId, accountWatermark?.safeSeq ?? currentSeq);
        return {
          accountId,
          accountRef: accountWatermark?.accountRef ?? null,
          currentSeq,
        };
      });
    const legacySnapshotRecovery = sourceCursor === null
      && accounts.some((account) => (watermarks.get(account.accountId) ?? account.currentSeq) < account.currentSeq);
    const legacyRecoveryErasureState = legacySnapshotRecovery
      ? await getDomainEventErasureEpoch(appContext.db)
      : null;
    if (legacyRecoveryErasureState?.incomplete) {
      throw new ServiceUnavailableError(
        "Event snapshot recovery is temporarily unavailable during erasure",
      );
    }
    const legacyRecoveryTargets = new Map(
      accounts.map((account) => [account.accountId, account.currentSeq]),
    );
    const legacyRecoveryRetainedCounts = legacyRecoveryErasureState === null
      ? null
      : await listDomainEventRecoveryRetainedCounts(
        appContext.db,
        [...watermarks].map(([accountId, baseSeq]) => ({
          accountId,
          baseSeq,
          targetSeq: legacyRecoveryTargets.get(accountId)!,
        })),
      );

    return {
      cursor: encodeDomainEventCursor(
        watermarks,
        {
          ...(request.query.accounts === undefined ? { scope: "granted" as const } : {}),
          ...(legacyRecoveryErasureState === null
            ? {}
            : {
              recovery: {
                kind: "snapshot" as const,
                erasureEpoch: legacyRecoveryErasureState.epoch,
                base: new Map(watermarks),
                targets: legacyRecoveryTargets,
                retainedCounts: legacyRecoveryRetainedCounts!,
              },
            }),
        },
      ),
      accounts,
    };
  });
}
