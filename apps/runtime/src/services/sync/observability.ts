import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  finishSyncRequestAttempt,
  finishSyncRun,
  insertSyncRequestAttempt,
  insertSyncRunEvent,
} from "@agency_hub_core/db";
import type {
  HttpRequestEvent,
  HttpRequestObserver,
  SyncHealth,
  SyncTelemetryEventSeverity,
} from "@agency_hub_core/shared";
import { redactSensitiveText } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  normalizeErrorSummary,
  type NormalizedSyncError,
  type PersistedSyncError,
} from "./errors.ts";

type SyncStream =
  | "light"
  | "followers"
  | "followers_reconcile"
  | "transactions"
  | "top_spenders"
  | "subscribers"
  | "dm_conversations"
  | "dm_messages"
  | "cleanup";
type SyncProvider = "fansly" | "onlyfans";

type RequestTraceWriter = {
  write(record: Record<string, unknown>): Promise<void>;
};

interface RequestTotalsSnapshot {
  totalAttempts: number;
  logicalRequests: number;
  retryAttempts: number;
  failedAttempts: number;
  totalRequestDurationMs: number;
}

export interface SyncAnomalyRecord {
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckpointSummary {
  cursorText?: string | null;
  cursorTimestamp?: string | null;
  lastSuccessfulRunId?: number | null;
  state?: Record<string, unknown>;
}

interface OperationSummary {
  attempts: number;
  logicalRequests: number;
  successes: number;
  retries: number;
  failures: number;
  maxDurationMs: number | null;
  totalDurationMs: number;
}

interface RequestSummaryRecord {
  timestamp: string;
  component: "sync_http_summary";
  provider: SyncProvider;
  runId: number;
  pageLabel: string;
  stream: SyncStream;
  status: "success" | "partial" | "failed" | "skipped";
  totalAttempts: number;
  retryAttempts: number;
  failedAttempts: number;
  totalRequestDurationMs: number;
  totalSyncDurationMs: number;
  byOperation: Record<string, {
    attempts: number;
    retries: number;
    failures: number;
    totalDurationMs: number;
  }>;
}

export interface DmMessagesChunkSummary {
  conversationsProcessed: number;
  messageFetchRequests: number;
  rateLimit429s: number;
  chunkDurationMs: number;
  averageGapMs: number;
}

interface DmMessagesChunkSummaryRecord extends DmMessagesChunkSummary {
  timestamp: string;
  component: "sync_dm_messages_chunk";
  provider: SyncProvider;
  runId: number;
  pageLabel: string;
  stream: "dm_messages";
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function stringifyError(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function normalizeSeverity(severity?: SyncTelemetryEventSeverity) {
  return severity ?? "info";
}

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  );
}

function flattenPagination(event: Pick<HttpRequestEvent, "pagination">) {
  return compactRecord({
    offset: event.pagination?.offset ?? undefined,
    limit: event.pagination?.limit ?? undefined,
    pageIndex: event.pagination?.pageIndex ?? undefined,
    cursorPresent: event.pagination?.cursorPresent ?? undefined,
  });
}

function attemptKey(event: Pick<HttpRequestEvent, "requestId" | "attemptNumber">) {
  return `${event.requestId}:${event.attemptNumber}`;
}

function createStdoutWriter(): RequestTraceWriter {
  let chain = Promise.resolve();

  return {
    write(record) {
      const line = `${JSON.stringify(record)}\n`;
      chain = chain.then(() => new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }));
      return chain;
    },
  };
}

function createFileWriter(filePath: string): RequestTraceWriter {
  let chain: Promise<void> = mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined);

  return {
    write(record) {
      const line = `${JSON.stringify(record)}\n`;
      chain = chain.then(() => appendFile(filePath, line, "utf8"));
      return chain.then(() => undefined);
    },
  };
}

