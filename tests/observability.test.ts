import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as dbRepo from "@agency_hub_core/db";

import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";

function mockStdoutWrite(lines: string[]) {
  return vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, cb?: unknown) => {
    lines.push(String(chunk));
    if (typeof cb === "function") {
      cb();
    }
    return true;
  }) as typeof process.stdout.write);
}

describe("sync observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats DB request telemetry persistence as best-effort while keeping stdout tracing alive", async () => {
    const stdoutLines: string[] = [];
    mockStdoutWrite(stdoutLines);

    const logger = {
      warn: vi.fn(),
    };
    const telemetry = new SyncRunTelemetry(
      {
        config: {
          databaseUrl: "",
          encryptionKey: Buffer.alloc(32, 7),
          encryptionKeyVersion: 1,
          logLevel: "silent",
          apiHost: "0.0.0.0",
          apiPort: 3000,
          sessionTtlDays: 30,
          fanslyBaseUrl: "https://example.invalid",
          onlyMonsterBaseUrl: "https://example.invalid",
          syncHttpTraceFile: null,
          fanslyDefaultDelayMs: 2500,
          followerPageDelayMs: 0,
          onlyFansDefaultDelayMs: 1000,
          transactionLookbackDays: 7,
          transactionRescanCapDays: 30,
          syncSharedRateLimitEnabled: false,
          syncPageExecutorConcurrency: 1,
          syncObservabilityRetentionDays: 30,
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
    const telemetry = new SyncRunTelemetry(
      {
        config: {
          databaseUrl: "",
          encryptionKey: Buffer.alloc(32, 7),
          encryptionKeyVersion: 1,
          logLevel: "silent",
          apiHost: "0.0.0.0",
          apiPort: 3000,
          sessionTtlDays: 30,
          fanslyBaseUrl: "https://example.invalid",
          onlyMonsterBaseUrl: "https://example.invalid",
          syncHttpTraceFile: traceFile,
          fanslyDefaultDelayMs: 2500,
          followerPageDelayMs: 0,
          onlyFansDefaultDelayMs: 1000,
          transactionLookbackDays: 7,
          transactionRescanCapDays: 30,
          syncSharedRateLimitEnabled: false,
          syncPageExecutorConcurrency: 1,
          syncObservabilityRetentionDays: 30,
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
});
