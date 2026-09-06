import { sql } from "drizzle-orm";
import {
  findPageById,
  getOfapiCaptureJob,
  insertAuditEvent,
  type Database,
} from "@agency_hub_core/db";
import { isOfapiTypedExportProfile } from "@agency_hub_core/shared";
import type { AppContext } from "../bootstrap.ts";
import { ConflictError } from "./errors.ts";
import { buildOfapiExportQuoteRequest } from "./ofapi-export-quotes.ts";

/** Owner recovery of an admission stop; this grants no new request or spend authority. */
export async function resumeOwnerOfapiTypedExport(
  app: AppContext,
  input: {
    jobId: string;
    expectedRowVersion: number;
    expectedPolicyRevision: number;
    reason: string;
  },
  actorUserId: number,
) {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const policy = (
      await db.execute<{ revision: number; background_paused: boolean }>(sql`
      select revision,background_paused from ofapi_collection_state where id=1 for update
    `)
    ).rows[0];
    if (
      policy?.revision !== input.expectedPolicyRevision ||
      policy.background_paused
    ) {
      throw new ConflictError("Collection policy changed or remains paused");
    }
    await db.execute(
      sql`select id from ofapi_capture_jobs where id=${input.jobId}::uuid for update`,
    );
    const job = await getOfapiCaptureJob(db, input.jobId);
    if (
      !job ||
      job.kind !== "account_export" ||
      !isOfapiTypedExportProfile(job.target.profile) ||
      typeof job.target.collectionJobId !== "string" ||
      job.state !== "blocked" ||
      job.rowVersion !== input.expectedRowVersion ||
      ![
        "background_paused",
        "job_unavailable",
        "collection_off",
        "on_demand_only",
      ].includes(job.reasonCode ?? "")
    ) {
      throw new ConflictError(
        "Export is not safely resumable from this snapshot",
      );
    }
    const page = await findPageById(db, job.pageId);
    if (page?.page.ofapiAccountId !== job.ofapiAccountId) {
      throw new ConflictError("Export account binding changed");
    }
    const uncertain = await db.execute(sql`select 1 from ofapi_request_attempts
      where owner_kind='capture_job' and owner_id=${job.id}::uuid
      and state in ('reserved','dispatching','indeterminate')`);
    if (uncertain.rows.length)
      throw new ConflictError(
        "An export request remains in flight or uncertain",
      );
    const next = buildOfapiExportQuoteRequest({ ...job, state: "leased" });
    if (
      !next ||
      job.pendingObservationId !== null ||
      (job.maxCalls !== null && job.dispatchCount >= job.maxCalls) ||
      (job.maxCredits !== null &&
        job.spentCredits + next.reservedCredits > job.maxCredits)
    ) {
      throw new ConflictError("Export has no funded resumable request");
    }
    // Zero-credit status/quote work remains possible after the paid start reserved the full cap.
    const resumed = await db.execute(sql`update ofapi_collection_jobs
      set state='queued',reason=null,policy_revision=${policy.revision},updated_at=now()
      where id=${job.target.collectionJobId}::uuid and page_id=${job.pageId}
      and state in ('queued','running','paused') and used_calls<max_calls and used_bytes<max_bytes
      and used_credits+${next.reservedCredits}<=max_credits returning id`);
    if (!resumed.rows.length)
      throw new ConflictError("Export task allowance exhausted");
    await db.execute(sql`update ofapi_capture_jobs set state='ready',reason_code=null,reason_message=null,
      next_attempt_at=now(),row_version=row_version+1,updated_at=now() where id=${job.id}::uuid`);
    await insertAuditEvent(db, {
      actorUserId,
      eventType: "admin.ofapi_export_resume",
      source: "dashboard",
      platformAccountId: job.pageId,
      metadata: {
        jobId: job.id,
        collectionJobId: job.target.collectionJobId,
        policyRevision: policy.revision,
        nextOperation: next.operation,
        reservedCredits: next.reservedCredits,
        reason: input.reason,
      },
    });
    return {
      jobId: job.id,
      rowVersion: job.rowVersion + 1,
      state: "ready" as const,
    };
  });
}
