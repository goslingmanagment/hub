import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  admitAiMediaAcceleratorReadOutcome,
  countAiMediaAcceleratorAdmissions24h,
  findPageById,
  finishAiMediaAcceleratorRead,
  getFanslyFastLanePageSyncGate,
  getNotificationIncidentByKey,
  hasUnfinishedFanslySyncAttempt,
  isDmArchiveScopeFenced,
  listAiMediaFastLaneHealth,
  markAiMediaAcceleratorReadDispatched,
  peekAiMediaFastLaneRead,
  requestAiMediaAcceleratorRead,
  setAiMediaFastLaneCooldown,
  setAiMediaFastLaneHealth,
  tryAcquireDmArchiveWriterFenceLock,
  type Database,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  FanslyApiError,
  type FanslyMessagesPageResponse,
  type FanslyRequestContext,
} from "@agency_hub_core/fansly";
import { extractFanslyWsFanMediaMessages, type HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { canonicalizeSyncPullObservation } from "../canonicalize/sync-pull.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { readFanslyPageGeneration } from "../egress/fansly-probe-context.ts";
import {
  AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY,
  incidentKey,
  openCriticalNotificationIncident,
  resolveCriticalNotificationIncident,
} from "../notification-incidents.ts";
import {
  resolvePageContext,
  resolveStoredProxyEgressKey,
  type ResolvedFanslyPageContext,
} from "../page-context.ts";
import { applyAiMediaAttachmentsEvent } from "../projections/ai-media-candidates.ts";
import { createSyncRateLimitWaiter } from "../sync/rate-limiter.ts";
import { dmRetentionDate, persistRawPayload } from "../sync/shared.ts";
import {
  aiMediaNotesPolicyForPage,
  fanslyFastLaneModeForPage,
  isAfterAiMediaDescribeBoundary,
  isAiMediaDescribeWindowOpen,
} from "./policy.ts";

// AI media describer — Fansly fast lane (docs/runbooks/ai-media-describe.md,
// AI_MEDIA_DESCRIBE_FANSLY_FAST_LANE_MODE, off by default).
//
// The hub's own B0 socket journals a frame; right after that commit (never
// inside the serial writer) this lane looks for a fan message with a photo,
// video or bundle. For each one it files a read request, then — per page,
// one at a time — reads that conversation's head ONCE through the page proxy,
// journals the response (raw + observation, nothing else), runs the same
// canonical parser over it and makes the fan's files due. The describe loop
// takes them within a second. New chats need no roster row: the read is
// addressed by the frame's groupId.
//
// Outside the page's sync lease, but never beside it on the wire:
//   - the read reserves its slot in the egress's shared pacing queue and
//     holds the queue for its whole timeout, so no later request of the
//     egress (any page, any stream) starts while it runs;
//   - right before dispatch it refuses while a sync request of the egress is
//     still unfinished, while any stream of the page cools down after a
//     429/5xx, or while the DM stream is paused or blocked;
//   - the frame's credential/proxy generation must still be the page's;
//   - one physical attempt, a 5 s timeout, the agency-wide rolling 24 h cap
//     shared with the in-chunk accelerator (compare-and-set admission);
//   - a 429/5xx/401/403 pauses the lane on every page of the egress.
// Anything refused stays for the ordinary paths (the chunk step, the
// projector, the minutely sweep).
//
// Logging rule: ids, statuses and outcomes only — never a URL or a message.

export const FAST_LANE_REQUEST_TIMEOUT_MS = 5_000;
/** The egress stays closed to other requests for the whole timeout. */
export const FAST_LANE_EGRESS_HOLD_MS = FAST_LANE_REQUEST_TIMEOUT_MS + 500;
/** Frames of one burst share one read. */
export const FAST_LANE_COALESCE_MS = 1_000;
export const FAST_LANE_STALE_AFTER_MS = 10 * 60 * 1000;
/** A sync request that started this long ago and never finished is not "in flight". */
const IN_FLIGHT_WINDOW_MS = 60 * 1000;
const IN_FLIGHT_RECHECKS = 3;
const IN_FLIGHT_RECHECK_MS = 500;
const COOLDOWN_429_MIN_MS = 15 * 60 * 1000;
const COOLDOWN_5XX_MS = 5 * 60 * 1000;
const COOLDOWN_AUTH_MS = 30 * 60 * 1000;
const COOLDOWN_TRANSPORT_MS = 60 * 1000;
const CONFIG_TTL_MS = 5_000;
const PEERS_TTL_MS = 60_000;
const HEALTH_INTERVAL_MS = 60_000;
/** The owner is told only after the lane was unavailable this long. */
export const FAST_LANE_INCIDENT_AFTER_MS = 10 * 60 * 1000;
const SOCKET_FRESH_MS = 30_000;
const DRAIN_LIMIT = 5;
/** An egress busy with a sync request: the read is tried again this much later. */
const EGRESS_BUSY_RETRY_MS = 2_000;
const EGRESS_BUSY_RETRIES = 2;

export interface FanslyFastLaneFrame {
  pageId: number;
  label: string;
  /** The page's credential/proxy generation of the socket that captured it. */
  generation: string;
  /** The page's own Fansly account id. */
  ownRef: string;
  observationId: number;
  frame: string;
  receivedAt: Date;
}

export interface FanslyFastLaneDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  coalesceMs?: number;
  fetchHead?: (
    context: FanslyRequestContext,
    params: { groupId: string; limit: number; before: null },
  ) => Promise<FanslyMessagesPageResponse>;
  resolveContext?: (label: string) => Promise<ResolvedFanslyPageContext>;
  readGeneration?: (label: string) => Promise<string | null>;
}