class RequestSummaryCollector implements HttpRequestObserver {
  private readonly operationSummaries = new Map<string, OperationSummary>();
  private readonly logicalRequests = new Set<string>();
  private requestAttempts = 0;
  private retryAttempts = 0;
  private failedAttempts = 0;
  private totalRequestDurationMs = 0;

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.state === "started") {
      this.requestAttempts += 1;
      this.logicalRequests.add(event.requestId);
      const summary = this.operationSummaries.get(event.operation) ?? {
        attempts: 0,
        logicalRequests: 0,
        successes: 0,
        retries: 0,
        failures: 0,
        maxDurationMs: null,
        totalDurationMs: 0,
      };
      summary.attempts += 1;
      if (event.attemptNumber === 1) {
        summary.logicalRequests += 1;
      }
      this.operationSummaries.set(event.operation, summary);
      return;
    }

    const summary = this.operationSummaries.get(event.operation);
    if (!summary) {
      return;
    }

    if (event.state === "success") {
      summary.successes += 1;
    } else if (event.state === "retry") {
      summary.retries += 1;
      this.retryAttempts += 1;
    } else if (event.state === "failed") {
      summary.failures += 1;
      this.failedAttempts += 1;
    }

    summary.totalDurationMs += event.durationMs;
    summary.maxDurationMs = summary.maxDurationMs === null
      ? event.durationMs
      : Math.max(summary.maxDurationMs, event.durationMs);
    this.totalRequestDurationMs += event.durationMs;
    this.operationSummaries.set(event.operation, summary);
  }

  getRequestTotalsSnapshot(): RequestTotalsSnapshot {
    return {
      totalAttempts: this.requestAttempts,
      logicalRequests: this.logicalRequests.size,
      retryAttempts: this.retryAttempts,
      failedAttempts: this.failedAttempts,
      totalRequestDurationMs: this.totalRequestDurationMs,
    };
  }

  getOperationStats() {
    return Array.from(this.operationSummaries.entries()).map(([operation, summary]) => [
      operation,
      {
        attempts: summary.attempts,
        logicalRequests: summary.logicalRequests,
        successes: summary.successes,
        retries: summary.retries,
        failures: summary.failures,
        maxDurationMs: summary.maxDurationMs,
        averageDurationMs: summary.attempts > 0
          ? Math.round(summary.totalDurationMs / summary.attempts)
          : null,
        totalDurationMs: summary.totalDurationMs,
      },
    ]);
  }

  buildSummaryRecord(
    metadata: SyncRunTelemetry["metadata"],
    status: "success" | "partial" | "failed" | "skipped",
    runStartedAt: Date,
    finishedAt: Date,
  ): RequestSummaryRecord {
    const totals = this.getRequestTotalsSnapshot();
    return {
      timestamp: finishedAt.toISOString(),
      component: "sync_http_summary",
      provider: metadata.provider,
      runId: metadata.runId,
      pageLabel: metadata.pageLabel,
      stream: metadata.stream,
      status,
      totalAttempts: totals.totalAttempts,
      retryAttempts: totals.retryAttempts,
      failedAttempts: totals.failedAttempts,
      totalRequestDurationMs: totals.totalRequestDurationMs,
      totalSyncDurationMs: Math.max(0, finishedAt.getTime() - runStartedAt.getTime()),
      byOperation: Object.fromEntries(
        Array.from(this.operationSummaries.entries()).map(([operation, summary]) => [
          operation,
          {
            attempts: summary.attempts,
            retries: summary.retries,
            failures: summary.failures,
            totalDurationMs: summary.totalDurationMs,
          },
        ]),
      ),
    };
  }
}

export function summarizeCheckpoint(
  checkpoint: {
    cursorText?: string | null;
    cursorTimestamp?: Date | null;
    lastSuccessfulRunId?: number | null;
    state?: Record<string, unknown>;
  } | null | undefined,
): CheckpointSummary | null {
  if (!checkpoint) {
    return null;
  }

  return {
    cursorText: checkpoint.cursorText ?? null,
    cursorTimestamp: iso(checkpoint.cursorTimestamp ?? null),
    lastSuccessfulRunId: checkpoint.lastSuccessfulRunId ?? null,
    state: checkpoint.state ?? {},
  };
}

