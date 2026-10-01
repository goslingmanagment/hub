import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  CaptureFanslyPageSendGuardInput,
  CaptureFanslyPageSendGuardResult,
  CompleteFanslySendAttemptInput,
  FanslySendGuardHolderSummary,
  FanslySendHolderIdentity,
} from "@agency_hub_core/db";
import type { Dispatcher } from "undici";

// The contract module directly, not the package index: the index also loads
// the adapter (and with it undici's fetch), which neither this module nor its
// test doubles need.
import {
  composeFanslySendCheck,
  FanslySendRefusedError,
  type FanslySendCompletionOutcome,
  type FanslySendGuard,
  type FanslySendGuardAcquireInput,
  type FanslySendLease,
  type FanslySendRefusalReason,
  type FanslySendSource,
} from "../../../../../packages/fansly/src/send-guard.ts";

// Plan §2.5 step 1: the legacy engine's per-page Fansly send guard, process
// side. The page's row in the database is the only authority (see
// packages/db/src/repositories/fansly-send-guard.ts); this module turns it into
// leases for the adapter:
//
//   acquire  — capture the row (endpoint pauses were already reserved by the
//              caller). Refused because of the pause: sleep exactly the time the
//              database says is left. Refused because a request is in flight:
//              poll about every 250 ms — or, when THIS process holds the page,
//              wait for that request's completion locally. Refused because the
//              holder overran its lease: the page is closed, and acquire fails.
//   send     — the bound dispatcher checks synchronously, right before the
//              headers are written, that the lease is still live, unused and
//              inside its send window, which is measured from the monotonic time
//              taken BEFORE the capture statement was issued (conservative).
//   complete — written after the body was read (or the error/timeout), retried
//              with backoff until it is durable. Until then this process
//              captures nothing else for the page, and the page stays closed for
//              everyone else — which is the safe failure.

/** u ∈ [0, 0.2): each pause is S × (1 + u). A constant, not a setting. */
export const FANSLY_SEND_JITTER_MAX = 0.2;
/** Lease = send window (the request timeout) + the request timeout + this. */
export const FANSLY_SEND_LEASE_MARGIN_MS = 15_000;
/** Poll while another process's request is in flight (± 20 %). */
export const FANSLY_SEND_BUSY_POLL_MS = 250;
const BUSY_POLL_SPREAD = 0.2;
const COMPLETION_RETRY_FIRST_MS = 200;
const COMPLETION_RETRY_MAX_MS = 5_000;

export interface FanslySendGuardStore {
  capture(input: CaptureFanslyPageSendGuardInput): Promise<CaptureFanslyPageSendGuardResult>;
  journalUnpaced(input: {
    token: string;
    source: FanslySendSource;
    operation: string;
    holder: FanslySendHolderIdentity;
  }): Promise<{ journalId: string }>;
  markSent(input: { token: string; sentAt: Date; sendOffsetMs: number }): Promise<void>;
  complete(input: CompleteFanslySendAttemptInput): Promise<{ released: boolean; journaled: boolean }>;
  markClosed(input: { pageId: number; token: string; reason: string }): Promise<boolean>;
}

