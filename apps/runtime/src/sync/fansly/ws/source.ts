import { randomUUID } from "node:crypto";

import {
  acquireFanslyWsOwnership,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  finishFanslyWsConnection,
  getOpenWorkForKey,
  guardFanslyWsConnection,
  isFanslyWsGenerationBlocked,
  replayFanslyWsDecode,
  type Database,
} from "@agency_hub_core/db";
import {
  composeFanslySendCheck,
  createOneShotSendCheck,
  safeFanslyAnswerHeaders,
  type FanslySendCompletionOutcome,
  type FanslySendLease,
  type FanslySendRefusalReason,
} from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import {
  readFanslyPageGeneration,
  readProbeGeneration,
  readProbeSnapshot,
} from "../../../services/egress/fansly-probe-context.ts";
import { openFanslyReceiverSocket } from "../../../services/egress/fansly-receiver-socket.ts";
import type { AppEgressContext } from "../../../services/egress/resolver.ts";
import {
  FANSLY_WS_CONNECTION_TIMING,
  receiveFanslyConnection,
  type FanslyReceiverSocket,
  type FanslyWsConnectionTiming,
  type FanslyWsStopReason,
} from "../../../services/fansly-ws/connection.ts";
import { createFanslyWsLiveApplier } from "../../../services/fansly-ws/live-apply.ts";
import { errorName, type SyncLogger } from "../../engine/commit.ts";
import { REQUEST_TIMEOUT_MS } from "../../engine/pacer.ts";
import type { AlertSink, Clock, Metrics, Rng, SendHooks, TransportOutcome } from "../../engine/ports.ts";
import type { DemandSignal } from "../../engine/resource.ts";
import { routeFanslyWsReceiptDemand } from "./route-receipt.ts";

// The page's WebSocket in the `sync` process (step-3 design §3.3, S2 §6.3): the
// step-1 receiver re-cut around the engine's pacer; the legacy receiver it came
// from is gone (step 4, S4-12). One source per LIVE page slot of the host (a
// page that is not live has no socket).
//
// - Ownership (J6): the source holds the page's socket lock `(58213, page)` on
//   its own dedicated session for as long as it runs, so no two sources (an
//   old host draining, a new one starting) ever both hold a page's socket. Every
//   capture and status write goes through that session (step-1 rule). A lost
//   session ends the connection without a drain; the source takes the lock
//   again and asks for a new connection.
// - The connection: never self-scheduled. The source raises `ws.connect`
//   demand (at start, and after every end on the step-1 ladder); the actor
//   admits it like any request, and the transport runs `handshake()` inside
//   the admitted step. Nothing else asks for the page's connection, so a
//   demand the database refused is written again — the same demand, the
//   same due time — while the source holds the lock and has no connection
//   (plan §9: demand outlives a database blip). The Upgrade rides an engine
//   lease (the step-1 `FanslySendLease` shape, G12/E15) whose send check is
//   the pacer's: it is the last check before the request headers (I1–I3),
//   and one admission is one Upgrade. The receiver keeps running after the
//   101.
// - Frames: captured on the owning session (observation + pending receipt),
//   then applied to the overlay and acked by the connection's applier, whose
//   post-ack hook routes the receipt's demand in the ack transaction (I18);
//   what the applier leaves is acked — and routed — by the worker timer.
// - Up and down: a verified connection raises `repair.ws-gap` demand (the
//   repair derives its window from the unreconciled connection rows, G17); a
//   socket down longer than two minutes raises `dm-conversations.ws-down`
//   once per outage; the auth frame's refusal blocks the credentials
//   generation (persisted on the connection row, as step 1) and raises
//   `account.verify` (written again while the block lasts if the database
//   refused it), with no reconnect until the generation changes.
// - Stop: `disabled` drains (the receiver captures what the socket already
//   delivered, ≤ 20 s; the applier ≤ 10 s; the connection row closes with the
//   instant intake stopped, the next connection's `gap_since`); `ownership_lost`
//   does not. Either way it is bounded, never rejects, and ends with the lock
//   session closed — before the host writes the page's safe release.

/** The overlay apply drain of a connection that ended: bounded to 10 s in
 *  `sync` (the leftovers stay pending for the worker timer, I18). */
export const SYNC_WS_APPLY_DRAIN_MS = 10_000;

/** The reconnect ladder (the step-1 receiver's): after `f`
 *  failed connections the next is due `min(60 s, 1.5 s × 2^min(f, 6)) ×
 *  U[0.8, 1.2]` later; after 10 failures in a row, 30 minutes. A connection
 *  that stayed up a minute resets the count. */
export const WS_RECONNECT_BASE_MS = 1_500;
export const WS_RECONNECT_CAP_MS = 60_000;
export const WS_RECONNECT_SLOW_AFTER_FAILURES = 10;
export const WS_RECONNECT_SLOW_MS = 30 * 60_000;

