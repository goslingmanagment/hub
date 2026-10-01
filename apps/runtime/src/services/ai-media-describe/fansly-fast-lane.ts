import { sql } from "drizzle-orm";

import {
  admitAiMediaAcceleratorReadOutcome,
  countAiMediaAcceleratorAdmissions24h,
  extendSyncProviderRateLimitHold,
  findPageById,
  finishAiMediaAcceleratorRead,
  getFanslyFastLanePageSyncGate,
  getNotificationIncidentByKey,
  handOffAiMediaFastLaneRead,
  hasAiMediaFastLaneCooldown,
  hasUnfinishedFanslySyncAttempt,
  isDmArchiveScopeFenced,
  lastAiMediaFastLaneDispatch,
  listAiMediaFastLaneHealth,
  markAiMediaAcceleratorReadDispatched,
  peekAiMediaFastLaneRead,
  recentFanslyProviderRefusal,
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
import { fanslyPageSendGuard, isFanslyPageOwnedBySyncEngineError } from "../fansly-send-guard/index.ts";
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
// Outside the page's sync lease, but never beside another request of the
// egress on the wire, and never into a cooldown:
//   - before reserving a pacing slot and again right before dispatch (after
//     the wait): no stream of any page of the egress cooling down, the DM
//     stream not paused/blocked, no 429 (15 min), 5xx (5 min) or 401/403
//     (30 min) seen on the egress, no unfinished sync request of the egress,
//     the frame's credential/proxy generation still current, the shared
//     rolling 24 h cap not spent;
//   - the slot holds the egress's pacing queue for the whole timeout, and the
//     hold is extended from the real dispatch;
//   - one physical attempt, a 5 s timeout, compare-and-set admission;
//   - a 429/5xx/401/403 pauses the lane on every page of the egress.
// A request the lane declines goes back to the in-chunk accelerator (which
// reads under the page lease); the projector and the minutely paths remain.
//
// Logging rule: ids, statuses and outcomes only — never a URL or a message.

export const FAST_LANE_REQUEST_TIMEOUT_MS = 5_000;
/** The egress stays closed to other requests for the whole timeout. */
export const FAST_LANE_EGRESS_HOLD_MS = FAST_LANE_REQUEST_TIMEOUT_MS + 500;
/** Frames of one burst share one read. */
export const FAST_LANE_COALESCE_MS = 1_000;
export const FAST_LANE_STALE_AFTER_MS = 10 * 60 * 1000;
/** One conversation is not read by the lane more often than this. */
export const FAST_LANE_CONVERSATION_GAP_MS = 10_000;
/** A sync request that started this long ago and never finished is not "in flight". */
const IN_FLIGHT_WINDOW_MS = 60 * 1000;
const EGRESS_BUSY_RETRIES = 2;
const EGRESS_BUSY_RETRY_MS = 2_000;
const REFUSAL_429_MS = 15 * 60 * 1000;
const REFUSAL_5XX_MS = 5 * 60 * 1000;
const REFUSAL_AUTH_MS = 30 * 60 * 1000;
const COOLDOWN_TRANSPORT_MS = 60 * 1000;
const CONFIG_TTL_MS = 5_000;
const PEERS_TTL_MS = 60_000;
const HEALTH_INTERVAL_MS = 60_000;
/** The owner is told only after the lane was unavailable this long. */
export const FAST_LANE_INCIDENT_AFTER_MS = 10 * 60 * 1000;
const SOCKET_FRESH_MS = 30_000;
const DRAIN_LIMIT = 5;
/** The legacy endpoint pause the lane holds; the page-wide spacing is the
 *  send guard's (plan §2.5). */
const HOLD_SCOPES = ["dm_messages"] as const;

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

type ReadOutcome = "read" | "declined" | "failed" | "stop";

class FastLaneRefused extends Error {}

type PeekedRead = NonNullable<Awaited<ReturnType<typeof peekAiMediaFastLaneRead>>>;

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
  let peers: { at: number; byEgress: Map<string, number[]>; egressOf: Map<number, string> } | null = null;
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

  /** Every Fansly page on the page's egress (pages on one proxy share one
   * pacing queue, so cooldowns and "in flight" are asked of all of them). */
  async function egressPeers(pageId: number): Promise<{ egressKey: string | null; pageIds: number[] }> {
    const at = Date.now();
    if (!peers || at - peers.at > PEERS_TTL_MS) {
      const byEgress = new Map<string, number[]>();
      const egressOf = new Map<number, string>();
      const ids = await app.db.execute<{ id: string }>(sql`
        select id::text as id from pages where platform = 'fansly' and deleted_at is null
      `);
      for (const row of ids.rows) {
        const stored = await findPageById(app.db, Number(row.id));
        if (!stored) continue;
        const key = resolveStoredProxyEgressKey(stored.proxy);
        byEgress.set(key, [...(byEgress.get(key) ?? []), stored.page.id]);
        egressOf.set(stored.page.id, key);
      }
      peers = { at, byEgress, egressOf };
    }
    const egressKey = peers.egressOf.get(pageId) ?? null;
    const found = egressKey === null ? [] : peers.byEgress.get(egressKey) ?? [];
    return { egressKey, pageIds: found.includes(pageId) ? found : [...found, pageId] };
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
    const mode = fanslyFastLaneModeForPage(effective, input.label);
    if (mode === "off") return;
    const policy = aiMediaNotesPolicyForPage(effective, input.label);
    const now = clock();
    if (!policy || !isAiMediaDescribeWindowOpen(policy, now)) return;
    const fresh = signals.filter((signal) => isAfterAiMediaDescribeBoundary(
      policy, signal.createdAtMs !== null ? new Date(signal.createdAtMs) : input.receivedAt,
    ));
    if (fresh.length === 0) return;
    if (mode === "shadow") {
      // Shadow files nothing (the in-chunk accelerator keeps its requests):
      // it only says what serve would have done, in the log.
      const limit24h = Math.max(0, effective.aiMediaDescribeFanslyAcceleratorDailyLimit ?? 60);
      const refusal = await gate({ pageId: input.pageId, label: input.label, generation: input.generation, limit24h });
      app.logger.info({
        pageId: input.pageId, messages: fresh.length, outcome: refusal ?? "ready",
        frameAgeMs: now.getTime() - input.receivedAt.getTime(),
      }, "ai media fast lane: shadow");
      return;
    }
    let queued = false;
    for (const signal of fresh) {
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
    for (let index = 0; index < DRAIN_LIMIT && !stopped; index += 1) {
      const row = await peekAiMediaFastLaneRead(app.db, { pageId, now: clock(), staleAfterMs: FAST_LANE_STALE_AFTER_MS });
      if (!row) return;
      // One conversation is read at most every FAST_LANE_CONVERSATION_GAP_MS.
      const last = await lastAiMediaFastLaneDispatch(app.db, { pageId, groupRef: row.groupRef });
      const wait = last === null ? 0 : last.getTime() + FAST_LANE_CONVERSATION_GAP_MS - clock().getTime();
      if (wait > 0) await sleep(wait);
      if (stopped) return;
      const outcome = await readOne({ pageId, label, ownRef, row });
      if (outcome === "stop") return;
    }
  }

  /** Every check that needs no provider request; null = clear to try. */
  async function gate(input: { pageId: number; label: string; generation: string | null; limit24h: number }): Promise<string | null> {
    const now = clock();
    if (!app.config.syncSharedRateLimitEnabled) return "no_shared_pacing";
    if (input.limit24h === 0 || await countAiMediaAcceleratorAdmissions24h(app.db, now) >= input.limit24h) {
      return "budget_exhausted";
    }
    const { egressKey, pageIds } = await egressPeers(input.pageId);
    if (egressKey === null) return "no_egress";
    return (await wireGate({ pageId: input.pageId, pageIds, label: input.label, generation: input.generation }))
      ?? (await hasUnfinishedFanslySyncAttempt(app.db, {
        pageIds, since: new Date(now.getTime() - IN_FLIGHT_WINDOW_MS),
      }) ? "egress_busy" : null);
  }

  /** What can change while the read waits for its slot; re-asked right
   * before dispatch. */
  async function wireGate(input: { pageId: number; pageIds: readonly number[]; label: string; generation: string | null }): Promise<string | null> {
    const now = clock();
    if (await hasAiMediaFastLaneCooldown(app.db, { pageIds: input.pageIds, now })) return "lane_cooldown";
    const sync = await getFanslyFastLanePageSyncGate(app.db, { pageId: input.pageId, peerPageIds: input.pageIds, now });
    if (sync.cooldown) return "page_cooldown";
    if (sync.held) return "page_held";
    const refusal = await recentFanslyProviderRefusal(app.db, {
      pageIds: input.pageIds, now, rateLimitMs: REFUSAL_429_MS, serverErrorMs: REFUSAL_5XX_MS, authMs: REFUSAL_AUTH_MS,
    });
    if (refusal) return `recent_${refusal}`;
    if (input.generation === null || await readGeneration(input.label) !== input.generation) {
      return "generation_changed";
    }
    return null;
  }

  async function readOne(input: { pageId: number; label: string; ownRef: string; row: PeekedRead }): Promise<ReadOutcome> {
    const { pageId, label, ownRef, row } = input;
    const startedAt = clock();
    const finish = async (
      status: "done" | "skipped" | "failed",
      outcome: string,
      extra: { httpStatus?: number | null; coveredMessageRefs?: readonly string[] } = {},
    ) => finishAiMediaAcceleratorRead(app.db, {
      id: row.id, pageId, groupRef: row.groupRef, status, outcome, now: clock(), startedAt, ...extra,
    });
    const handOff = async (reason: string): Promise<ReadOutcome> => {
      await handOffAiMediaFastLaneRead(app.db, { id: row.id, reason });
      return "declined";
    };

    const effective = await effectiveConfig();
    const policy = aiMediaNotesPolicyForPage(effective, label);
    if (fanslyFastLaneModeForPage(effective, label) !== "serve" || !policy) {
      // Switched off meanwhile: the in-chunk accelerator takes it.
      return handOff("lane_off");
    }
    const limit24h = Math.max(0, effective.aiMediaDescribeFanslyAcceleratorDailyLimit ?? 60);

    // Checks before a pacing slot is reserved: a refused read never holds
    // the egress. A busy egress is looked at again twice, 2 s apart.
    let refusal = await gate({ pageId, label, generation: row.generation, limit24h });
    for (let attempt = 0; refusal === "egress_busy" && attempt < EGRESS_BUSY_RETRIES && !stopped; attempt += 1) {
      await sleep(EGRESS_BUSY_RETRY_MS);
      refusal = await gate({ pageId, label, generation: row.generation, limit24h });
    }
    if (refusal) return handOff(refusal);
    if (stopped) return "stop";

    let context: ResolvedFanslyPageContext;
    try {
      context = await resolveContext(label);
    } catch {
      return handOff("context_unavailable");
    }
    const { pageIds } = await egressPeers(pageId);

    let admitted = 0;
    let dispatchedHttp = false;
    let transportFailure: string | null = null;
    const observer: HttpRequestObserver = {
      async onRequestEvent(event) {
        if (event.state === "started") {
          if (admitted >= 1) throw new FastLaneRefused("one_attempt");
          if (stopped) throw new FastLaneRefused("stopping");
          // Right before dispatch, after the pacing wait: everything that can
          // change while waiting, then the admission.
          const late = await wireGate({ pageId, pageIds, label, generation: row.generation })
            ?? (await hasUnfinishedFanslySyncAttempt(app.db, {
              pageIds, since: new Date(clock().getTime() - IN_FLIGHT_WINDOW_MS),
            }) ? "egress_busy" : null);
          if (late) throw new FastLaneRefused(late);
          const admission = await admitAiMediaAcceleratorReadOutcome(app.db, {
            id: row.id, requestId: event.requestId, limit24h, now: clock(),
          });
          if (admission === "taken") throw new FastLaneRefused("taken");
          if (admission === "cap") throw new FastLaneRefused("budget_exhausted");
          admitted += 1;
          dispatchedHttp = true;
          const dispatchAt = clock();
          // The hold counts from the real start, not from the slot.
          await extendSyncProviderRateLimitHold(app.db, {
            provider: "fansly", egressKey: context.egressKey, scopes: HOLD_SCOPES,
            until: new Date(dispatchAt.getTime() + FAST_LANE_EGRESS_HOLD_MS),
          });
          await markAiMediaAcceleratorReadDispatched(app.db, { id: row.id, now: dispatchAt });
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
        sendGuard: fanslyPageSendGuard(app, pageId, "ai_fast_lane"),
        requestTimeoutMs: FAST_LANE_REQUEST_TIMEOUT_MS,
      }, { groupId: row.groupRef, limit: 25, before: null });
    } catch (error) {
      if (error instanceof FastLaneRefused) {
        if (error.message === "taken") return "declined";
        if (error.message === "stopping") return "stop";
        return handOff(error.message);
      }
      // The page's send guard belongs to the Fansly Sync Engine (sync engine
      // design §2.7): refused before anything was sent, like a held page.
      if (isFanslyPageOwnedBySyncEngineError(error)) return handOff("page_held");
      if (error instanceof FanslyApiError) {
        const status = error.status ?? null;
        const cooldownMs = status === 429
          ? Math.max(REFUSAL_429_MS, (error.retryAfterAt?.getTime() ?? 0) - clock().getTime())
          : status === 401 || status === 403 ? REFUSAL_AUTH_MS
          : status !== null && status >= 500 ? REFUSAL_5XX_MS
          : 0;
        if (cooldownMs > 0) await pauseEgress(pageIds, cooldownMs, `fansly_${status}`);
        await finish("failed", `fansly_${status ?? "error"}`, { httpStatus: status });
        app.logger.warn({ pageId, readId: row.id, httpStatus: status }, "ai media fast lane: provider refused the read");
        return "stop";
      }
      if (transportFailure || dispatchedHttp) {
        await pauseEgress(pageIds, COOLDOWN_TRANSPORT_MS, `fansly_${transportFailure ?? "error"}`);
        await finish("failed", `fansly_${transportFailure ?? "error"}`);
        return "stop";
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
      return "declined";
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
    const carried = page.items.map((message) => message.id);
    await finish("done", carried.includes(row.messageRef) ? "fast_lane" : "fast_lane_not_in_head", {
      httpStatus: 200,
      coveredMessageRefs: carried,
    });
    app.logger.info({ pageId, readId: row.id, candidates }, "ai media fast lane: head read");
    return "read";
  }

  async function pauseEgress(pageIds: readonly number[], ms: number, reason: string) {
    const now = clock();
    for (const pageId of pageIds) {
      await setAiMediaFastLaneCooldown(app.db, { pageId, until: new Date(now.getTime() + ms), reason, now });
    }
  }

  // ── Health: "unavailable > 10 min" is the only thing the owner hears ──────
  // A spent daily cap or an owner-paused DM stream are choices, not faults.

  async function checkHealth() {
    const effective = await effectiveConfig();
    const now = clock();
    const served = await app.db.execute<{ id: string; label: string }>(sql`
      select id::text as id, label from pages where platform = 'fansly' and deleted_at is null
    `);
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
      else if ((health.get(pageId)?.cooldownUntil ?? new Date(0)) > now) reason = health.get(pageId)?.reason ?? "lane_cooldown";
      else if ((await getFanslyFastLanePageSyncGate(app.db, { pageId, now })).cooldown) reason = "page_cooldown";
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
  };
}

export type FanslyFastLane = ReturnType<typeof createFanslyFastLane>;
