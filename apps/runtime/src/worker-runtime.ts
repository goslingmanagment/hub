import { PgBoss } from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { startWorkerServices } from "./worker-services.ts";

export async function runWorkerRuntime() {
  const processStartedAt = new Date();
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });
  // PgBoss extends EventEmitter: without a listener an 'error' event throws.
  // The worker is nothing without its queue, so fail fast and let Docker's
  // restart policy recover it (audit B8).
  boss.on("error", (error) => {
    app.logger.error({ err: error }, "pg-boss worker error; exiting for restart");
    process.exit(1);
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
