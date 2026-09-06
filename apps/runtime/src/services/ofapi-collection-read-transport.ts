import { createHash } from "node:crypto";
import {
  captureOfapiAttemptResponse,
  createOrGetOfapiCaptureJob,
  getOfapiCaptureJob,
  findCompletedOfapiCaptureJobByTarget,
  hashOfapiCaptureValue,
  leaseNextOfapiCaptureJob,
  loadOfapiCaptureObservation,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  releaseOfapiAttemptPreDispatch,
  reserveOfapiRequestAttempt,
  reconcileOfapiCapturedAttemptCredit,
  settleOfapiCaptureParse,
  settleOfapiCollectionRequest,
  type OfapiCaptureJobRecord,
} from "@agency_hub_core/db";
import {
  OFAPI_MIRROR_BUDGET_DEFAULTS,
  resolveOfapiCatalogPath,
  type OfapiCollectionContext,
} from "@agency_hub_core/shared";
import type { AppContext } from "../bootstrap.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";
import {
  capturePayloadResponse,
  parseOfapiJsonBytes,
} from "./ofapi-capture-contract.ts";
import { resolveOfapiEgressContext } from "./ofapi-egress.ts";
import { OfapiGovernedRequestError } from "./ofapi.ts";

export interface OfapiCollectionReadStep {
  operation: string;
  pathname: string;
  query: Record<string, string>;
  detail?: boolean;
}
export interface OfapiCapturedCollectionRead {
  body: unknown;
  status: number;
  bytes: number;
  observationId: number;
  observationReceivedAt: Date;
  captureJob: OfapiCaptureJobRecord;
  attemptId: string;
}
async function loadCaptured(
  app: AppContext,
  job: OfapiCaptureJobRecord,
): Promise<OfapiCapturedCollectionRead> {
  const observationId =
    job.pendingObservationId ?? Number(job.result?.observationId);
  const observationReceivedAt =
    job.pendingObservationReceivedAt ??
    new Date(String(job.result?.observationReceivedAt));
  if (!observationId || !Number.isFinite(observationReceivedAt.getTime()))
    throw new Error("Collection response is unavailable");
  const row = await loadOfapiCaptureObservation(app.db, {
    observationId,
    observationReceivedAt,
  });
  if (!row?.attemptId)
    throw new Error("Collection response observation is unavailable");
  const payload = await resolveCapturePayloadRow(
    app,
    "observation",
    row.id,
    row,
  );
  const response = capturePayloadResponse(payload.payload);
  if (!response) throw new Error("Invalid capture envelope");
  const parsed = parseOfapiJsonBytes(response.bodyBytes);
  if (parsed.creditsUsed !== null)
    await reconcileOfapiCapturedAttemptCredit(app.db, {
      attemptId: row.attemptId,
      actualCredits: parsed.creditsUsed,
      balanceAfter: parsed.balanceAfter,
    });
  await settleOfapiCollectionRequest(app.db, row.attemptId, parsed.creditsUsed);
  return {
    body: parsed.body,
    status: response.status,
    bytes: response.bodyBytes.length,
    observationId,
    observationReceivedAt,
    captureJob: job,
    attemptId: row.attemptId,
  };
}
/** One physical GET at most per step. A retained response is always consumed before any new egress. */
export async function captureOfapiCollectionRead(
  app: AppContext,
  input: {
    pageId: number;
    accountId: string;
    step: OfapiCollectionReadStep;
    context: OfapiCollectionContext;
    stepKey: string;
    maxBytes: number;
    beforeDispatch: () => Promise<boolean>;
  },
): Promise<OfapiCapturedCollectionRead> {
  const resolved = resolveOfapiCatalogPath(
    input.step.pathname,
    input.step.query,
  );
  if (
    !resolved ||
    resolved.definition.operation !== input.step.operation ||
    resolved.accountId !== input.accountId ||
    resolved.definition.category !== input.context.category
  )
    throw new Error("Unregistered collection read");
  const target = { ...input.step, collectionJobId: input.context.jobId };
  const completed = await findCompletedOfapiCaptureJobByTarget(app.db, {
    activeSlotKey: `page:${input.pageId}:collection:${input.stepKey}`,
    targetHash: hashOfapiCaptureValue(target),
    kind: "collection_read",
    goal: null,
  });
  if (completed) return loadCaptured(app, completed);
  const created = await createOrGetOfapiCaptureJob(app.db, {
    pageId: input.pageId,
    ofapiAccountId: input.accountId,
    kind: "collection_read",
    activeSlotKey: `page:${input.pageId}:collection:${input.stepKey}`,
    target,
    budgetScope: "bulk",
    createdBy: "owner",
    maxCalls: 1,
    maxCredits: Math.max(1, input.context.reservedCredits ?? 1),
  });
  if (created.job.state === "complete") return loadCaptured(app, created.job);
  const job = await leaseNextOfapiCaptureJob(app.db, {
    pageId: input.pageId,
    jobId: created.job.id,
    leaseOwner: `collection:${input.context.jobId}`,
    leaseTtlMs: 180000,
  });
  if (!job?.leaseToken)
    throw new Error(`Collection capture unavailable: ${created.job.state}`);
  if (job.pendingObservationId) return loadCaptured(app, job);
  if (!app.ofapi?.dispatchGovernedRaw)
    throw new Error("OFAPI transport unavailable");
  const egress = await resolveOfapiEgressContext(app, {
    pageId: input.pageId,
    ofapiAccountId: input.accountId,
  });
  try {
    const deadlineAt = new Date(Date.now() + 65000),
      globalDailyCap =
        app.config.ofapiMirrorGlobalDailyCreditBudget ??
        OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget;
    const reservation = await reserveOfapiRequestAttempt(app.db, {
      ownerKind: "capture_job",
      ownerId: job.id,
      pageId: job.pageId,
      ofapiAccountId: job.ofapiAccountId,
      originPrincipalId: null,
      budgetScope: "bulk",
      operation: input.step.operation,
      endpointClass: input.context.category,
      egressKey: egress.egressKey,
      method: "GET",
      requestSemantics: "safe_read",
      requestShape: { ...input.step },
      requireFreshStorageHealth: true,
      reservedCredits: input.context.reservedCredits ?? 1,
      globalDailyCap,
      scopeDailyCap: Math.min(
        globalDailyCap,
        app.config.ofapiBackfillDailyCreditBudget ?? 200,
      ),
      creditFloor: app.config.ofapiCreditFloor ?? 500,
      balanceMaxAgeMs: 21600000,
      allowFloorProbe: false,
      jobLeaseToken: job.leaseToken,
      deadlineAt,
    });
    if (!reservation.admitted)
      throw new Error(`Capture admission: ${reservation.reason}`);
    let raw;
    try {
      raw = await app.ofapi.dispatchGovernedRaw(
        {
          pageId: input.pageId,
          dispatcher: egress.dispatcher,
          egressKey: egress.egressKey,
          collectionContext: input.context,
        },
        {
          attemptId: reservation.attemptId,
          operation: input.step.operation,
          method: "GET",
          pathname: input.step.pathname,
          query: input.step.query,
          priorityClass: "bulk",
          deadlineAt,
          maxResponseBytes: Math.min(input.maxBytes, 10 * 1024 * 1024),
          beforeDispatch: async () =>
            (await input.beforeDispatch()) &&
            (await markOfapiAttemptDispatching(app.db, {
              attemptId: reservation.attemptId,
              fenceToken: reservation.fenceToken,
              jobLeaseToken: job.leaseToken!,
            })),
        },
      );
    } catch (error) {
      if (
        error instanceof OfapiGovernedRequestError &&
        error.phase === "pre_dispatch"
      )
        await releaseOfapiAttemptPreDispatch(app.db, {
          attemptId: reservation.attemptId,
          fenceToken: reservation.fenceToken,
          reasonCode: error.reason,
        });
      else
        await markOfapiAttemptIndeterminate(app.db, {
          attemptId: reservation.attemptId,
          fenceToken: reservation.fenceToken,
          outcome: "transport",
        });
      throw error;
    }
    // Capture and credit settlement precede JSON parsing, projection and checkpoint advancement.
    try {
      await captureOfapiAttemptResponse(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
        responseObservedAt: raw.receivedAt,
        httpStatus: raw.status,
        httpOutcome:
          raw.status >= 200 && raw.status < 300
            ? "success"
            : raw.status === 429
              ? "rate"
              : raw.status >= 500
                ? "vendor_5xx"
                : "request_rejected",
        responseHeaders: raw.headers,
        bodyBytes: raw.bodyBytes,
        request: { ...input.step },
        producer: "ofapi-collection",
        observationKind: "ofapi.collection_read_response.v1",
      });
    } catch (error) {
      await markOfapiAttemptIndeterminate(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
        outcome: "capture_uncommitted",
        responseObservedAt: raw.receivedAt,
      });
      throw error;
    }
    const captured = await getOfapiCaptureJob(app.db, job.id);
    if (!captured) throw new Error("Capture job disappeared");
    return loadCaptured(app, { ...captured, leaseToken: job.leaseToken });
  } finally {
    await egress.close();
  }
}
export async function completeOfapiCollectionRead(
  app: AppContext,
  read: OfapiCapturedCollectionRead,
  itemCount: number,
) {
  if (read.captureJob.state === "complete") return;
  if (!read.captureJob.leaseToken)
    throw new Error("Collection parse lease absent");
  const payload = {
    observationId: read.observationId,
    observationReceivedAt: read.observationReceivedAt.toISOString(),
    itemCount,
  };
  await settleOfapiCaptureParse(app.db, {
    jobId: read.captureJob.id,
    attemptId: read.attemptId,
    leaseToken: read.captureJob.leaseToken,
    observationId: read.observationId,
    observationReceivedAt: read.observationReceivedAt,
    parserOutcome: "accepted",
    rawCount: itemCount,
    acceptedCount: itemCount,
    boundaryDuplicateCount: 0,
    explicitlyIrrelevantCount: 0,
    rejectedCount: 0,
    disposition: {
      kind: "complete",
      terminal: {
        producer: "ofapi-collection",
        kind: "ofapi.collection_read_materialized.v1",
        payload,
        payloadHash: createHash("sha256")
          .update(JSON.stringify(payload))
          .digest(),
        idempotencyKey: `collection-complete:${read.observationId}`,
      },
      result: payload,
    },
  });
}
