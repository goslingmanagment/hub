import { PgBoss } from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { startWorkerServices } from "./worker-services.ts";

export async function runWorkerRuntime() {
  const processStartedAt = new Date();
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });
  const runtime = await startWorkerServices(app, boss, { processStartedAt });

  const shutdown = async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);

    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
