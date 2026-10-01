import { PgBoss } from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { startRuntimeHeartbeat } from "./services/runtime-heartbeat.ts";
import { registerAllSchedules } from "./services/schedules.ts";
import {
  SCHEDULER_STANDBY_RETRY_MS,
  acquireSchedulerLeadership,
} from "./services/scheduler-leader.ts";

// Kernel Stage 25: the scheduler role. Exactly one active scheduler (session
// advisory lock) registers every cron schedule and runs pg-boss's timekeeper
// (cron firing). Workers and the api run with `schedule: false`, so losing
// the scheduler stalls CRON only — queued/live work keeps flowing — until the
// standby (or Docker's restart) takes the lock.

export async function runSchedulerRuntime() {
  const processStartedAt = new Date();
  const app = await createAppContext({ processRole: "scheduler" });
  let stopped = false;

  app.logger.info("Scheduler booting; contending for leadership");
  const leadership = await acquireSchedulerLeadership({
    pool: app.pool,
    retryMs: SCHEDULER_STANDBY_RETRY_MS,
    onStandby: () => app.logger.info("Scheduler standby: leader lock held elsewhere; retrying"),
    isStopped: () => stopped,
  });
  if (leadership === null) {
    process.exit(0);
  }
  app.logger.info("Scheduler leadership acquired");

  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
    // Leader-only timekeeper: this is THE instance that fires cron.
    schedule: true,
    // S7: job deletion only happens on a maintenance pass, so the effective
    // cadence is deleteAfterSeconds PLUS up to one interval. pg-boss defaults
    // this to 24h, which would double the 24h heartbeat retention pinned in
    // services/queue-retention.ts. Must match the api and worker roles.
    maintenanceIntervalSeconds: 3600,
  });
  boss.on("error", (error) => {
    app.logger.error({ err: error }, "pg-boss scheduler error; exiting for restart");
    process.exit(1);
  });
  await boss.start();
  await registerAllSchedules(boss);
  app.logger.info("Scheduler online: schedules registered, timekeeper running");

  const heartbeat = startRuntimeHeartbeat(app, "scheduler", {
    startedAt: processStartedAt,
    // Docker healthcheck watches this file's mtime (compose: SCHEDULER_HEALTH_FILE).
    // NB: a hot STANDBY never starts the heartbeat (it idles on the lock), so a
    // standby service entry must not carry this healthcheck.
    healthFilePath: process.env.SCHEDULER_HEALTH_FILE ?? null,
  });

  // Losing the lock session means another scheduler may already be firing
  // cron — exit immediately rather than double-fire.
  void leadership.lost.then(() => {
    if (!stopped) {
      app.logger.error("Scheduler leadership lost (lock session died); exiting for restart");
      process.exit(1);
    }
  });

  const shutdown = async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    stopped = true;
    await heartbeat.stop().catch(() => undefined);
    await boss.stop({ close: true, timeout: 15_000 }).catch(() => undefined);
    await leadership.release().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
