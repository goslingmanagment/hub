import { PgBoss } from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { getFanslySendGuards, startFanslySendGuardSweeper } from "./services/fansly-send-guard/index.ts";
import {
  publishCaptureCasSettingsAtStartup,
  startRuntimeHeartbeat,
} from "./services/runtime-heartbeat.ts";
import { startWorkerServices } from "./worker-services.ts";

export async function runWorkerRuntime() {
  const processStartedAt = new Date();
  const app = await createAppContext({ processRole: "worker" });
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
    // Stage 25: cron registration + firing belong to the scheduler role.
    schedule: false,
    // S7: job deletion only happens on a maintenance pass, so the effective
    // cadence is deleteAfterSeconds PLUS up to one interval. pg-boss defaults
    // this to 24h, which would double the 24h heartbeat retention pinned in
    // services/queue-retention.ts. Must match the api and scheduler roles.
    maintenanceIntervalSeconds: 3600,
    // pg-boss's own pool polls every few seconds: keep its idle connections.
    ...(app.poolLifetime ?? {}),
  });
  // PgBoss extends EventEmitter: without a listener an 'error' event throws.
  // The worker is nothing without its queue, so fail fast and let Docker's
  // restart policy recover it (audit B8).
  boss.on("error", (error) => {
    app.logger.error({ err: error }, "pg-boss worker error; exiting for restart");
    process.exit(1);
  });
  // The capture CAS settings are otherwise published only by the heartbeat,
  // which starts after the queue services below: a job handler that ran first
  // captured inline, with no catalog reference (prod 2026-09-30).
  await publishCaptureCasSettingsAtStartup(app, "worker");
  const runtime = await startWorkerServices(app, boss, { processStartedAt });
  // Advertise the worker as live ONLY after its queue services have started — a
  // heartbeat written before startWorkerServices() could otherwise show
  // worker: active in the Configuration view while no jobs are being consumed.
  const heartbeat = startRuntimeHeartbeat(app, "worker", { startedAt: processStartedAt });
  // Plan §2.5: releases Fansly pages whose request holder is provably gone.
  const sendGuardSweeper = startFanslySendGuardSweeper(app, { registry: getFanslySendGuards(app) });

  const shutdown = async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);

    await heartbeat.stop().catch(() => undefined);
    await sendGuardSweeper.stop().catch(() => undefined);
    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
