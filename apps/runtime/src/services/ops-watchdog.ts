// W5.2 (A53, B8 leg C): the ops deadman. The scheduler writes a heartbeat and
// the golden-signal sampler writes minutely samples — but before this file,
// NOTHING read either one to alert: a dead scheduler silently stopped ALL
// cron (planner, sweeps, sampler, credits, the Telegram report), and Docker's
// `restart: unless-stopped` only acts on process exit, never on a
// wedged-but-alive process. The watchdog runs from the API process — the one
// long-lived process independent of scheduler/worker — and pages when either
// signal goes silent. E-2 adds a third leg: Fansly sync chunks that stop
// starting while work is due. The Fansly Sync Engine adds a fourth (alert 5,
// design §9.6): a page is in the engine and no `sync` process beats.

import {
  getFanslySyncLiveness,
  getLatestOpsMetricSampleAt,
  hasFreshInstanceHeartbeat,
  hasSyncPageInEngine,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  runNotificationDeliveryOutbox,
  type NotificationOutboxSender,
} from "./notification-delivery-outbox.ts";
import {
  notifyOfapiGlobalIncident,
  notifySyncEngineIncident,
  resolveOfapiGlobalIncident,
  resolveSyncEngineIncident,
} from "./notification-incidents.ts";
import {
  runNotificationPagingSweepExclusive,
  type NotificationPagingSweepResult,
} from "./notification-paging-sweep.ts";

export const OPS_WATCHDOG_INTERVAL_MS = 60_000;
/** Silence tolerance: matches INSTANCE_STALE_TTL_MS (a few missed beats). */
export const OPS_WATCHDOG_SILENCE_MS = 3 * 60_000;
/** Deploy-window guard: containers restart within a deploy; the scheduler
 * needs time to win leadership and the sampler to produce its first row.
 * Until the api itself has been up this long a stale signal opens nothing —
 * but a fresh one still resolves, so the latch the outgoing api opened during
 * the restart closes within a minute instead of after the whole grace. */
export const OPS_WATCHDOG_BOOT_GRACE_MS = 5 * 60_000;
/** E-2: no Fansly chunk started for this long while a stream has been due
 * for as long (getFanslySyncLiveness). The widest production gap between
 * Fansly chunk starts over 21 days (the host power-off of 2026-09-23 aside)
 * was 5 min 10 s; deploy gaps stay under 6 min. */
export const OPS_WATCHDOG_SYNC_SILENCE_MS = 15 * 60_000;
/** Alert 5 (design §9.6): the `sync` process beats every 30 s; none for this
 *  long while a page is in the engine pages the owner. */
export const OPS_WATCHDOG_SYNC_ENGINE_SILENCE_MS = 2 * 60_000;
/** Bounds the chunk-start lookup; anything older reads as "over an hour". */
export const OPS_WATCHDOG_SYNC_LOOKBACK_MS = 60 * 60_000;
/** The api-side delivery fallback drains a few rows on a short clock: it runs
 * beside the watchdog every minute, and the worker takes over once it is back. */
export const OPS_WATCHDOG_FALLBACK_MAX_ROWS = 5;
export const OPS_WATCHDOG_FALLBACK_BUDGET_MS = 60_000;
/** stop() waits this long for an in-flight check or fallback: inside Docker's
 * 10 s stop grace for the api, beside the heartbeat's own 5 s stop. */
export const OPS_WATCHDOG_STOP_TIMEOUT_MS = 5_000;

export interface OpsWatchdogCheckResult {
  /** Inside OPS_WATCHDOG_BOOT_GRACE_MS: fresh signals resolve, stale ones open nothing. */
  bootGrace: boolean;
  schedulerFresh: boolean;
  samplerFresh: boolean;
  /** No Fansly chunk started for OPS_WATCHDOG_SYNC_SILENCE_MS while a stream
   * has been due for as long. */
  syncStalled: boolean;
  /** A Fansly page is in the engine and no `sync` process beat within
   *  OPS_WATCHDOG_SYNC_ENGINE_SILENCE_MS (alert 5). */
  syncEngineSilent: boolean;
}

type DeadmanKind = "scheduler_silent" | "ops_sampler_silent" | "sync_silent";

async function latchDeadman(
  app: Pick<AppContext, "db" | "config" | "logger">,
  input: {
    kind: DeadmanKind;
    healthy: boolean;
    bootGrace: boolean;
    now: Date;
    errorSummary: () => string;
  },
): Promise<void> {
  if (input.healthy) {
    await resolveOfapiGlobalIncident(app, { kind: input.kind, recoveredAt: input.now });
  } else if (!input.bootGrace) {
    await notifyOfapiGlobalIncident(app, {
      kind: input.kind,
      errorSummary: input.errorSummary(),
      occurredAt: input.now,
    });
  }
}

