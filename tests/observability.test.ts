import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as dbRepo from "@agency_hub_core/db";
import type { HttpRequestEvent } from "@agency_hub_core/shared";

import { summarizeCheckpoint, SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";

function mockStdoutWrite(lines: string[]) {
  return vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, cb?: unknown) => {
    lines.push(String(chunk));
    if (typeof cb === "function") {
      cb();
    }
    return true;
  }) as typeof process.stdout.write);
}

const STARTED_EVENT: HttpRequestEvent = {
  state: "started",
  requestId: "account_me:test",
  operation: "account_me",
  endpointTemplate: "/account/me",
  method: "GET",
  attemptNumber: 1,
  timestamp: new Date("2026-03-10T12:00:00.000Z"),
  requestMetadata: {},
};

const SUCCESS_EVENT: HttpRequestEvent = {
  state: "success",
  requestId: "account_me:test",
  operation: "account_me",
  endpointTemplate: "/account/me",
  method: "GET",
  attemptNumber: 1,
  timestamp: new Date("2026-03-10T12:00:00.120Z"),
  durationMs: 120,
  httpStatus: 200,
  requestMetadata: {},
  responseMetadata: {
    returnedItems: 1,
  },
};

const RETRY_EVENT: HttpRequestEvent = {
  state: "retry",
  requestId: "account_me:test",
  operation: "account_me",
  endpointTemplate: "/account/me",
  method: "GET",
  attemptNumber: 1,
  timestamp: new Date("2026-03-10T12:00:00.120Z"),
  durationMs: 120,
  httpStatus: 429,
  failureKind: "http",
  retryDelayMs: 2_000,
  errorMessage: "rate limited",
  requestMetadata: {},
};

const FAILED_EVENT: HttpRequestEvent = {
  state: "failed",
  requestId: "account_me:test",
  operation: "account_me",
  endpointTemplate: "/account/me",
  method: "GET",
  attemptNumber: 2,
  timestamp: new Date("2026-03-10T12:00:02.120Z"),
  durationMs: 120,
  httpStatus: 500,
  failureKind: "http",
  errorMessage: "upstream exploded",
  requestMetadata: {},
};

function buildTelemetry(
  overrides: Partial<ConstructorParameters<typeof SyncRunTelemetry>[1]> = {},
  configOverrides: Record<string, unknown> = {},
) {
  return new SyncRunTelemetry(
    {
      config: {
        syncHttpTraceFile: null,
        ...configOverrides,
      },
      db: {} as never,
      logger: {
        warn: vi.fn(),
      } as never,
    } as never,
    {
      runId: 99,
      platformAccountId: 7,
      pageLabel: "lana",
      provider: "fansly",
      stream: "dm_conversations",
      trigger: "worker",
      egressKey: "direct",
      ...overrides,
    },
    {
      runStartedAt: new Date("2026-03-10T12:00:00.000Z"),
    },
  );
}

