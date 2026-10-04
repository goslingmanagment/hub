import {
  upsertCheckpoint,
  upsertCheckpointProgress,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
  type Database,
  type SyncStream,
} from "@agency_hub_core/db";
import { FanslyApiError, type FanslyRequestContext } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import { fanslyUtcDayKey, writeFanslyLaneCoverage } from "../../sync/fansly/lib/lane.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { persistRawPayload } from "./shared.ts";

type PersistRawPayloadOptions = NonNullable<Parameters<typeof persistRawPayload>[2]>;

export interface FanslyDailyAttemptState {
  utcDay: string;
  callsToday: number;
}

/** Reset only the daily attempt allowance; every lane-specific cursor survives. */
export function rollFanslyUtcDay<TState extends FanslyDailyAttemptState>(
  state: TState,
  now: Date,
): TState {
  const today = fanslyUtcDayKey(now);
  return state.utcDay === today
    ? state
    : { ...state, utcDay: today, callsToday: 0 };
}

export function nextFanslyUtcDayStart(now: Date): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    5,
  ));
}

export function spreadFanslyContinuation(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  const jitter = 1 + (random() * 2 - 1) * 0.3;
  return new Date(now.getTime() + Math.max(0, Math.round(delayMs * jitter)));
}

export function isRepeatedRequest<T>(previous: T | null, next: T): boolean {
  return previous !== null && Object.is(previous, next);
}

type ProgressInput<TState> = {
  db: Database;
  pageId: number;
  stream: SyncStream;
  cursorText: string | null;
  cursorTimestamp?: Date | null;
  state: TState;
  telemetry: Pick<SyncRunTelemetry, "recordCheckpointAdvanced">;
};

export async function saveFanslyLaneProgress<TState>(input: ProgressInput<TState>) {
  const advanced = await upsertCheckpointProgress(input.db, {
    platformAccountId: input.pageId,
    stream: input.stream,
    cursorText: input.cursorText,
    ...(input.cursorTimestamp === undefined
      ? {}
      : { cursorTimestamp: input.cursorTimestamp }),
    state: { ...input.state } as Record<string, unknown>,
  });
  await input.telemetry.recordCheckpointAdvanced(
    input.stream,
    summarizeCheckpoint(advanced),
  );
  return advanced;
}

export async function completeFanslyLane<TState>(
  input: ProgressInput<TState> & { syncRunId: number },
) {
  const completed = await upsertCheckpoint(input.db, {
    platformAccountId: input.pageId,
    stream: input.stream,
    cursorText: input.cursorText,
    ...(input.cursorTimestamp === undefined
      ? {}
      : { cursorTimestamp: input.cursorTimestamp }),
    state: { ...input.state } as Record<string, unknown>,
    lastSuccessfulRunId: input.syncRunId,
  });
  await input.telemetry.recordCheckpointAdvanced(
    input.stream,
    summarizeCheckpoint(completed),
  );
  return completed;
}