export async function runOpsWatchdogCheck(
  app: Pick<AppContext, "db" | "config" | "logger">,
  options: { startedAtMs: number; now?: Date },
): Promise<OpsWatchdogCheckResult> {
  const now = options.now ?? new Date();
  const bootGrace = now.getTime() - options.startedAtMs < OPS_WATCHDOG_BOOT_GRACE_MS;

  const schedulerFresh = await hasFreshInstanceHeartbeat(app.db, {
    role: "scheduler",
    ttlMs: OPS_WATCHDOG_SILENCE_MS,
  });
  await latchDeadman(app, {
    kind: "scheduler_silent",
    healthy: schedulerFresh,
    bootGrace,
    now,
    errorSummary: () =>
      `No scheduler heartbeat within ${Math.round(OPS_WATCHDOG_SILENCE_MS / 60_000)} min — `
      + "cron is not firing (planner, sweeps, sampler, credits, Telegram report all stalled)",
  });

  const latestSampleAt = await getLatestOpsMetricSampleAt(app.db);
  const samplerFresh = latestSampleAt !== null
    && now.getTime() - latestSampleAt.getTime() <= OPS_WATCHDOG_SILENCE_MS;
  await latchDeadman(app, {
    kind: "ops_sampler_silent",
    healthy: samplerFresh,
    bootGrace,
    now,
    errorSummary: () => latestSampleAt === null
      ? "ops_metric_samples is empty — the golden-signal sampler has never run"
      : `Newest golden-signal sample is ${Math.round((now.getTime() - latestSampleAt.getTime()) / 60_000)} min old — ops telemetry is blind`,
  });

  // E-2: the planner is one all-or-nothing cycle (its DLQ has no consumer)
  // and a wedged executor starts nothing; both read as chunks not starting.
  // A stream counts once it has been due for the same threshold, so an hourly
  // stream idling to its next slot, or work that just came due, is no stall.
  const sync = await getFanslySyncLiveness(app.db, {
    since: new Date(now.getTime() - OPS_WATCHDOG_SYNC_LOOKBACK_MS),
    dueBefore: new Date(now.getTime() - OPS_WATCHDOG_SYNC_SILENCE_MS),
  });
  const syncStalled = sync.hasDueStream && (
    sync.latestStartedAt === null
    || now.getTime() - sync.latestStartedAt.getTime() > OPS_WATCHDOG_SYNC_SILENCE_MS
  );
  await latchDeadman(app, {
    kind: "sync_silent",
    healthy: !syncStalled,
    bootGrace,
    now,
    errorSummary: () => {
      const silentFor = sync.latestStartedAt === null
        ? `over ${Math.round(OPS_WATCHDOG_SYNC_LOOKBACK_MS / 60_000)} min`
        : `${Math.floor((now.getTime() - sync.latestStartedAt.getTime()) / 60_000)} min`;
      return `No Fansly sync chunk started for ${silentFor} — planner or executor stalled`;
    },
  });

  // Alert 5: with every page `off` the process is allowed to be absent.
  const syncEngineSilent = await hasSyncPageInEngine(app.db)
    && !await hasFreshInstanceHeartbeat(app.db, { role: "sync", ttlMs: OPS_WATCHDOG_SYNC_ENGINE_SILENCE_MS });
  if (!syncEngineSilent) {
    await resolveSyncEngineIncident(app, { subKey: "process", pageId: null, pageLabel: null, recoveredAt: now });
  } else if (!bootGrace) {
    await notifySyncEngineIncident(app, {
      subKey: "process",
      pageId: null,
      pageLabel: null,
      detail: "heartbeat_silent",
      errorSummary: `No sync process heartbeat within ${Math.round(OPS_WATCHDOG_SYNC_ENGINE_SILENCE_MS / 60_000)} min `
        + "while a Fansly page is in the engine (shadow/handover/live) — `docker compose ps sync`",
      occurredAt: now,
    });
  }

  return { bootGrace, schedulerFresh, samplerFresh, syncStalled, syncEngineSilent };
}

/**
 * The paging sweep and the outbox delivery are pg-boss crons: the scheduler
 * fires them and only the worker consumes them. So scheduler_silent could
 * never page while the scheduler was down, ops_sampler_silent never while the
 * worker was, and by the time either came back the latch had resolved. While
 * a deadman is tripped the api runs both itself; the sweep lock and the
 * outbox lease keep a worker running alongside from sending anything twice.
 * Inside the boot grace a stale signal is a deploy, not an outage.
 */
