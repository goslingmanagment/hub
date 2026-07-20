import { setTimeout as delay } from "node:timers/promises";

import {
  captureOfapiAttemptResponse,
  completeOfapiInteractiveRequest,
  createOfapiInteractiveRequest,
  listExpiredOfapiInteractiveResponseCaptures,
  loadOfapiCaptureObservation,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  reconcileOfapiCapturedAttemptCredit,
  releaseOfapiAttemptPreDispatch,
  reserveOfapiRequestAttempt,
  type OfapiHttpOutcome,
  type OfapiParserOutcome,
} from "@agency_hub_core/db";
import { OFAPI_MIRROR_BUDGET_DEFAULTS } from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { AppContext } from "../bootstrap.ts";
import {
  ServiceUnavailableError,
  TooManyRequestsError,
} from "./errors.ts";
import {
  OfapiGovernedRequestError,
  type OfapiGovernedRawResponse,
  type OfapiRawResponse,
} from "./ofapi.ts";
import {
  capturePayloadResponse,
  parseOfapiJsonBytes,
  validateOfapiInteractiveResponseShape,
  type ParsedOfapiJsonBody,
} from "./ofapi-capture-contract.ts";
import {
  materializeOfapiCaptureObservation,
} from "./ofapi-capture-materialization.ts";

const BALANCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FLOOR_PROBE_COOLDOWN_MS = 60 * 60 * 1000;
const CAPTURE_COMMIT_ATTEMPTS = 3;

function httpOutcome(status: number): OfapiHttpOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 404) return "not_found";
  if (status === 401) return "auth_confirmed";
  if (status === 403) return "forbidden_unconfirmed";
  if (status === 429) return "rate";
  if (status >= 500) return "vendor_5xx";
  if (status === 400 || status === 409 || status === 422) return "request_rejected";
  return "unexpected_http";
}

function interactiveParserOutcome(
  operation: string,
  status: number,
  parsed: ParsedOfapiJsonBody,
): OfapiParserOutcome {
  const successfulHttp = status >= 200 && status < 300;
  if (!parsed.validJson) {
    return successfulHttp ? "contract_rejected" : "intentional_noop";
  }
  if (!successfulHttp) return "accepted";
  return !validateOfapiInteractiveResponseShape(operation, parsed.body)
    ? "contract_rejected"
    : "accepted";
}

function denialError(reason: string) {
  if (
    reason === "global_cap" ||
    reason === "scope_cap" ||
    reason === "principal_credit_cap" ||
    reason === "principal_call_cap" ||
    reason === "principal_storm_block"
  ) {
    return new TooManyRequestsError("OFAPI read budget is temporarily exhausted");
  }
  return new ServiceUnavailableError(`OFAPI read admission refused: ${reason}`);
}