describe("sync observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a persisted successful attempt off stdout", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);
    vi.spyOn(dbRepo, "insertSyncRequestAttempt").mockResolvedValue({ id: 21 } as never);
    vi.spyOn(dbRepo, "finishSyncRequestAttempt").mockResolvedValue({ id: 21 } as never);
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);

    const requestObserver = buildTelemetry().getRequestObserver();
    await requestObserver.onRequestEvent(STARTED_EVENT);
    await requestObserver.onRequestEvent(SUCCESS_EVENT);

    expect(stdoutLines).toEqual([]);
  });

  it("still traces retried and failed attempts on stdout, with their started line", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);
    vi.spyOn(dbRepo, "insertSyncRequestAttempt").mockResolvedValue({ id: 22 } as never);
    vi.spyOn(dbRepo, "finishSyncRequestAttempt").mockResolvedValue({ id: 22 } as never);
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);

    const requestObserver = buildTelemetry().getRequestObserver();
    await requestObserver.onRequestEvent(STARTED_EVENT);
    await requestObserver.onRequestEvent(RETRY_EVENT);
    await requestObserver.onRequestEvent({ ...STARTED_EVENT, attemptNumber: 2 });
    await requestObserver.onRequestEvent(FAILED_EVENT);

    expect(stdoutLines).toHaveLength(4);
    const states = stdoutLines.map((line) => (JSON.parse(line) as { state: string }).state);
    expect(states).toEqual(["started", "retry", "started", "failed"]);
  });

  it("restores the verbose per-attempt stdout feed when the flag is on", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);
    vi.spyOn(dbRepo, "insertSyncRequestAttempt").mockResolvedValue({ id: 23 } as never);
    vi.spyOn(dbRepo, "finishSyncRequestAttempt").mockResolvedValue({ id: 23 } as never);
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);

    const requestObserver = buildTelemetry({}, { syncHttpAttemptTraceStdout: true }).getRequestObserver();
    await requestObserver.onRequestEvent(STARTED_EVENT);
    await requestObserver.onRequestEvent(SUCCESS_EVENT);

    expect(stdoutLines).toHaveLength(2);
    expect(stdoutLines.join("")).toContain("\"component\":\"sync_http\"");
  });

  it("falls back to stdout when finishing the attempt row fails", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);
    vi.spyOn(dbRepo, "insertSyncRequestAttempt").mockResolvedValue({ id: 24 } as never);
    vi.spyOn(dbRepo, "finishSyncRequestAttempt").mockRejectedValueOnce(new Error("telemetry down"));
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);

    const requestObserver = buildTelemetry().getRequestObserver();
    await requestObserver.onRequestEvent(STARTED_EVENT);
    await requestObserver.onRequestEvent(SUCCESS_EVENT);

    // The DB lost the terminal state of this attempt, so stdout keeps the whole
    // attempt (both lines) instead of silently dropping a success nobody stored.
    expect(stdoutLines).toHaveLength(2);
    const states = stdoutLines.map((line) => (JSON.parse(line) as { state: string }).state);
    expect(states).toEqual(["started", "success"]);
  });

  // Pinned invariant: when the DB write for an attempt fails, stdout must remain the
  // surviving record of that attempt — the default stdout filter must not swallow it.
  it("treats DB request telemetry persistence as best-effort while keeping stdout tracing alive", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);

    const logger = {
      warn: vi.fn(),
    };
    const encryptionKey = Buffer.alloc(32, 7);
    const telemetry = new SyncRunTelemetry(
      {
        config: {
          databaseUrl: "",
          encryptionKey,
          encryptionKeyVersion: 1,
          encryptionKeysByVersion: new Map([[1, encryptionKey]]),
          logLevel: "silent",
          apiHost: "0.0.0.0",
          apiPort: 3000,
          trustProxy: false,
          sessionTtlDays: 30,
          fanslyBaseUrl: "https://example.invalid",
          syncHttpTraceFile: null,
          fanslyDefaultDelayMs: 2500,
          fanslyDmConversationsDelayMs: 5000,
          fanslyDmMessagesDelayMs: 5000,
          followerPageDelayMs: 0,
          onlyFansDefaultDelayMs: 1000,
          transactionLookbackDays: 7,
          transactionRescanCapDays: 30,
          syncSharedRateLimitEnabled: false,
          egressPacerMode: "off" as const,
          lakeDir: "lake",
          syncPageExecutorConcurrency: 1,
          syncObservabilityRetentionDays: 30,
          healthSyncLightMaxAgeMinutes: 180,
          healthSyncFollowerMaxAgeMinutes: 1080,
          healthSyncMonitoringToken: null,
          telegramBotToken: null,
          telegramChatId: null,
          telegramEnabled: false,
          telegramReportHourUtc: 9,
          serviceEgressProxyUrl: null,
          serviceEgressProxyUsername: null,
          serviceEgressProxyPassword: null,
          isProduction: false,
        },
        db: {} as never,
        logger: logger as never,
      },
      {
        runId: 42,
        platformAccountId: 7,
        pageLabel: "lana",
        provider: "fansly",
        stream: "light",
        trigger: "cli",
        egressKey: "direct",
      },
    );

    const insertAttemptSpy = vi
      .spyOn(dbRepo, "insertSyncRequestAttempt")
      .mockRejectedValueOnce(new Error("telemetry down"));
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({
      id: 1,
    } as never);

    const requestObserver = telemetry.getRequestObserver();
    await requestObserver.onRequestEvent({
      state: "started",
      requestId: "account_me:test",
      operation: "account_me",
      endpointTemplate: "/account/me",
      method: "GET",
      attemptNumber: 1,
      timestamp: new Date("2026-03-10T12:00:00.000Z"),
      requestMetadata: {},
    });
    await requestObserver.onRequestEvent({
      state: "success",
      requestId: "account_me:test",
      operation: "account_me",
      endpointTemplate: "/account/me",
      method: "GET",
      attemptNumber: 1,
      timestamp: new Date("2026-03-10T12:00:00.120Z"),
      durationMs: 120,
      httpStatus: 200,
      requestMetadata: {},
      responseMetadata: {
        returnedItems: 1,
      },
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(insertAttemptSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestShape: expect.objectContaining({
        egressKey: "direct",
      }),
    }));
    expect(stdoutLines).toHaveLength(2);
    expect(stdoutLines.join("")).toContain("\"component\":\"sync_http\"");
    // Both lines survive through the persistence-failure fallback: the "started" line
    // is emitted as soon as its insert is known to have failed, the terminal one after.
    expect(stdoutLines.map((line) => (JSON.parse(line) as { state: string }).state)).toEqual([
      "started",
      "success",
    ]);
    expect(telemetry.getRequestTotalsSnapshot()).toMatchObject({
      totalAttempts: 1,
      logicalRequests: 1,
      totalRequestDurationMs: 120,
    });
  });

  it("writes request traces and the final summary to the optional NDJSON file sink", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);

    const traceDir = await mkdtemp(path.join(tmpdir(), "sync-http-trace-"));
    const traceFile = path.join(traceDir, "requests.ndjson");
    const encryptionKey = Buffer.alloc(32, 7);
    const telemetry = new SyncRunTelemetry(
      {
        config: {
          databaseUrl: "",
          encryptionKey,
          encryptionKeyVersion: 1,
          encryptionKeysByVersion: new Map([[1, encryptionKey]]),
          logLevel: "silent",
          apiHost: "0.0.0.0",
          apiPort: 3000,
          trustProxy: false,
          sessionTtlDays: 30,
          fanslyBaseUrl: "https://example.invalid",
          syncHttpTraceFile: traceFile,
          fanslyDefaultDelayMs: 2500,
          fanslyDmConversationsDelayMs: 5000,
          fanslyDmMessagesDelayMs: 5000,
          followerPageDelayMs: 0,
          onlyFansDefaultDelayMs: 1000,
          transactionLookbackDays: 7,
          transactionRescanCapDays: 30,
          syncSharedRateLimitEnabled: false,
          egressPacerMode: "off" as const,
          lakeDir: "lake",
          syncPageExecutorConcurrency: 1,
          syncObservabilityRetentionDays: 30,
          healthSyncLightMaxAgeMinutes: 180,
          healthSyncFollowerMaxAgeMinutes: 1080,
          healthSyncMonitoringToken: null,
          telegramBotToken: null,
          telegramChatId: null,
          telegramEnabled: false,
          telegramReportHourUtc: 9,
          serviceEgressProxyUrl: null,
          serviceEgressProxyUsername: null,
          serviceEgressProxyPassword: null,
          isProduction: false,
        },
        db: {} as never,
        logger: {
          warn: vi.fn(),
        } as never,
      },
      {
        runId: 73,
        platformAccountId: 9,
        pageLabel: "lora1",
        provider: "onlyfans",
        stream: "dm_messages",
        trigger: "worker",
        egressKey: "shared-proxy",
      },
      {
        runStartedAt: new Date("2026-03-10T12:00:00.000Z"),
      },
    );

    const insertAttemptSpy = vi.spyOn(dbRepo, "insertSyncRequestAttempt").mockResolvedValue({ id: 11 } as never);
    vi.spyOn(dbRepo, "finishSyncRequestAttempt").mockResolvedValue({ id: 11 } as never);
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 12 } as never);
    vi.spyOn(dbRepo, "finishSyncRun").mockResolvedValue({ id: 73 } as never);

    const requestObserver = telemetry.getRequestObserver();
    await requestObserver.onRequestEvent({
      state: "started",
      requestId: "onlymonster_transactions:test",
      operation: "onlymonster_transactions",
      endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/transactions",
      method: "GET",
      attemptNumber: 1,
      timestamp: new Date("2026-03-10T12:00:01.000Z"),
      pagination: {
        pageIndex: 0,
        cursorPresent: false,
      },
      requestMetadata: {
        cursorPresent: false,
        limit: 100,
      },
    });
    await requestObserver.onRequestEvent({
      state: "success",
      requestId: "onlymonster_transactions:test",
      operation: "onlymonster_transactions",
      endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/transactions",
      method: "GET",
      attemptNumber: 1,
      timestamp: new Date("2026-03-10T12:00:01.250Z"),
      durationMs: 250,
      httpStatus: 200,
      pagination: {
        pageIndex: 0,
        cursorPresent: false,
      },
      requestMetadata: {
        cursorPresent: false,
        limit: 100,
      },
      responseMetadata: {
        returnedItems: 2,
        cursorPresent: true,
      },
    });

    await telemetry.recordDmMessagesChunkSummary({
      conversationsProcessed: 2,
      messageFetchRequests: 3,
      rateLimit429s: 1,
      chunkDurationMs: 7_500,
      averageGapMs: 3_750,
    });
    await telemetry.finish("success", null, {});

    expect(insertAttemptSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestShape: expect.objectContaining({
        egressKey: "shared-proxy",
      }),
    }));
    const fileContents = await readFile(traceFile, "utf8");
    expect(fileContents).toContain("\"component\":\"sync_http\"");
    expect(fileContents).toContain("\"component\":\"sync_http_summary\"");
    expect(fileContents).toContain("\"component\":\"sync_dm_messages_chunk\"");
    expect(fileContents).toContain("\"pageIndex\":0");
    expect(fileContents).toContain("\"cursorPresent\":false");
    expect(fileContents).not.toContain("x-om-auth-token");
    expect(fileContents).not.toContain("shared-proxy");

    await rm(traceDir, { recursive: true, force: true });
  });

  it("records clean partial continuation finishes as info instead of warning noise", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);
    const insertEventSpy = vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);
    vi.spyOn(dbRepo, "finishSyncRun").mockResolvedValue({ id: 99 } as never);

    const telemetry = buildTelemetry();
    await telemetry.finish("partial", null, {
      yieldReason: "request_budget",
      chunkBudget: {
        requestCount: 5,
        elapsedMs: 12_000,
      },
    });

    const runFinished = insertEventSpy.mock.calls.find(([, input]) => input.eventType === "run_finished");
    expect(runFinished?.[1]).toMatchObject({
      eventType: "run_finished",
      severity: "info",
      details: {
        status: "partial",
        health: "degraded",
        yieldReason: "request_budget",
      },
    });
  });

  it("keeps partial finishes warning-level when the run has warning anomalies", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);
    const insertEventSpy = vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);
    vi.spyOn(dbRepo, "finishSyncRun").mockResolvedValue({ id: 99 } as never);

    const telemetry = buildTelemetry();
    await telemetry.addAnomaly({
      code: "high_retry_volume",
      severity: "warn",
      message: "Run exceeded the retry volume threshold",
      details: {
        retryAttempts: 4,
      },
    });
    await telemetry.finish("partial", null, {
      yieldReason: "request_budget",
    });

    const runFinished = insertEventSpy.mock.calls.find(([, input]) => input.eventType === "run_finished");
    expect(runFinished?.[1]).toMatchObject({
      eventType: "run_finished",
      severity: "warn",
      details: {
        status: "partial",
        health: "degraded",
        yieldReason: "request_budget",
      },
    });
  });

  it("projects unbounded checkpoint state to bounded scalars", () => {
    const summary = summarizeCheckpoint({
      cursorText: "cursor-9",
      cursorTimestamp: new Date("2026-03-10T12:00:00.000Z"),
      lastSuccessfulRunId: 41,
      state: {
        // The cumulative array that made telemetry grow O(N²) per sweep.
        snapshotConversationIds: Array.from({ length: 10_000 }, (_, index) => `conv-${index}`),
        currentConversationId: "conv-9999",
        pagesProcessed: 12,
        bootstrapComplete: false,
        lastError: null,
        pendingByStream: { dm: 1, tips: 2, posts: 3 },
      },
    });

    expect(summary?.cursorText).toBe("cursor-9");
    expect(summary?.cursorTimestamp).toBe("2026-03-10T12:00:00.000Z");
    expect(summary?.lastSuccessfulRunId).toBe(41);
    expect(summary?.stateScalars).toEqual({
      snapshotConversationIdsCount: 10_000,
      currentConversationId: "conv-9999",
      pagesProcessed: 12,
      bootstrapComplete: false,
      lastError: null,
      pendingByStreamKeys: 3,
    });
    // No copy of the array survives anywhere in the emitted summary.
    const encoded = JSON.stringify(summary);
    expect(encoded).not.toContain("conv-0");
    expect(encoded.length).toBeLessThan(1024);
  });

  it("truncates long checkpoint state strings at 120 characters", () => {
    const summary = summarizeCheckpoint({
      state: {
        resumeToken: "x".repeat(500),
        shortToken: "y".repeat(120),
      },
    });

    const resumeToken = summary?.stateScalars?.resumeToken as string;
    expect(resumeToken).toBe(`${"x".repeat(120)}…`);
    expect(resumeToken.length).toBe(121);
    expect(summary?.stateScalars?.shortToken).toBe("y".repeat(120));
  });

  it("caps the checkpoint state projection at 32 keys", () => {
    const state = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`key${index}`, index]),
    );

    const scalars = summarizeCheckpoint({ state })?.stateScalars ?? {};
    expect(Object.keys(scalars)).toHaveLength(32);
    expect(scalars.key0).toBe(0);
    expect(scalars.key31).toBe(31);
    expect(scalars.key32).toBeUndefined();
  });

  it("reports a progress-only checkpoint write as advanced", async () => {
    mockStdoutWrite([]);
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);

    const telemetry = buildTelemetry();
    // upsertCheckpointProgress (touchSuccessMetadata: false) moves neither the
    // cursor nor lastSuccessfulRunId, and the projected state scalars can be
    // identical too — only the write itself proves the sweep moved.
    const identical = {
      cursorText: null,
      cursorTimestamp: null,
      lastSuccessfulRunId: 7,
      state: { snapshotConversationIds: ["a", "b"] },
    };
    await telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint(identical));
    await telemetry.recordCheckpointAdvanced("dm_conversations", summarizeCheckpoint(identical));

    const stats = telemetry.buildStats("partial");
    expect(JSON.stringify(stats.checkpoint.after)).toEqual(JSON.stringify(stats.checkpoint.before));
    expect(stats.checkpoint.advanced.dm_conversations).toBe(true);
  });

  it("keeps the pre-G1 diff semantics for a loaded-but-never-advanced checkpoint", async () => {
    mockStdoutWrite([]);
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({ id: 1 } as never);

    const telemetry = buildTelemetry();
    await telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint({
      cursorText: "cursor-1",
      state: { pagesProcessed: 3 },
    }));

    // Parity with the original before/after JSON diff: a label that was loaded
    // but never advanced diffs against the absent after-summary and reads as
    // advanced=true. Some handlers persist checkpoints without calling
    // recordCheckpointAdvanced, so the diff leg keeps them truthful — changing
    // this reading is out of scope for the telemetry-size change.
    const stats = telemetry.buildStats("success");
    expect(stats.checkpoint.advanced.dm_conversations).toBe(true);
  });
});
