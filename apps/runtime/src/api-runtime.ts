import { createAppContext } from "./bootstrap.ts";
import { buildApiServer } from "./api/server.ts";
import {
  getFanslySendGuards,
  startFanslySendGuardSweeper,
  type FanslySendGuardSweeper,
} from "./services/fansly-send-guard/index.ts";
import {
  publishCaptureCasSettingsAtStartup,
  startRuntimeHeartbeat,
  type RuntimeHeartbeat,
} from "./services/runtime-heartbeat.ts";
import { startOpsWatchdog, type OpsWatchdog } from "./services/ops-watchdog.ts";

export async function runApiRuntime() {
  const appContext = await createAppContext({ processRole: "api" });
  // Before the first request: api routes capture (the page metadata refresh)
  // and read payloads (the agent read plane), and the heartbeat that otherwise
  // publishes the capture CAS settings starts only once the server listens.
  await publishCaptureCasSettingsAtStartup(appContext, "api");
  const server = await buildApiServer(appContext);
  const keepAlive = setInterval(() => {}, 60_000);
  let heartbeat: RuntimeHeartbeat | null = null;
  let watchdog: OpsWatchdog | null = null;
  let sendGuardSweeper: FanslySendGuardSweeper | null = null;

  try {
    await server.listen({
      host: appContext.config.apiHost,
      port: appContext.config.apiPort,
    });
    appContext.logger.info({
      host: appContext.config.apiHost,
      port: appContext.config.apiPort,
    }, "API server started");
    // Advertise as live only once the server is actually accepting connections.
    heartbeat = startRuntimeHeartbeat(appContext, "api");
    // W5.2 (A53): the api is the deadman for the scheduler + sampler — the
    // one long-lived process independent of both — and delivers the pages
    // itself while either is down. The whole context: Telegram egress needs it.
    watchdog = startOpsWatchdog(appContext);
    // Plan §2.5: releases Fansly pages whose request holder is provably gone
    // (a CLI process in this container, a restarted container on this host).
    sendGuardSweeper = startFanslySendGuardSweeper(appContext, {
      registry: getFanslySendGuards(appContext),
    });
  } catch (error) {
    clearInterval(keepAlive);
    await sendGuardSweeper?.stop().catch(() => undefined);
    await watchdog?.stop();
    await heartbeat?.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
    await appContext.close().catch(() => undefined);
    throw error;
  }

  const shutdown = async () => {
    clearInterval(keepAlive);
    // No new Fansly capture from here on; a request already in flight
    // finishes and appContext.close() waits for its completion.
    appContext.fanslySendGuards?.stop();
    // The watchdog lets a fallback Telegram send settle its outbox row before
    // the pool ends. Both stops are bounded at 5 s and run side by side, inside
    // Docker's 10 s stop grace.
    await Promise.all([
      watchdog?.stop(),
      heartbeat?.stop().catch(() => undefined),
      sendGuardSweeper?.stop().catch(() => undefined),
    ]);
    await server.close();
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