export class SyncRunTelemetry {
  private readonly anomalies = new Map<string, SyncAnomalyRecord>();
  private readonly notes: string[] = [];
  private readonly telemetryWarnings: string[] = [];
  private readonly checkpointBefore: Record<string, CheckpointSummary | null> = {};
  private readonly checkpointAfter: Record<string, CheckpointSummary | null> = {};
  private readonly phaseNames: string[] = [];
  private readonly requestAttemptIds = new Map<string, number>();
  private readonly requestSummaryCollector = new RequestSummaryCollector();
  private readonly requestTraceWriters: RequestTraceWriter[];
  private readonly requestObserver: HttpRequestObserver;
  private readonly runStartedAt: Date;

  private boundary: Record<string, unknown> | null = null;
  private scan: Record<string, unknown> | null = null;
  private hydration: Record<string, unknown> | null = null;

  constructor(
    private readonly app: Pick<AppContext, "config" | "db" | "logger">,
    readonly metadata: {
      runId: number;
      platformAccountId: number;
      pageLabel: string;
      provider: SyncProvider;
      stream: SyncStream;
      trigger: string;
      egressKey: string;
    },
    input?: {
      runStartedAt?: Date | string | null;
    },
  ) {
    this.runStartedAt = normalizeDate(input?.runStartedAt) ?? new Date();
    this.requestTraceWriters = [
      createStdoutWriter(),
      ...(this.app.config.syncHttpTraceFile ? [createFileWriter(this.app.config.syncHttpTraceFile)] : []),
    ];
    this.requestObserver = this.createCompositeRequestObserver();
  }

  getRequestObserver() {
    return this.requestObserver;
  }

  async recordRunStarted() {
    await this.recordEvent("run_started", "Sync run started", {
      trigger: this.metadata.trigger,
    });
  }

  async recordWorkerHeartbeat(emittedAt = new Date()) {
    await this.safeTelemetryOp(
      "worker_heartbeat",
      () => insertSyncRunEvent(this.app.db, {
        syncRunId: this.metadata.runId,
        platformAccountId: this.metadata.platformAccountId,
        provider: this.metadata.provider,
        stream: this.metadata.stream,
        eventType: "worker_heartbeat",
        severity: "info",
        message: "Worker heartbeat",
        details: {},
        emittedAt,
      }),
    );
  }

  async recordPhaseStarted(name: string, details?: Record<string, unknown>) {
    this.phaseNames.push(name);
    await this.recordEvent("phase_started", `Phase started: ${name}`, {
      phase: name,
      ...details,
    });
  }

  async recordCheckpointLoaded(
    label: string,
    checkpoint: CheckpointSummary | null,
  ) {
    this.checkpointBefore[label] = checkpoint;
    await this.recordEvent("checkpoint_loaded", `Loaded ${label} checkpoint`, {
      checkpointLabel: label,
      checkpoint: checkpoint ?? {},
    });
  }

  async recordCheckpointAdvanced(
    label: string,
    checkpoint: CheckpointSummary | null,
  ) {
    this.checkpointAfter[label] = checkpoint;
    await this.recordEvent("checkpoint_advanced", `Advanced ${label} checkpoint`, {
      checkpointLabel: label,
      checkpoint: checkpoint ?? {},
    });
  }

  async addNote(message: string, details?: Record<string, unknown>) {
    this.notes.push(message);
    await this.recordEvent("note", message, details);
  }

  async recordDmMessagesChunkSummary(summary: DmMessagesChunkSummary) {
    if (this.metadata.stream !== "dm_messages") {
      return;
    }

    const record: DmMessagesChunkSummaryRecord = {
      timestamp: new Date().toISOString(),
      component: "sync_dm_messages_chunk",
      provider: this.metadata.provider,
      runId: this.metadata.runId,
      pageLabel: this.metadata.pageLabel,
      stream: "dm_messages",
      ...summary,
    };
    await this.emitTraceRecord(record as unknown as Record<string, unknown>, "sync_dm_messages_chunk");
  }

  async addAnomaly(input: SyncAnomalyRecord) {
    if (!this.anomalies.has(input.code)) {
      this.anomalies.set(input.code, input);
    }

    await this.recordEvent("anomaly", input.message, {
      code: input.code,
      ...input.details,
    }, input.severity === "error" ? "error" : "warn");
  }

