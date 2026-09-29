// W5.2 (A53, B8 leg C): the ops deadman. The scheduler writes a heartbeat and
// the golden-signal sampler writes minutely samples — but before this file,
// NOTHING read either one to alert: a dead scheduler silently stopped ALL
// cron (planner, sweeps, sampler, credits, the Telegram report), and Docker's
// `restart: unless-stopped` only acts on process exit, never on a
// wedged-but-alive process. The watchdog runs from the API process — the one
// long-lived process independent of scheduler/worker — and pages when either
// signal goes silent. E-2 adds a third leg: Fansly sync chunks that stop
// starting while work is due.

import {
  getFanslySyncLiveness,
  getLatestOpsMetricSampleAt,
  hasFreshInstanceHeartbeat,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  runNotificationDeliveryOutbox,
  type NotificationOutboxSender,
} from "./notification-delivery-outbox.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
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
/** E-2: no Fansly chunk started for this long while a stream is due. The
 * widest production gap between Fansly chunk starts over 21 days (the host
 * power-off of 2026-09-23 aside) was 5 min 10 s; deploy gaps stay under 6 min. */
export const OPS_WATCHDOG_SYNC_SILENCE_MS = 15 * 60_000;
/** Bounds the chunk-start lookup; anything older reads as "over an hour". */
export const OPS_WATCHDOG_SYNC_LOOKBACK_MS = 60 * 60_000;
/** The api-side delivery fallback drains a few rows on a short clock: it runs
 * beside the watchdog every minute, and the worker takes over once it is back. */
export const OPS_WATCHDOG_FALLBACK_MAX_ROWS = 5;
export const OPS_WATCHDOG_FALLBACK_BUDGET_MS = 60_000;

export interface OpsWatchdogCheckResult {
  /** Inside OPS_WATCHDOG_BOOT_GRACE_MS: fresh signals resolve, stale ones open nothing. */
  bootGrace: boolean;
  schedulerFresh: boolean;
  samplerFresh: boolean;
  /** No Fansly chunk started for OPS_WATCHDOG_SYNC_SILENCE_MS while a stream is due. */
  syncStalled: boolean;
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
  const sync = await getFanslySyncLiveness(app.db, {
    now,
    since: new Date(now.getTime() - OPS_WATCHDOG_SYNC_LOOKBACK_MS),
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

  return { bootGrace, schedulerFresh, samplerFresh, syncStalled };
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
  input?: { now?: Date; sender?: NotificationOutboxSender },
): Promise<OpsWatchdogDeliveryFallbackResult> {
  const sweep = await runNotificationPagingSweepExclusive(
    app,
    input?.now ? { now: input.now } : undefined,
  );
  const delivery = await runNotificationDeliveryOutbox(app, {
    ...(input?.now ? { now: input.now } : {}),
    ...(input?.sender ? { sender: input.sender } : {}),
    maxRows: OPS_WATCHDOG_FALLBACK_MAX_ROWS,
    budgetMs: OPS_WATCHDOG_FALLBACK_BUDGET_MS,
  });
  return { sweep, delivery };
}

export interface OpsWatchdog {
  stop(): void;
}

/** Started from the api runtime. Unref'd so it never holds shutdown open;
 * in-flight serialized so a slow DB can't stack checks. The delivery fallback
 * is its own serialized task, so a slow Telegram send never holds a deadman
 * check back. */
export function startOpsWatchdog(app: AppContext): OpsWatchdog {
  const startedAtMs = Date.now();
  let checkInFlight = false;
  let fallbackInFlight = false;

  const runFallback = () => {
    if (fallbackInFlight) {
      return;
    }
    fallbackInFlight = true;
    void runOpsWatchdogDeliveryFallback(app)
      .then(({ sweep, delivery }) => {
        if ((sweep && (sweep.paged > 0 || sweep.resolved > 0 || sweep.failed > 0)) || delivery.leased > 0) {
          app.logger.info({ sweep, delivery }, "Ops watchdog fallback swept and delivered alerts");
        }
      })
      .catch((error) => {
        app.logger.warn({ err: error }, "Ops watchdog delivery fallback failed; retrying next tick");
      })
      .finally(() => {
        fallbackInFlight = false;
      });
  };

  const timer = setInterval(() => {
    if (checkInFlight) {
      return;
    }
    checkInFlight = true;
    void runOpsWatchdogCheck(app, { startedAtMs })
      .then((result) => {
        if (opsWatchdogNeedsDeliveryFallback(result)) {
          runFallback();
        }
      })
      .catch((error) => {
        app.logger.warn({ err: error }, "Ops watchdog check failed; retrying next tick");
      })
      .finally(() => {
        checkInFlight = false;
      });
  }, OPS_WATCHDOG_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