type ReadOutcome =
  | "read"
  | "skipped"
  | "failed"
  | "left"
  | "retry";

class FastLaneRefused extends Error {}

export function createFanslyFastLane(app: AppContext, deps: FanslyFastLaneDeps = {}) {
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const coalesceMs = deps.coalesceMs ?? FAST_LANE_COALESCE_MS;
  const fetchHead = deps.fetchHead
    ?? ((context, params) => app.adapter.getMessagesPage(context, params));
  const resolveContext = deps.resolveContext ?? (async (label: string) => {
    const context = await resolvePageContext(app, label);
    // Only a Fansly context carries a session; nothing else is ever read here.
    if (!("session" in context)) throw new FastLaneRefused("not_fansly");
    return context as ResolvedFanslyPageContext;
  });
  const readGeneration = deps.readGeneration ?? ((label: string) => readFanslyPageGeneration(app.db, label));

  let stopped = false;
  let config: { at: number; value: Awaited<ReturnType<typeof loadEffectiveConfig>> } | null = null;
  let peers: { at: number; byEgress: Map<string, number[]> } | null = null;
  const pages = new Map<number, { label: string; ownRef: string; scheduled: boolean; running: Promise<void> | null; again: boolean }>();
  let inflight: Array<Promise<unknown>> = [];

  const track = <T>(promise: Promise<T>) => {
    inflight.push(promise);
    void promise.finally(() => {
      inflight = inflight.filter((other) => other !== promise);
    }).catch(() => undefined);
    return promise;
  };

  async function effectiveConfig() {
    const at = Date.now();
    if (!config || at - config.at > CONFIG_TTL_MS) {
      config = { at, value: await loadEffectiveConfig(app.db, app.config) };
    }
    return config.value;
  }

  /** Every Fansly page that shares an egress key (pages on one proxy share
   * one pacing queue, so "in flight" is asked of all of them). */
  async function egressPeers(egressKey: string, pageId: number): Promise<number[]> {
    const at = Date.now();
    if (!peers || at - peers.at > PEERS_TTL_MS) {
      const byEgress = new Map<string, number[]>();
      const ids = await app.db.execute<{ id: string }>(sql`
        select id::text as id from pages where platform = 'fansly' and deleted_at is null
      `);
      for (const row of ids.rows) {
        const stored = await findPageById(app.db, Number(row.id));
        if (!stored) continue;
        const key = resolveStoredProxyEgressKey(stored.proxy);
        byEgress.set(key, [...(byEgress.get(key) ?? []), stored.page.id]);
      }
      peers = { at, byEgress };
    }
    const found = peers.byEgress.get(egressKey) ?? [];
    return found.includes(pageId) ? found : [...found, pageId];
  }

  /** Called after the B0 capture committed; never awaited by the socket. */
  function onCaptured(input: FanslyFastLaneFrame): void {
    if (stopped) return;
    let signals;
    try {
      signals = extractFanslyWsFanMediaMessages(input.frame, input.ownRef);
    } catch {
      return;
    }
    if (signals.length === 0) return;
    void track(route(input, signals)).catch((error: unknown) => {
      app.logger.warn({ pageId: input.pageId, err: error instanceof Error ? error.name : "error" }, "ai media fast lane: routing failed");
    });
  }

  async function route(input: FanslyFastLaneFrame, signals: ReturnType<typeof extractFanslyWsFanMediaMessages>) {
    const effective = await effectiveConfig();
    if (fanslyFastLaneModeForPage(effective, input.label) === "off") return;
    const policy = aiMediaNotesPolicyForPage(effective, input.label);
    const now = clock();
    if (!policy || !isAiMediaDescribeWindowOpen(policy, now)) return;
    let queued = false;
    for (const signal of signals) {
      const messageAt = signal.createdAtMs !== null ? new Date(signal.createdAtMs) : input.receivedAt;
      if (!isAfterAiMediaDescribeBoundary(policy, messageAt)) continue;
      if (await requestAiMediaAcceleratorRead(app.db, {
        pageId: input.pageId,
        groupRef: signal.groupRef,
        messageRef: signal.messageRef,
        now,
        lane: "fast",
        frameReceivedAt: input.receivedAt,
        generation: input.generation,
      })) {
        queued = true;
      }
    }
    if (queued) schedule(input.pageId, input.label, input.ownRef);
  }

  function schedule(pageId: number, label: string, ownRef: string) {
    const state = pages.get(pageId) ?? { label, ownRef, scheduled: false, running: null, again: false };
    state.label = label;
    state.ownRef = ownRef;
    pages.set(pageId, state);
    if (state.running) {
      state.again = true;
      return;
    }
    if (state.scheduled) return;
    state.scheduled = true;
    state.running = track((async () => {
      try {
        await sleep(coalesceMs);
        state.scheduled = false;
        do {
          state.again = false;
          await drainPage(pageId, state.label, state.ownRef);
        } while (state.again && !stopped);
      } finally {
        state.scheduled = false;
        state.running = null;
      }
    })()).catch((error: unknown) => {
      app.logger.warn({ pageId, err: error instanceof Error ? error.name : "error" }, "ai media fast lane: page drain failed");
    });
  }

  async function drainPage(pageId: number, label: string, ownRef: string) {
    const busyRetries = new Map<number, number>();
    for (let index = 0; index < DRAIN_LIMIT + EGRESS_BUSY_RETRIES && !stopped; index += 1) {
      const row = await peekAiMediaFastLaneRead(app.db, { pageId, now: clock(), staleAfterMs: FAST_LANE_STALE_AFTER_MS });
      if (!row) return;
      const retries = busyRetries.get(row.id) ?? 0;
      const outcome = await readOne({ pageId, label, ownRef, row, lastTry: retries >= EGRESS_BUSY_RETRIES });
      if (outcome === "retry") {
        busyRetries.set(row.id, retries + 1);
        await sleep(EGRESS_BUSY_RETRY_MS);
        continue;
      }
      if (outcome === "left") return;
    }
  }

  async function readOne(input: {
    pageId: number;
    label: string;
    ownRef: string;
    row: NonNullable<Awaited<ReturnType<typeof peekAiMediaFastLaneRead>>>;
    /** An egress still busy on this try closes the request. */
    lastTry: boolean;
  }): Promise<ReadOutcome> {
    const { pageId, label, ownRef, row } = input;
    const startedAt = clock();
    const finish = async (
      status: "done" | "skipped" | "failed",
      outcome: string,
      extra: { httpStatus?: number | null; coveredMessageRefs?: readonly string[] } = {},
    ) => finishAiMediaAcceleratorRead(app.db, {
      id: row.id, pageId, groupRef: row.groupRef, status, outcome, now: clock(), startedAt, ...extra,
    });

    const effective = await effectiveConfig();
    const mode = fanslyFastLaneModeForPage(effective, label);
    const policy = aiMediaNotesPolicyForPage(effective, label);
    if (mode === "off" || !policy) {
      // Switched off meanwhile: the ordinary paths take it.
      return "left";
    }
    const limit24h = Math.max(0, effective.aiMediaDescribeFanslyAcceleratorDailyLimit ?? 60);

    // Gates that need no provider request.
    const refusal = await gate({ pageId, label, row, limit24h });
    if (mode === "shadow") {
      await finish("skipped", refusal ? `shadow_${refusal}` : "shadow_ready");
      return "skipped";
    }
    if (refusal) {
      await finish("skipped", refusal);
      return "skipped";
    }

    let context: ResolvedFanslyPageContext;
    try {
      context = await resolveContext(label);
    } catch {
      await finish("skipped", "context_unavailable");
      return "skipped";
    }
    const peerIds = await egressPeers(context.egressKey, pageId);

    let admitted = 0;
    let dispatchedHttp = false;
    let transportFailure: string | null = null;
    const observer: HttpRequestObserver = {
      async onRequestEvent(event) {
        if (event.state === "started") {
          if (admitted >= 1) throw new FastLaneRefused("one_attempt");
          // Right before dispatch, after the pacing wait (our hold is in
          // place): never beside an unfinished sync request of the egress.
          for (let check = 0; ; check += 1) {
            const busy = await hasUnfinishedFanslySyncAttempt(app.db, {
              pageIds: peerIds, since: new Date(clock().getTime() - IN_FLIGHT_WINDOW_MS),
            });
            if (!busy) break;
            if (check + 1 >= IN_FLIGHT_RECHECKS) throw new FastLaneRefused("egress_busy");
            await sleep(IN_FLIGHT_RECHECK_MS);
          }
          if (await readGeneration(label) !== row.generation) throw new FastLaneRefused("generation_changed");
          const admission = await admitAiMediaAcceleratorReadOutcome(app.db, {
            id: row.id, requestId: event.requestId, limit24h, now: clock(),
          });
          if (admission === "taken") throw new FastLaneRefused("taken");
          if (admission === "cap") throw new FastLaneRefused("budget_exhausted");
          admitted += 1;
          dispatchedHttp = true;
          await markAiMediaAcceleratorReadDispatched(app.db, { id: row.id, now: clock() });
        }
        if (event.state === "failed" && (event.failureKind === "transport" || event.failureKind === "timeout")) {
          transportFailure = event.failureKind;
        }
      },
    };

    let page: FanslyMessagesPageResponse;
    try {
      page = await fetchHead({
        session: context.session,
        proxy: context.proxy,
        egressKey: context.egressKey,
        requestObserver: observer,
        remainingAttempts: () => Math.max(0, 1 - admitted),
        rateLimitWaiter: createSyncRateLimitWaiter(app, { egressKey: context.egressKey, holdMs: FAST_LANE_EGRESS_HOLD_MS }),
        requestTimeoutMs: FAST_LANE_REQUEST_TIMEOUT_MS,
      }, { groupId: row.groupRef, limit: 25, before: null });
    } catch (error) {
      if (error instanceof FastLaneRefused) {
        if (error.message === "taken") return "skipped";
        if (error.message === "egress_busy" && !input.lastTry) return "retry";
        await finish("skipped", error.message);
        return error.message === "egress_busy" ? "left" : "skipped";
      }
      if (error instanceof FanslyApiError) {
        const status = error.status ?? null;
        const cooldownMs = status === 429
          ? Math.max(COOLDOWN_429_MIN_MS, (error.retryAfterAt?.getTime() ?? 0) - clock().getTime())
          : status === 401 || status === 403 ? COOLDOWN_AUTH_MS
          : status !== null && status >= 500 ? COOLDOWN_5XX_MS
          : 0;
        if (cooldownMs > 0) await pauseEgress(peerIds, cooldownMs, `fansly_${status}`);
        await finish("failed", `fansly_${status ?? "error"}`, { httpStatus: status });
        app.logger.warn({ pageId, readId: row.id, httpStatus: status }, "ai media fast lane: provider refused the read");
        return "left";
      }
      if (transportFailure || dispatchedHttp) {
        await pauseEgress(peerIds, COOLDOWN_TRANSPORT_MS, `fansly_${transportFailure ?? "error"}`);
        await finish("failed", `fansly_${transportFailure ?? "error"}`);
        return "left";
      }
      throw error;
    }

    // Journal first (raw + observation), fenced against a running erasure of
    // the conversation or its fan; nothing else is written for the archive.
    const senders = [...new Set(page.items.map((message) => message.senderId).filter((id) => id !== ownRef))];
    const fenced = await app.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) return "erasure_busy";
      const blocked = await isDmArchiveScopeFenced(db, {
        pageId, platform: "fansly", refs: [row.groupRef, ...senders], materialAt: row.frameReceivedAt ?? startedAt,
      });
      return blocked ? "erasure_fenced" : null;
    });
    if (fenced) {
      await finish("skipped", fenced, { httpStatus: 200 });
      return "skipped";
    }
    const requestParams = { groupId: row.groupRef, limit: 25, before: null };
    const raw = await persistRawPayload(app.db, {
      platformAccountId: pageId,
      syncRunId: null,
      endpoint: "dm_messages",
      requestParams,
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "dm_messages",
      retainUntil: dmRetentionDate(),
    }, { action: "inserting ai media fast lane dm_messages raw payload", platform: "fansly" });

    // The canonicalizer's own parser over the fresh page → candidates now.
    let candidates = 0;
    if (raw.observationId !== null && raw.observationId !== undefined) {
      const drafts = canonicalizeSyncPullObservation({
        id: raw.observationId,
        source: "pull",
        producer: "sync:fansly:dm_messages",
        platform: "fansly",
        accountId: pageId,
        kind: "dm_messages",
        payload: page.raw,
        observedAt: null,
        receivedAt: raw.capturedAt ?? clock(),
      }, { nativeAccountRefByAccountId: new Map([[pageId, ownRef]]) });
      for (const draft of drafts) {
        if (draft.type !== "message.attachments_observed") continue;
        const applied = await applyAiMediaAttachmentsEvent(app, {
          pageId,
          ownRef,
          policy,
          liveChatOnly: effective.aiMediaDescribeLiveChatOnly !== false,
          event: {
            data: draft.data,
            observationId: raw.observationId,
            occurredAt: draft.occurredAt,
            messageRef: draft.messageRef ?? null,
            conversationRef: draft.conversationRef ?? null,
          },
        });
        if (applied.status === "deferred") break;
        candidates += applied.candidates;
      }
    }
    await finish("done", "fast_lane", {
      httpStatus: 200,
      coveredMessageRefs: page.items.map((message) => message.id),
    });
    app.logger.info({ pageId, readId: row.id, candidates }, "ai media fast lane: head read");
    return "read";
  }

  async function gate(input: {
    pageId: number;
    label: string;
    row: NonNullable<Awaited<ReturnType<typeof peekAiMediaFastLaneRead>>>;
    limit24h: number;
  }): Promise<string | null> {
    const now = clock();
    if (input.limit24h === 0) return "budget_exhausted";
    const health = (await listAiMediaFastLaneHealth(app.db)).find((row) => row.pageId === input.pageId);
    if (health?.cooldownUntil && health.cooldownUntil > now) return "lane_cooldown";
    const sync = await getFanslyFastLanePageSyncGate(app.db, { pageId: input.pageId, now });
    if (sync.cooldown) return "page_cooldown";
    if (sync.held) return "page_held";
    if (input.row.generation === null || await readGeneration(input.label) !== input.row.generation) {
      return "generation_changed";
    }
    return null;
  }

  async function pauseEgress(pageIds: readonly number[], ms: number, reason: string) {
    const now = clock();
    for (const pageId of pageIds) {
      await setAiMediaFastLaneCooldown(app.db, { pageId, until: new Date(now.getTime() + ms), reason, now });
    }
  }

  // ── Health: "unavailable > 10 min" is the only thing the owner hears ──────

  async function checkHealth() {
    const effective = await effectiveConfig();
    const now = clock();
    const served = await app.db.execute<{ id: string; label: string }>(sql`
      select id::text as id, label from pages where platform = 'fansly' and deleted_at is null
    `);
    const limit24h = Math.max(0, effective.aiMediaDescribeFanslyAcceleratorDailyLimit ?? 60);
    const used = await countAiMediaAcceleratorAdmissions24h(app.db, now);
    const health = new Map((await listAiMediaFastLaneHealth(app.db)).map((row) => [row.pageId, row]));
    const unavailable: string[] = [];
    for (const row of served.rows) {
      const pageId = Number(row.id);
      if (fanslyFastLaneModeForPage(effective, row.label) !== "serve") continue;
      let reason: string | null = null;
      const socket = await app.db.execute<{ open: boolean }>(sql`
        select exists (
          select 1 from fansly_ws_connections
          where page_id = ${pageId} and closed_at is null and verified_at is not null
            and last_guard_at > ${new Date(now.getTime() - SOCKET_FRESH_MS)}
        ) as open
      `);
      if (socket.rows[0]?.open !== true) reason = "socket_down";
      else if (used >= limit24h) reason = "budget_exhausted";
      else if ((health.get(pageId)?.cooldownUntil ?? new Date(0)) > now) reason = health.get(pageId)?.reason ?? "lane_cooldown";
      else {
        const sync = await getFanslyFastLanePageSyncGate(app.db, { pageId, now });
        if (sync.cooldown) reason = "page_cooldown";
        else if (sync.held) reason = "page_held";
      }
      await setAiMediaFastLaneHealth(app.db, { pageId, available: reason === null, reason, now });
      const since = reason === null ? null : health.get(pageId)?.unavailableSince ?? now;
      if (since && now.getTime() - since.getTime() > FAST_LANE_INCIDENT_AFTER_MS) {
        unavailable.push(`${row.label}: ${reason}`);
      }
    }
    const key = incidentKey({ kind: "ai_provider_failed", platformAccountId: null, subKey: AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY });
    const open = (await getNotificationIncidentByKey(app.db, key))?.status === "open";
    if (unavailable.length > 0 && !open) {
      await openCriticalNotificationIncident(app, {
        kind: "ai_provider_failed",
        platformAccountId: null,
        pageLabel: null,
        platform: "fansly",
        subKey: AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY,
        errorCode: "media_fast_lane_unavailable",
        errorSummary: `Fresh fan photos wait for the minutely path on: ${unavailable.join("; ")}.`,
        occurredAt: now,
      });
    } else if (unavailable.length === 0 && open) {
      await resolveCriticalNotificationIncident(app, {
        kind: "ai_provider_failed",
        platformAccountId: null,
        pageLabel: null,
        platform: "fansly",
        subKey: AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY,
        recoveredAt: now,
      });
    }
  }

  let healthRunning = false;
  const healthTimer = setInterval(() => {
    if (stopped || healthRunning) return;
    healthRunning = true;
    void track(checkHealth()).catch((error: unknown) => {
      app.logger.warn({ err: error instanceof Error ? error.name : "error" }, "ai media fast lane: health check failed");
    }).finally(() => {
      healthRunning = false;
    });
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref?.();

  return {
    onCaptured,
    /** Tests: run one health pass now. */
    checkHealth,
    /** Tests: wait until routed work and page drains settle. */
    async idle() {
      while (inflight.length > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
    async stop() {
      stopped = true;
      clearInterval(healthTimer);
      await Promise.allSettled([...inflight]);
    },
    /** For tests and diagnostics only. */
    requestId: () => randomUUID(),
  };
}

export type FanslyFastLane = ReturnType<typeof createFanslyFastLane>;
