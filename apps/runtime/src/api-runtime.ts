import { createAppContext } from "./bootstrap.ts";
import { buildApiServer } from "./api/server.ts";
import { startRuntimeHeartbeat, type RuntimeHeartbeat } from "./services/runtime-heartbeat.ts";

export async function runApiRuntime() {
  const appContext = await createAppContext();
  const server = await buildApiServer(appContext);
  const keepAlive = setInterval(() => {}, 60_000);
  let heartbeat: RuntimeHeartbeat | null = null;

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
  } catch (error) {
    clearInterval(keepAlive);
    await heartbeat?.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
    await appContext.close().catch(() => undefined);
    throw error;
  }

  const shutdown = async () => {
    clearInterval(keepAlive);
    await heartbeat?.stop().catch(() => undefined);
    await server.close();
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
