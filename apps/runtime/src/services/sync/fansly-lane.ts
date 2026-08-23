import {
  upsertCaptureCoverage,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
  type Database,
  type SyncStream,
} from "@agency_hub_core/db";
import type { FanslyRequestContext } from "@agency_hub_core/fansly";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { SyncRunTelemetry } from "./observability.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { persistRawPayload } from "./shared.ts";

type PersistRawPayloadOptions = NonNullable<Parameters<typeof persistRawPayload>[2]>;

export interface FanslyDailyAttemptState {
  utcDay: string;
  callsToday: number;
}

export type FanslyResponseClass = "nonempty" | "empty" | "invalid";

export function classifyFanslyResponse(
  payload: unknown,
  classifier: {
    isValid: (value: unknown) => boolean;
    isEmpty: (value: unknown) => boolean;
  },
): FanslyResponseClass {
  if (!classifier.isValid(payload)) {
    return "invalid";
  }
  return classifier.isEmpty(payload) ? "empty" : "nonempty";
}

export function fanslyUtcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
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

export function advanceOffsetPage(input: {
  offset: number;
  pageSize: number;
  rowCount: number;
}): { done: boolean; nextOffset: number } {
  return {
    done: input.rowCount < input.pageSize,
    nextOffset: input.offset + input.pageSize,
  };
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
  rateLimitWaiter: FanslyRequestContext["rateLimitWaiter"];
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
  const requestContext: FanslyRequestContext = {
    session: input.session,
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
    ...(input.egressKey === undefined ? {} : { egressKey: input.egressKey }),
    requestObserver: attemptBudget.observer,
    remainingAttempts: attemptBudget.remainingAttempts,
    ...(input.rateLimitWaiter === undefined
      ? {}
      : { rateLimitWaiter: input.rateLimitWaiter }),
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
  return { attemptBudget, complete, requestContext, saveProgress };
}

/**
 * Persist the attempt reservation before the adapter is allowed to send.
 * The adapter consults `remainingAttempts` once per logical request, so its
 * retry count can never exceed the durable allowance left for the UTC day.
 */
export function createDurableFanslyAttemptBudget<TState extends FanslyDailyAttemptState>(input: {
  dailyCap: number;
  downstreamObserver?: HttpRequestObserver | null;
  getState: () => TState;
  setState: (state: TState) => void;
  saveProgress: () => Promise<unknown>;
}) {
  const remainingAttempts = () => Math.max(0, input.dailyCap - input.getState().callsToday);

  const observer: HttpRequestObserver = {
    async onRequestEvent(event: HttpRequestEvent) {
      if (event.state === "started") {
        const state = input.getState();
        // A caller checks capacity before starting a logical request. This is
        // a defensive refusal for a stale/custom adapter that ignores the
        // retry allowance; no physical request has happened at this point.
        if (state.callsToday >= input.dailyCap) {
          throw new FanslyDailyAttemptBudgetExhaustedError(input.dailyCap);
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
}

export class FanslyDailyAttemptBudgetExhaustedError extends Error {
  constructor(readonly dailyCap: number) {
    super(`Fansly daily attempt budget exhausted at ${dailyCap}`);
    this.name = "FanslyDailyAttemptBudgetExhaustedError";
  }
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

export async function writeFanslyLaneCoverage(input: {
  db: Database;
  pageId: number;
  plane: string;
  scopeRef: string;
  status: CaptureCoverageStatus;
  acquisitionMode: "forward_only" | "retroactive";
  proof: CaptureCoverageProof;
  proofObservationId?: number | null;
  oldestCapturedAt?: Date | null;
  newestCapturedAt?: Date | null;
  observedUniqueCount?: number | null;
  expectedCount?: number | null;
  reasonCode?: string | null;
  cursor?: Record<string, unknown>;
}) {
  const { db, ...coverage } = input;
  return upsertCaptureCoverage(db, {
    ...coverage,
    platform: "fansly",
  });
}

type FanslyLaneCoverageExtra = {
  acquisitionMode?: "forward_only" | "retroactive";
  scopeRef?: string;
  proofObservationId?: number | null;
  oldestCapturedAt?: Date | null;
  newestCapturedAt?: Date | null;
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
