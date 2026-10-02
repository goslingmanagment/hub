import { sql } from "drizzle-orm";

import {
  acquireSyncPageOwnership,
  ensureFanslySyncPages,
  heartbeatSyncPageOwner,
  listSyncPages,
  paceFloorFromDb,
  writeSafeRelease,
  type Database,
  type FanslySendHolderIdentity,
  type SyncPageOwnerRecord,
  type SyncPageRow,
} from "@agency_hub_core/db";
import { FANSLY_PAUSE_MIN_MS, type AppConfig } from "@agency_hub_core/shared";

import {
  buildFanslySendHolderIdentity,
  createDefaultFanslySendOsProbe,
  judgeFanslySendHolderTermination,
  type FanslySendOsProbe,
} from "../../services/fansly-send-guard/os-probe.ts";
import { createPageTransport } from "../fansly/transport.ts";
import { SyncActor, type ActorExit, type ShadowFeed } from "./actor.ts";
import {
  errorName,
  type CaptureCodec,
  type ObservationCanonicalizer,
  type SyncFaultHook,
  type SyncLogger,
  type ThreadChainChangedHook,
  type WorkClosedHook,
} from "./commit.ts";
import { PgOwnershipSession, PgWake } from "./host-ports.ts";
import { createPacer, type Pacer, type PacerDeps } from "./pacer.ts";
import {
  createEffectiveConfigPauseSource,
  createEffectiveConfigSettingsSource,
  cryptoRng,
  noopMetrics,
  systemClock,
  type AlertSink,
  type Clock,
  type Metrics,
  type PauseSource,
  type SettingsSource,
  type Rng,
  type Wake,
} from "./ports.ts";
import type { EngineRegistry } from "./resource.ts";
import { createLegacyShadowLatency, ShadowTransport, type PageTransport, type ShadowLatencySource } from "./shadow.ts";

// The host (plan §2.4, §8; design §3.6): pages ↔ actors. It owns the process's
// lock session and LISTEN client, watches `sync_pages.mode` every 2 s, takes a
// page only when its previous owner is CONFIRMED stopped, starts one actor per
// owned page with the takeover floor, heartbeats each owner, and on shutdown,
// mode change or ownership loss lets the request in flight finish and writes
// the page's safe release.
//
// I17 — no live sender before the step-3 switch. Three independent gates, each
// pinned by tests/sync-live-gate.integration.test.ts:
//   1. `LIVE_LOOP_ENABLED` below is false until the switch PR (S3-05);
//   2. a page reaches `live` only through the switch CLI's capability
//      (`setSyncPageMode`; `sync page mode` moves only off ↔ shadow);
//   3. every live admission needs the step-1 guard row handed to the engine
//      (`owner_engine = 'fansly_sync_engine'`, checked in `lockOwnedPage`).
// The live transport (`fansly/transport.ts`) is built in one place only: the
// live branch below.

/** The live loop runs only when this is true: false until the switch PR
 *  (S3-05). A `live` page is reported `ownership_unconfirmed` meanwhile. */
export const LIVE_LOOP_ENABLED = false;

/** The mode loop re-reads `sync_pages` this often. */
export const MODE_LOOP_INTERVAL_MS = 2_000;
/** Each owner's liveness mark (`owner_heartbeat_at`). */
export const OWNER_HEARTBEAT_INTERVAL_MS = 10_000;
/** A page whose previous owner is not confirmed stopped is retried this often. */
export const UNCONFIRMED_RETRY_MS = 5_000;
/** … and alerts (alert 1, `ownership`) after this long, except in `handover`. */
export const OWNERSHIP_ALERT_AFTER_MS = 120_000;
/** A lost lock session is reopened after 1 s, doubling up to 30 s. */
export const SESSION_RECONNECT_MIN_MS = 1_000;
export const SESSION_RECONNECT_MAX_MS = 30_000;
/** Shutdown: the request in flight (≤ 20 s total) and its commits. */
export const SHUTDOWN_ACTOR_BUDGET_MS = 30_000;
/** Shutdown: after a hard abort of what is left. */
export const SHUTDOWN_ABORT_BUDGET_MS = 5_000;

