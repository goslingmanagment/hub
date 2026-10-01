import { setTimeout as sleep } from "node:timers/promises";
import {
  applyFanslyWsLiveReceipt, confirmDmLiveMessages, listPendingFanslyWsLiveReceipts,
  type FanslyWsLiveApplyResult, type FanslyWsLivePayloadResolver,
} from "@agency_hub_core/db";
import type { AppContext } from "../../bootstrap.ts";
import { resolveCapturePayloadRow } from "../payload-reader.ts";

// The live overlay's drivers (plan §7.2). One idempotent apply
// (applyFanslyWsLiveReceipt) is reached three ways, all on the pool and never
// on a page's lock-owning capture session: right after each capture (the
// connection's applier below), at worker start and on the worker timer (every
// pending receipt of every page, so a page whose socket is down, blocked or
// disabled is still applied). Losing any one path loses nothing: the receipt
// stays pending until some path acks it. Step 1: no HTTP, no work.

type LiveApp = Pick<AppContext, "db" | "logger">;

/** Raw bodies through the payload seam, on the apply transaction. A failure
 * rolls the attempt back and leaves the receipt pending for the timer. */
export function fanslyWsLivePayloadResolver(app: LiveApp): FanslyWsLivePayloadResolver {
  return async (db, observationId, source) =>
    (await resolveCapturePayloadRow({ db, logger: app.logger }, "observation", observationId, source)).payload;
}

/** A fixed class only: driver errors embed SQL and bound parameters, and a
 * frame's parameters are private correspondence. */
export function fanslyWsLiveErrorClass(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return "unknown";
}

export async function applyFanslyWsLive(
  app: LiveApp,
  observationId: number,
  resolvePayload: FanslyWsLivePayloadResolver = fanslyWsLivePayloadResolver(app),
): Promise<FanslyWsLiveApplyResult | null> {
  try {
    const result = await applyFanslyWsLiveReceipt(app.db, { observationId, resolvePayload });
    if ("dataError" in result) {
      app.logger.warn({ observationId, errorClass: result.dataError },
        "Fansly live overlay frame refused by the database on every attempt; the receipt is acked as debt");
    }
    return result;
  } catch (error) {
    app.logger.warn({ observationId, errorClass: fanslyWsLiveErrorClass(error) },
      "Fansly live overlay apply failed; the receipt stays pending for replay");
    return null;
  }
}

/** Per-connection applier: receipts in capture order, one transaction at a
 * time, so a burst never takes more than one pool connection per page and a
 * slow event-counter lock never stalls the capture writer. A full queue only
 * defers a receipt to the worker timer. */
export function createFanslyWsLiveApplier(app: LiveApp, options: { maxQueued?: number } = {}) {
  const maxQueued = options.maxQueued ?? 1024;
  const resolvePayload = fanslyWsLivePayloadResolver(app);
  const queue: number[] = [];
  let closed = false;
  let active = false;
  let idle: Promise<void> = Promise.resolve();
  function kick() {
    if (active) return;
    active = true;
    idle = (async () => {
      try {
        while (queue.length > 0) await applyFanslyWsLive(app, queue.shift()!, resolvePayload);
      } finally { active = false; }
    })();
  }
  return {
    enqueue(observationId: number) {
      if (closed || queue.length >= maxQueued) return;
      queue.push(observationId);
      kick();
    },
    /** Stop accepting, then finish the queue within `deadlineMs`. Whatever is
     * left stays pending in the database for the worker timer. */
    async drain(deadlineMs: number) {
      closed = true;
      const deadline = new AbortController();
      await Promise.race([idle, sleep(deadlineMs, undefined, { signal: deadline.signal }).catch(() => undefined)]);
      deadline.abort();
      queue.length = 0;
    },
  };
}

/** Production cadence of the worker-level replay and parity pass. */
export interface FanslyWsLiveTimerTiming {
  intervalMs: number;
  /** Receipts younger than this are left to the connection's applier. */
  replayMinAgeMs: number;
  replayBatch: number;
  parityBatch: number;
}
export const FANSLY_WS_LIVE_TIMER: Readonly<FanslyWsLiveTimerTiming> = Object.freeze({
  intervalMs: 5_000, replayMinAgeMs: 3_000, replayBatch: 100, parityBatch: 200,
});

/** Worker-level timer over all Fansly pages: replays pending live receipts
 * (bounded batch, oldest first; the receipt lock is `skip locked`) and runs
 * one bounded passive parity pass. Each pass continues after the previous
 * pass's last receipt and wraps to the oldest after a short batch, so
 * receipts that keep failing for a while (an erasure in flight, a held lock)
 * never starve the ones behind them. The first tick runs at start: that is
 * the start-up replay. */
export function startFanslyWsLiveTimer(app: LiveApp, options: { timing?: FanslyWsLiveTimerTiming } = {}) {
  const timing = options.timing ?? FANSLY_WS_LIVE_TIMER;
  const resolvePayload = fanslyWsLivePayloadResolver(app);
  let stopped = false;
  let ticking: Promise<void> | null = null;
  let after = 0;
  async function tick() {
    const pending = await listPendingFanslyWsLiveReceipts(app.db, {
      limit: timing.replayBatch, afterObservationId: after,
      receivedBefore: new Date(Date.now() - timing.replayMinAgeMs),
    });
    after = pending.length < timing.replayBatch ? 0 : pending.at(-1)!;
    for (const observationId of pending) {
      if (stopped) return;
      await applyFanslyWsLive(app, observationId, resolvePayload);
    }
    if (!stopped) await confirmDmLiveMessages(app.db, { limit: timing.parityBatch });
  }
  function run() {
    if (stopped || ticking) return;
    ticking = tick().catch((error: unknown) => {
      app.logger.warn({ errorClass: fanslyWsLiveErrorClass(error) }, "Fansly live overlay timer pass failed; next tick retries");
    }).finally(() => { ticking = null; });
  }
  const timer = setInterval(run, timing.intervalMs);
  run();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await ticking;
    },
  };
}