export async function executeCaptureFirstInteractiveRead(
  app: AppContext,
  input: {
    principalUserId: number;
    pageId: number;
    ofapiAccountId: string;
    dispatcher: Dispatcher;
    egressKey: string;
    operation: string;
    surface: string;
    pathname: string;
    query: Record<string, string>;
    fallbackCredits: number;
    servingMode?: "vendor_only" | "shadow" | "db_fallback";
    fallbackReason?:
      | "surface_not_cutover"
      | "no_certificate"
      | "stale_head"
      | "gap"
      | "projection_lag"
      | "shadow_probe"
      | null;
  },
): Promise<OfapiRawResponse> {
  if (!app.ofapi?.dispatchGovernedRaw) {
    throw new ServiceUnavailableError("OFAPI capture-first transport is unavailable");
  }

  const deadlineAt = new Date(Date.now() + 65_000);
  const owner = await createOfapiInteractiveRequest(app.db, {
    pageId: input.pageId,
    ofapiAccountId: input.ofapiAccountId,
    principalUserId: input.principalUserId,
    operation: input.operation,
    surface: input.surface,
    target: {
      method: "GET",
      pathname: input.pathname,
      query: input.query,
    },
  });
  const globalDailyCap = Math.max(
    1,
    app.config.ofapiMirrorGlobalDailyCreditBudget
      ?? OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget,
  );
  const reservation = await reserveOfapiRequestAttempt(app.db, {
    ownerKind: "interactive_request",
    ownerId: owner.id,
    pageId: input.pageId,
    ofapiAccountId: input.ofapiAccountId,
    originPrincipalId: input.principalUserId,
    budgetScope: "interactive",
    operation: input.operation,
    endpointClass: input.surface,
    egressKey: input.egressKey,
    method: "GET",
    requestSemantics: "safe_read",
    requestShape: {
      pathname: input.pathname,
      query: input.query,
    },
    requireFreshStorageHealth: true,
    surface: input.surface,
    servingMode: input.servingMode ?? "vendor_only",
    fallbackReason: input.fallbackReason ?? null,
    reservedCredits: Math.max(1, Math.trunc(input.fallbackCredits)),
    globalDailyCap,
    scopeDailyCap: globalDailyCap,
    creditFloor: Math.max(0, app.config.ofapiCreditFloor ?? 500),
    balanceMaxAgeMs: BALANCE_MAX_AGE_MS,
    allowFloorProbe: true,
    floorProbeCooldownMs: FLOOR_PROBE_COOLDOWN_MS,
    principalCallCap: Math.max(
      1,
      app.config.ofapiMirrorPrincipalDailyCallCap
        ?? OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCallCap,
    ),
    principalCreditCap: Math.max(
      1,
      app.config.ofapiMirrorPrincipalDailyCreditCap
        ?? OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCreditCap,
    ),
    deadlineAt,
  });
  if (!reservation.admitted) {
    throw denialError(reservation.reason);
  }

  let raw: OfapiGovernedRawResponse;
  try {
    raw = await app.ofapi.dispatchGovernedRaw({
      pageId: input.pageId,
      actorUserId: input.principalUserId,
      dispatcher: input.dispatcher,
      egressKey: input.egressKey,
    }, {
      attemptId: reservation.attemptId,
      operation: input.operation,
      method: "GET",
      pathname: input.pathname,
      query: input.query,
      priorityClass: "interactive",
      deadlineAt,
      beforeDispatch: () => markOfapiAttemptDispatching(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
      }),
    });
  } catch (error) {
    if (error instanceof OfapiGovernedRequestError && error.phase === "pre_dispatch") {
      await releaseOfapiAttemptPreDispatch(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
        reasonCode: error.reason,
      });
    } else {
      await markOfapiAttemptIndeterminate(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
        outcome: error instanceof OfapiGovernedRequestError && error.reason === "deadline"
          ? "vendor_slow"
          : "transport",
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    throw new ServiceUnavailableError("OFAPI upstream is unavailable");
  }

  let captureError: unknown = null;
  let captured = false;
  for (let attempt = 1; attempt <= CAPTURE_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      await captureOfapiAttemptResponse(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
        responseObservedAt: raw.receivedAt,
        httpStatus: raw.status,
        httpOutcome: httpOutcome(raw.status),
        responseHeaders: raw.headers,
        bodyBytes: raw.bodyBytes,
        request: {
          method: "GET",
          pathname: input.pathname,
          query: input.query,
        },
        producer: "ofapi-mirror-interactive",
        observationKind: "ofapi.interactive_response.v1",
      });
      captured = true;
      break;
    } catch (error) {
      captureError = error;
      if (attempt < CAPTURE_COMMIT_ATTEMPTS) {
        await delay(attempt * 50);
      }
    }
  }
  if (!captured) {
    await markOfapiAttemptIndeterminate(app.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      outcome: "capture_uncommitted",
      responseObservedAt: raw.receivedAt,
      details: {
        error: captureError instanceof Error ? captureError.message : String(captureError),
      },
    }).catch((error) => {
      app.logger.error({ err: error, attemptId: reservation.attemptId },
        "Failed to record uncommitted OFAPI capture");
    });
    throw new ServiceUnavailableError("OFAPI response could not be durably captured");
  }

  const parsed = parseOfapiJsonBytes(raw.bodyBytes);
  if (parsed.creditsUsed !== null) {
    await reconcileOfapiCapturedAttemptCredit(app.db, {
      attemptId: reservation.attemptId,
      actualCredits: parsed.creditsUsed,
      balanceAfter: parsed.balanceAfter,
    });
  }

  const parserOutcome = interactiveParserOutcome(input.operation, raw.status, parsed);
  const completed = await completeOfapiInteractiveRequest(app.db, {
    requestId: owner.id,
    attemptId: reservation.attemptId,
    outcome: parserOutcome === "contract_rejected" ? "failed" : "served",
    parserOutcome,
    errorCode: parserOutcome === "contract_rejected" ? "invalid_response" : null,
  });
  if (!completed || parserOutcome === "contract_rejected") {
    throw new ServiceUnavailableError("OFAPI returned an invalid response");
  }

  return {
    status: raw.status,
    body: parsed.body,
    headers: raw.headers,
  };
}

