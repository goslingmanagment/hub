import PgBoss from "pg-boss";

import { createAppContext } from "./bootstrap.ts";
import { runAllSync, runFollowerSync, runLightSync, scheduleExistingPages } from "./services/sync.ts";

async function main() {
  const app = await createAppContext();
  const boss = new PgBoss({
    connectionString: app.config.databaseUrl,
  });

  await boss.start();
  await scheduleExistingPages(app, boss);

  // Handle on-demand sync triggers from the API
  await boss.work("sync.trigger", { batchSize: 10 }, async ([job]) => {
    const { pageLabel, scope } = job.data as { pageLabel: string; scope: "light" | "followers" | "all" };
    if (scope === "light") {
      await runLightSync(app, pageLabel, { trigger: "api" });
    } else if (scope === "followers") {
      await runFollowerSync(app, pageLabel, "api");
    } else {
      await runAllSync(app, pageLabel, { trigger: "api" });
    }
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
