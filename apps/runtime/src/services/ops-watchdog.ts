// W5.2 (A53, B8 leg C): the ops deadman. The scheduler writes a heartbeat and
// the golden-signal sampler writes minutely samples — but before this file,
// NOTHING read either one to alert: a dead scheduler silently stopped ALL
// cron (planner, sweeps, sampler, credits, the Telegram report), and Docker's
// `restart: unless-stopped` only acts on process exit, never on a
// wedged-but-alive process. The watchdog runs from the API process — the one
// long-lived process independent of scheduler/worker — and pages when either
// signal goes silent.

import {
  getLatestOpsMetricSampleAt,
  hasFreshInstanceHeartbeat,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";

export const OPS_WATCHDOG_INTERVAL_MS = 60_000;
/** Silence tolerance: matches INSTANCE_STALE_TTL_MS (a few missed beats). */
export const OPS_WATCHDOG_SILENCE_MS = 3 * 60_000;
/** Deploy-window guard: containers restart within a deploy; the scheduler
 * needs time to win leadership and the sampler to produce its first row.
 * Checks are skipped until the api itself has been up this long. */
export const OPS_WATCHDOG_BOOT_GRACE_MS = 5 * 60_000;

export interface OpsWatchdogCheckResult {
  skipped: boolean;
  schedulerFresh: boolean | null;
  samplerFresh: boolean | null;
}

export async function runOpsWatchdogCheck(
  app: Pick<AppContext, "db" | "config" | "logger">,
  options: { startedAtMs: number; now?: Date },
): Promise<OpsWatchdogCheckResult> {
  const now = options.now ?? new Date();
  if (now.getTime() - options.startedAtMs < OPS_WATCHDOG_BOOT_GRACE_MS) {
    return { skipped: true, schedulerFresh: null, samplerFresh: null };
  }

  const schedulerFresh = await hasFreshInstanceHeartbeat(app.db, {
    role: "scheduler",
    ttlMs: OPS_WATCHDOG_SILENCE_MS,
  });
  if (schedulerFresh) {
    await resolveOfapiGlobalIncident(app, { kind: "scheduler_silent" });
  } else {
    await notifyOfapiGlobalIncident(app, {
      kind: "scheduler_silent",
      errorSummary:
        `No scheduler heartbeat within ${Math.round(OPS_WATCHDOG_SILENCE_MS / 60_000)} min — `
        + "cron is not firing (planner, sweeps, sampler, credits, Telegram report all stalled)",
    });
  }

  const latestSampleAt = await getLatestOpsMetricSampleAt(app.db);
  const samplerFresh = latestSampleAt !== null
    && now.getTime() - latestSampleAt.getTime() <= OPS_WATCHDOG_SILENCE_MS;
  if (samplerFresh) {
    await resolveOfapiGlobalIncident(app, { kind: "ops_sampler_silent" });
  } else {
    await notifyOfapiGlobalIncident(app, {
      kind: "ops_sampler_silent",
      errorSummary: latestSampleAt === null
        ? "ops_metric_samples is empty — the golden-signal sampler has never run"
        : `Newest golden-signal sample is ${Math.round((now.getTime() - latestSampleAt.getTime()) / 60_000)} min old — ops telemetry is blind`,
    });
  }

  return { skipped: false, schedulerFresh, samplerFresh };
}

export interface OpsWatchdog {
  stop(): void;
}

/** Started from the api runtime. Unref'd so it never holds shutdown open;
 * in-flight serialized so a slow DB can't stack checks. */
export function startOpsWatchdog(
  app: Pick<AppContext, "db" | "config" | "logger">,
): OpsWatchdog {
  const startedAtMs = Date.now();
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void runOpsWatchdogCheck(app, { startedAtMs })
      .catch((error) => {
        app.logger.warn({ err: error }, "Ops watchdog check failed; retrying next tick");
      })
      .finally(() => {
        inFlight = false;
      });
  }, OPS_WATCHDOG_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
