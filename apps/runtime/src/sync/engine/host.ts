import { sql } from "drizzle-orm";

import {
  acquireSyncPageOwnership,
  ensureFanslySyncPages,
  getSyncPage,
  heartbeatSyncPageOwner,
  listSyncPages,
  lockOwnedPage,
  paceFloorFromDb,
  upsertDemands,
  writeSafeRelease,
  type Database,
  type FanslySendHolderIdentity,
  type SyncPageOwnerRecord,
  type SyncPageRow,
  type UpsertDemandInput,
} from "@agency_hub_core/db";
import { FANSLY_PAUSE_MIN_MS, type AppConfig } from "@agency_hub_core/shared";

import {
  buildFanslySendHolderIdentity,
  createDefaultFanslySendOsProbe,
  judgeFanslySendHolderTermination,
  type FanslySendOsProbe,
} from "../../services/fansly-send-guard/os-probe.ts";
import { resolveLegacyStreamIncidentsOfEnginePage } from "../../services/notification-incidents.ts";
import { createPageTransport } from "../fansly/transport.ts";
import { FanslyWsSource, type FanslyWsSourceDeps } from "../fansly/ws/source.ts";
import { createSyncWorkSecretBox } from "../requests/secret-params.ts";
import { SyncActor, type ActorExit } from "./actor.ts";
import { SYNC_OWNERSHIP_UNCONFIRMED_MS } from "./alerts.ts";
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
  type LivePageSocket,
  type LivePageSocketRef,
  type Metrics,
  type PageTransport,
  type PauseSource,
  type SettingsSource,
  type Rng,
  type Wake,
} from "./ports.ts";
import { demandToUpsert, type DemandSignal, type EngineRegistry } from "./resource.ts";
import { noStallTracker, type StallTracker, type StallTracking } from "./watchdog.ts";

// The host (plan §2.4, §8; design §3.6): pages ↔ actors. It owns the process's
// lock session and LISTEN client, watches `sync_pages.mode` every 2 s, takes a
// `live` page only when its previous owner is CONFIRMED stopped, starts one
// actor per owned page with the takeover floor, heartbeats each owner, and on
// shutdown, mode change or ownership loss lets the request in flight finish
// and writes the page's safe release. A page in any other mode runs no actor
// (`off`; `shadow`, a mode nothing runs since step 4 S4-23; `handover`).
//
// I17 — no live sender by accident. Independent gates, each pinned by
// tests/sync-live-gate.integration.test.ts:
//   1. `LIVE_LOOP_ENABLED` below (the build can run a live loop at all);
//   2. a page is `live` only by its birth: onboarding creates it so
//      (`createLiveSyncPage`, step 4 S4-05: a new page with nothing of the
//      legacy engine). No lever moves an existing page there — `sync page
//      mode` and `setSyncPageMode` know shadow → off alone; the step-3 switch
//      that took the six earlier pages live is gone (S4-21);
//   3. every live admission needs the step-1 guard row to be the engine's
//      (`owner_engine = 'fansly_sync_engine'`, checked in `lockOwnedPage`);
//   4. a live loop starts only on a row that carries its import mark
//      (`sync_pages.legacy_imported_at`, J3: stamped at a page's birth, and by
//      the switch's import for the pages it took over): a `live` row without
//      it waits (`legacy_not_imported`, alert after 2 min) and nothing is sent.
// The page transport (`fansly/transport.ts`) is built in one place only:
// `#acquire` below. A live page also gets its WebSocket source
// (`fansly/ws/source.ts`, design §3.3, J6): created with the slot, started once
// the actor exists, its Upgrade admitted by that actor like any request, and
// stopped — the socket closed and its lock session ended — before the page's
// safe release.

/** The live loop runs only when this is true (flipped at step 3, S3-05).
 *  Still no page sends without its `live` row, the engine's guard row and the
 *  import mark (gates 2–4 above). */
export const LIVE_LOOP_ENABLED = true;

