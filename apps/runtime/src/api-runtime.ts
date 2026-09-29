import { createAppContext } from "./bootstrap.ts";
import { buildApiServer } from "./api/server.ts";
import { startRuntimeHeartbeat, type RuntimeHeartbeat } from "./services/runtime-heartbeat.ts";
import { startOpsWatchdog, type OpsWatchdog } from "./services/ops-watchdog.ts";

export async function runApiRuntime() {
  const appContext = await createAppContext();
  const server = await buildApiServer(appContext);
  const keepAlive = setInterval(() => {}, 60_000);
  let heartbeat: RuntimeHeartbeat | null = null;
  let watchdog: OpsWatchdog | null = null;

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
  } catch (error) {
    clearInterval(keepAlive);
    watchdog?.stop();
    await heartbeat?.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
    await appContext.close().catch(() => undefined);
    throw error;
  }

  const shutdown = async () => {
    clearInterval(keepAlive);
    watchdog?.stop();
    await heartbeat?.stop().catch(() => undefined);
    await server.close();
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
