import {
  assertHttpRequestActive,
  getHttpRequestSignal,
  waitForHttpRequestDelay,
  waitForHttpRequestPermit,
} from "./http-request-scope.ts";

import type {
  HttpRequestEvent,
  HttpRequestFailureKind,
  HttpRequestObserver,
  HttpRequestPagination,
} from "./types.ts";

export interface ObservedRequestSuccess<TResult> {
  kind: "success";
  value: TResult;
  httpStatus: number;
  responseMetadata?: Record<string, unknown>;
}

export interface ObservedRequestRetry {
  kind: "retry";
  httpStatus?: number | null;
  failureKind?: HttpRequestFailureKind | null;
  retryDelayMs: number;
  errorMessage?: string | null;
  responseMetadata?: Record<string, unknown>;
  error?: unknown;
}

export interface ObservedRequestFailure {
  kind: "failed";
  httpStatus?: number | null;
  failureKind?: HttpRequestFailureKind | null;
  errorMessage?: string | null;
  responseMetadata?: Record<string, unknown>;
  error: unknown;
}

export type ObservedRequestOutcome<TResult> =
  | ObservedRequestSuccess<TResult>
  | ObservedRequestRetry
  | ObservedRequestFailure;

type ObservedTransportOutcome = ObservedRequestRetry | ObservedRequestFailure;

export async function executeObservedRequest<TResponse, TResult>(input: {
  observer?: HttpRequestObserver | null;
  requestId: string;
  operation: string;
  endpointTemplate: string;
  method: string;
  pagination?: HttpRequestPagination | null;
  requestMetadata?: Record<string, unknown>;
  retries?: number;
  waitForRateLimit?: () => Promise<number>;
  execute: () => Promise<TResponse>;
  onTransportError: (error: unknown, context: {
    attemptNumber: number;
    retriesRemaining: number;
  }) => ObservedTransportOutcome | Promise<ObservedTransportOutcome>;
  onResponse: (response: TResponse, context: {
    attemptNumber: number;
    retriesRemaining: number;
  }) => ObservedRequestOutcome<TResult> | Promise<ObservedRequestOutcome<TResult>>;
}) {
  const retries = input.retries ?? 3;
  const signal = getHttpRequestSignal();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptNumber = attempt + 1;
    const retriesRemaining = retries - attempt;
    const rateLimitWaitMs = await waitForHttpRequestPermit(async () => (
      await input.waitForRateLimit?.() ?? 0
    ));
    assertHttpRequestActive();
    const startedAt = new Date();

    await emitRequestEvent(input.observer, {
      state: "started",
      requestId: input.requestId,
      operation: input.operation,
      endpointTemplate: input.endpointTemplate,
      method: input.method,
      attemptNumber,
      timestamp: startedAt,
      pagination: input.pagination ?? null,
      requestMetadata: input.requestMetadata,
      rateLimitWaitMs: rateLimitWaitMs > 0 ? rateLimitWaitMs : null,
    });

    let response: TResponse;
    try {
      // Observers may persist admission and yield to a lease heartbeat.
      assertHttpRequestActive();
      response = await input.execute();
    } catch (error) {
      const durationMs = Date.now() - startedAt.getTime();
      const cancelledBeforeDispatch = signal?.aborted && error === signal.reason;
      const outcome: ObservedTransportOutcome = cancelledBeforeDispatch
        ? {
          kind: "failed",
          failureKind: "policy",
          errorMessage: "HTTP request cancelled before dispatch",
          error,
        }
        : await input.onTransportError(error, {
          attemptNumber,
          retriesRemaining: signal?.aborted ? 0 : retriesRemaining,
        });
      const terminalEvent = buildTerminalEvent({
        ...input,
        outcome,
        attemptNumber,
        startedAt,
        durationMs,
        rateLimitWaitMs,
      });
      await emitRequestEvent(input.observer, terminalEvent);
      if (outcome.kind === "retry") {
        await waitForHttpRequestDelay(outcome.retryDelayMs);
        continue;
      }

      throw outcome.error;
    }

    const durationMs = Date.now() - startedAt.getTime();
    let outcome: ObservedRequestOutcome<TResult>;
    try {
      outcome = await input.onResponse(response, {
        attemptNumber,
        retriesRemaining: signal?.aborted ? 0 : retriesRemaining,
      });
    } catch (error) {
      // The request already happened. A decoder/response-policy exception must
      // close its attempt, never enter transport retry or expose response text
      // embedded in the exception through diagnostic metadata.
      outcome = {
        kind: "failed",
        failureKind: "provider",
        errorMessage: "HTTP response processing failed",
        error,
      };
    }
    const terminalEvent = buildTerminalEvent({
      ...input,
      outcome,
      attemptNumber,
      startedAt,
      durationMs,
      rateLimitWaitMs,
    });
    await emitRequestEvent(input.observer, terminalEvent);

    if (outcome.kind === "success") {
      return outcome.value;
    }

    if (outcome.kind === "retry") {
      await waitForHttpRequestDelay(outcome.retryDelayMs);
      continue;
    }

    throw outcome.error;
  }

  throw new Error(`Observed request ${input.operation} exhausted retries`);
}

function buildTerminalEvent<TResult>(input: {
  requestId: string;
  operation: string;
  endpointTemplate: string;
  method: string;
  pagination?: HttpRequestPagination | null;
  requestMetadata?: Record<string, unknown>;
  outcome: ObservedRequestOutcome<TResult>;
  attemptNumber: number;
  startedAt: Date;
  durationMs: number;
  rateLimitWaitMs: number;
}): HttpRequestEvent {
  const base = {
    requestId: input.requestId,
    operation: input.operation,
    endpointTemplate: input.endpointTemplate,
    method: input.method,
    attemptNumber: input.attemptNumber,
    timestamp: new Date(input.startedAt.getTime() + input.durationMs),
    pagination: input.pagination ?? null,
    requestMetadata: input.requestMetadata,
    rateLimitWaitMs: input.rateLimitWaitMs > 0 ? input.rateLimitWaitMs : null,
  };

  if (input.outcome.kind === "success") {
    return {
      ...base,
      state: "success",
      httpStatus: input.outcome.httpStatus,
      durationMs: input.durationMs,
      responseMetadata: input.outcome.responseMetadata,
    };
  }

  if (input.outcome.kind === "retry") {
    return {
      ...base,
      state: "retry",
      httpStatus: input.outcome.httpStatus ?? null,
      failureKind: input.outcome.failureKind ?? null,
      retryDelayMs: input.outcome.retryDelayMs,
      durationMs: input.durationMs,
      responseMetadata: input.outcome.responseMetadata,
      errorMessage: input.outcome.errorMessage ?? null,
    };
  }

  return {
    ...base,
    state: "failed",
    httpStatus: input.outcome.httpStatus ?? null,
    failureKind: input.outcome.failureKind ?? null,
    durationMs: input.durationMs,
    responseMetadata: input.outcome.responseMetadata,
    errorMessage: input.outcome.errorMessage ?? null,
  };
}

async function emitRequestEvent(observer: HttpRequestObserver | null | undefined, event: HttpRequestEvent) {
  await observer?.onRequestEvent(event);
}