/** The mode loop re-reads `sync_pages` this often. */
export const MODE_LOOP_INTERVAL_MS = 2_000;
/** Each owner's liveness mark (`owner_heartbeat_at`). */
export const OWNER_HEARTBEAT_INTERVAL_MS = 10_000;
/** A page whose previous owner is not confirmed stopped is retried this often. */
export const UNCONFIRMED_RETRY_MS = 5_000;
/** … and alerts (alert 1, `ownership`) after this long, except in `handover`
 *  (the evaluator's bound, `engine/alerts.ts`). */
export const OWNERSHIP_ALERT_AFTER_MS = SYNC_OWNERSHIP_UNCONFIRMED_MS;
/** A lost lock session is reopened after 1 s, doubling up to 30 s. */
export const SESSION_RECONNECT_MIN_MS = 1_000;
export const SESSION_RECONNECT_MAX_MS = 30_000;
/** Shutdown: the request in flight (≤ 20 s total) and its commits, and — in
 *  parallel — a live page's socket drain (≤ 20 s) and overlay apply drain
 *  (≤ 10 s). */
export const SHUTDOWN_ACTOR_BUDGET_MS = 30_000;
/** Shutdown: after a hard abort of what is left (the request, the drains).
 *  30 + 5 s and the releases sit inside the container's 45 s stop grace. */
export const SHUTDOWN_ABORT_BUDGET_MS = 5_000;

export type HostPageState =
  | { kind: "running"; generation: bigint }
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
  capture?: CaptureCodec;
  canonicalize?: ObservationCanonicalizer;
  onThreadChainChanged?: ThreadChainChangedHook;
  onWorkClosed?: WorkClosedHook;
  /** The process's stall watchdog (`engine/watchdog.ts`): it watches the
   *  host's start, every pass of the mode loop, and every actor from its
   *  start to the end of its exit. */
  watchdog?: StallTracking;
  modeLoopIntervalMs?: number;
  /** TESTS ONLY: override `LIVE_LOOP_ENABLED` (a host without a live loop,
   *  tests/sync-live-gate.integration.test.ts). `main.ts` never passes it
   *  (pinned by a grep test). */
  liveLoopEnabled?: boolean;
  /** TESTS ONLY: a pacer with a test setting floor. Never passed by `main.ts`. */
  pacerFactory?: (deps: PacerDeps) => Pacer;
  /** TESTS ONLY: the route budgets' time scale for every actor (paired with a
   *  test pause; `RoutePolicyOptions`). Never passed by `main.ts`. */
  routeTimeScale?: number;
  /** TESTS ONLY: a stand-in for the live page transport. `links.ws` is the
   *  page's socket source, whose `handshake` runs the `ws.connect` Upgrade;
   *  `links.socket` is the socket owner the production transport sends
   *  `ws.upgrade` through (the source, or a test's `liveSocket`). */
  liveTransportFactory?: (page: SyncPageRow, links: LivePageLinks) => Promise<PageTransport>;
  /** TESTS ONLY: the socket source's scaled timing and socket opener. */
  wsSourceOverrides?: Pick<FanslyWsSourceDeps, "timing" | "openSocket">;
  /** TESTS ONLY: a stand-in for a live page's socket owner, in place of the
   *  page's `FanslyWsSource` (none is created then): `ws.connect` plans by
   *  its state and the live transport sends the Upgrade through its
   *  handshake. Null for a page: no socket owner — `ws.connect` waits on
   *  `dependency`. Never passed by `main.ts`. */
  liveSocket?: (page: SyncPageRow) => LivePageSocket | null;
  /** TESTS ONLY: crash points. */
  faults?: SyncFaultHook;
}

/** What a live page's transport is wired to besides its egress. */
export interface LivePageLinks {
  /** The page's socket source (null: the page has no label, or a test's
   *  `liveSocket` stands in for it). */
  ws: FanslyWsSource | null;
  /** The page's socket owner the transport sends `ws.upgrade` through. */
  socket: LivePageSocketRef;
}

interface PageSlot {
  pageId: number;
  generation: bigint;
  actor: SyncActor;
  transport: PageTransport;
  /** The watchdog's tracker of the actor, done once its exit is through. */
  stall: StallTracker;
  /** The page's WebSocket (design §3.3, J6); null without a label, or where
   *  a test's `liveSocket` stands in for it. */
  ws: FanslyWsSource | null;
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

