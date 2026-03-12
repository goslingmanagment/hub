import type { AppContext } from "./bootstrap.ts";
import { runAllSync, runFollowerSync, runLightSync } from "./services/sync.ts";
import type { SyncTriggerPayload } from "./services/sync-queue.ts";

export interface SyncTriggerJob {
  data: SyncTriggerPayload;
}

export async function processSyncTriggerBatch(
  app: AppContext,
  jobs: SyncTriggerJob[],
) {
  for (const job of jobs) {
    const { pageLabel, scope } = job.data;
    if (scope === "light") {
      await runLightSync(app, pageLabel, { trigger: "api" });
    } else if (scope === "followers") {
      await runFollowerSync(app, pageLabel, "api");
    } else {
      await runAllSync(app, pageLabel, { trigger: "api" });
    }
  }
}
