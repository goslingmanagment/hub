import PgBoss from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { scheduleExistingPages } from "./services/sync.ts";
import { processSyncTriggerBatch, type SyncTriggerJob } from "./worker-sync-trigger.ts";

async function main() {
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });

  await boss.start();
  await scheduleExistingPages(app, boss);

  // Handle on-demand sync triggers from the API
  await boss.work("sync.trigger", { batchSize: 10 }, async (jobs) => {
    await processSyncTriggerBatch(app, jobs as SyncTriggerJob[]);
  });

  app.logger.info("Worker started");

  const shutdown = async () => {
    await boss.stop();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
