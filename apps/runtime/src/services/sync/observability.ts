import { randomUUID } from "node:crypto";

import {
  finishSyncRequestAttempt,
  finishSyncRun,
  insertSyncRequestAttempt,
  insertSyncRunEvent,
} from "@fansly-connect/db";
import type {
  SyncHealth,
  SyncRequestTelemetry,
  SyncTelemetryAttemptFinishInput,
  SyncTelemetryAttemptStartInput,
  SyncTelemetryEventSeverity,
} from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";

type SyncStream = "light" | "followers" | "transactions" | "subscribers" | "cleanup";
type SyncProvider = "fansly" | "onlyfans";

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

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSeverity(severity?: SyncTelemetryEventSeverity) {
  return severity ?? "info";
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

export class SyncRunTelemetry implements SyncRequestTelemetry {
  private readonly operationSummaries = new Map<string, OperationSummary>();
  private readonly anomalies = new Map<string, SyncAnomalyRecord>();
  private readonly notes: string[] = [];
  private readonly telemetryWarnings: string[] = [];
  private readonly logicalRequests = new Set<string>();

  private checkpointBefore: Record<string, CheckpointSummary | null> = {};
  private checkpointAfter: Record<string, CheckpointSummary | null> = {};
  private boundary: Record<string, unknown> | null = null;
  private scan: Record<string, unknown> | null = null;
  private hydration: Record<string, unknown> | null = null;
  private phaseNames: string[] = [];
  private requestAttempts = 0;
  private retryAttempts = 0;
  private failedAttempts = 0;

  constructor(
    private readonly app: Pick<AppContext, "db" | "logger">,
    readonly metadata: {
      runId: number;
      platformAccountId: number;
      pageLabel: string;
      provider: SyncProvider;
      stream: SyncStream;
      trigger: string;
    },
  ) {}

  createLogicalRequestId(operation: string) {
    return `${operation}:${randomUUID()}`;
  }

  async startAttempt(input: SyncTelemetryAttemptStartInput) {
    this.requestAttempts += 1;
    this.logicalRequests.add(input.logicalRequestId);
    const summary = this.operationSummaries.get(input.operation) ?? {
      attempts: 0,
      logicalRequests: 0,
      successes: 0,
      retries: 0,
      failures: 0,
      maxDurationMs: null,
      totalDurationMs: 0,
    };
    summary.attempts += 1;
    if (input.attemptNumber === 1) {
      summary.logicalRequests += 1;
    }
    this.operationSummaries.set(input.operation, summary);

    return this.safeTelemetryOp(
      "insertSyncRequestAttempt",
      async () => {
        const attempt = await insertSyncRequestAttempt(this.app.db, {
          syncRunId: this.metadata.runId,
          platformAccountId: this.metadata.platformAccountId,
          provider: this.metadata.provider,
          stream: this.metadata.stream,
          operation: input.operation,
          logicalRequestId: input.logicalRequestId,
          attemptNumber: input.attemptNumber,
          requestShape: input.requestShape ?? {},
        });
        return attempt.id;
      },
      null,
    );
  }

  async finishAttempt(input: SyncTelemetryAttemptFinishInput) {
    const summary = this.operationSummaries.get(input.operation);
    if (summary) {
      if (input.state === "success") {
        summary.successes += 1;
      } else if (input.state === "retry") {
        summary.retries += 1;
        this.retryAttempts += 1;
      } else if (input.state === "failed") {
        summary.failures += 1;
        this.failedAttempts += 1;
      }
      if (typeof input.durationMs === "number") {
        summary.totalDurationMs += input.durationMs;
        summary.maxDurationMs = summary.maxDurationMs === null
          ? input.durationMs
          : Math.max(summary.maxDurationMs, input.durationMs);
      }
      this.operationSummaries.set(input.operation, summary);
    }

    if (!input.attemptId) {
      return;
    }

    await this.safeTelemetryOp(
      "finishSyncRequestAttempt",
      () => finishSyncRequestAttempt(this.app.db, input.attemptId!, {
        state: input.state,
        failureKind: input.failureKind ?? null,
        httpStatus: input.httpStatus ?? null,
        retryDelayMs: input.retryDelayMs ?? null,
        durationMs: input.durationMs ?? null,
        responseShape: input.responseShape ?? {},
        errorMessage: input.errorMessage ?? null,
      }),
    );
  }

  async recordRunStarted() {
    await this.recordEvent("run_started", "Sync run started", {
      trigger: this.metadata.trigger,
    });
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
    errorSummary?: string | null,
    extraStats?: Record<string, unknown>,
  ) {
    this.applyAutomaticAnomalies(status);
    const stats = this.buildStats(status, errorSummary ?? null, extraStats);
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
        details: {
          status,
          health: stats.health,
          errorSummary: errorSummary ?? null,
        },
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
    errorSummary?: string | null,
    extraStats?: Record<string, unknown>,
  ) {
    const operations = Object.fromEntries(
      Array.from(this.operationSummaries.entries()).map(([operation, summary]) => [
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
        },
      ]),
    );

    return {
      health: this.resolveHealth(status),
      requestTotals: {
        totalAttempts: this.requestAttempts,
        logicalRequests: this.logicalRequests.size,
        retryAttempts: this.retryAttempts,
        failedAttempts: this.failedAttempts,
        byOperation: operations,
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
      errorSummary: errorSummary ?? null,
      ...extraStats,
    } satisfies Record<string, unknown>;
  }

  private applyAutomaticAnomalies(status: "success" | "partial" | "failed" | "skipped") {
    if (status === "partial") {
      if (!this.anomalies.has("partial_stream_failure")) {
        this.anomalies.set("partial_stream_failure", {
          code: "partial_stream_failure",
          severity: "warn",
          message: "One or more sync phases failed while others completed",
        });
      }
    }

    if (this.retryAttempts > 3 && !this.anomalies.has("high_retry_volume")) {
      this.anomalies.set("high_retry_volume", {
        code: "high_retry_volume",
        severity: "warn",
        message: "Run exceeded the retry volume threshold",
        details: {
          retryAttempts: this.retryAttempts,
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
      this.retryAttempts > 0 ||
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

  getRequestTotalsSnapshot() {
    return {
      totalAttempts: this.requestAttempts,
      logicalRequests: this.logicalRequests.size,
      retryAttempts: this.retryAttempts,
      failedAttempts: this.failedAttempts,
    };
  }

  getHydrationSummary() {
    return this.hydration;
  }
}