export interface OfapiInteractiveResponseRecoveryResult {
  scanned: number;
  terminalized: number;
  materialized: number;
  raced: number;
  unavailable: number;
  errors: number;
}

/**
 * Finishes expired capture-first interactive owners from their immutable raw
 * observation. The intentionally narrow app type makes vendor egress
 * structurally unavailable to this recovery path.
 */
export async function recoverExpiredOfapiInteractiveResponses(
  app: Pick<AppContext, "db" | "logger">,
  input?: { now?: Date; limit?: number },
): Promise<OfapiInteractiveResponseRecoveryResult> {
  const now = input?.now ?? new Date();
  const candidates = await listExpiredOfapiInteractiveResponseCaptures(app.db, {
    now,
    ...(input?.limit === undefined ? {} : { limit: input.limit }),
  });
  const result: OfapiInteractiveResponseRecoveryResult = {
    scanned: candidates.length,
    terminalized: 0,
    materialized: 0,
    raced: 0,
    unavailable: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    const observation = await loadOfapiCaptureObservation(app.db, {
      observationId: candidate.observationId,
      observationReceivedAt: candidate.observationReceivedAt,
    });
    if (!observation || observation.attemptId !== candidate.attemptId) {
      result.unavailable += 1;
      continue;
    }
    const captured = capturePayloadResponse(observation.payload);
    const parsed = captured === null
      ? { validJson: false, body: null, creditsUsed: null, balanceAfter: null }
      : parseOfapiJsonBytes(captured.bodyBytes);
    try {
      if (parsed.creditsUsed !== null) {
        await reconcileOfapiCapturedAttemptCredit(app.db, {
          attemptId: candidate.attemptId,
          actualCredits: parsed.creditsUsed,
          balanceAfter: parsed.balanceAfter,
          now,
        });
      }
    } catch (error) {
      result.errors += 1;
      app.logger.error(
        { error, attemptId: candidate.attemptId },
        "Failed to reconcile recovered OFAPI interactive response credits",
      );
      continue;
    }

    try {
      const materialized = await materializeOfapiCaptureObservation(app, observation);
      if (materialized.kind === "materialized") result.materialized += 1;
    } catch (error) {
      // The raw observation remains replayable by the normal materialization
      // sweep; delivery ownership can still be terminalized independently.
      result.errors += 1;
      app.logger.error(
        { error, observationId: observation.id },
        "Recovered OFAPI interactive response materialization remains replayable",
      );
    }

    const parserOutcome = captured === null
      ? "failed"
      : interactiveParserOutcome(candidate.operation, captured.status, parsed);
    const completed = await completeOfapiInteractiveRequest(app.db, {
      requestId: candidate.requestId,
      attemptId: candidate.attemptId,
      outcome: "failed",
      parserOutcome,
      errorCode: "response_delivery_interrupted",
      now,
    });
    if (completed) result.terminalized += 1;
    else result.raced += 1;
  }
  return result;
}