export function createFanslyLaneRuntime<TState extends FanslyDailyAttemptState>(input: {
  db: Database;
  pageId: number;
  stream: SyncStream;
  cursorText: () => string | null;
  dailyCap: number;
  telemetry: Pick<SyncRunTelemetry, "recordCheckpointAdvanced">;
  downstreamObserver?: HttpRequestObserver | null;
  getState: () => TState;
  setState: (state: TState) => void;
  session: FanslyRequestContext["session"];
  proxy: FanslyRequestContext["proxy"];
  egressKey: FanslyRequestContext["egressKey"];
  sendGuard: FanslyRequestContext["sendGuard"];
}) {
  const saveProgress = () => saveFanslyLaneProgress({
    db: input.db,
    pageId: input.pageId,
    stream: input.stream,
    cursorText: input.cursorText(),
    state: input.getState(),
    telemetry: input.telemetry,
  });
  const attemptBudget = createDurableFanslyAttemptBudget({
    dailyCap: input.dailyCap,
    ...(input.downstreamObserver === undefined
      ? {}
      : { downstreamObserver: input.downstreamObserver }),
    getState: input.getState,
    setState: input.setState,
    saveProgress,
  });
  const requestContextFor = (
    budget: Pick<typeof attemptBudget, "observer" | "remainingAttempts">,
  ): FanslyRequestContext => ({
    session: input.session,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
    ...(input.egressKey === undefined ? {} : { egressKey: input.egressKey }),
    requestObserver: budget.observer,
    remainingAttempts: budget.remainingAttempts,
    sendGuard: input.sendGuard,
  });
  const requestContext = requestContextFor(attemptBudget);
  /** Requests that leave `attempts` of the day's allowance to a later one:
   *  neither their retries nor any physical attempt of theirs can spend it. */
  const holdingBack = (attempts: number) => {
    const budget = attemptBudget.holdingBack(attempts);
    return { hasCapacity: budget.hasCapacity, requestContext: requestContextFor(budget) };
  };
  const complete = (syncRunId: number, cursorTimestamp?: Date | null) => completeFanslyLane({
    db: input.db,
    pageId: input.pageId,
    stream: input.stream,
    cursorText: input.cursorText(),
    ...(cursorTimestamp === undefined ? {} : { cursorTimestamp }),
    state: input.getState(),
    telemetry: input.telemetry,
    syncRunId,
  });
  return { attemptBudget, complete, holdingBack, requestContext, saveProgress };
}

/**
 * Persist the attempt reservation before the adapter is allowed to send.
 * The adapter consults `remainingAttempts` once per logical request, so its
 * retry count can never exceed the durable allowance left for the UTC day.
 *
 * `holdingBack(n)` is the same allowance with the day's last `n` attempts kept
 * for a later request: a retry is an attempt like any other, so a check before
 * the request is not enough — the allowance the adapter reads and the
 * admission of every attempt both stop short of the held ones.
 */
export function createDurableFanslyAttemptBudget<TState extends FanslyDailyAttemptState>(input: {
  dailyCap: number;
  downstreamObserver?: HttpRequestObserver | null;
  getState: () => TState;
  setState: (state: TState) => void;
  saveProgress: () => Promise<unknown>;
}) {
  const holdingBack = (held: number) => {
    const allowance = input.dailyCap - held;
    const remainingAttempts = () => Math.max(0, allowance - input.getState().callsToday);

    const observer: HttpRequestObserver = {
      async onRequestEvent(event: HttpRequestEvent) {
        if (event.state === "started") {
          const state = input.getState();
          // A caller checks capacity before starting a logical request. This is
          // a defensive refusal for a stale/custom adapter that ignores the
          // retry allowance; no physical request has happened at this point.
          if (state.callsToday >= allowance) {
            throw new FanslyDailyAttemptBudgetExhaustedError(allowance);
          }
          input.setState({ ...state, callsToday: state.callsToday + 1 });
          await input.saveProgress();
        }
        await input.downstreamObserver?.onRequestEvent(event);
      },
    };

    return {
      observer,
      remainingAttempts,
      hasCapacity: (count = 1) => remainingAttempts() >= count,
    };
  };

  return { ...holdingBack(0), holdingBack };
}

export class FanslyDailyAttemptBudgetExhaustedError extends Error {
  constructor(readonly dailyCap: number) {
    super(`Fansly daily attempt budget exhausted at ${dailyCap}`);
    this.name = "FanslyDailyAttemptBudgetExhaustedError";
  }
}

/**
 * Is this failure about ONE subject (a media item, a post) rather than about
 * the page?
 *
 * A per-subject lane isolates a subject's failure so one unreachable item
 * cannot wedge a queue of thousands. Only an answer the provider gave ABOUT
 * THE REQUEST qualifies: an addressed 4xx (404/410/400…), a 200 envelope with
 * `success: false`, or a 5xx without a `Retry-After` — the production shape of
 * a gone item (`error getting media offer`).
 *
 * Everything else is about the page and belongs to the executor, untouched:
 * a dead session (401/403 → auth pause), the provider's pace (any 429, or a
 * 5xx naming its own deadline → `retry_at` from `retryAfterAt`, Decision
 * #275), a transport, proxy or timeout failure with no status at all
 * (transient_network ladder), a missing proxy (blocker), a lost lease, and
 * every local error. Counted against the subject, those discarded the
 * provider's deadline, walked on to the next subject into the same wall, and
 * pushed each subject a day out for an outage that was never theirs (prod: a
 * dead page proxy, `Socks5 proxy rejected connection`, marked 75 media failed
 * in under an hour).
 *
 * A 4xx that happens to carry a `Retry-After` stays scoped: the executor reads
 * no deadline for it and would park the whole stream as provider_bad_data.
 * The cost of the split: a subject whose request DETERMINISTICALLY times out
 * is no longer skipped — the stream retries it on the executor ladder, with an
 * incident, instead.
 */
