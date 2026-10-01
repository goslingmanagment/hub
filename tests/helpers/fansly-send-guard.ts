import type {
  CaptureFanslyPageSendGuardInput,
  CaptureFanslyPageSendGuardResult,
  CompleteFanslySendAttemptInput,
  FanslySendHolderIdentity,
} from "@agency_hub_core/db";
import type { FanslySendGuard, FanslySendSource } from "@agency_hub_core/fansly";

import {
  FanslySendGuardRegistry,
  type FanslySendGuardClock,
  type FanslySendGuardHooks,
  type FanslySendGuardLogger,
  type FanslySendGuardStore,
} from "../../apps/runtime/src/services/fansly-send-guard/engine.ts";

// An in-memory twin of the 0225 guard statements
// (packages/db/src/repositories/fansly-send-guard.ts), driven by an injectable
// "database clock". The state machine tests run the real registry against it
// with a fake clock; adapter tests that are not about pacing use
// `createTestFanslySendGuard()`, a guard with S = 0 whose pages start open.

export interface InMemoryGuardRow {
  pageId: number;
  holderToken: string | null;
  holderSource: string | null;
  holderOperation: string | null;
  holder: FanslySendHolderIdentity | null;
  capturedAt: number | null;
  leaseUntil: number | null;
  lastCompletedAt: number;
  nextU: number;
  closedReason: string | null;
}

export interface InMemoryJournalRow {
  id: string;
  pageId: number | null;
  token: string;
  source: string;
  operation: string;
  settingMs: number | null;
  jitterU: number | null;
  pauseMs: number | null;
  previousCompletedAt: number | null;
  captureWaitMs: number;
  captureRefusals: number;
  capturedAt: number;
  sentAt: Date | null;
  sendOffsetMs: number | null;
  completedAt: number | null;
  outcome: string | null;
  outcomeDetail: string | null;
  httpStatus: number | null;
}

