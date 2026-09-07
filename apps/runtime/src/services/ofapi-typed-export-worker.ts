import { resumeOfapiExportCancellationStatus } from "./ofapi-export-controls.ts";
import { sql } from "drizzle-orm";
import { OFAPI_TYPED_EXPORT_PROFILES } from "@agency_hub_core/shared";
import type { AppContext } from "../bootstrap.ts";
import { executeOfapiCaptureJobChunk } from "./ofapi-capture-jobs.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
export const OFAPI_TYPED_EXPORT_SWEEP_QUEUE = "ofapi.typed-export.sweep";
/** Only explicitly created export jobs; this never enables baseline/background capture. */
export async function runOfapiTypedExportSweep(app: AppContext) {
  await resumeOfapiExportCancellationStatus(app);
  const jobs = await app.db.execute<{ id: string; page_id: string }>(sql`select id,page_id from ofapi_capture_jobs
    where kind='account_export' and target->>'profile' in (${sql.join(OFAPI_TYPED_EXPORT_PROFILES.map(value => sql`${value}`), sql`,`)})
      and ((state='awaiting_parse' and reason_code is null) or (state in ('ready','retry_wait') and next_attempt_at<=now()))
    order by updated_at limit 5`);
  const outcomes = [];
  for (const job of jobs.rows) {
    try { outcomes.push(await executeOfapiCaptureJobChunk(app, Number(job.page_id), job.id)); }
    catch (error) { app.logger.error({ error, jobId: job.id }, "Typed export sweep failed; durable lease recovery retains the request fence"); }
  }
  return outcomes;
}
export async function ensureOfapiTypedExportQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, OFAPI_TYPED_EXPORT_SWEEP_QUEUE, { policy: "exclusive" }, createdQueues);
}
export async function ensureOfapiTypedExportSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(OFAPI_TYPED_EXPORT_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
}