export type HostPageState =
  | { kind: "running"; mode: "shadow" | "live"; generation: bigint }
  | { kind: "waiting"; reason: string; since: Date }
  | { kind: "handover" }
  | { kind: "idle" };

export interface SyncHostOptions {
  db: Database;
  connectionString: string;
  /** The boot config (egress, credentials decoding). */
  config: AppConfig;
  /** The env config the live pause key is layered over (`PauseSource`). */
  rawConfig: AppConfig;
  logger: SyncLogger;
  registry: EngineRegistry;
  clock?: Clock;
  rng?: Rng;
  /** The step-1 OS probe: this process's identity and the judge of a
   *  previous owner (rules (c)/(d)). */
  probe?: FanslySendOsProbe;
  pause?: PauseSource;
  /** The live settings resources read; default: the effective config over
   *  `rawConfig`, as the pause. */
  settings?: SettingsSource;
  alerts?: AlertSink;
  metrics?: Metrics;
  /** Default: one PgWake on `fansly_sync_work`. */
  wake?: Wake & { start?(): Promise<void>; close?(): Promise<void> };
  shadowLatency?: (pageId: number) => ShadowLatencySource;
  shadowFeed?: ShadowFeed;
  capture?: CaptureCodec;
  canonicalize?: ObservationCanonicalizer;
  onThreadChainChanged?: ThreadChainChangedHook;
  onWorkClosed?: WorkClosedHook;
  modeLoopIntervalMs?: number;
  /** TESTS ONLY: run the live loop although `LIVE_LOOP_ENABLED` is false
   *  (tests/sync-live-gate.integration.test.ts). `main.ts` never passes it
   *  (pinned by a grep test). */
  liveLoopEnabled?: boolean;
  /** TESTS ONLY: a pacer with a test setting floor. Never passed by `main.ts`. */
  pacerFactory?: (deps: PacerDeps) => Pacer;
  /** TESTS ONLY: a stand-in for the live page transport. */
  liveTransportFactory?: (page: SyncPageRow) => Promise<PageTransport>;
  /** TESTS ONLY: crash points. */
  faults?: SyncFaultHook;
}

interface PageSlot {
  pageId: number;
  mode: "shadow" | "live";
  generation: bigint;
  actor: SyncActor;
  transport: PageTransport;
  stop: AbortController;
  abort: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  /** Keep the advisory lock after the actor ends (`handover`). */
  keepLock: boolean;
  done: Promise<void>;
}

interface Waiting {
  reason: string;
  sinceMono: number;
  sinceWall: Date;
  nextTryMono: number;
  alerted: boolean;
}

export class SyncEngineHost {
  readonly #o: SyncHostOptions;
  readonly #clock: Clock;
  readonly #rng: Rng;
  readonly #probe: FanslySendOsProbe;
  readonly #identity: FanslySendHolderIdentity;
  readonly #pause: PauseSource;
  readonly #settings: SettingsSource;
  readonly #metrics: Metrics;
  readonly #alerts: AlertSink;
  readonly #wake: Wake & { start?(): Promise<void>; close?(): Promise<void> };
  readonly #liveLoopEnabled: boolean;
  readonly #slots = new Map<number, PageSlot>();
  readonly #waiting = new Map<number, Waiting>();
  readonly #pendingRelease = new Map<number, bigint>();
  readonly #handover = new Set<number>();
  #session: PgOwnershipSession | null = null;
  #sessionRetryMono = Number.NEGATIVE_INFINITY;
  #sessionDelayMs = SESSION_RECONNECT_MIN_MS;
  #timer: ReturnType<typeof setInterval> | null = null;
  #tick: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;
  #liveDisabledLogged = new Set<number>();

  constructor(options: SyncHostOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
    this.#rng = options.rng ?? cryptoRng;
    this.#probe = options.probe ?? createDefaultFanslySendOsProbe();
    this.#identity = buildFanslySendHolderIdentity(this.#probe, "sync");
    this.#pause = options.pause ?? createEffectiveConfigPauseSource(options.db, options.rawConfig);
    this.#settings = options.settings ?? createEffectiveConfigSettingsSource(options.db, options.rawConfig);
    this.#metrics = options.metrics ?? noopMetrics;
    this.#alerts = options.alerts ?? createLoggingAlertSink(options.logger);
    this.#wake = options.wake ?? new PgWake({ connectionString: options.connectionString, logger: options.logger });
    this.#liveLoopEnabled = options.liveLoopEnabled ?? LIVE_LOOP_ENABLED;
  }

