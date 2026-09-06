import { createHash } from "node:crypto";
import {
  appendProjectionOnlyDomainEvents,
  checkOfapiCollectionLease,
  checkpointOfapiCollectionJob,
  claimOfapiCollectionJob,
  enqueueDueOfapiCollectionSchedules,
  findPageById,
  getEffectiveOfapiCollectionPolicy,
  getOfapiCollectionJob,
  listPendingOfapiCollectionJobs,
  saveOfapiReadSnapshot,
} from "@agency_hub_core/db";
import {
  OFAPI_READ_CATALOG,
  findOfapiReadDefinition,
  validateOfapiReadQuery,
  type OfapiCollectionCategory,
} from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";
import type { AppContext } from "../bootstrap.ts";
import {
  captureOfapiCollectionRead,
  completeOfapiCollectionRead,
  type OfapiCollectionReadStep,
} from "./ofapi-collection-read-transport.ts";
import {
  normalizeOfapiRead,
  ofapiReadCoverage,
} from "./ofapi-read-normalization.ts";
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
];
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
      (row) => row.id === id && row.category === job.category,
    );
    if (
      !def ||
      extra.length ||
      queryExtra.length ||
      Boolean(def.detail) !== Boolean(nativeId) ||
      (nativeId && !/^\d+$/.test(nativeId))
    )
      throw new Error(`Unsupported collection selection ${entry}`);
    const query: Record<string, string> = {};
    if (def.query.limit) query.limit = def.id === "fans_expired" ? "20" : "50";
    if (def.query.offset) query.offset = "0";
    if (job.target.from && job.target.to) {
      if (def.query.start_date) {
        query.start_date = job.target.from;
        query.end_date = job.target.to;
      }
      if (def.query.startDate) {
        query.startDate = job.target.from;
        query.endDate = job.target.to;
      }
    }
    const explicitQuery = new URLSearchParams(rawQuery ?? "");
    if (new Set(explicitQuery.keys()).size !== [...explicitQuery.keys()].length)
      throw new Error("Duplicate collection query");
    for (const [key, value] of explicitQuery) query[key] = value;
    return {
      operation: def.operation,
      pathname: `/${accountId}/${def.path.replace(":id", nativeId ?? "")}`,
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
            from.getTime() + (day + 1) * 86400000,
          ).toISOString(),
          type,
          filter: "chart",
        },
      });
  return steps;
}
export async function materializeOfapiReadSnapshot(
  app: Pick<AppContext, "db">,
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
  const items = normalizeOfapiRead(def, input.body),
    coverage = ofapiReadCoverage(
      def,
      input.body,
      input.step.pathname,
      input.step.query,
    );
  const data = {
    pageId: input.pageId,
    source: "onlyfansapi",
    operation: def.operation,
    category: def.category,
    pathname: input.step.pathname,
    query: input.step.query,
    observedAt: input.observationReceivedAt.toISOString(),
    granularity: def.granularity,
    coverage,
    items,
  };
  const dedupKey = `ofapi-read:${input.observationId}:v1`;
  const appended = await appendProjectionOnlyDomainEvents(
    app.db,
    input.pageId,
    [
      {
        type: "ofapi.read_snapshot_observed",
        occurredAt: input.observationReceivedAt,
        data,
        schemaVersion: 1,
        observationId: input.observationId,
        dedupKey,
      },
    ],
    {
      occurredAt: input.observationReceivedAt,
      observationId: input.observationId,
      dedupKey: `${dedupKey}:checkpoint`,
    },
  );
  const eventId = appended.events[0]!.eventId;
  await saveOfapiReadSnapshot(app.db, {
    ...data,
    observedAt: input.observationReceivedAt,
    observationId: input.observationId,
    observationReceivedAt: input.observationReceivedAt,
    eventId,
  });
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
      const stepKey = `${jobId}:${index}:${createHash("sha256").update(JSON.stringify(step)).digest("hex")}`;
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
          reservedCredits: 1,
        },
        beforeDispatch: () => checkOfapiCollectionLease(app.db, jobId, token),
      });
      localRecovery = true;
      if (read.status < 200 || read.status >= 300) {
        localRecovery = false;
        throw new Error(`Vendor HTTP ${read.status}; response captured`);
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
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(step.query))
        .digest("hex");
      const visited = Array.isArray(checkpoint.visited)
        ? (checkpoint.visited as string[])
        : [];
      const next = projected.coverage.nextQuery;
      const nextHash = next
        ? createHash("sha256").update(JSON.stringify(next)).digest("hex")
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
    const reason =
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
      state: localRecovery ? "queued" : "paused",
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
export async function ensureOfapiCollectionSchedules(boss: PgBoss) {
  await boss.createQueue(OFAPI_COLLECTION_RUN_QUEUE, { retryLimit: 0 });
  await boss.createQueue(OFAPI_COLLECTION_SWEEP_QUEUE, { retryLimit: 0 });
  await boss.schedule(OFAPI_COLLECTION_SWEEP_QUEUE, "* * * * *", null, {
    tz: "UTC",
  });
}
export async function sweepOfapiCollections(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  handlers: OfapiCollectionHandlers = {},
) {
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
  boss: PgBoss,
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