  setBoundarySummary(boundary: Record<string, unknown>) {
    this.boundary = {
      ...(this.boundary ?? {}),
      ...boundary,
    };
  }

  setScanSummary(scan: Record<string, unknown>) {
    this.scan = {
      ...(this.scan ?? {}),
      ...scan,
    };
  }

  mergeHydrationSummary(hydration: Record<string, unknown>) {
    const next = {
      ...(this.hydration ?? {}),
    };

    for (const [key, value] of Object.entries(hydration)) {
      if (typeof value === "number" && typeof next[key] === "number") {
        next[key] = (next[key] as number) + value;
      } else {
        next[key] = value;
      }
    }

    this.hydration = next;
  }

  async recordSkipped(reason: string) {
    await this.recordEvent("lock_skipped", reason, {
      code: "lock_skipped",
    }, "warn");
    await this.addAnomaly({
      code: "lock_skipped",
      severity: "warn",
      message: reason,
    });
    return this.finish("skipped", reason);
  }

  async finish(
    status: "success" | "partial" | "failed" | "skipped",
    failure?: string | NormalizedSyncError | null,
    extraStats?: Record<string, unknown>,
  ) {
    this.applyAutomaticAnomalies(status);
    const finishedAt = new Date();
    const normalizedFailure = typeof failure === "string" || !failure
      ? null
      : failure;
    const errorSummary = typeof failure === "string"
      ? normalizeErrorSummary(failure)
      : (failure?.summary ?? null);
    const requestSummary = this.requestSummaryCollector.buildSummaryRecord(
      this.metadata,
      status,
      this.runStartedAt,
      finishedAt,
    );
    await this.emitRequestSummary(requestSummary);
    const stats = this.buildStats(status, normalizedFailure?.error ?? null, extraStats, requestSummary);
    await this.safeTelemetryOp(
      "run_finished_event",
      () => insertSyncRunEvent(this.app.db, {
        syncRunId: this.metadata.runId,
        platformAccountId: this.metadata.platformAccountId,
        provider: this.metadata.provider,
        stream: this.metadata.stream,
        eventType: "run_finished",
        severity: status === "failed" ? "error" : status === "partial" ? "warn" : "info",
        message: `Sync run finished with status ${status}`,
        details: compactRecord({
          status,
          health: stats.health,
          errorSummary: normalizedFailure ? undefined : errorSummary ?? undefined,
          error: normalizedFailure?.error ?? undefined,
        }),
        emittedAt: finishedAt,
      }),
    );
    return finishSyncRun(this.app.db, this.metadata.runId, {
      status,
      stats,
      errorSummary: errorSummary ?? null,
    });
  }

  buildStats(
    status: "success" | "partial" | "failed" | "skipped",
    error?: PersistedSyncError | null,
    extraStats?: Record<string, unknown>,
    requestSummary?: RequestSummaryRecord,
  ) {
    const requestTotals = requestSummary ?? this.requestSummaryCollector.buildSummaryRecord(
      this.metadata,
      status,
      this.runStartedAt,
      new Date(),
    );

    return {
      health: this.resolveHealth(status),
      requestTotals: {
        totalAttempts: requestTotals.totalAttempts,
        logicalRequests: this.requestSummaryCollector.getRequestTotalsSnapshot().logicalRequests,
        retryAttempts: requestTotals.retryAttempts,
        failedAttempts: requestTotals.failedAttempts,
        totalRequestDurationMs: requestTotals.totalRequestDurationMs,
        byOperation: Object.fromEntries(this.requestSummaryCollector.getOperationStats()),
      },
      anomalies: Array.from(this.anomalies.values()),
      notes: this.notes,
      telemetryWarnings: this.telemetryWarnings,
      checkpoint: {
        before: this.checkpointBefore,
        after: this.checkpointAfter,
        advanced: Object.fromEntries(
          Array.from(new Set([
            ...Object.keys(this.checkpointBefore),
            ...Object.keys(this.checkpointAfter),
          ])).map((label) => [
            label,
            JSON.stringify(this.checkpointAfter[label] ?? null) !== JSON.stringify(this.checkpointBefore[label] ?? null),
          ]),
        ),
      },
      boundary: this.boundary,
      scan: this.scan,
      hydration: this.hydration,
      phases: this.phaseNames,
      ...extraStats,
      ...(error ? { error } : {}),
    } satisfies Record<string, unknown>;
  }

