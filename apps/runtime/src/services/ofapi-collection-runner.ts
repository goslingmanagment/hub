import { runCanonicalization } from "./canonicalize-driver.ts";
import { projectOfapiReadSnapshotObservation } from "./projections/ofapi-read-snapshots.ts";
import { sql } from "drizzle-orm";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import {
  checkOfapiCollectionLease,
  checkpointOfapiCollectionJob,
  claimOfapiCollectionJob,
  closeAdmissionRefusedOfapiCollectionRuns,
  closeSafeReadFailedOfapiCollectionRuns,
  enqueueDueOfapiCollectionSchedules,
  findPageById,
  getEffectiveOfapiCollectionPolicy,
  getOfapiCollectionJob,
  hashOfapiCaptureValue,
  listPendingOfapiCollectionJobs,
  OfapiCollectionPolicyError,
} from "@agency_hub_core/db";
import {
  OFAPI_READ_CATALOG,
  isOfapiUserListRef,
  findOfapiReadDefinition,
  validateOfapiReadQuery,
  type OfapiCollectionCategory,
} from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";
import type { AppContext } from "../bootstrap.ts";
import {
  captureOfapiCollectionRead,
  matchesOfapiCollectionJobCategory,
  completeOfapiCollectionRead,
  OfapiCollectionAdmissionError,
  type OfapiCollectionReadStep,
} from "./ofapi-collection-read-transport.ts";
import {
  normalizeOfapiRead,
  ofapiReadCoverage,
} from "./ofapi-read-normalization.ts";
import { OfapiGovernedRequestError } from "./ofapi.ts";
export type OfapiCollectionJob = NonNullable<
  Awaited<ReturnType<typeof getOfapiCollectionJob>>
>;
export interface OfapiCollectionHandler {
  plan(job: OfapiCollectionJob, accountId: string): OfapiCollectionReadStep[];
  materialize?(
    app: AppContext,
    input: {
      job: OfapiCollectionJob;
      step: OfapiCollectionReadStep;
      body: unknown;
      observationId: number;
      observationReceivedAt: Date;
    },
  ): Promise<void>;
}
export type OfapiCollectionHandlers = Partial<
  Record<OfapiCollectionCategory, OfapiCollectionHandler>
>;
export const OFAPI_COLLECTION_RUN_QUEUE = "ofapi.collection.run";
export const OFAPI_COLLECTION_SWEEP_QUEUE = "ofapi.collection.sweep";
const READ_CATEGORIES: OfapiCollectionCategory[] = [
  "profile_notifications",
  "posts_comments",
  "content_history",
  "balances",
  "smart_links", "tracking_links",
  "account_settings",
];
class OfapiCollectionCapturedHttpError extends Error {
  constructor(readonly status: number) {
    super(`Vendor HTTP ${status}; response captured`);
  }
}
/**
 * Captured vendor statuses that end a scheduled run as failed. 401 and 403 are
 * authorization, which someone has to restore, so those runs stay paused, as
 * does any status outside 4xx/5xx. `closeSafeReadFailedOfapiCollectionRuns`
 * applies the same rule in SQL to runs parked before this one existed.
 */