export function opsWatchdogNeedsDeliveryFallback(result: OpsWatchdogCheckResult): boolean {
  return !result.bootGrace
    && (!result.schedulerFresh || !result.samplerFresh || result.syncStalled);
}

export interface OpsWatchdogDeliveryFallbackResult {
  /** Null when a worker's sweep held the lock this minute. */
  sweep: NotificationPagingSweepResult | null;
  delivery: Awaited<ReturnType<typeof runNotificationDeliveryOutbox>>;
}

/** Telegram egress resolves through `resolveEgress(app as AppContext)`, so the
 * api hands over its whole context, not a Pick. */
export async function runOpsWatchdogDeliveryFallback(
  app: AppContext,
  input?: { now?: Date; sender?: NotificationOutboxSender; signal?: AbortSignal },
): Promise<OpsWatchdogDeliveryFallbackResult> {
  const sweep = await runNotificationPagingSweepExclusive(
    app,
    input?.now ? { now: input.now } : undefined,
  );
  const delivery = await runNotificationDeliveryOutbox(app, {
    ...(input?.now ? { now: input.now } : {}),
    ...(input?.sender ? { sender: input.sender } : {}),
    ...(input?.signal ? { signal: input.signal } : {}),
    maxRows: OPS_WATCHDOG_FALLBACK_MAX_ROWS,
    budgetMs: OPS_WATCHDOG_FALLBACK_BUDGET_MS,
  });
  return { sweep, delivery };
}

export interface OpsWatchdog {
  /** Stops the ticks and waits, bounded by OPS_WATCHDOG_STOP_TIMEOUT_MS, for
   * the check and fallback in flight. A fallback send cut off by the exit
   * would leave its outbox row leased, and the worker would resend it once
   * the lease expired. */
  stop(): Promise<void>;
}

/** Started from the api runtime. Unref'd so it never holds shutdown open;
 * in-flight serialized so a slow DB can't stack checks. The delivery fallback
 * is its own serialized task, so a slow Telegram send never holds a deadman
 * check back. */
export function startOpsWatchdog(
  app: AppContext,
  /** Test seams; production passes none. */
  options: { startedAtMs?: number; intervalMs?: number; sender?: NotificationOutboxSender } = {},
): OpsWatchdog {
  const startedAtMs = options.startedAtMs ?? Date.now();
  const stopping = new AbortController();
  let checkInFlight: Promise<void> | null = null;
  let fallbackInFlight: Promise<void> | null = null;

  const runFallback = () => {
    if (fallbackInFlight || stopping.signal.aborted) {
      return;
    }
    fallbackInFlight = runOpsWatchdogDeliveryFallback(app, {
      signal: stopping.signal,
      ...(options.sender ? { sender: options.sender } : {}),
    })
      .then(({ sweep, delivery }) => {
        if ((sweep && (sweep.paged > 0 || sweep.resolved > 0 || sweep.failed > 0)) || delivery.leased > 0) {
          app.logger.info({ sweep, delivery }, "Ops watchdog fallback swept and delivered alerts");
        }
      })
      .catch((error) => {
        app.logger.warn({ err: error }, "Ops watchdog delivery fallback failed; retrying next tick");
      })
      .finally(() => {
        fallbackInFlight = null;
      });
  };

  const timer = setInterval(() => {
    if (checkInFlight || stopping.signal.aborted) {
      return;
    }
    checkInFlight = runOpsWatchdogCheck(app, { startedAtMs })
      .then((result) => {
        if (opsWatchdogNeedsDeliveryFallback(result)) {
          runFallback();
        }
      })
      .catch((error) => {
        app.logger.warn({ err: error }, "Ops watchdog check failed; retrying next tick");
      })
      .finally(() => {
        checkInFlight = null;
      });
  }, options.intervalMs ?? OPS_WATCHDOG_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      stopping.abort();
      // Both chains catch their own errors, so neither rejects.
      const inFlight = [checkInFlight, fallbackInFlight].filter((task) => task !== null);
      if (inFlight.length === 0) {
        return;
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.all(inFlight).then(() => false),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(true), OPS_WATCHDOG_STOP_TIMEOUT_MS);
          deadline.unref();
        }),
      ]);
      clearTimeout(deadline);
      if (timedOut) {
        app.logger.warn(
          { timeoutMs: OPS_WATCHDOG_STOP_TIMEOUT_MS },
          "Ops watchdog stop timed out on in-flight work; a row it leased is retried once the lease expires",
        );
      }
    },
  };
}