export interface FanslySendGuardClock {
  /** Monotonic milliseconds (performance.now in production). */
  monotonicMs(): number;
  /** Wall-clock milliseconds, for the journal's `sent_at`. */
  wallMs(): number;
  /** Sleep; rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal | null): Promise<void>;
}

export interface FanslySendLeaseInfo {
  readonly token: string;
  readonly pageId: number | null;
  readonly source: FanslySendSource;
  readonly operation: string;
  readonly journalId: string | null;
}

/** Test hooks for the acceptance test (plan §2.5 p.3 (a)). Never set in
 *  production. */
export interface FanslySendGuardHooks {
  /** After a capture, before `acquire` returns: a delay here stands for the
   *  work between capture and send (observers, the dispatcher queue). */
  afterCapture?(lease: FanslySendLeaseInfo): Promise<void> | void;
  /** SYNCHRONOUSLY after the send check passed and before the headers are
   *  written: a block here is a process stopped after its last token check. */
  afterSendCheck?(lease: FanslySendLeaseInfo): void;
  /** Before the completion is written; a promise that never settles is a hung
   *  sender. */
  beforeCompletion?(lease: FanslySendLeaseInfo): Promise<void> | void;
}

export interface FanslySendGuardLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface FanslySendGuardCounters {
  captures: number;
  /** Capture attempts the database refused (pause or busy). */
  captureRefusals: number;
  /** Dispatches the send check refused. */
  sendRefusals: number;
  closedRefusals: number;
}

export interface FanslySendGuardRegistryDeps {
  store: FanslySendGuardStore;
  /** S, read fresh before every capture. */
  readSettingMs: () => Promise<number>;
  identity: () => FanslySendHolderIdentity;
  logger: FanslySendGuardLogger;
  clock?: FanslySendGuardClock;
  /** Uniform [0, 1); drives u and the busy-poll spread. */
  random?: () => number;
  hooks?: FanslySendGuardHooks;
  /** The lease's margin over send window + request timeout. Tests shorten
   *  it; production keeps FANSLY_SEND_LEASE_MARGIN_MS. */
  leaseMarginMs?: number;
}

/** The page's holder overran its lease and is neither completed nor confirmed
 *  terminated: nothing may be sent for the page (plan §2.5 p.1). */
export class FanslyPageSendClosedError extends Error {
  constructor(readonly pageId: number, readonly holder: FanslySendGuardHolderSummary) {
    super(
      `Fansly page ${pageId} is closed to new requests: the request held by `
        + `${holder.role ?? "?"}@${holder.host ?? "?"} pid ${holder.pid ?? "?"} `
        + `(${holder.source ?? "?"}/${holder.operation ?? "?"}) overran its lease`
        + `${holder.leaseUntil ? ` at ${holder.leaseUntil.toISOString()}` : ""} and is neither `
        + "completed nor confirmed terminated (see `fansly-send-guard status`)",
    );
    this.name = "FanslyPageSendClosedError";
  }
}

/** The process is shutting down: it starts no new Fansly request. */
export class FanslySendGuardStoppedError extends Error {
  constructor() {
    super("Fansly send guard is stopping: no new requests are admitted");
    this.name = "FanslySendGuardStoppedError";
  }
}

export const systemFanslySendGuardClock: FanslySendGuardClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
  async sleep(ms, signal) {
    if (ms <= 0) {
      signal?.throwIfAborted();
      return;
    }
    try {
      await delay(ms, undefined, signal ? { signal } : undefined);
    } catch (error) {
      // node:timers wraps the reason in an AbortError; keep the owner's.
      signal?.throwIfAborted();
      throw error;
    }
  },
};

async function waitFor(promise: Promise<void>, signal: AbortSignal | null) {
  signal?.throwIfAborted();
  if (!signal) {
    await promise;
    return;
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForValue<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  let value!: T;
  await waitFor(promise.then((resolved) => {
    value = resolved;
  }), signal);
  return value;
}

function assertRequestTimeout(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Fansly send guard needs a positive request timeout (got ${value})`);
  }
  return value;
}

/** S must be a finite, non-negative number of milliseconds. The owner's range
 *  is validated where the setting is written; here an unusable value closes
 *  the page rather than guessing one. */
function assertSettingMs(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Fansly send guard refuses an unusable pause setting (${value} ms)`);
  }
  return value;
}

class GuardLease implements FanslySendLease, FanslySendLeaseInfo {
  readonly settled: Promise<void>;
  #resolveSettled!: () => void;
  #state: "held" | "completing" | "done" = "held";
  #sent = false;
  #refusal: FanslySendRefusedError | null = null;
  #sentWallMs: number | null = null;
  #sendOffsetMs: number | null = null;
  #completion: Promise<void> | null = null;

  constructor(
    private readonly registry: FanslySendGuardRegistry,
    readonly token: string,
    readonly pageId: number | null,
    readonly source: FanslySendSource,
    readonly operation: string,
    readonly journalId: string | null,
    /** Monotonic time taken before the capture statement was issued. */
    readonly issuedAt: number,
    /** Monotonic deadline for the send; past it the lease never sends. */
    readonly sendDeadline: number,
    /** False for the release of a capture whose outcome was lost. */
    readonly expectHeld: boolean,
  ) {
    this.settled = new Promise<void>((resolve) => {
      this.#resolveSettled = resolve;
    });
  }

