import { setTimeout as delay } from "node:timers/promises";

import {
  captureOfapiAttemptResponse,
  completeOfapiInteractiveRequest,
  createOfapiInteractiveRequest,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  reconcileOfapiCapturedAttemptCredit,
  releaseOfapiAttemptPreDispatch,
  reserveOfapiRequestAttempt,
  type OfapiHttpOutcome,
} from "@agency_hub_core/db";
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
import { parseOfapiJsonBytes } from "./ofapi-capture-contract.ts";

const DEFAULT_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET = 7_000;
const DEFAULT_MIRROR_PRINCIPAL_DAILY_CALL_CAP = 4_000;
const DEFAULT_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP = 4_000;
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
    app.config.ofapiMirrorGlobalDailyCreditBudget ?? DEFAULT_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET,
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
      app.config.ofapiMirrorPrincipalDailyCallCap ?? DEFAULT_MIRROR_PRINCIPAL_DAILY_CALL_CAP,
    ),
    principalCreditCap: Math.max(
      1,
      app.config.ofapiMirrorPrincipalDailyCreditCap ?? DEFAULT_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP,
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

  const successfulHttp = raw.status >= 200 && raw.status < 300;
  const parserOutcome = parsed.validJson || !successfulHttp
    ? parsed.validJson ? "accepted" as const : "intentional_noop" as const
    : "contract_rejected" as const;
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
