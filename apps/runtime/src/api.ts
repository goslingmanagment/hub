import { createAppContext } from "./bootstrap.ts";
import { buildApiServer } from "./api/server.ts";

async function main() {
  const appContext = await createAppContext();
  const server = await buildApiServer(appContext);

  try {
    await server.listen({
      host: appContext.config.apiHost,
      port: appContext.config.apiPort,
    });
    appContext.logger.info({
      host: appContext.config.apiHost,
      port: appContext.config.apiPort,
    }, "API server started");
  } catch (error) {
    await server.close().catch(() => undefined);
    await appContext.close().catch(() => undefined);
    throw error;
  }

  const shutdown = async () => {
    await server.close();
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