function capturedStatusEndsScheduledRun(status: number) {
  return status >= 400 && status <= 599 && status !== 401 && status !== 403;
}
export function planOfapiReadCollection(
  job: OfapiCollectionJob,
  accountId: string,
): OfapiCollectionReadStep[] {
  const selection = job.target.selection;
  const chosen = selection.length
    ? selection
    : OFAPI_READ_CATALOG.filter(
        (row) => row.category === job.category && row.defaultCollect,
      ).map((row) => row.id);
  return chosen.map((entry) => {
    const [selector, rawQuery, ...queryExtra] = entry.split("?");
    const [id, nativeId, ...extra] = selector!.split(":");
    const def = OFAPI_READ_CATALOG.find(
      (row) => row.id === id && matchesOfapiCollectionJobCategory(row, {
        category: job.category, jobId: job.id, purpose: job.purpose,
      }),
    );
    if (
      !def ||
      extra.length ||
      queryExtra.length ||
      Boolean(def.detail) !== Boolean(nativeId) ||
      (nativeId && !(def.path.includes(":list") ? isOfapiUserListRef(nativeId) : (def.idKind === "ulid" ? /^[0-9A-HJKMNP-TV-Z]{26}$/ : /^\d+$/).test(nativeId)))
    )
      throw new Error(`Unsupported collection selection ${entry}`);
    const query: Record<string, string> = {};
    if (def.query.limit) query.limit = def.id === "fans_expired" ? "20" : "50";
    if (def.query.offset) query.offset = "0";
    if (def.scope === "smart_link" && !def.detail) query.account_ids = accountId;
    if (job.target.from && job.target.to) {
      if (def.query.start_date) {
        query.start_date = job.target.from;
        query.end_date = job.target.to;
      }
      if (def.query.startDate) {
        query.startDate = job.target.from;
        query.endDate = job.target.to;
      }
      if (def.query.date_start) { query.date_start = job.target.from; query.date_end = job.target.to; }
      if (def.query.acquisition_start) { query.acquisition_start = job.target.from; query.acquisition_end = job.target.to; }
    }
    const explicitQuery = new URLSearchParams(rawQuery ?? "");
    if (new Set(explicitQuery.keys()).size !== [...explicitQuery.keys()].length)
      throw new Error("Duplicate collection query");
    for (const [key, value] of explicitQuery) query[key] = value;
    return {
      operation: def.operation,
      pathname: `${def.scope === "smart_link" ? "" : `/${accountId}`}/${def.path.replace(/:(?:id|list)/, nativeId ?? "")}`,
      ...(def.scope === "smart_link" ? { scopeAccountId: accountId } : {}),
      query: validateOfapiReadQuery(def, query),
      detail: def.detail,
    };
  });
}
export function planOfapiProfileVisitorCollection(
  job: OfapiCollectionJob,
  accountId: string,
): OfapiCollectionReadStep[] {
  if (!job.target.from || !job.target.to)
    throw new Error("Visitors require an explicit daily window");
  const from = new Date(job.target.from),
    to = new Date(job.target.to);
  if (
    from.getUTCHours() ||
    from.getUTCMinutes() ||
    from.getUTCSeconds() ||
    to.getUTCHours() ||
    to.getUTCMinutes() ||
    to.getUTCSeconds() ||
    from >= to
  )
    throw new Error("Visitors windows must use UTC midnight boundaries");
  const types = job.target.selection.length ? job.target.selection : ["total"];
  if (types.some((type) => !["total", "users", "guests"].includes(type)))
    throw new Error("Invalid visitor selection");
  const days = (to.getTime() - from.getTime()) / 86400000;
  if (days * types.length > job.max_calls || days * types.length > 1000)
    throw new Error("Visitor window exceeds the approved call bound");
  const steps: OfapiCollectionReadStep[] = [];
  for (let day = 0; day < days; day++)
    for (const type of types)
      steps.push({
        operation: "ofapi_read_profile_visitors",
        pathname: `/${accountId}/statistics/reach/profile-visitors`,
        query: {
          start_date: new Date(from.getTime() + day * 86400000).toISOString(),
          end_date: new Date(
            from.getTime() + (day + 1) * 86400000 - 1,
          ).toISOString(),
          type,
          filter: "chart",
        },
      });
  return steps;
}
export async function materializeOfapiReadSnapshot(
  app: AppContext,
  input: {
    pageId: number;
    step: OfapiCollectionReadStep;
    body: unknown;
    observationId: number;
    observationReceivedAt: Date;
  },
) {
  const def = findOfapiReadDefinition(input.step.operation);
  if (!def) throw new Error("Unknown collection operation");
  const items = normalizeOfapiRead(def, input.body, input.step.pathname),
    coverage = ofapiReadCoverage(
      def,
      input.body,
      input.step.pathname,
      input.step.query,
    );
  const canonical = await runCanonicalization(app, { observationId: input.observationId, kinds: ["ofapi.collection_read_response.v1"], pageSize:1, maxPagesPerFamily:1 });
  if (canonical.skippedUnparseable || canonical.skippedUnmapped) throw new Error("OFAPI collection response contract rejected; raw response retained");
  await projectOfapiReadSnapshotObservation(app, { accountId: input.pageId, observationId: input.observationId });
  const materialized = await app.db.execute(sql`select 1 from ofapi_read_snapshots where page_id=${input.pageId} and observation_id=${input.observationId}`);
  if (!materialized.rows.length) throw new Error("OFAPI read canonical projection is unavailable");
  return { items, coverage };
}
/** Each invocation takes a lease and checkpoints every durable response before another request. */
export async function runOfapiCollectionJob(
  app: AppContext,
  jobId: string,
  handlers: OfapiCollectionHandlers = {},
) {
  const token = await claimOfapiCollectionJob(app.db, jobId);
  if (!token) return { state: "busy" };
  const job = await getOfapiCollectionJob(app.db, jobId);
  if (!job) throw new Error("Collection job disappeared");
  let checkpoint = { ...job.checkpoint };
  let localRecovery = false;
  let capturedFailureBytes = 0;
  try {
    const stored = await findPageById(app.db, Number(job.page_id));
    const accountId = stored?.page.ofapiAccountId;
    if (!accountId) throw new Error("Account binding unavailable");
    const handler =
      handlers[job.category] ??
      (READ_CATEGORIES.includes(job.category)
        ? { plan: planOfapiReadCollection }
        : null);
    if (!handler)
      throw new Error(`Collector handler unavailable: ${job.category}`);
    // Freeze the chosen plan so a deploy or changed catalog cannot silently add work to an approved job.
    const steps = Array.isArray(checkpoint.plan)
      ? (checkpoint.plan as OfapiCollectionReadStep[])
      : handler.plan(job, accountId);
    checkpoint = { ...checkpoint, plan: steps };
    await checkpointOfapiCollectionJob(app.db, {
      id: jobId,
      token,
      checkpoint,
      state: "running",
    });
    const startedAt = Date.now();
    while (Number(checkpoint.index ?? 0) < steps.length) {
      const current = await getOfapiCollectionJob(app.db, jobId);
      if (!current) throw new Error("Collection job disappeared");
      const index = Number(checkpoint.index ?? 0),
        base = steps[index]!;
      const step = {
        ...base,
        query: checkpoint.nextQuery
          ? (checkpoint.nextQuery as Record<string, string>)
          : base.query,
      };
      const policy = await getEffectiveOfapiCollectionPolicy(
        app.db,
        job.category,
        Number(job.page_id),
      );
      // This check improves diagnostics; physical dispatch rechecks policy and atomically reserves all caps.
      if (policy.backgroundPaused) throw new Error("background_paused");
      if (
        job.purpose === "background" &&
        (policy.mode !== "scheduled" || (step.detail && !policy.includeDetails))
      )
        throw new Error("Scheduled policy changed");
      const remainingBytes =
        Number(current.max_bytes) - Number(current.used_bytes);
      // JSONB changes object key order. Identity must survive the checkpoint
      // round trip, including a replay after a paid response was captured.
      const stepKey = `${jobId}:${index}:${hashOfapiCaptureValue(step)}`;
      const read = await captureOfapiCollectionRead(app, {
        pageId: Number(job.page_id),
        accountId,
        step,
        stepKey,
        maxBytes: Math.max(1, remainingBytes),
        context: {
          category: job.category,
          purpose: job.purpose,
          jobId,
          detail: step.detail ?? false,
          reservedCredits: findOfapiReadDefinition(step.operation)?.reservedCredits ?? 1,
        },
        beforeDispatch: () => checkOfapiCollectionLease(app.db, jobId, token),
      });
      localRecovery = true;
      if (read.status < 200 || read.status >= 300) {
        localRecovery = false;
        // Owner Resume can consume this same response again. Account for its
        // retained bytes once while preserving the failed step and cursor.
        if (checkpoint.failedResponseObservationId !== read.observationId)
          capturedFailureBytes = read.bytes;
        checkpoint = { ...checkpoint, failedResponseObservationId: read.observationId,
          failedResponseStatus: read.status };
        throw new OfapiCollectionCapturedHttpError(read.status);
      }
      const projected = await materializeOfapiReadSnapshot(app, {
        pageId: Number(job.page_id),
        step,
        body: read.body,
        observationId: read.observationId,
        observationReceivedAt: read.observationReceivedAt,
      });
      await handler.materialize?.(app, {
        job,
        step,
        body: read.body,
        observationId: read.observationId,
        observationReceivedAt: read.observationReceivedAt,
      });
      await completeOfapiCollectionRead(app, read, projected.items.length);
      const fingerprint = hashOfapiCaptureValue(step.query);
      const visited = Array.isArray(checkpoint.visited)
        ? (checkpoint.visited as string[])
        : [];
      const next = projected.coverage.nextQuery;
      const nextHash = next
        ? hashOfapiCaptureValue(next)
        : null;
      if (nextHash && (nextHash === fingerprint || visited.includes(nextHash)))
        throw new Error("Provider cursor cycle; response retained");
      checkpoint = {
        plan: steps,
        index: next ? index : index + 1,
        nextQuery: next,
        visited: next ? [...visited, fingerprint] : [],
        lastObservationId: read.observationId,
      };
      const completed = Number(checkpoint.index) >= steps.length;
      const savedState = await checkpointOfapiCollectionJob(app.db, {
        id: jobId,
        token,
        checkpoint,
        state: completed ? "completed" : "running",
        bytesAdded: read.bytes,
      });
      localRecovery = false;
      if (savedState === "paused")
        return { state: "paused", reason: "Policy changed during request" };
      if (completed) return { state: "completed" };
      if (Date.now() - startedAt > 45000) {
        await checkpointOfapiCollectionJob(app.db, {
          id: jobId,
          token,
          checkpoint,
          state: "queued",
        });
        return { state: "queued" };
      }
    }
    await checkpointOfapiCollectionJob(app.db, {
      id: jobId,
      token,
      checkpoint,
      state: "completed",
    });
    return { state: "completed" };
  } catch (error) {
    const admissionError = error instanceof OfapiGovernedRequestError && error.phase === "pre_dispatch"
      ? error.cause : error;
    const scheduledLimit = job.purpose === "background" && admissionError instanceof OfapiCollectionPolicyError
      && ["job_limit", "daily_limit", "interval_limit"].includes(admissionError.reason)
      ? admissionError.reason : null;
    // A captured 4xx/5xx answers this step, and a replay of the step reads
    // the same retained response, so the run cannot move. It ends failed and
    // the next interval starts a new bounded run. Authorization, a rejected
    // contract and a cursor cycle still wait for the owner.
    const scheduledHttpFailure = job.purpose === "background"
      && error instanceof OfapiCollectionCapturedHttpError
      && capturedStatusEndsScheduledRun(error.status);
    // The request left and no response was captured. The step allows one
    // request, so this run can never read it again; parked as paused it held
    // its category until an owner noticed (2026-09-08..10-06: eight runs on
    // both OF pages, the oldest for a month). The attempt is already settled
    // as billed by the transport. The next interval starts a new run under its
    // own limits; it does not resume this cursor.
    const scheduledTransportFailure = job.purpose === "background"
      && error instanceof OfapiGovernedRequestError && error.phase === "post_dispatch";
    // A capture-admission refusal (disk gate, credit floor, caps) comes before
    // any vendor request, so nothing is paid or uncertain. A scheduled run
    // ends failed like an exhausted allowance and the next interval starts a
    // fresh window. Parked as paused, it held its category for good: from
    // 2026-09-18 a 93% disk stopped balances, visitors and both link
    // categories on both OF pages.
    const scheduledRefusal = job.purpose === "background"
      && admissionError instanceof OfapiCollectionAdmissionError
      ? admissionError.reason : null;
    // A bounded scheduled run may end with a partial cursor. Retain that
    // evidence as failed, not completed or operator-paused, so the next
    // configured interval can start a new bounded window without backlog.
    const reason = scheduledLimit ? `scheduled_run_exhausted:${scheduledLimit}` :
      scheduledRefusal ? `scheduled_run_refused:${scheduledRefusal}` :
      error instanceof Error
        ? error.message.startsWith("Failed query")
          ? "Local collection persistence failed"
          : error.message
        : "Collection failed";
    if (reason.includes("contract rejected") || reason.includes("cursor cycle"))
      localRecovery = false;
    checkpoint = {
      ...checkpoint,
      localFailures: Number(checkpoint.localFailures ?? 0) + 1,
    };
    if (Number(checkpoint.localFailures) > 3) localRecovery = false;
    const recoveryState = await checkpointOfapiCollectionJob(app.db, {
      id: jobId,
      token,
      checkpoint,
      state: scheduledLimit || scheduledRefusal || scheduledHttpFailure || scheduledTransportFailure ? "failed"
        : localRecovery ? "queued" : "paused",
      bytesAdded: capturedFailureBytes,
      reason,
    }).catch((err) =>
      app.logger.error(
        { err, jobId },
        "Collection checkpoint recovery required",
      ),
    );
    app.logger.warn(
      { jobId, reason },
      "Collection stopped with retained checkpoint",
    );
    return { state: recoveryState ?? "paused", reason };
  }
}
export async function ensureOfapiCollectionQueues(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, OFAPI_COLLECTION_RUN_QUEUE, { retryLimit: 0 }, createdQueues);
  await ensureQueueCreated(boss, OFAPI_COLLECTION_SWEEP_QUEUE, { retryLimit: 0 }, createdQueues);
}
export async function ensureOfapiCollectionSchedules(boss: QueueCreationClient) {
  await boss.schedule?.(OFAPI_COLLECTION_SWEEP_QUEUE, "* * * * *", null, {
    tz: "UTC",
  });
}
export async function sweepOfapiCollections(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  handlers: OfapiCollectionHandlers = {},
) {
  const closed = await closeAdmissionRefusedOfapiCollectionRuns(app.db);
  if (closed.length > 0)
    app.logger.warn(
      { runs: closed },
      "Closed scheduled collection runs parked by a capture-admission refusal",
    );
  const ended = await closeSafeReadFailedOfapiCollectionRuns(app.db);
  if (ended.length > 0)
    app.logger.warn(
      { runs: ended },
      "Closed scheduled collection runs parked by a failed safe read",
    );
  await enqueueDueOfapiCollectionSchedules(app.db, [
    ...new Set([
      ...READ_CATEGORIES,
      ...(Object.keys(handlers) as OfapiCollectionCategory[]),
    ]),
  ]);
  for (const row of await listPendingOfapiCollectionJobs(app.db))
    await boss.send(
      OFAPI_COLLECTION_RUN_QUEUE,
      { jobId: row.id },
      { singletonKey: row.id, retryLimit: 0 },
    );
}
export async function startOfapiCollectionWorker(
  app: AppContext,
  boss: Pick<PgBoss, "work" | "send">,
  handlers: OfapiCollectionHandlers = {},
) {
  await boss.work<{ jobId: string }>(
    OFAPI_COLLECTION_RUN_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs)
        await runOfapiCollectionJob(app, job.data.jobId, handlers);
    },
  );
  await boss.work(OFAPI_COLLECTION_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    await sweepOfapiCollections(app, boss, handlers);
  });
}