  /** A live page's socket source while its actor runs (null otherwise). */
  wsSource(pageId: number): FanslyWsSource | null {
    return this.#slots.get(pageId)?.ws ?? null;
  }

  async start(): Promise<void> {
    const boot = this.#o.watchdog?.track({ component: "host" }, "start") ?? noStallTracker;
    try {
      const created = await ensureFanslySyncPages(this.#o.db, { createdBy: "sync:host" });
      if (created > 0) this.#o.logger.info({ created }, "Fansly sync: page rows created");
      await this.#wake.start?.();
    } finally {
      boot.done();
    }
    await this.#runTick();
    this.#timer = setInterval(() => void this.#runTick(), this.#o.modeLoopIntervalMs ?? MODE_LOOP_INTERVAL_MS);
  }

  /** Per page: running (generation), waiting (why), handover, idle. */
  state(pageId: number): HostPageState {
    const slot = this.#slots.get(pageId);
    if (slot !== undefined) return { kind: "running", generation: slot.generation };
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
   * finishes (≤ 20 s) and is committed while, at the same time, every live
   * page's socket stops reading and drains what it already received (≤ 20 s
   * capture, ≤ 10 s overlay apply); whatever is still running after the
   * budget is aborted (nothing more is sent, the drains are cut); every page
   * gets its safe release — after its socket closed — and its lock back; the
   * session and the listener close.
   */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      await this.#tick?.catch(() => undefined);
      const slots = [...this.#slots.values()];
      for (const slot of slots) {
        slot.stop.abort();
        void slot.ws?.stop("disabled");
      }
      const finished = await settleWithin(Promise.all(slots.map((slot) => slot.done)), SHUTDOWN_ACTOR_BUDGET_MS);
      if (!finished) {
        for (const slot of this.#slots.values()) {
          slot.abort.abort();
          void slot.ws?.stop("ownership_lost");
        }
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
    if (this.#tick === null) {
      // A pass that never ends holds every later one (`??=`): the watchdog
      // sees it, the passes themselves never would.
      const pass = this.#o.watchdog?.track({ component: "host" }, "release") ?? noStallTracker;
      this.#tick = this.#modeLoop(pass)
        .catch((error: unknown) => {
          this.#o.logger.warn({ err: errorName(error) }, "Fansly sync host: mode loop pass failed");
        })
        .finally(() => {
          pass.done();
          this.#tick = null;
        });
    }
    return this.#tick;
  }

  async #modeLoop(pass: StallTracker): Promise<void> {
    for (const [pageId, generation] of [...this.#pendingRelease]) {
      if (!this.#slots.has(pageId) && (await this.#release(pageId, generation))) this.#pendingRelease.delete(pageId);
    }
    pass.progress("session");
    const session = await this.#ensureSession();
    pass.progress("list_pages");
    const pages = await listSyncPages(this.#o.db);
    for (const page of pages) {
      if (this.#stopping !== null) return;
      pass.progress("page");
      const slot = this.#slots.get(page.pageId);
      const run = this.#runs(page);
      if (slot !== undefined) {
        if (!run) {
          // Left `live`: finish the step in flight and release. `handover`
          // keeps the lock.
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
      if (run && page.legacyImportedAt === null) {
        // J3: a live row without its import mark (a page's birth always
        // writes one; a row set live by hand has none): no live loop, the
        // lock this host may hold since `handover` is kept.
        this.#markWaiting(page, "legacy_not_imported", UNCONFIRMED_RETRY_MS);
        continue;
      }
      if (!run) {
        this.#waiting.delete(page.pageId);
        if (page.mode === "live") this.#reportLiveDisabled(page);
        if (session?.holds(page.pageId) === true) await session.unlock(page.pageId).catch(() => undefined);
        continue;
      }
      if (session === null) {
        this.#markWaiting(page, "ownership_session_unavailable", 0);
        continue;
      }
      await this.#acquire(session, page);
    }
  }

  /** Whether this host runs an actor for the page: only a `live` page, and
   *  only in a build with a live loop. */
  #runs(page: SyncPageRow): boolean {
    return page.mode === "live" && this.#liveLoopEnabled;
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
        context: { reason },
      }).catch(() => undefined);
    }
  }

  async #acquire(session: PgOwnershipSession, page: SyncPageRow): Promise<void> {
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
    if (acquired.holdsImported) {
      // The old hold columns said something else than the page's hold set:
      // the previous image wrote them (or a hand did), and they won.
      this.#metrics.increment("sync_holds_imported", { pageId });
      logger.warn({ pageId, pageLabel: page.pageLabel },
        "Fansly sync host: the page's hold set was re-read from the old hold columns of its row");
    }
    const wasWaiting = this.#waiting.get(pageId);
    this.#waiting.delete(pageId);
    if (wasWaiting?.alerted === true) {
      void this.#alerts.resolve({ subKey: "page_stopped", pageId }).catch(() => undefined);
    }

    let transport: PageTransport | null = null;
    let pacer: Pacer;
    let ownRef: string | null;
    // The page's socket (J6): created with the slot, started once its actor
    // exists, stopped before the page's safe release. It is the page's socket
    // owner: `ws.connect` plans by its state, the transport sends the Upgrade
    // through its handshake (a test's `liveSocket` stands in for it).
    const ws = this.#createWsSource(page, generation);
    const standIn = this.#o.liveSocket;
    const socket: LivePageSocket | null = standIn === undefined ? ws : standIn(page);
    const socketRef: LivePageSocketRef = () => socket;
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
      transport = await this.#liveTransport(page, { ws, socket: socketRef });
    } catch (error) {
      // Nothing was sent under the new generation: release it at once.
      await transport?.close().catch(() => undefined);
      if (!(await this.#release(pageId, generation))) this.#pendingRelease.set(pageId, generation);
      await session.unlock(pageId).catch(() => undefined);
      this.#markWaiting(page, "start_failed", UNCONFIRMED_RETRY_MS);
      logger.error({ pageId, err: errorName(error) }, "Fansly sync host: the page actor could not start");
      return;
    }

    const stall = this.#o.watchdog?.track({ component: "actor", pageId, generation }, "recover") ?? noStallTracker;
    const actor = new SyncActor({
      db,
      pageId,
      ownRef,
      generation,
      stall,
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
      ...(this.#o.faults === undefined ? {} : { faults: this.#o.faults }),
      ...(this.#o.routeTimeScale === undefined ? {} : { routeTimeScale: this.#o.routeTimeScale }),
      socket: socketRef,
      secrets: createSyncWorkSecretBox(this.#o.config),
    });
    const stop = new AbortController();
    const abort = new AbortController();
    const slot: PageSlot = {
      pageId,
      generation,
      actor,
      transport,
      stall,
      ws,
      stop,
      abort,
      keepLock: false,
      heartbeat: setInterval(() => void this.#heartbeat(slot), OWNER_HEARTBEAT_INTERVAL_MS),
      done: Promise.resolve(),
    };
    slot.heartbeat.unref?.();
    this.#slots.set(pageId, slot);
    logger.info({ pageId, pageLabel: page.pageLabel, generation: generation.toString(), evidence: acquired.evidence },
      "Fansly sync host: page acquired");
    slot.done = actor.run({ stop: stop.signal, abort: abort.signal })
      .catch((error: unknown): ActorExit => ({ kind: "failed", error: errorName(error) }))
      .then((exit) => this.#onActorExit(slot, exit, session));
    ws?.start();
    await this.#closeLegacyStreamIncidents(page);
  }

  /**
   * Every takeover closes the page's legacy stream latches, which only
   * the legacy executor's chunk recovery resolved and which nothing resolves
   * once the engine runs the page (`resolveLegacyStreamIncidentsOfEnginePage`,
   * reason `engine_owned`): a page switched before the build that added this
   * has its own closed on its first takeover after it. Idempotent (nothing
   * open, nothing written); never throws.
   */
  async #closeLegacyStreamIncidents(page: SyncPageRow): Promise<void> {
    const closed = await resolveLegacyStreamIncidentsOfEnginePage(this.#o, { pageId: page.pageId, pageLabel: page.pageLabel });
    if (closed.length > 0) {
      this.#o.logger.info({ pageId: page.pageId, pageLabel: page.pageLabel, streams: closed },
        "Fansly sync host: the legacy stream incidents of a live page closed (engine_owned)");
    }
  }

  async #liveTransport(page: SyncPageRow, links: LivePageLinks): Promise<PageTransport> {
    if (this.#o.liveTransportFactory !== undefined) return this.#o.liveTransportFactory(page, links);
    if (page.pageLabel === null) throw new Error(`Fansly sync page ${page.pageId} has no label`);
    return createPageTransport(
      { db: this.#o.db, config: this.#o.config },
      { pageId: page.pageId, pageLabel: page.pageLabel },
      { socket: links.socket },
    );
  }

  #createWsSource(page: SyncPageRow, generation: bigint): FanslyWsSource | null {
    // TESTS ONLY: a stand-in owns the page's socket; no source competes for it.
    if (this.#o.liveSocket !== undefined) return null;
    if (page.pageLabel === null) {
      this.#o.logger.error({ pageId: page.pageId }, "Fansly sync host: a live page without a label has no socket");
      return null;
    }
    return new FanslyWsSource({
      db: this.#o.db,
      config: this.#o.config,
      logger: this.#o.logger,
      clock: this.#clock,
      metrics: this.#metrics,
      connectionString: this.#o.connectionString,
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      rng: this.#rng,
      alerts: this.#alerts,
      enqueue: (signals) => this.#enqueueLiveDemand(page.pageId, generation, signals),
      ...(this.#o.wsSourceOverrides?.timing === undefined ? {} : { timing: this.#o.wsSourceOverrides.timing }),
      ...(this.#o.wsSourceOverrides?.openSocket === undefined ? {} : { openSocket: this.#o.wsSourceOverrides.openSocket }),
    });
  }

  /** A socket source's demand (`ws.connect`, repair, `.ws-down`, verify):
   *  one transaction fenced by the slot's generation, through the registry's
   *  coalescing and SLO rules; a key the registry does not know is dropped. */
  async #enqueueLiveDemand(pageId: number, generation: bigint, signals: readonly DemandSignal[]): Promise<void> {
    const now = this.#clock.wallNow();
    await this.#o.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await lockOwnedPage(tx, { pageId, generation, lock: "no_key_update" });
      const page = await getSyncPage(tx, pageId);
      const upserts: UpsertDemandInput[] = [];
      for (const signal of signals) {
        const spec = this.#o.registry.spec(signal.resource);
        if (spec === null) {
          this.#metrics.increment("sync_ws_demand_unknown_resource", { resource: signal.resource });
          continue;
        }
        const upsert = demandToUpsert(signal, spec, { pageId, now, ...(page === null ? {} : { page }) });
        if (upsert !== null) upserts.push(upsert);
      }
      if (upserts.length > 0) await upsertDemands(tx, upserts);
    });
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
    // Still watched: a socket stop or a release that never ends would keep
    // the page from any owner.
    slot.stall.progress("exit");
    try {
      await this.#endSlot(slot, exit, session);
    } finally {
      slot.stall.done();
    }
  }

  async #endSlot(slot: PageSlot, exit: ActorExit, session: PgOwnershipSession): Promise<void> {
    clearInterval(slot.heartbeat);
    // J6: the socket is closed and its lock session ended BEFORE the safe
    // release (bounded; a lost ownership does not drain).
    await slot.ws?.stop(exit.kind === "ownership_lost" ? "ownership_lost" : "disabled");
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
 * The host's default alert sink (tests, tools): alerts are logged only. The
 * `sync` process passes the incident sink (`engine/alerts.ts`).
 */
export function createLoggingAlertSink(logger: SyncLogger): AlertSink {
  return {
    async open(input) {
      logger.error({ pageId: input.pageId, subKey: input.subKey, detail: input.detail }, "Fansly sync alert");
    },
    async resolve(input) {
      logger.info({ pageId: input.pageId, subKey: input.subKey }, "Fansly sync alert resolved");
    },
  };
}
