import PgBoss from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { scheduleExistingPages } from "./services/sync.ts";

async function main() {
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });

  await boss.start();
  await scheduleExistingPages(app, boss);

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
