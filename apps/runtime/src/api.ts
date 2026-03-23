import { pathToFileURL } from "node:url";

import { createAppContext } from "./bootstrap.ts";
import { buildApiServer } from "./api/server.ts";

export async function main() {
  const appContext = await createAppContext();
  const server = await buildApiServer(appContext);
  const keepAlive = setInterval(() => {}, 60_000);

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
    clearInterval(keepAlive);
    await server.close().catch(() => undefined);
    await appContext.close().catch(() => undefined);
    throw error;
  }

  const shutdown = async () => {
    clearInterval(keepAlive);
    await server.close();
    await appContext.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