export class InMemoryFanslySendGuardStore implements FanslySendGuardStore {
  readonly rows = new Map<number, InMemoryGuardRow>();
  readonly journal: InMemoryJournalRow[] = [];
  /** Statements that throw before (or after) they take effect, for failure
   *  paths: `capture: "lost_answer"` commits the capture and then throws. */
  readonly faults: {
    capture: Array<"before" | "lost_answer">;
    complete: number;
  } = { capture: [], complete: 0 };
  completeCalls = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** How a page without a row starts: like 0225 (closed for 1.2 × S from
     *  now), or open (its "previous completion" long ago). */
    private readonly seedOpen = false,
  ) {}

  seed(pageId: number, input: { lastCompletedAt?: number; nextU?: number } = {}) {
    this.rows.set(pageId, {
      pageId,
      holderToken: null,
      holderSource: null,
      holderOperation: null,
      holder: null,
      capturedAt: null,
      leaseUntil: null,
      lastCompletedAt: input.lastCompletedAt ?? this.now(),
      nextU: input.nextU ?? 0.2,
      closedReason: null,
    });
  }

  async capture(input: CaptureFanslyPageSendGuardInput): Promise<CaptureFanslyPageSendGuardResult> {
    const fault = this.faults.capture.shift();
    if (fault === "before") throw new Error("capture statement failed");
    let row = this.rows.get(input.pageId);
    if (!row) {
      this.seed(input.pageId, this.seedOpen ? { lastCompletedAt: Number.NEGATIVE_INFINITY } : {});
      row = this.rows.get(input.pageId)!;
      if (!this.seedOpen) return { kind: "pause", waitMs: 0 };
    }
    const now = this.now();
    const opensAt = row.lastCompletedAt + input.settingMs * (1 + row.nextU);
    if (row.holderToken === null && now >= opensAt) {
      row.holderToken = input.token;
      row.holderSource = input.source;
      row.holderOperation = input.operation;
      row.holder = input.holder;
      row.capturedAt = now;
      row.leaseUntil = now + input.leaseMs;
      row.closedReason = null;
      const id = String(this.journal.length + 1);
      this.journal.push({
        id,
        pageId: input.pageId,
        token: input.token,
        source: input.source,
        operation: input.operation,
        settingMs: input.settingMs,
        jitterU: row.nextU,
        pauseMs: Math.ceil(input.settingMs * (1 + row.nextU)),
        previousCompletedAt: Number.isFinite(row.lastCompletedAt) ? row.lastCompletedAt : null,
        captureWaitMs: input.captureWaitMs,
        captureRefusals: input.captureRefusals,
        capturedAt: now,
        sentAt: null,
        sendOffsetMs: null,
        completedAt: null,
        outcome: null,
        outcomeDetail: null,
        httpStatus: null,
      });
      if (fault === "lost_answer") throw new Error("connection lost after commit");
      return { kind: "captured", journalId: id, jitterU: row.nextU, pauseMs: Math.ceil(input.settingMs * (1 + row.nextU)) };
    }
    if (fault === "lost_answer") throw new Error("connection lost after commit");
    if (row.holderToken !== null) {
      return {
        kind: "busy",
        leaseExpired: (row.leaseUntil ?? Number.POSITIVE_INFINITY) <= now,
        holder: {
          token: row.holderToken,
          source: row.holderSource,
          operation: row.holderOperation,
          host: row.holder?.host ?? null,
          pid: row.holder?.pid ?? null,
          role: row.holder?.role ?? null,
          instance: row.holder?.instance ?? null,
          leaseUntil: row.leaseUntil === null ? null : new Date(row.leaseUntil),
        },
      };
    }
    return { kind: "pause", waitMs: Math.max(0, opensAt - now) };
  }

  async journalUnpaced(input: {
    token: string;
    source: FanslySendSource;
    operation: string;
    holder: FanslySendHolderIdentity;
  }) {
    const id = String(this.journal.length + 1);
    this.journal.push({
      id,
      pageId: null,
      token: input.token,
      source: input.source,
      operation: input.operation,
      settingMs: null,
      jitterU: null,
      pauseMs: null,
      previousCompletedAt: null,
      captureWaitMs: 0,
      captureRefusals: 0,
      capturedAt: this.now(),
      sentAt: null,
      sendOffsetMs: null,
      completedAt: null,
      outcome: null,
      outcomeDetail: null,
      httpStatus: null,
    });
    return { journalId: id };
  }

  async markSent(input: { token: string; sentAt: Date; sendOffsetMs: number }) {
    const entry = this.journal.find((candidate) => candidate.token === input.token && candidate.sentAt === null);
    if (entry) {
      entry.sentAt = input.sentAt;
      entry.sendOffsetMs = input.sendOffsetMs;
    }
  }

  async complete(input: CompleteFanslySendAttemptInput) {
    this.completeCalls += 1;
    if (this.faults.complete > 0) {
      this.faults.complete -= 1;
      throw new Error("completion statement failed");
    }
    const now = this.now();
    let released = false;
    const row = input.pageId === null ? undefined : this.rows.get(input.pageId);
    if (row && row.holderToken === input.token) {
      row.holderToken = null;
      row.holderSource = null;
      row.holderOperation = null;
      row.holder = null;
      row.capturedAt = null;
      row.leaseUntil = null;
      row.closedReason = null;
      row.lastCompletedAt = now;
      row.nextU = input.nextU;
      released = true;
    }
    const entry = this.journal.find((candidate) => candidate.token === input.token && candidate.completedAt === null);
    if (entry) {
      entry.completedAt = now;
      entry.outcome = input.outcome;
      entry.outcomeDetail = input.outcomeDetail;
      entry.httpStatus = input.httpStatus;
      entry.sentAt = input.sentAt ?? entry.sentAt;
      entry.sendOffsetMs = input.sendOffsetMs ?? entry.sendOffsetMs;
    }
    return { released, journaled: entry !== undefined };
  }

  async markClosed(input: { pageId: number; token: string; reason: string }) {
    const row = this.rows.get(input.pageId);
    if (!row || row.holderToken !== input.token || row.closedReason !== null) return false;
    if ((row.leaseUntil ?? Number.POSITIVE_INFINITY) > this.now()) return false;
    row.closedReason = input.reason;
    return true;
  }

  /** The confirmation of a dead holder, as `confirmFanslySendGuardTerminated`. */
  confirmTerminated(pageId: number, token: string) {
    const row = this.rows.get(pageId);
    if (!row || row.holderToken !== token) return false;
    const now = this.now();
    Object.assign(row, {
      holderToken: null,
      holderSource: null,
      holderOperation: null,
      holder: null,
      capturedAt: null,
      leaseUntil: null,
      closedReason: null,
      lastCompletedAt: now,
      nextU: 0.2,
    });
    const entry = this.journal.find((candidate) => candidate.token === token && candidate.completedAt === null);
    if (entry) {
      entry.completedAt = now;
      entry.outcome = "confirmed_terminated";
    }
    return true;
  }
}

/** A guard clock on the global timers and Date, so `vi.useFakeTimers()`
 *  drives it (node:timers/promises is not faked). */
export const globalTimersFanslySendGuardClock: FanslySendGuardClock = {
  monotonicMs: () => Date.now(),
  wallMs: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
};

export const TEST_FANSLY_SEND_HOLDER: FanslySendHolderIdentity = {
  host: "test-host",
  pid: 4242,
  pidStart: "start-4242",
  pidNs: null,
  bootId: null,
  instance: "00000000-0000-4000-8000-000000004242",
  role: "test",
};

export const silentFanslySendGuardLogger: FanslySendGuardLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createTestFanslySendGuards(options: {
  store?: InMemoryFanslySendGuardStore;
  settingMs?: number | (() => number);
  clock?: FanslySendGuardClock;
  random?: () => number;
  hooks?: FanslySendGuardHooks;
  logger?: FanslySendGuardLogger;
} = {}) {
  const store = options.store ?? new InMemoryFanslySendGuardStore(undefined, true);
  const settingMs = options.settingMs ?? 0;
  const registry = new FanslySendGuardRegistry({
    store,
    readSettingMs: async () => (typeof settingMs === "function" ? settingMs() : settingMs),
    identity: () => TEST_FANSLY_SEND_HOLDER,
    logger: options.logger ?? silentFanslySendGuardLogger,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  return { registry, store };
}

/** A guard for adapter tests that are not about pacing: S = 0, pages start
 *  open, one request in flight per page, every attempt journaled in memory. */
export function createTestFanslySendGuard(pageId = 1, source: FanslySendSource = "sync_stream"): FanslySendGuard {
  return createTestFanslySendGuards().registry.forPage(pageId, source);
}