export function wsReconnectDelayMs(failures: number, random: number, baseMs = WS_RECONNECT_BASE_MS): number {
  const backoff = failures >= WS_RECONNECT_SLOW_AFTER_FAILURES
    ? WS_RECONNECT_SLOW_MS
    : Math.min(WS_RECONNECT_CAP_MS, baseMs * 2 ** Math.min(failures, 6));
  return backoff * (0.8 + Math.min(Math.max(random, 0), 1) * 0.4);
}

/** Source timing. Production always uses the defaults; the override exists
 *  only so integration tests can run on scaled time. It is not configuration. */
export interface FanslyWsSourceTiming extends FanslyWsConnectionTiming {
  /** The overlay apply drain after a connection ends. */
  applyDrainMs: number;
  /** The reconnect ladder's base (`wsReconnectDelayMs`). */
  reconnectBaseMs: number;
  /** The socket down this long ⇒ `dm-conversations.ws-down` (plan §7 p.10 (в)). */
  downListAfterMs: number;
  /** How often the down time is looked at. */
  downCheckMs: number;
  /** A lock held elsewhere is tried again, and a blocked credentials
   *  generation re-read, this often. */
  recheckMs: number;
  /** A lock session lost under the source is taken again after this pause. */
  reacquireMs: number;
  /** A handshake that has not settled by then answers `timeout`. */
  handshakeTimeoutMs: number;
  /** A reconnect demand waits at most this long for the step that made the
   *  attempt to settle (see `#requestConnect`). */
  settleWaitMs: number;
}

export const FANSLY_WS_SOURCE_TIMING: Readonly<FanslyWsSourceTiming> = Object.freeze({
  ...FANSLY_WS_CONNECTION_TIMING,
  applyDrainMs: SYNC_WS_APPLY_DRAIN_MS,
  reconnectBaseMs: WS_RECONNECT_BASE_MS,
  downListAfterMs: 2 * 60_000,
  downCheckMs: 10_000,
  recheckMs: 10_000,
  reacquireMs: 1_000,
  handshakeTimeoutMs: REQUEST_TIMEOUT_MS,
  settleWaitMs: 30_000,
});

/** What a stop may still take after the drains, before it gives up waiting. */
const STOP_SLACK_MS = 5_000;
/** The settle wait's poll. */
const SETTLE_POLL_MS = 200;

/** Opens the socket of one connection attempt over the page egress, on the
 *  lease that admits its Upgrade (`openFanslyReceiverSocket`). */
export type FanslyWsSocketOpener = (egress: AppEgressContext, lease: FanslySendLease) => {
  socket: FanslyReceiverSocket;
  stop(): void;
};

export interface FanslyWsSourceDeps {
  db: Database;
  /** The boot config: the stored session and the page egress are decoded with it. */
  config: AppConfig;
  logger: SyncLogger;
  clock: Clock;
  metrics: Metrics;
  connectionString: string;
  pageId: number;
  pageLabel: string;
  /** Upserts demand for this page (`ws.connect`, `repair.ws-gap`,
   *  `dm-conversations.ws-down`, `account.verify`) in its own generation-fenced
   *  transaction; `upsertDemand` wakes the actor. */
  enqueue(signals: readonly DemandSignal[]): Promise<void>;
  /** The reconnect jitter (default `Math.random`). */
  rng?: Rng;
  /** Alert 2 on a refusal of the socket alone. */
  alerts?: AlertSink;
  /** TESTS ONLY: scaled timing. */
  timing?: FanslyWsSourceTiming;
  /** TESTS ONLY: the socket opener (default `openFanslyReceiverSocket`). */
  openSocket?: FanslyWsSocketOpener;
}

export type WsSourceState = "idle" | "owning" | "connecting" | "open" | "down" | "blocked_generation" | "stopped";

// ── the engine's lease over the pacer check (G12, E15) ──────────────────────

/** How a handshake's Upgrade settled (the lease completion). */
export interface UpgradeSettlement {
  outcome: FanslySendCompletionOutcome;
  httpStatus: number | null;
  /** The answer's safe headers (`safeFanslyAnswerHeaders`): what the
   *  classifier reads of a refused Upgrade — a 429's or a 5xx's `Retry-After`. */
  headers: Readonly<Record<string, string>>;
}

/** A `FanslySendLease` whose send check is the admission's (the pacer's,
 *  one-shot): the step-1 socket code binds it exactly as it binds a guard
 *  lease, and its completion settles the handshake. Nothing is journaled
 *  here — the admission's `sync_attempts` row is the journal. */
export interface EngineUpgradeLease extends FanslySendLease {
  /** Resolves once, at the first `complete`. */
  readonly settled: Promise<UpgradeSettlement>;
  /** Why the check refused the dispatch (null: it did not). */
  readonly refusal: FanslySendRefusalReason | null;
}

