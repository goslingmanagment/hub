import type {
  OfapiCaptureAttemptResolveBody,
  OfapiCaptureAttemptResolveResponse,
  OfapiCaptureControlBody,
  OfapiCaptureControlResponse,
  OfapiCaptureJobReplayBody,
  OfapiCaptureJobReplayResponse,
  OfapiCaptureOperatorStatusResponse,
  OfapiCoverageRevokeBody,
  OfapiCoverageRevokeResponse,
  OfapiExportCreateReconcileBody,
  OfapiExportCreateReconcileResponse,
} from "@agency_hub_core/contracts";
import {
  getOfapiCaptureOperatorAttempt,
  getOfapiCaptureOperatorStatus,
  OfapiCaptureInvariantError,
  OfapiMessageCoverageOperatorConflictError,
  reconcileOfapiExportCreate,
  replayOfapiCaptureJobParse,
  revokeOfapiMessageCoverage,
  resolveOfapiIndeterminateAttempt,
  setOfapiCaptureControl,
  type OfapiCaptureOperatorAttemptRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

function serializeAttempt(
  attempt: OfapiCaptureOperatorAttemptRecord,
): OfapiCaptureAttemptResolveResponse["attempt"] {
  return {
    attemptId: attempt.attemptId,
    captureJobId: attempt.captureJobId,
    pageId: attempt.pageId,
    operation: attempt.operation,
    state: attempt.state,
    creditState: attempt.creditState,
    reservedCredits: attempt.reservedCredits,
    settledCredits: attempt.settledCredits,
    certaintyResolution: attempt.certaintyResolution,
    dispatchStartedAt: attempt.dispatchStartedAt?.toISOString() ?? null,
    finishedAt: attempt.finishedAt?.toISOString() ?? null,
  };
}

function previewAttemptResolution(
  attempt: OfapiCaptureOperatorAttemptRecord,
  resolution: "confirmed_billed" | "confirmed_not_billed",
  actualCredits?: number,
): OfapiCaptureOperatorAttemptRecord {
  const billedCredits = resolution === "confirmed_not_billed"
    ? 0
    : actualCredits ?? attempt.reservedCredits;
  return {
    ...attempt,
    creditState: billedCredits === 0 ? "released" : "settled",
    settledCredits: billedCredits,
    certaintyResolution: resolution,
  };
}

export async function getOwnerOfapiCaptureOperatorStatus(
  app: Pick<AppContext, "db">,
): Promise<OfapiCaptureOperatorStatusResponse> {
  const status = await getOfapiCaptureOperatorStatus(app.db);
  return {
    controls: status.controls.map((control) => ({
      ...control,
      updatedAt: control.updatedAt.toISOString(),
    })),
    jobGroups: status.jobGroups.map((group) => ({
      ...group,
      oldestUpdatedAt: group.oldestUpdatedAt.toISOString(),
    })),
    jobSamples: status.jobSamples.map((job) => ({
      ...job,
      updatedAt: job.updatedAt.toISOString(),
    })),
    indeterminate: {
      count: status.indeterminate.count,
      oldestAt: status.indeterminate.oldestAt?.toISOString() ?? null,
      samples: status.indeterminate.samples.map(serializeAttempt),
    },
    strandedInteractive: {
      count: status.strandedInteractive.count,
      oldestAt: status.strandedInteractive.oldestAt?.toISOString() ?? null,
    },
    storageHealth: status.storageHealth === null
      ? null
      : {
        ...status.storageHealth,
        checkedAt: status.storageHealth.checkedAt.toISOString(),
      },
  };
}

export async function setOwnerOfapiCaptureControl(
  app: Pick<AppContext, "db">,
  input: OfapiCaptureControlBody & { actorUserId: number },
): Promise<OfapiCaptureControlResponse> {
  try {
    const result = await setOfapiCaptureControl(app.db, {
      controlKey: input.controlKey,
      paused: input.paused,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
      execute: input.dryRun === false,
    });
    return {
      controlKey: input.controlKey,
      executed: result.executed,
      previous: {
        paused: result.previous.paused,
        reason: result.previous.reason,
        version: Number(result.previous.version),
      },
      next: result.next,
    };
  } catch (error) {
    if (error instanceof OfapiCaptureInvariantError) {
      throw new ConflictError(error.message);
    }
    throw error;
  }
}

export async function resolveOwnerOfapiCaptureAttempt(
  app: Pick<AppContext, "db">,
  input: OfapiCaptureAttemptResolveBody & { attemptId: string; actorUserId: number },
): Promise<OfapiCaptureAttemptResolveResponse> {
  const current = await getOfapiCaptureOperatorAttempt(app.db, input.attemptId);
  if (!current) throw new NotFoundError(`OFAPI attempt ${input.attemptId} was not found`);
  if (current.state !== input.expectedState || current.creditState !== "indeterminate") {
    throw new ConflictError(`OFAPI attempt ${input.attemptId} is not unresolved indeterminate`);
  }
  if (input.dryRun !== false) {
    return {
      dryRun: true,
      status: "would_resolve",
      attempt: serializeAttempt(previewAttemptResolution(
        current,
        input.resolution,
        input.actualCredits,
      )),
    };
  }
  const resolved = await resolveOfapiIndeterminateAttempt(app.db, {
    attemptId: input.attemptId,
    expectedState: input.expectedState,
    resolution: input.resolution,
    ...(input.actualCredits === undefined ? {} : { actualCredits: input.actualCredits }),
    actorUserId: input.actorUserId,
    reason: input.reason,
  });
  if (!resolved) {
    throw new ConflictError(`OFAPI attempt ${input.attemptId} changed during resolution`);
  }
  const attempt = await getOfapiCaptureOperatorAttempt(app.db, input.attemptId);
  if (!attempt) throw new NotFoundError(`OFAPI attempt ${input.attemptId} was not found`);
  return { dryRun: false, status: "resolved", attempt: serializeAttempt(attempt) };
}

export async function replayOwnerOfapiCaptureJob(
  app: Pick<AppContext, "db">,
  input: OfapiCaptureJobReplayBody & { jobId: string; actorUserId: number },
): Promise<OfapiCaptureJobReplayResponse> {
  try {
    const result = await replayOfapiCaptureJobParse(app.db, {
      jobId: input.jobId,
      expectedState: input.expectedState,
      expectedReasonCode: input.expectedReasonCode,
      expectedJobRowVersion: input.expectedJobRowVersion,
      actorUserId: input.actorUserId,
      reason: input.reason,
      execute: input.dryRun === false,
    });
    if (!result) throw new NotFoundError(`OFAPI capture job ${input.jobId} was not found`);
    return {
      ...result,
      next: {
        ...result.next,
        observationReceivedAt: result.next.observationReceivedAt.toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof OfapiCaptureInvariantError) {
      throw new ConflictError(error.message);
    }
    throw error;
  }
}

export async function revokeOwnerOfapiMessageCoverage(
  app: Pick<AppContext, "db">,
  input: OfapiCoverageRevokeBody & {
    pageId: number;
    chatId: string;
    actorUserId: number;
  },
): Promise<OfapiCoverageRevokeResponse> {
  try {
    const result = await revokeOfapiMessageCoverage(app.db, {
      actionId: input.actionId,
      pageId: input.pageId,
      chatId: input.chatId,
      expectedSourceAccountSeq: input.expectedSourceAccountSeq,
      actorUserId: input.actorUserId,
      reason: input.reason,
      execute: input.dryRun === false,
    });
    if (!result) {
      throw new NotFoundError(
        `OFAPI coverage for page ${input.pageId}, chat ${input.chatId} was not found`,
      );
    }
    return {
      dryRun: input.dryRun !== false,
      ...result,
      revokedAt: result.revokedAt?.toISOString() ?? null,
    };
  } catch (error) {
    if (error instanceof OfapiMessageCoverageOperatorConflictError) {
      throw new ConflictError(error.message);
    }
    throw error;
  }
}

export async function reconcileOwnerOfapiExportCreate(
  app: Pick<AppContext, "db">,
  input: OfapiExportCreateReconcileBody & { jobId: string; actorUserId: number },
): Promise<OfapiExportCreateReconcileResponse> {
  const repositoryInput = {
    jobId: input.jobId,
    attemptId: input.attemptId,
    action: input.action,
    vendorExportId: input.action === "adopt_created" ? input.vendorExportId : null,
    ...(input.action === "adopt_created" && input.actualCredits !== undefined
      ? { actualCredits: input.actualCredits }
      : {}),
    expectedState: input.expectedState,
    expectedReasonCode: input.expectedReasonCode,
    expectedJobRowVersion: input.expectedJobRowVersion,
    actorUserId: input.actorUserId,
    reason: input.reason,
  } as const;
  let result = await reconcileOfapiExportCreate(app.db, {
    ...repositoryInput,
    execute: false,
    allowUnresolvedPreview: true,
    recordAction: input.dryRun !== false,
  });
  if (input.dryRun === false && result.outcome === "would_reconcile") {
    if (result.attempt.creditState === "indeterminate") {
      const resolved = await resolveOfapiIndeterminateAttempt(app.db, {
        attemptId: input.attemptId,
        expectedState: "indeterminate",
        resolution: input.action === "confirm_not_created"
          ? "confirmed_not_billed"
          : "confirmed_billed",
        ...(input.action === "adopt_created" && input.actualCredits !== undefined
          ? { actualCredits: input.actualCredits }
          : {}),
        actorUserId: input.actorUserId,
        reason: input.reason,
      });
      if (!resolved) {
        throw new ConflictError(`OFAPI attempt ${input.attemptId} changed during resolution`);
      }
    }
    result = await reconcileOfapiExportCreate(app.db, {
      ...repositoryInput,
      execute: true,
    });
  }
  if (result.outcome === "not_found") {
    throw new NotFoundError(`OFAPI export job or attempt was not found`);
  }
  if (result.outcome === "certainty_unresolved") {
    throw new ConflictError(
      `Resolve attempt ${input.attemptId} certainty before changing the export job`,
    );
  }
  if (result.outcome === "conflict") {
    throw new ConflictError(`OFAPI export job ${input.jobId} no longer matches the expected state`);
  }
  return {
    dryRun: input.dryRun !== false,
    status: result.outcome === "would_reconcile" ? "would_reconcile" : "reconciled",
    action: input.action,
    job: {
      jobId: result.job.id,
      state: result.job.state,
      reasonCode: result.job.reasonCode,
      rowVersion: result.job.rowVersion,
    },
    attempt: serializeAttempt(
      result.outcome === "would_reconcile" && result.attempt.creditState === "indeterminate"
        ? previewAttemptResolution(
          result.attempt,
          input.action === "confirm_not_created"
            ? "confirmed_not_billed"
            : "confirmed_billed",
          input.action === "adopt_created" ? input.actualCredits : undefined,
        )
        : result.attempt,
    ),
  };
}
