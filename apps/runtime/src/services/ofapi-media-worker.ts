import { sql } from "drizzle-orm";
import type { AppContext } from "../bootstrap.ts";
import { executeOfapiCaptureJobChunk } from "./ofapi-capture-jobs.ts";
import { reconcileOfapiUploadWebhook } from "./ofapi-media-uploads.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
export const OFAPI_MEDIA_SWEEP_QUEUE = "ofapi.media.sweep";
export async function runOfapiMediaUploadSweep(app: AppContext) {
  const candidates = await app.db.execute<{ id: string; page_id: string }>(
    sql`select id,page_id from ofapi_capture_jobs where kind='media_upload' and (state in ('ready','retry_wait','awaiting_parse') or (state='blocked' and reason_code in ('background_paused','job_unavailable') and cursor->>'phase'='poll')) order by updated_at limit 5`,
  );
  const outcomes = [];
  for (const job of candidates.rows) {
    try {
      if (await reconcileOfapiUploadWebhook(app, job.id)) {
        outcomes.push({ kind: "webhook", jobId: job.id });
        continue;
      }
      outcomes.push(
        await executeOfapiCaptureJobChunk(app, Number(job.page_id), job.id),
      );
    } catch (error) {
      app.logger.error(
        { error, jobId: job.id },
        "Media upload task retained for lease recovery",
      );
    }
  }
  return outcomes;
}
export async function ensureOfapiMediaQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(
    boss,
    OFAPI_MEDIA_SWEEP_QUEUE,
    { policy: "exclusive" },
    createdQueues,
  );
}
export async function ensureOfapiMediaSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(OFAPI_MEDIA_SWEEP_QUEUE, "* * * * *", null, {
    tz: "UTC",
  });
}