  /** This process's owner identity (`sync_pages.owner_*`). */
  get identity(): FanslySendHolderIdentity {
    return this.#identity;
  }

  /** The current lock session (tests terminate it). */
  get session(): PgOwnershipSession | null {
    return this.#session;
  }

  async start(): Promise<void> {
    const created = await ensureFanslySyncPages(this.#o.db, { createdBy: "sync:host" });
    if (created > 0) this.#o.logger.info({ created }, "Fansly sync: page rows created");
    await this.#wake.start?.();
    await this.#runTick();
    this.#timer = setInterval(() => void this.#runTick(), this.#o.modeLoopIntervalMs ?? MODE_LOOP_INTERVAL_MS);
  }

  /** Per page: running (mode, generation), waiting (why), handover, idle. */
  state(pageId: number): HostPageState {
    const slot = this.#slots.get(pageId);
    if (slot !== undefined) return { kind: "running", mode: slot.mode, generation: slot.generation };
    const waiting = this.#waiting.get(pageId);
    if (waiting !== undefined) return { kind: "waiting", reason: waiting.reason, since: waiting.sinceWall };
    if (this.#handover.has(pageId)) return { kind: "handover" };
    return { kind: "idle" };
  }

  /** Run one mode-loop pass now (tests). */
  tick(): Promise<void> {
    return this.#runTick();
  }

  /**
   * Graceful stop (SIGTERM): no new step on any page; the request in flight
   * finishes (≤ 20 s) and is committed; whatever is still running after the
   * budget is aborted (nothing more is sent); every page gets its safe release
   * and its lock back; the session and the listener close.
   */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      await this.#tick?.catch(() => undefined);
      const slots = [...this.#slots.values()];
      for (const slot of slots) slot.stop.abort();
      const finished = await settleWithin(Promise.all(slots.map((slot) => slot.done)), SHUTDOWN_ACTOR_BUDGET_MS);
      if (!finished) {
        for (const slot of this.#slots.values()) slot.abort.abort();
        await settleWithin(Promise.all(slots.map((slot) => slot.done)), SHUTDOWN_ABORT_BUDGET_MS);
      }
      for (const [pageId, generation] of this.#pendingRelease) {
        if (await this.#release(pageId, generation)) this.#pendingRelease.delete(pageId);
      }
      await this.#session?.close();
      this.#session = null;
      await this.#wake.close?.();
    })();
    return this.#stopping;
  }

  #runTick(): Promise<void> {
    if (this.#stopping !== null) return Promise.resolve();
    this.#tick ??= this.#modeLoop()
      .catch((error: unknown) => {
        this.#o.logger.warn({ err: errorName(error) }, "Fansly sync host: mode loop pass failed");
      })
      .finally(() => {
        this.#tick = null;
      });
    return this.#tick;
  }

  async #modeLoop(): Promise<void> {
    for (const [pageId, generation] of [...this.#pendingRelease]) {
      if (!this.#slots.has(pageId) && (await this.#release(pageId, generation))) this.#pendingRelease.delete(pageId);
    }
    const session = await this.#ensureSession();
    const pages = await listSyncPages(this.#o.db);
    for (const page of pages) {
      if (this.#stopping !== null) return;
      const slot = this.#slots.get(page.pageId);
      const desired = this.#desiredRun(page);
      if (slot !== undefined) {
        if (desired !== slot.mode) {
          // Left its mode: finish the step in flight, release, re-acquire in
          // the new mode on a later pass. `handover` keeps the lock.
          slot.keepLock = page.mode === "handover";
          slot.stop.abort();
        }
        continue;
      }
      if (page.mode === "handover") {
        this.#waiting.delete(page.pageId);
        this.#handover.add(page.pageId);
        continue;
      }
      this.#handover.delete(page.pageId);
      if (desired === null) {
        this.#waiting.delete(page.pageId);
        if (page.mode === "live") this.#reportLiveDisabled(page);
        if (session?.holds(page.pageId) === true) await session.unlock(page.pageId).catch(() => undefined);
        continue;
      }
      if (session === null) {
        this.#markWaiting(page, "ownership_session_unavailable", 0);
        continue;
      }
      await this.#acquire(session, page, desired);
    }
  }

  #desiredRun(page: SyncPageRow): "shadow" | "live" | null {
    if (page.mode === "shadow") return "shadow";
    if (page.mode === "live" && this.#liveLoopEnabled) return "live";
    return null;
  }

  #reportLiveDisabled(page: SyncPageRow): void {
    if (this.#liveDisabledLogged.has(page.pageId)) return;
    this.#liveDisabledLogged.add(page.pageId);
    this.#o.logger.error({ pageId: page.pageId, pageLabel: page.pageLabel },
      "Fansly sync: page is 'live' but this build has no live loop (LIVE_LOOP_ENABLED = false); not acquired");
  }

  async #ensureSession(): Promise<PgOwnershipSession | null> {
    const current = this.#session;
    if (current !== null && current.alive()) return current;
    // A lost session is never re-used; its pages are re-acquired only after
    // their actors finished (their slots are gone).
    if (current !== null) {
      this.#session = null;
      await current.close();
      this.#sessionRetryMono = this.#clock.monoNow() + this.#sessionDelayMs;
    }
    if (this.#clock.monoNow() < this.#sessionRetryMono) return null;
    try {
      this.#session = await PgOwnershipSession.open({
        connectionString: this.#o.connectionString,
        checkDb: this.#o.db,
        onLost: () => this.#onSessionLost(),
      });
      this.#sessionDelayMs = SESSION_RECONNECT_MIN_MS;
      return this.#session;
    } catch (error) {
      this.#sessionRetryMono = this.#clock.monoNow() + this.#sessionDelayMs;
      this.#sessionDelayMs = Math.min(this.#sessionDelayMs * 2, SESSION_RECONNECT_MAX_MS);
      this.#o.logger.warn({ err: errorName(error) }, "Fansly sync host: the ownership session could not be opened");
      return null;
    }
  }

  #onSessionLost(): void {
    this.#metrics.increment("sync_ownership_session_lost");
    this.#o.logger.warn({ pages: [...this.#slots.keys()] },
      "Fansly sync host: the ownership session ended; actors finish their step and release");
    // Every actor sees `alive() === false` on its next check; the pacer's
    // send check already refuses a dispatch that has not started.
    for (const slot of this.#slots.values()) slot.stop.abort();
  }

  #markWaiting(page: SyncPageRow, reason: string, retryMs: number): void {
    const now = this.#clock.monoNow();
    const existing = this.#waiting.get(page.pageId);
    const waiting: Waiting = existing === undefined
      ? { reason, sinceMono: now, sinceWall: this.#clock.wallNow(), nextTryMono: now + retryMs, alerted: false }
      : { ...existing, reason, nextTryMono: now + retryMs };
    this.#waiting.set(page.pageId, waiting);
    if (!waiting.alerted && now - waiting.sinceMono >= OWNERSHIP_ALERT_AFTER_MS && page.mode !== "handover") {
      waiting.alerted = true;
      void this.#alerts.open({
        subKey: "page_stopped",
        pageId: page.pageId,
        detail: "ownership_unconfirmed",
        shadow: page.mode === "shadow",
        context: { reason },
      }).catch(() => undefined);
    }
  }

  async #acquire(session: PgOwnershipSession, page: SyncPageRow, mode: "shadow" | "live"): Promise<void> {
    const { db, logger } = this.#o;
    const pageId = page.pageId;
    const waiting = this.#waiting.get(pageId);
    if (waiting !== undefined && this.#clock.monoNow() < waiting.nextTryMono) {
      this.#markWaiting(page, waiting.reason, waiting.nextTryMono - this.#clock.monoNow());
      return;
    }
    if (!(await session.tryLock(pageId))) {
      this.#markWaiting(page, "lock_held_elsewhere", UNCONFIRMED_RETRY_MS);
      return;
    }
    const acquired = await acquireSyncPageOwnership(db, {
      pageId,
      owner: this.#identity,
      judgePreviousOwner: (previous) => this.#judge(previous),
    }).catch((error: unknown) => {
      logger.warn({ pageId, err: errorName(error) }, "Fansly sync host: acquire failed");
      return { kind: "error" as const };
    });
    if (acquired.kind !== "acquired") {
      await session.unlock(pageId).catch(() => undefined);
      this.#markWaiting(page, acquired.kind === "unconfirmed" ? "previous_owner_unconfirmed" : acquired.kind, UNCONFIRMED_RETRY_MS);
      return;
    }
    const generation = acquired.generation;
    const wasWaiting = this.#waiting.get(pageId);
    this.#waiting.delete(pageId);
    if (wasWaiting?.alerted === true) {
      void this.#alerts.resolve({ subKey: "page_stopped", pageId }).catch(() => undefined);
    }

    let transport: PageTransport | null = null;
    let pacer: Pacer;
    let ownRef: string | null;
    try {
      const settingMs = await this.#pause.readSettingMs();
      // I5: computed by the database clock, from every send of every owner.
      const floorDelayMs = await paceFloorFromDb(db, { pageId, settingMs: Math.max(settingMs, FANSLY_PAUSE_MIN_MS) });
      pacer = (this.#o.pacerFactory ?? createPacer)({
        clock: this.#clock,
        rng: this.#rng,
        pause: this.#pause,
        ownership: session,
      });
      pacer.initTakeover(floorDelayMs);
      ownRef = await readOwnRef(db, pageId);
      transport = mode === "shadow"
        ? new ShadowTransport({
          clock: this.#clock,
          latency: this.#o.shadowLatency?.(pageId) ?? createLegacyShadowLatency({ db, pageId, clock: this.#clock, rng: this.#rng }),
        })
        : await this.#liveTransport(page);
    } catch (error) {
      // Nothing was sent under the new generation: release it at once.
      await transport?.close().catch(() => undefined);
      if (!(await this.#release(pageId, generation))) this.#pendingRelease.set(pageId, generation);
      await session.unlock(pageId).catch(() => undefined);
      this.#markWaiting(page, "start_failed", UNCONFIRMED_RETRY_MS);
      logger.error({ pageId, err: errorName(error) }, "Fansly sync host: the page actor could not start");
      return;
    }

    const actor = new SyncActor({
      db,
      pageId,
      ownRef,
      generation,
      mode,
      registry: this.#o.registry,
      clock: this.#clock,
      rng: this.#rng,
      alerts: this.#alerts,
      metrics: this.#metrics,
      logger,
      pacer,
      transport,
      ownership: session,
      wake: this.#wake,
      settings: this.#settings,
      ...(this.#o.capture === undefined ? {} : { capture: this.#o.capture }),
      ...(this.#o.canonicalize === undefined ? {} : { canonicalize: this.#o.canonicalize }),
      ...(this.#o.onThreadChainChanged === undefined ? {} : { onThreadChainChanged: this.#o.onThreadChainChanged }),
      ...(this.#o.onWorkClosed === undefined ? {} : { onWorkClosed: this.#o.onWorkClosed }),
      ...(this.#o.shadowFeed === undefined ? {} : { shadowFeed: this.#o.shadowFeed }),
      ...(this.#o.faults === undefined ? {} : { faults: this.#o.faults }),
    });
    const stop = new AbortController();
    const abort = new AbortController();
    const slot: PageSlot = {
      pageId,
      mode,
      generation,
      actor,
      transport,
      stop,
      abort,
      keepLock: false,
      heartbeat: setInterval(() => void this.#heartbeat(slot), OWNER_HEARTBEAT_INTERVAL_MS),
      done: Promise.resolve(),
    };
    slot.heartbeat.unref?.();
    this.#slots.set(pageId, slot);
    logger.info({ pageId, pageLabel: page.pageLabel, mode, generation: generation.toString(), evidence: acquired.evidence },
      "Fansly sync host: page acquired");
    slot.done = actor.run({ stop: stop.signal, abort: abort.signal })
      .catch((error: unknown): ActorExit => ({ kind: "failed", error: errorName(error) }))
      .then((exit) => this.#onActorExit(slot, exit, session));
  }

  async #liveTransport(page: SyncPageRow): Promise<PageTransport> {
    if (this.#o.liveTransportFactory !== undefined) return this.#o.liveTransportFactory(page);
    if (page.pageLabel === null) throw new Error(`Fansly sync page ${page.pageId} has no label`);
    return createPageTransport({ db: this.#o.db, config: this.#o.config }, { pageId: page.pageId, pageLabel: page.pageLabel });
  }

  #judge(previous: SyncPageOwnerRecord): string | null {
    return judgeFanslySendHolderTermination({
      holderHost: previous.host,
      holderPid: previous.pid,
      holderPidStart: previous.pidStart,
      holderPidNs: previous.pidNs,
      holderBootId: previous.bootId,
      holderInstance: previous.instance,
    }, { identity: this.#identity, probe: this.#probe });
  }

  async #heartbeat(slot: PageSlot): Promise<void> {
    if (slot.stop.signal.aborted) return;
    try {
      const owned = await heartbeatSyncPageOwner(this.#o.db, { pageId: slot.pageId, generation: slot.generation });
      if (!owned) {
        this.#o.logger.error({ pageId: slot.pageId, generation: slot.generation.toString() },
          "Fansly sync host: the page has a newer owner; stopping its actor");
        slot.stop.abort();
      }
    } catch (error) {
      this.#o.logger.warn({ pageId: slot.pageId, err: errorName(error) }, "Fansly sync host: owner heartbeat failed");
    }
  }

  async #onActorExit(slot: PageSlot, exit: ActorExit, session: PgOwnershipSession): Promise<void> {
    clearInterval(slot.heartbeat);
    await slot.transport.close().catch(() => undefined);
    const foreign = exit.kind === "ownership_lost" && exit.foreign;
    if (!foreign) {
      // Safe release (rule (b)): nothing of this generation is in flight any
      // more and nothing will be. Without the database it stays pending and
      // the page waits — fail closed.
      if (!(await this.#release(slot.pageId, slot.generation))) this.#pendingRelease.set(slot.pageId, slot.generation);
    }
    if (!(slot.keepLock && session.alive())) await session.unlock(slot.pageId).catch(() => undefined);
    if (this.#slots.get(slot.pageId) === slot) this.#slots.delete(slot.pageId);
    const level = exit.kind === "stopped" || exit.kind === "mode_changed" ? "info" : "warn";
    this.#o.logger[level]({ pageId: slot.pageId, generation: slot.generation.toString(), exit },
      "Fansly sync host: page actor ended");
    if (exit.kind === "failed") {
      this.#metrics.increment("sync_actor_failed", { pageId: slot.pageId });
      this.#waiting.set(slot.pageId, {
        reason: "actor_failed",
        sinceMono: this.#clock.monoNow(),
        sinceWall: this.#clock.wallNow(),
        nextTryMono: this.#clock.monoNow() + UNCONFIRMED_RETRY_MS,
        alerted: false,
      });
    }
  }

  async #release(pageId: number, generation: bigint): Promise<boolean> {
    try {
      await writeSafeRelease(this.#o.db, { pageId, generation });
      return true;
    } catch (error) {
      this.#o.logger.warn({ pageId, err: errorName(error) }, "Fansly sync host: the safe release could not be written");
      return false;
    }
  }
}

async function readOwnRef(db: Database, pageId: number): Promise<string | null> {
  const result = await db.execute<{ ref: string | null }>(sql`
    select external_page_id as ref from pages where id = ${pageId}
  `);
  return result.rows[0]?.ref ?? null;
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The alert sink of step 2: alerts of the engine are logged and counted. A
 * shadow page's alerts are metrics only (D14); the paging incident kind and
 * its producers arrive with S2-13 (`engine/alerts.ts`).
 */
export function createLoggingAlertSink(logger: SyncLogger): AlertSink {
  return {
    async open(input) {
      const fields = { pageId: input.pageId, subKey: input.subKey, detail: input.detail, shadow: input.shadow };
      if (input.shadow) logger.info(fields, "Fansly sync shadow alert (metric only)");
      else logger.error(fields, "Fansly sync alert");
    },
    async resolve(input) {
      logger.info({ pageId: input.pageId, subKey: input.subKey }, "Fansly sync alert resolved");
    },
  };
}