export function createEngineUpgradeLease(hooks: SendHooks, input: { pageId: number }): EngineUpgradeLease {
  const gate = createOneShotSendCheck(hooks.check);
  let settle: (value: UpgradeSettlement) => void = () => undefined;
  const settled = new Promise<UpgradeSettlement>((resolve) => {
    settle = resolve;
  });
  let completed = false;
  return {
    token: randomUUID(),
    pageId: input.pageId,
    get sent() {
      return gate.sent;
    },
    get sendRefused() {
      return gate.refusal !== null;
    },
    get refusal() {
      return gate.refusal?.reason ?? null;
    },
    bind: (dispatcher) => composeFanslySendCheck(dispatcher, gate.check),
    async complete({ outcome, httpStatus, headers }) {
      if (completed) return;
      completed = true;
      // Only the safe headers settle the Upgrade, whoever completes the lease.
      settle({ outcome, httpStatus: httpStatus ?? null, headers: safeFanslyAnswerHeaders(headers) });
    },
    settled,
  };
}

/** The transport outcome of a settled Upgrade (design §3.3 item 1): an answer
 *  carries its status and safe headers, so the classifier reads a refused
 *  Upgrade as it reads a REST answer — a 429's `Retry-After` is the hold, a
 *  5xx naming its `Retry-After` is the provider's pause. */
export function upgradeOutcome(lease: Pick<EngineUpgradeLease, "sent" | "refusal">, settled: UpgradeSettlement): TransportOutcome {
  if (!lease.sent && lease.refusal !== null) return { kind: "aborted_before_send", refusal: lease.refusal };
  switch (settled.outcome) {
    case "response":
      return {
        kind: "response",
        status: settled.httpStatus ?? 0,
        headers: { ...settled.headers },
        bodyText: "",
        bodyBytes: 0,
        sendMark: lease.sent ? "request_start" : "completion_fallback",
      };
    case "timeout":
      return { kind: "timeout", sent: lease.sent, message: "fansly_ws_handshake_timeout" };
    case "transport_error":
      return { kind: "transport_error", sent: lease.sent, message: "fansly_ws_handshake_failed" };
    case "aborted_before_send":
      // The attempt ended before its dispatch reached the check (the socket
      // could not be opened, or the connection stopped first): nothing
      // reached Fansly, and it is not a refusal of the check.
      return { kind: "transport_error", sent: lease.sent, message: "fansly_ws_handshake_not_dispatched" };
  }
}

// ── the source ──────────────────────────────────────────────────────────────

type WsOwner = NonNullable<Awaited<ReturnType<typeof acquireFanslyWsOwnership>>>;

/** The `ws.connect` demand the source asked for and has not written yet. */
interface ConnectWant {
  reason: "ws_start" | "ws_reconnect" | "ws_generation_changed";
  dueAt: Date;
  failures: number;
}

interface Connection {
  id: string;
  generation: string;
  controller: AbortController;
  /** The connection was verified and its `repair.ws-gap` demand written. */
  up: boolean;
  upPending: boolean;
  /** The end processing finished (the receiver, the apply drain, the row). */
  ended: Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

/** The step-1 rule: only a graceful stop (`disabled`) still captures frames
 *  the socket delivered; ownership, generation or guard loss never does. */
function drainable(reason: unknown): boolean {
  return reason === "disabled";
}

export class FanslyWsSource {
  readonly #d: FanslyWsSourceDeps;
  readonly #timing: FanslyWsSourceTiming;
  readonly #life = new AbortController();
  #state: WsSourceState = "idle";
  #downSince: Date | null = null;
  #downListed = false;
  #failures = 0;
  #connectNotBefore: Date | null = null;
  /** Asked for and not written yet (null: nothing outstanding). */
  #connectWant: ConnectWant | null = null;
  /** `ws.connect` writes run one at a time. */
  #connectWrites: Promise<void> = Promise.resolve();
  #lastGeneration: string | null = null;
  #blockedGeneration: string | null = null;
  /** The refused generation whose `account.verify` was not written. */
  #verifyUnwritten: string | null = null;
  #owner: WsOwner | null = null;
  #connection: Connection | null = null;
  #started = false;
  #forced = false;
  #loop: Promise<void> | null = null;
  #downTimer: ReturnType<typeof setInterval> | null = null;
  #stopping: Promise<void> | null = null;

  constructor(deps: FanslyWsSourceDeps) {
    this.#d = deps;
    this.#timing = deps.timing ?? FANSLY_WS_SOURCE_TIMING;
  }

  get state(): WsSourceState {
    return this.#state;
  }

  /** Since when the page has no verified socket (null while it has one). */
  get downSince(): Date | null {
    return this.#downSince;
  }