  getRequestTotalsSnapshot() {
    return this.requestSummaryCollector.getRequestTotalsSnapshot();
  }

  getHydrationSummary() {
    return this.hydration;
  }

  private createCompositeRequestObserver(): HttpRequestObserver {
    const sinks: Array<{ name: string; observer: HttpRequestObserver }> = [
      {
        name: "request_summary_collector",
        observer: this.requestSummaryCollector,
      },
      {
        name: "sync_request_db",
        observer: this.createDbRequestObserver(),
      },
      ...this.requestTraceWriters.map((writer, index) => ({
        name: index === 0 ? "sync_request_stdout" : `sync_request_file_${index}`,
        observer: this.createTraceObserver(writer),
      })),
    ];

    return {
      onRequestEvent: async (event) => {
        await Promise.all(sinks.map(async ({ name, observer }) => {
          try {
            await observer.onRequestEvent(event);
          } catch (error) {
            this.recordTraceWarning(name, error);
          }
        }));
      },
    };
  }

  private createDbRequestObserver(): HttpRequestObserver {
    return {
      onRequestEvent: async (event) => {
        if (event.state === "started") {
          const createdAttemptId = await this.safeTelemetryOp(
            "insertSyncRequestAttempt",
            async () => {
              const attempt = await insertSyncRequestAttempt(this.app.db, {
                syncRunId: this.metadata.runId,
                platformAccountId: this.metadata.platformAccountId,
                provider: this.metadata.provider,
                stream: this.metadata.stream,
                operation: event.operation,
                logicalRequestId: event.requestId,
                attemptNumber: event.attemptNumber,
                requestShape: this.buildRequestShape(event),
                startedAt: event.timestamp,
              });
              return attempt.id;
            },
            null,
          );
          if (createdAttemptId !== null) {
            this.requestAttemptIds.set(attemptKey(event), createdAttemptId);
          }
          return;
        }

        const createdAttemptId = this.requestAttemptIds.get(attemptKey(event)) ?? null;
        if (createdAttemptId === null) {
          return;
        }

        await this.safeTelemetryOp(
          "finishSyncRequestAttempt",
          () => finishSyncRequestAttempt(this.app.db, createdAttemptId, {
            state: event.state,
            failureKind: event.state === "success" ? null : event.failureKind ?? null,
            httpStatus: "httpStatus" in event ? event.httpStatus ?? null : null,
            retryDelayMs: event.state === "retry" ? event.retryDelayMs : null,
            durationMs: event.durationMs,
            responseShape: "responseMetadata" in event ? event.responseMetadata ?? {} : {},
            errorMessage: event.state === "success" ? null : event.errorMessage ?? null,
            finishedAt: event.timestamp,
          }),
        );

        this.requestAttemptIds.delete(attemptKey(event));
      },
    };
  }

  private createTraceObserver(writer: RequestTraceWriter): HttpRequestObserver {
    return {
      onRequestEvent: async (event) => {
        await writer.write(compactRecord({
          timestamp: event.timestamp.toISOString(),
          component: "sync_http",
          provider: this.metadata.provider,
          runId: this.metadata.runId,
          pageLabel: this.metadata.pageLabel,
          stream: this.metadata.stream,
          requestId: event.requestId,
          operation: event.operation,
          endpointTemplate: event.endpointTemplate,
          method: event.method,
          attemptNumber: event.attemptNumber,
          state: event.state,
          rateLimitWaitMs: event.rateLimitWaitMs ?? undefined,
          httpStatus: "httpStatus" in event ? event.httpStatus ?? undefined : undefined,
          durationMs: "durationMs" in event ? event.durationMs : undefined,
          retryDelayMs: event.state === "retry" ? event.retryDelayMs : undefined,
          failureKind: "failureKind" in event ? event.failureKind ?? undefined : undefined,
          ...flattenPagination(event),
          ...(event.requestMetadata ?? {}),
        }));
      },
    };
  }

