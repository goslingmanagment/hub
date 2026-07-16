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

const INTERACTIVE_SCOPE_DAILY_CAP = 250;
const PRINCIPAL_HOURLY_CALL_CAP = 60;
const PRINCIPAL_HOURLY_CREDIT_CAP = 60;
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

function nonNegativeInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function parseCapturedBody(bytes: Buffer) {
  if (bytes.length === 0) {
    return {
      validJson: true,
      body: null as unknown,
      creditsUsed: null as number | null,
      balanceAfter: null as number | null,
    };
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return {
      validJson: false,
      body: text as unknown,
      creditsUsed: null as number | null,
      balanceAfter: null as number | null,
    };
  }
  try {
    const body = JSON.parse(text) as unknown;
    const root = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    const meta = root?._meta && typeof root._meta === "object" && !Array.isArray(root._meta)
      ? root._meta as Record<string, unknown>
      : null;
    const credits = meta?._credits && typeof meta._credits === "object"
        && !Array.isArray(meta._credits)
      ? meta._credits as Record<string, unknown>
      : null;
    return {
      validJson: true,
      body,
      creditsUsed: nonNegativeInteger(credits?.used),
      balanceAfter: nonNegativeInteger(credits?.balance),
    };
  } catch {
    return {
      validJson: false,
      body: text as unknown,
      creditsUsed: null as number | null,
      balanceAfter: null as number | null,
    };
  }
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
  const globalDailyCap = Math.max(1, app.config.ofapiDmDailyCreditBudget ?? 500);
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
    surface: input.surface,
    servingMode: "vendor_only",
    reservedCredits: Math.max(1, Math.trunc(input.fallbackCredits)),
    globalDailyCap,
    scopeDailyCap: Math.min(globalDailyCap, INTERACTIVE_SCOPE_DAILY_CAP),
    creditFloor: Math.max(0, app.config.ofapiCreditFloor ?? 500),
    balanceMaxAgeMs: BALANCE_MAX_AGE_MS,
    allowFloorProbe: true,
    floorProbeCooldownMs: FLOOR_PROBE_COOLDOWN_MS,
    principalCallCap: PRINCIPAL_HOURLY_CALL_CAP,
    principalCreditCap: PRINCIPAL_HOURLY_CREDIT_CAP,
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

  const parsed = parseCapturedBody(raw.bodyBytes);
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