  get sent() {
    return this.#sent;
  }

  get sendRefused() {
    return this.#refusal !== null;
  }

  bind(dispatcher: Dispatcher): Dispatcher {
    return composeFanslySendCheck(dispatcher, () => this.checkSend());
  }

  /** Synchronous: runs inside undici's `onRequestStart`. */
  checkSend(): FanslySendRefusedError | null {
    const clock = this.registry.clock;
    const now = clock.monotonicMs();
    let reason: FanslySendRefusalReason | null = null;
    if (this.#state !== "held") reason = "lease_inactive";
    else if (this.#sent) reason = "lease_used";
    else if (now >= this.sendDeadline) reason = "send_deadline_passed";
    if (reason !== null) {
      const refusal = new FanslySendRefusedError(reason);
      this.#refusal ??= refusal;
      this.registry.noteSendRefused(this, reason);
      return refusal;
    }
    this.#sent = true;
    this.#sentWallMs = clock.wallMs();
    this.#sendOffsetMs = Math.max(0, Math.ceil(now - this.issuedAt));
    this.registry.recordSent(this, new Date(this.#sentWallMs), this.#sendOffsetMs);
    this.registry.hooks?.afterSendCheck?.(this);
    return null;
  }

  complete(input: { outcome: FanslySendCompletionOutcome; httpStatus?: number | null }): Promise<void> {
    if (!this.#completion) {
      this.#state = "completing";
      const outcome: FanslySendCompletionOutcome = !this.#sent && this.#refusal !== null
        ? "aborted_before_send"
        : input.outcome;
      this.#completion = this.registry
        .writeCompletion(this, {
          outcome,
          outcomeDetail: this.#refusal?.reason ?? null,
          httpStatus: input.httpStatus ?? null,
          sentAt: this.#sentWallMs === null ? null : new Date(this.#sentWallMs),
          sendOffsetMs: this.#sendOffsetMs,
        })
        .finally(() => {
          this.#state = "done";
          this.#resolveSettled();
        });
    }
    return this.#completion;
  }
}

/**
 * One per process. Hands out guards bound to a page (or to no page) and a
 * source; tracks this process's leases so a shutdown can stop new captures and
 * wait for the in-flight requests' completions.
 */
export class FanslySendGuardRegistry {
  readonly clock: FanslySendGuardClock;
  readonly hooks: FanslySendGuardHooks | undefined;
  readonly counters: FanslySendGuardCounters = {
    captures: 0,
    captureRefusals: 0,
    sendRefusals: 0,
    closedRefusals: 0,
  };
  #stopped = false;
  readonly #inflight = new Set<GuardLease>();
  /** The lease this process holds per page (until its completion is durable). */
  readonly #localHolds = new Map<number, GuardLease>();
  readonly #random: () => number;

  constructor(private readonly deps: FanslySendGuardRegistryDeps) {
    this.clock = deps.clock ?? systemFanslySendGuardClock;
    this.hooks = deps.hooks;
    this.#random = deps.random ?? Math.random;
  }

  get stopped() {
    return this.#stopped;
  }

  /** This process as a holder of guard rows. */
  holderIdentity(): FanslySendHolderIdentity {
    return this.deps.identity();
  }

  get inflightCount() {
    return this.#inflight.size;
  }

  /** The guard of one page for one kind of sender. */
  forPage(pageId: number, source: FanslySendSource): FanslySendGuard {
    if (!Number.isSafeInteger(pageId) || pageId <= 0) {
      throw new Error(`Fansly send guard needs a page id (got ${pageId})`);
    }
    return { acquire: (input) => this.acquirePage(pageId, source, input) };
  }

  /** The check of a session whose account is unknown yet (onboarding, the
   *  credentials check): journaled, one physical request per lease, but paced
   *  against no page (plan §2.4, owner decision №4). */
  withoutPage(source: FanslySendSource): FanslySendGuard {
    return { acquire: (input) => this.acquireUnpaced(source, input) };
  }

  /** Stop admitting new captures (SIGTERM). In-flight requests go on. */
  stop() {
    this.#stopped = true;
  }

  /** Wait until every lease of this process has its completion written. */
  async drain() {
    while (this.#inflight.size > 0) {
      await Promise.allSettled(Array.from(this.#inflight, (lease) => lease.settled));
    }
  }

  async close() {
    this.stop();
    await this.drain();
  }

  /** Best effort, never awaited: the completion writes the same values. */
  recordSent(lease: FanslySendLeaseInfo, sentAt: Date, sendOffsetMs: number) {
    void this.deps.store.markSent({ token: lease.token, sentAt, sendOffsetMs }).catch((error: unknown) => {
      this.deps.logger.warn({
        component: "fansly_send_guard",
        pageId: lease.pageId,
        err: error,
      }, "Fansly send guard could not record the send moment yet; the completion will");
    });
  }

  noteSendRefused(lease: FanslySendLeaseInfo, reason: FanslySendRefusalReason) {
    this.counters.sendRefusals += 1;
    this.deps.logger.warn({
      component: "fansly_send_guard",
      pageId: lease.pageId,
      source: lease.source,
      operation: lease.operation,
      reason,
    }, "Fansly send guard refused a dispatch; nothing was sent");
  }

  private assertOpen(signal: AbortSignal | null) {
    signal?.throwIfAborted();
    if (this.#stopped) throw new FanslySendGuardStoppedError();
  }

  private busyPollMs() {
    const spread = (this.#random() * 2 - 1) * BUSY_POLL_SPREAD;
    return Math.max(1, Math.ceil(FANSLY_SEND_BUSY_POLL_MS * (1 + spread)));
  }

  private nextU() {
    const draw = Math.min(Math.max(this.#random(), 0), 1 - Number.EPSILON);
    return draw * FANSLY_SEND_JITTER_MAX;
  }

  private async acquirePage(
    pageId: number,
    source: FanslySendSource,
    input: FanslySendGuardAcquireInput,
  ): Promise<FanslySendLease> {
    const requestTimeoutMs = assertRequestTimeout(input.requestTimeoutMs);
    const signal = input.signal ?? null;
    const startedAt = this.clock.monotonicMs();
    let refusals = 0;

    for (;;) {
      this.assertOpen(signal);
      const held = this.#localHolds.get(pageId);
      if (held) {
        // This process holds the page: its own completion is the event to
        // wait for, not a database poll.
        await waitFor(held.settled, signal);
        continue;
      }

      // A read only: abandoning it on abort leaves nothing behind (unlike the
      // capture statement, which is always waited for).
      const settingMs = assertSettingMs(await waitForValue(this.deps.readSettingMs(), signal));
      this.assertOpen(signal);
      if (this.#localHolds.has(pageId)) continue;

      const sendWindowMs = requestTimeoutMs;
      const leaseMs = sendWindowMs + requestTimeoutMs + (this.deps.leaseMarginMs ?? FANSLY_SEND_LEASE_MARGIN_MS);
      const token = randomUUID();
      const issuedAt = this.clock.monotonicMs();
      let result: CaptureFanslyPageSendGuardResult;
      try {
        result = await this.deps.store.capture({
          pageId,
          token,
          source,
          operation: input.operation,
          holder: this.deps.identity(),
          settingMs,
          leaseMs,
          captureWaitMs: Math.max(0, Math.ceil(issuedAt - startedAt)),
          captureRefusals: refusals,
        });
      } catch (error) {
        // The capture may have committed with its answer lost. Release what
        // this token holds (nothing, when it captured nothing) and keep the
        // page closed in this process until that release is durable.
        this.releaseUnknownCapture(pageId, token, source, input.operation, issuedAt);
        throw error;
      }

      if (result.kind === "captured") {
        const lease = new GuardLease(
          this, token, pageId, source, input.operation, result.journalId,
          issuedAt, issuedAt + sendWindowMs, true,
        );
        this.#localHolds.set(pageId, lease);
        this.#inflight.add(lease);
        this.counters.captures += 1;
        if (signal?.aborted || this.#stopped) {
          await lease.complete({ outcome: "aborted_before_send" });
          this.assertOpen(signal);
        }
        if (this.hooks?.afterCapture) {
          try {
            await this.hooks.afterCapture(lease);
          } catch (error) {
            await lease.complete({ outcome: "aborted_before_send" });
            throw error;
          }
        }
        return lease;
      }

      refusals += 1;
      this.counters.captureRefusals += 1;
      if (result.kind === "pause") {
        // Exactly what the database says is left; at least 1 ms so a clock
        // edge cannot spin.
        await this.clock.sleep(Math.max(1, Math.ceil(result.waitMs)), signal);
        continue;
      }
      if (result.leaseExpired) {
        this.counters.closedRefusals += 1;
        await this.reportClosed(pageId, result.holder);
        throw new FanslyPageSendClosedError(pageId, result.holder);
      }
      await this.clock.sleep(this.busyPollMs(), signal);
    }
  }

  private async acquireUnpaced(
    source: FanslySendSource,
    input: FanslySendGuardAcquireInput,
  ): Promise<FanslySendLease> {
    const requestTimeoutMs = assertRequestTimeout(input.requestTimeoutMs);
    const signal = input.signal ?? null;
    this.assertOpen(signal);
    const token = randomUUID();
    const issuedAt = this.clock.monotonicMs();
    const { journalId } = await this.deps.store.journalUnpaced({
      token,
      source,
      operation: input.operation,
      holder: this.deps.identity(),
    });
    const lease = new GuardLease(
      this, token, null, source, input.operation, journalId,
      issuedAt, issuedAt + requestTimeoutMs, false,
    );
    this.#inflight.add(lease);
    this.counters.captures += 1;
    if (signal?.aborted || this.#stopped) {
      await lease.complete({ outcome: "aborted_before_send" });
      this.assertOpen(signal);
    }
    return lease;
  }

  private releaseUnknownCapture(
    pageId: number,
    token: string,
    source: FanslySendSource,
    operation: string,
    issuedAt: number,
  ) {
    // A lease that can never send (its send window is already over).
    const lease = new GuardLease(this, token, pageId, source, operation, null, issuedAt, issuedAt, false);
    this.#localHolds.set(pageId, lease);
    this.#inflight.add(lease);
    void lease.complete({ outcome: "aborted_before_send" });
  }

  private async reportClosed(pageId: number, holder: FanslySendGuardHolderSummary) {
    this.deps.logger.error({
      component: "fansly_send_guard",
      pageId,
      holderHost: holder.host,
      holderPid: holder.pid,
      holderRole: holder.role,
      holderSource: holder.source,
      holderOperation: holder.operation,
      leaseUntil: holder.leaseUntil?.toISOString() ?? null,
    }, "Fansly page closed: its request holder overran the lease and is not confirmed terminated");
    try {
      await this.deps.store.markClosed({ pageId, token: holder.token, reason: "lease_expired_unconfirmed" });
    } catch (error) {
      this.deps.logger.warn({ component: "fansly_send_guard", pageId, err: error }, "Fansly send guard could not mark the page closed");
    }
  }

  /** Retried with backoff until durable; the page stays closed meanwhile. */
  async writeCompletion(
    lease: GuardLease,
    input: Omit<CompleteFanslySendAttemptInput, "pageId" | "token" | "nextU">,
  ) {
    try {
      await this.hooks?.beforeCompletion?.(lease);
      const nextU = this.nextU();
      let retryMs = COMPLETION_RETRY_FIRST_MS;
      for (let attempt = 1; ; attempt += 1) {
        try {
          const { released } = await this.deps.store.complete({
            pageId: lease.pageId,
            token: lease.token,
            nextU,
            ...input,
          });
          if (lease.pageId !== null && lease.expectHeld && !released) {
            this.deps.logger.error({
              component: "fansly_send_guard",
              pageId: lease.pageId,
              source: lease.source,
              operation: lease.operation,
            }, "Fansly send guard completion found the page no longer held by this lease (confirmed terminated while alive?)");
          }
          return;
        } catch (error) {
          this.deps.logger.warn({
            component: "fansly_send_guard",
            pageId: lease.pageId,
            attempt,
            err: error,
          }, "Fansly send guard completion failed; the page stays closed until it is written");
          await this.clock.sleep(retryMs);
          retryMs = Math.min(retryMs * 2, COMPLETION_RETRY_MAX_MS);
        }
      }
    } finally {
      if (lease.pageId !== null && this.#localHolds.get(lease.pageId) === lease) {
        this.#localHolds.delete(lease.pageId);
      }
      this.#inflight.delete(lease);
    }
  }
}