  private buildRequestShape(event: HttpRequestEvent) {
    return compactRecord({
      egressKey: this.metadata.egressKey,
      endpointTemplate: event.endpointTemplate,
      method: event.method,
      rateLimitWaitMs: event.rateLimitWaitMs ?? undefined,
      ...flattenPagination(event),
      ...(event.requestMetadata ?? {}),
    });
  }

  private async emitRequestSummary(summary: RequestSummaryRecord) {
    await this.emitTraceRecord(summary as unknown as Record<string, unknown>, "sync_request_summary");
  }

  private async emitTraceRecord(record: Record<string, unknown>, name: string) {
    await Promise.all(this.requestTraceWriters.map(async (writer, index) => {
      try {
        await writer.write(record);
      } catch (error) {
        this.recordTraceWarning(index === 0 ? `${name}_stdout` : `${name}_file_${index}`, error);
      }
    }));
  }

  private recordTraceWarning(name: string, error: unknown) {
    const message = `${name}: ${stringifyError(error)}`;
    this.telemetryWarnings.push(message);
    this.app.logger.warn(
      {
        runId: this.metadata.runId,
        pageLabel: this.metadata.pageLabel,
        stream: this.metadata.stream,
        telemetryOperation: name,
        err: error,
      },
      "Request tracing failed; continuing sync",
    );
  }

  private applyAutomaticAnomalies(status: "success" | "partial" | "failed" | "skipped") {
    if (this.requestSummaryCollector.getRequestTotalsSnapshot().retryAttempts > 3 && !this.anomalies.has("high_retry_volume")) {
      this.anomalies.set("high_retry_volume", {
        code: "high_retry_volume",
        severity: "warn",
        message: "Run exceeded the retry volume threshold",
        details: {
          retryAttempts: this.requestSummaryCollector.getRequestTotalsSnapshot().retryAttempts,
        },
      });
    }
  }

  private resolveHealth(status: "success" | "partial" | "failed" | "skipped"): SyncHealth {
    if (status === "failed") {
      return "failed";
    }

    if (Array.from(this.anomalies.values()).some((anomaly) => anomaly.severity === "error")) {
      return "suspicious";
    }

    if (
      status === "partial" ||
      status === "skipped" ||
      this.requestSummaryCollector.getRequestTotalsSnapshot().retryAttempts > 0 ||
      Array.from(this.anomalies.values()).some((anomaly) => anomaly.severity === "warn")
    ) {
      return "degraded";
    }

    return "healthy";
  }

  private async recordEvent(
    eventType: string,
    message: string,
    details?: Record<string, unknown>,
    severity?: SyncTelemetryEventSeverity,
  ) {
    await this.safeTelemetryOp(
      "insertSyncRunEvent",
      () => insertSyncRunEvent(this.app.db, {
        syncRunId: this.metadata.runId,
        platformAccountId: this.metadata.platformAccountId,
        provider: this.metadata.provider,
        stream: this.metadata.stream,
        eventType,
        severity: normalizeSeverity(severity),
        message,
        details: details ?? {},
      }),
    );
  }

  private async safeTelemetryOp<T>(
    name: string,
    run: () => Promise<T>,
    fallback?: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const message = `${name}: ${stringifyError(error)}`;
      this.telemetryWarnings.push(message);
      this.app.logger.warn(
        {
          runId: this.metadata.runId,
          pageLabel: this.metadata.pageLabel,
          stream: this.metadata.stream,
          telemetryOperation: name,
          err: error,
        },
        "Telemetry write failed; continuing sync",
      );

      if (name !== "insertSyncRunEvent") {
        try {
          await insertSyncRunEvent(this.app.db, {
            syncRunId: this.metadata.runId,
            platformAccountId: this.metadata.platformAccountId,
            provider: this.metadata.provider,
            stream: this.metadata.stream,
            eventType: "telemetry_error",
            severity: "warn",
            message: `Telemetry write failed during ${name}`,
            details: {
              error: message,
            },
          });
        } catch {
          // Ignore recursive telemetry failures.
        }
      }

      return fallback as T;
    }
  }
}