  /** Connections that failed in a row (the reconnect ladder's position). */
  get failures(): number {
    return this.#failures;
  }

  /** The ladder's earliest instant for the next Upgrade (null: now). The
   *  `ws.connect` demand carries it as its due time; a plan that finds its
   *  row due earlier (a refused admission reopens a row at once) waits until
   *  then. */
  get connectNotBefore(): Date | null {
    return this.#connectNotBefore;
  }

  /** Take the page's socket lock (retrying while another session holds it),
   *  then ask for a connection. Idempotent. */
  start(): void {
    if (this.#started || this.#stopping !== null) return;
    this.#started = true;
    this.#downSince = this.#d.clock.wallNow();
    this.#downTimer = setInterval(() => void this.#checkDown(), this.#timing.downCheckMs);
    this.#downTimer.unref?.();
    this.#loop = this.#ownLoop().catch((error: unknown) => {
      this.#d.logger.error({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync WS: the ownership loop failed");
    });
  }

  /**
   * The one physical Upgrade of an admitted `ws.connect` step (S3-04 routes
   * `ws.upgrade` here): read the page's session and egress on the owning
   * session, open the connection row, open the socket on an engine lease
   * over `hooks.check`, and answer once the Upgrade settled — 101, another
   * status, an error, or a refusal of the check. The receiver keeps running
   * after a 101. Never throws. With `expect.credentialsGeneration` (the
   * digest the live transport checked against the verified one before the
   * admission), stored credentials that changed since open nothing: the
   * socket is asked for again, and that admission's check raises the verify.
   */
  async handshake(
    hooks: SendHooks,
    signal: AbortSignal,
    expect?: { credentialsGeneration: string | null },
  ): Promise<TransportOutcome> {
    const { pageId, pageLabel, logger } = this.#d;
    const owner = this.#owner;
    if (owner === null || !owner.alive || this.#stopping !== null || this.#connection !== null
      || (this.#state !== "owning" && this.#state !== "down")) {
      this.#d.metrics.increment("sync_ws_handshake_refused", { pageId, state: this.#state });
      return { kind: "aborted_before_send", refusal: "lease_inactive" };
    }
    const before = this.#state;
    this.#state = "connecting";
    this.#connectNotBefore = null;
    // This admitted step is the connection an unwritten demand asked for.
    this.#connectWant = null;
    let context: Awaited<ReturnType<typeof readProbeSnapshot>>;
    let accountRef: string;
    try {
      context = await readProbeSnapshot(owner.db, this.#d.config, pageLabel);
      if (context.pageId !== pageId || !context.expectedAccountId) {
        await context.egress.dispatcher?.destroy().catch(() => undefined);
        throw new Error("fansly_ws_identity_changed");
      }
      accountRef = context.expectedAccountId;
    } catch (error) {
      // Never log the error object: it may carry the session or SQL.
      logger.warn({ pageId, err: errorName(error) }, "Fansly sync WS: the page's session or egress could not be read");
      void this.#afterFailedAttempt("prepare_failed");
      return { kind: "transport_error", sent: false, message: "fansly_ws_prepare_failed" };
    }
    const { generation } = context;
    if (expect !== undefined && expect.credentialsGeneration !== generation) {
      // Not the credentials the admission checked: nothing is sent.
      await context.egress.dispatcher?.destroy().catch(() => undefined);
      this.#d.metrics.increment("sync_ws_handshake_refused", { pageId, state: "credentials_changed" });
      logger.info({ pageId }, "Fansly sync WS: the stored credentials changed since the admission; no Upgrade with them");
      this.#state = before;
      void this.#requestConnect("ws_generation_changed");
      return { kind: "aborted_before_send", refusal: "lease_inactive" };
    }
    if (generation !== this.#lastGeneration) {
      this.#failures = 0;
      this.#lastGeneration = generation;
    }
    try {
      if (await isFanslyWsGenerationBlocked(owner.db, pageId, generation)) {
        await context.egress.dispatcher?.destroy().catch(() => undefined);
        this.#block(generation, false);
        return { kind: "aborted_before_send", refusal: "lease_inactive" };
      }
      await replayFanslyWsDecode(owner.db, pageId).catch(() => undefined);
      const id = randomUUID();
      await beginFanslyWsConnection(owner.db, { id, pageId, generation });
      const lease = createEngineUpgradeLease(hooks, { pageId });
      const connection = this.#open(owner, context, accountRef, id, lease);
      return await this.#settle(connection, lease, signal);
    } catch (error) {
      await context.egress.dispatcher?.destroy().catch(() => undefined);
      logger.warn({ pageId, err: errorName(error) }, "Fansly sync WS: the connection could not be opened");
      void this.#afterFailedAttempt("open_failed");
      return { kind: "transport_error", sent: false, message: "fansly_ws_open_failed" };
    }
  }

  /**
   * Stop the source (bounded, never rejects). `disabled` (mode change,
   * shutdown) drains: frames already delivered are captured (≤ the receiver's
   * drain) and applied (≤ the apply drain), the row closes at the instant
   * intake stopped. `ownership_lost` (the page's engine ownership ended) does
   * not drain; called during a graceful stop it cuts it short. The lock
   * session is closed when it returns.
   */
  stop(reason: "disabled" | "ownership_lost"): Promise<void> {
    if (reason === "ownership_lost") this.#escalate();
    this.#stopping ??= this.#shutdown(reason);
    return this.#stopping;
  }

  // ── ownership ─────────────────────────────────────────────────────────────

  async #ownLoop(): Promise<void> {
    const { pageId, logger, metrics } = this.#d;
    while (!this.#life.signal.aborted) {
      const lost = deferred<void>();
      let owner: WsOwner | null = null;
      try {
        owner = await acquireFanslyWsOwnership(this.#d.connectionString, pageId, () => this.#onOwnerLost(lost.resolve));
      } catch (error) {
        logger.warn({ pageId, err: errorName(error) }, "Fansly sync WS: the socket lock session could not be opened");
      }
      if (owner === null) {
        // Another session holds the page's socket (a host still releasing
        // the page): look again shortly.
        this.#state = "idle";
        metrics.increment("sync_ws_lock_held_elsewhere", { pageId });
        await this.#sleep(this.#timing.recheckMs);
        continue;
      }
      if (this.#life.signal.aborted) {
        await owner.close();
        return;
      }
      this.#owner = owner;
      logger.info({ pageId, pageLabel: this.#d.pageLabel }, "Fansly sync WS: the page's socket lock is held");
      await this.#arm();
      await this.#whileOwned(lost.promise);
      if (this.#life.signal.aborted) return;
      // The session ended under the source: its connection (if any) ended
      // without a drain; the next owner of the row marks it `abandoned`.
      await this.#connection?.ended;
      this.#owner = null;
      this.#state = "idle";
      this.#downSince ??= this.#d.clock.wallNow();
      metrics.increment("sync_ws_ownership_lost", { pageId });
      logger.warn({ pageId }, "Fansly sync WS: the socket lock session ended; taking the lock again");
      await this.#sleep(this.#timing.reacquireMs);
    }
  }

  #onOwnerLost(resolveLost: () => void): void {
    const connection = this.#connection;
    if (connection !== null && !connection.controller.signal.aborted) connection.controller.abort("ownership_lost");
    resolveLost();
  }

  /** With the lock: a refused credentials generation stays refused (step 1);
   *  otherwise ask for a connection (now at start, on the ladder after a loss). */
  async #arm(): Promise<void> {
    const owner = this.#owner;
    if (owner === null) return;
    let generation: string | null = null;
    try {
      generation = await readProbeGeneration(this.#d.db, this.#d.pageLabel);
    } catch (error) {
      // No stored session or proxy yet: the handshake reports it.
      this.#d.logger.debug({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync WS: no credentials generation to check");
    }
    if (generation !== null && await isFanslyWsGenerationBlocked(owner.db, this.#d.pageId, generation).catch(() => false)) {
      this.#block(generation, false);
      return;
    }
    this.#state = "owning";
    await this.#requestConnect(this.#failures === 0 ? "ws_start" : "ws_reconnect");
  }

  /** Until the lock session is lost or the source stops; meanwhile re-read a
   *  blocked credentials generation and write again the demand the database
   *  refused. */
  async #whileOwned(lost: Promise<void>): Promise<void> {
    let isLost = false;
    void lost.then(() => {
      isLost = true;
    });
    while (!isLost && !this.#life.signal.aborted) {
      await Promise.race([lost, this.#sleep(this.#timing.recheckMs)]);
      if (isLost || this.#life.signal.aborted) return;
      if (this.#state === "blocked_generation") await this.#recheckBlocked();
      await this.#retryUnwritten();
    }
  }

  /** The one-time demands nothing else raises again: the connection while
   *  the page has no socket, the verify while its generation stays refused.
   *  (`repair.ws-gap` is retried by the next guard, `.ws-down` by the down
   *  timer.) */
  async #retryUnwritten(): Promise<void> {
    const verify = this.#verifyUnwritten;
    if (verify !== null) {
      if (this.#state === "blocked_generation" && this.#blockedGeneration === verify) await this.#writeVerify(verify);
      else this.#verifyUnwritten = null;
    }
    if (this.#connectWant !== null && this.#connection === null && (this.#state === "owning" || this.#state === "down")) {
      await this.#writeConnect(true);
    }
  }

  async #recheckBlocked(): Promise<void> {
    // Unreadable is not a new generation.
    const generation = await readProbeGeneration(this.#d.db, this.#d.pageLabel).catch(() => null);
    if (generation === null || generation === this.#blockedGeneration || this.#state !== "blocked_generation") return;
    this.#d.logger.info({ pageId: this.#d.pageId }, "Fansly sync WS: the page's credentials changed; connecting again");
    this.#blockedGeneration = null;
    this.#failures = 0;
    this.#state = "owning";
    await this.#requestConnect("ws_generation_changed");
  }

  #block(generation: string, refused: boolean): void {
    this.#state = "blocked_generation";
    this.#blockedGeneration = generation;
    // No reconnect until the generation changes.
    this.#connectWant = null;
    if (!refused) return;
    const { pageId, logger, metrics } = this.#d;
    metrics.increment("sync_ws_auth_refused", { pageId });
    logger.error({ pageId }, "Fansly sync WS: the socket refused the page's credentials; no reconnect until they change");
    // A REST answer decides whether the page's session is bad (a 401/403
    // holds the page, §9); the socket's own refusal is alert 2.
    void this.#writeVerify(generation);
    void this.#d.alerts?.open({ subKey: "live_degraded", pageId, detail: "ws_auth_refused", shadow: false })
      .catch(() => undefined);
  }

  /** The refused generation's `account.verify`; kept for `#retryUnwritten`
   *  while it could not be written. */
  async #writeVerify(generation: string): Promise<void> {
    if (await this.#enqueue([{ resource: "account.verify", demand: { reason: "ws_auth_refused" } }])) {
      if (this.#verifyUnwritten === generation) this.#verifyUnwritten = null;
    } else {
      this.#verifyUnwritten = generation;
    }
  }

  // ── one connection ────────────────────────────────────────────────────────

  #open(
    owner: WsOwner,
    context: Awaited<ReturnType<typeof readProbeSnapshot>>,
    accountRef: string,
    id: string,
    lease: EngineUpgradeLease,
  ): Connection {
    const { pageId, pageLabel, logger } = this.#d;
    const { generation, token, egress } = context;
    const controller = new AbortController();
    const connection: Connection = { id, generation, controller, up: false, upPending: false, ended: Promise.resolve() };
    this.#connection = connection;
    // Guard/status and capture share the lock-owning session without nested
    // transactions interleaving.
    let pending: Promise<unknown> = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = pending.then(operation);
      pending = next.catch(() => undefined);
      return next;
    };
    const validate = async (db: Database) => {
      if (!owner.alive || this.#forced || (controller.signal.aborted && !drainable(controller.signal.reason))) {
        throw new Error("fansly_ws_stopped");
      }
      if (await readFanslyPageGeneration(db, pageLabel) !== generation) {
        controller.abort("generation_changed");
        throw new Error("fansly_ws_generation_changed");
      }
    };
    // The receipt's demand is routed in the transaction that acks it (I18).
    const applier = createFanslyWsLiveApplier(
      { db: this.#d.db, logger: logger as never },
      { afterAck: routeFanslyWsReceiptDemand },
    );
    const opener = this.#d.openSocket ?? openFanslyReceiverSocket;
    const run = async (): Promise<FanslyWsStopReason> => {
      let reason: FanslyWsStopReason = "guard_unavailable";
      let intakeStoppedAt: Date | undefined;
      try {
        await validate(owner.db);
        reason = await receiveFanslyConnection({
          open: () => opener(egress, lease),
          token,
          signal: controller.signal,
          timing: this.#timing,
          onStable: () => {
            this.#failures = 0;
          },
          onIntakeStopped: (at) => {
            intakeStoppedAt = at;
          },
          capture: async (frame, ordinal, receivedAt) => {
            const observationId = await serial(() => captureFanslyWsFrame(owner.db, {
              connectionId: id, pageId, generation, accountRef, frame, ordinal, receivedAt, validate,
            }));
            // The overlay apply runs after the capture commit, on the pool.
            applier.enqueue(observationId);
            return observationId;
          },
          guard: (verified) => serial(async () => {
            await validate(owner.db);
            await guardFanslyWsConnection(owner.db, id, verified);
            await replayFanslyWsDecode(owner.db, pageId).catch(() => undefined);
            if (verified) this.#onVerified(connection);
          }),
        });
      } catch (error) {
        logger.warn({ pageId, connectionId: id, err: errorName(error) }, "Fansly sync WS: the connection could not run");
      } finally {
        controller.abort("disabled");
        // Settles a handshake whose attempt ended before its dispatch.
        await lease.complete({ outcome: lease.sent ? "transport_error" : "aborted_before_send" });
        // Captured frames reach the overlay before the row closes; whatever
        // the drain leaves stays pending for the worker timer.
        await applier.drain(this.#timing.applyDrainMs);
        // Only the lock-owning session writes; if it is gone, the next owner
        // closes the row as `abandoned`.
        await serial(() => finishFanslyWsConnection(owner.db, id, reason, intakeStoppedAt)).catch((error: unknown) => {
          logger.warn({ pageId, connectionId: id, stopReason: reason, err: owner.alive ? errorName(error) : "ownership_lost" },
            "Fansly sync WS: the connection close was not confirmed; the next owner marks it abandoned");
        });
        await egress.dispatcher?.destroy().catch(() => undefined);
      }
      return reason;
    };
    connection.ended = run()
      .then((reason) => this.#afterConnection(connection, owner, reason))
      .catch((error: unknown) => {
        logger.error({ pageId, connectionId: id, err: errorName(error) }, "Fansly sync WS: a connection's end failed");
      });
    return connection;
  }

  /** Wait for the Upgrade to settle (bounded by the request timeout and the
   *  actor's abort). */
  async #settle(connection: Connection, lease: EngineUpgradeLease, signal: AbortSignal): Promise<TransportOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const raced = await Promise.race([
        lease.settled.then((settled) => ({ kind: "settled" as const, settled })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), this.#timing.handshakeTimeoutMs);
        }),
        new Promise<{ kind: "aborted" }>((resolve) => {
          onAbort = () => resolve({ kind: "aborted" });
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (raced.kind === "timeout") {
        connection.controller.abort("disabled");
        return { kind: "timeout", sent: lease.sent, message: "fansly_ws_handshake_timeout" };
      }
      if (raced.kind === "aborted") {
        connection.controller.abort("ownership_lost");
        return lease.sent
          ? { kind: "transport_error", sent: true, message: "fansly_ws_handshake_aborted" }
          : { kind: "aborted_before_send", refusal: "lease_inactive" };
      }
      const outcome = upgradeOutcome(lease, raced.settled);
      if (outcome.kind === "response" && outcome.status === 101 && this.#state === "connecting") {
        this.#state = "open";
      }
      this.#d.metrics.increment("sync_ws_handshakes", {
        pageId: this.#d.pageId,
        outcome: outcome.kind === "response" ? String(outcome.status) : outcome.kind,
      });
      return outcome;
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  /** A verified connection: the socket is up; the gap since the previous one
   *  gets its repair (demand only, G17). Retried on the next guard while the
   *  demand could not be written. */
  #onVerified(connection: Connection): void {
    if (connection.up || connection.upPending || this.#connection !== connection) return;
    connection.upPending = true;
    if (this.#state === "connecting") this.#state = "open";
    this.#downSince = null;
    this.#downListed = false;
    void this.#enqueue([{ resource: "repair.ws-gap", demand: { reason: "ws_gap" } }]).then((written) => {
      connection.upPending = false;
      connection.up = written;
    });
  }

  async #afterConnection(connection: Connection, owner: WsOwner, reason: FanslyWsStopReason): Promise<void> {
    const { pageId, metrics, logger } = this.#d;
    if (this.#connection === connection) this.#connection = null;
    metrics.increment("sync_ws_connections_ended", { pageId, reason });
    this.#downSince ??= this.#d.clock.wallNow();
    if (this.#stopping !== null || this.#life.signal.aborted) return;
    logger.info({ pageId, connectionId: connection.id, stopReason: reason }, "Fansly sync WS: the connection ended");
    if (reason === "auth_refused") {
      this.#block(connection.generation, true);
      return;
    }
    this.#failures += 1;
    // A lost lock session: the ownership loop takes the lock again and asks
    // for the connection then.
    if (!owner.alive || this.#owner !== owner) return;
    this.#state = "down";
    await this.#requestConnect("ws_reconnect");
  }

  /** An attempt that failed before its socket opened. */
  async #afterFailedAttempt(why: string): Promise<void> {
    this.#d.metrics.increment("sync_ws_attempts_failed", { pageId: this.#d.pageId, why });
    if (this.#stopping !== null) return;
    this.#failures += 1;
    if (this.#state === "connecting") this.#state = "down";
    await this.#requestConnect("ws_reconnect");
  }

  /**
   * Ask for the next connection: `ws.connect` due now at start or after a
   * credentials change, else on the ladder. The demand is written once no
   * `ws.connect` step of the page is running: merged into the step that
   * made the attempt, it would make that row due again at once (a newer
   * demand keeps a settling row open, I11) and skip the ladder.
   */
  async #requestConnect(reason: ConnectWant["reason"]): Promise<void> {
    const deadline = this.#d.clock.monoNow() + this.#timing.settleWaitMs;
    while (!this.#life.signal.aborted && this.#d.clock.monoNow() < deadline) {
      if (!(await this.#connectRunning())) break;
      await this.#sleep(SETTLE_POLL_MS);
    }
    if (this.#life.signal.aborted) return;
    const now = this.#d.clock.wallNow();
    const dueAt = reason === "ws_reconnect"
      ? new Date(now.getTime() + Math.round(wsReconnectDelayMs(this.#failures, this.#random(), this.#timing.reconnectBaseMs)))
      : now;
    this.#connectNotBefore = reason === "ws_reconnect" ? dueAt : null;
    this.#connectWant = { reason, dueAt, failures: this.#failures };
    await this.#writeConnect(false);
  }

  /**
   * Write the wanted `ws.connect` demand, one write at a time; it stays
   * wanted until a write lands (`#retryUnwritten` writes it again, with its
   * first due time — the ladder's instant does not move). A retry leaves a
   * running step alone: that step is the connection (`handshake` drops the
   * want), or it ends and the next re-check writes the demand.
   */
  #writeConnect(retry: boolean): Promise<void> {
    const write = this.#connectWrites.then(async () => {
      const want = this.#connectWant;
      if (want === null || this.#life.signal.aborted) return;
      if (retry && await this.#connectRunning()) return;
      const written = await this.#enqueue([{
        resource: "ws.connect",
        dueAt: want.dueAt,
        params: { failures: want.failures },
        demand: { reason: want.reason },
      }]);
      if (!written || this.#connectWant !== want) return;
      this.#connectWant = null;
      if (retry) {
        this.#d.logger.info({ pageId: this.#d.pageId, reason: want.reason }, "Fansly sync WS: the connection demand was written on a retry");
      }
    });
    this.#connectWrites = write.catch(() => undefined);
    return write;
  }

  /** A `ws.connect` step of the page is running (unreadable: no). */
  async #connectRunning(): Promise<boolean> {
    const open = await getOpenWorkForKey(this.#d.db, { pageId: this.#d.pageId, shadow: false, resource: "ws.connect", subject: "" })
      .catch(() => null);
    return open?.state === "running";
  }

  // ── down ──────────────────────────────────────────────────────────────────

  async #checkDown(): Promise<void> {
    const since = this.#downSince;
    if (this.#stopping !== null || since === null || this.#downListed) return;
    if (this.#d.clock.wallNow().getTime() - since.getTime() <= this.#timing.downListAfterMs) return;
    // Once per outage: the work re-arms itself every 30 s while the socket
    // stays down, and a further demand would make it due at once.
    this.#downListed = true;
    this.#d.metrics.increment("sync_ws_down_list", { pageId: this.#d.pageId });
    if (!(await this.#enqueue([{ resource: "dm-conversations.ws-down", demand: { reason: "ws_down" } }]))) {
      this.#downListed = false;
    }
  }

  // ── stop ──────────────────────────────────────────────────────────────────

  #escalate(): void {
    if (this.#forced) return;
    this.#forced = true;
    const connection = this.#connection;
    if (connection !== null && !connection.controller.signal.aborted) connection.controller.abort("ownership_lost");
    // A graceful stop already draining: closing the lock session fails its
    // captures at once (they are not committed).
    if (this.#stopping !== null) void this.#owner?.close();
  }

  async #shutdown(reason: "disabled" | "ownership_lost"): Promise<void> {
    const { pageId, logger } = this.#d;
    this.#life.abort();
    if (this.#downTimer !== null) clearInterval(this.#downTimer);
    this.#downTimer = null;
    try {
      const connection = this.#connection;
      if (connection !== null) {
        if (!connection.controller.signal.aborted) connection.controller.abort(reason);
        const bound = this.#timing.drainMs + this.#timing.applyDrainMs + STOP_SLACK_MS;
        if (!(await settleWithin(connection.ended, bound))) {
          logger.warn({ pageId, connectionId: connection.id }, "Fansly sync WS: the drain overran its bound; closing the socket lock");
          this.#forced = true;
          await this.#owner?.close();
          await settleWithin(connection.ended, STOP_SLACK_MS);
        }
      }
      if (this.#loop !== null) await settleWithin(this.#loop, STOP_SLACK_MS);
    } finally {
      await this.#owner?.close();
      this.#owner = null;
      this.#connection = null;
      this.#state = "stopped";
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Write demand; false (logged) when it could not be written. */
  async #enqueue(signals: readonly DemandSignal[]): Promise<boolean> {
    try {
      await this.#d.enqueue(signals);
      return true;
    } catch (error) {
      this.#d.logger.warn({ pageId: this.#d.pageId, resources: signals.map((signal) => signal.resource), err: errorName(error) },
        "Fansly sync WS: demand could not be written");
      return false;
    }
  }

  #random(): number {
    return this.#d.rng?.next() ?? Math.random();
  }

  /** Sleep, cut short when the source stops. */
  async #sleep(ms: number): Promise<void> {
    await this.#d.clock.sleep(ms, this.#life.signal).catch(() => undefined);
  }
}