export function isSubjectScopedFanslyFailure(error: unknown): boolean {
  if (!(error instanceof FanslyApiError) || typeof error.status !== "number") {
    return false;
  }
  if (error.status === 401 || error.status === 403 || error.status === 429) {
    return false;
  }
  return !(error.status >= 500 && error.retryAfterAt !== null);
}

export class FanslyLaneInvalidResponseError extends Error {
  constructor(readonly observationKind: string) {
    super(`Fansly ${observationKind} response is invalid; journal retained and progress withheld`);
    this.name = "FanslyLaneInvalidResponseError";
  }
}

export async function journalFanslyLaneResponse(input: {
  db: Database;
  row: Parameters<typeof persistRawPayload>[1];
  options: PersistRawPayloadOptions;
}) {
  return persistRawPayload(input.db, input.row, input.options);
}

export function createFanslyLaneJournal(input: {
  db: Database;
  pageId: number;
  syncRunId: number;
  mapperVersion: string;
  payloadKind: Parameters<typeof persistRawPayload>[1]["payloadKind"];
  retainUntil: Date;
  onJournal?: () => void;
}) {
  return async (
    endpoint: string,
    requestParams: Record<string, unknown>,
    responsePayload: unknown,
    extra: {
      action?: string;
      observationPayload?: unknown;
      row?: Partial<Parameters<typeof persistRawPayload>[1]>;
    } = {},
  ) => {
    const result = await journalFanslyLaneResponse({
      db: input.db,
      row: {
        platformAccountId: input.pageId,
        syncRunId: input.syncRunId,
        endpoint,
        requestParams,
        responsePayload,
        mapperVersion: input.mapperVersion,
        payloadKind: input.payloadKind,
        retainUntil: input.retainUntil,
        ...extra.row,
      },
      options: {
        action: extra.action ?? `inserting Fansly ${endpoint} raw payload`,
        platform: "fansly",
        ...(extra.observationPayload === undefined
          ? {}
          : { observationPayload: extra.observationPayload }),
      },
    });
    input.onJournal?.();
    return result;
  };
}

type FanslyLaneCoverageExtra = {
  acquisitionMode?: "forward_only" | "retroactive";
  scopeRef?: string;
  proofObservationId?: number | null;
  oldestCapturedAt?: Date | null;
  newestCapturedAt?: Date | null;
  replaceWindowBounds?: boolean;
  observedUniqueCount?: number | null;
  expectedCount?: number | null;
  reasonCode?: string | null;
  cursor?: Record<string, unknown>;
};

/** With `plane` fixed, `key` is the scope; otherwise `key` is the plane. */
export function createFanslyLaneCoverageWriter(input: {
  db: Database;
  pageId: number;
  plane?: string;
  scopeRef?: string;
  acquisitionMode: "forward_only" | "retroactive";
  newestCapturedAt?: Date | null;
}) {
  return async (
    key: string,
    status: CaptureCoverageStatus,
    proof: CaptureCoverageProof,
    extra: FanslyLaneCoverageExtra = {},
  ) => {
    const { acquisitionMode, scopeRef, ...rest } = extra;
    return writeFanslyLaneCoverage({
      db: input.db,
      pageId: input.pageId,
      plane: input.plane ?? key,
      scopeRef: scopeRef ?? (input.plane === undefined ? input.scopeRef ?? "" : key),
      status,
      acquisitionMode: acquisitionMode ?? input.acquisitionMode,
      proof,
      ...(input.newestCapturedAt === undefined
        ? {}
        : { newestCapturedAt: input.newestCapturedAt }),
      ...rest,
    });
  };
}
