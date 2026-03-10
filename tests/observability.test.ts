import { afterEach, describe, expect, it, vi } from "vitest";

import * as dbRepo from "@fansly-connect/db";

import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";

describe("sync observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats telemetry persistence as best-effort", async () => {
    const logger = {
      warn: vi.fn(),
    };
    const telemetry = new SyncRunTelemetry(
      {
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
      },
    );

    vi.spyOn(dbRepo, "insertSyncRequestAttempt").mockRejectedValueOnce(new Error("telemetry down"));
    vi.spyOn(dbRepo, "insertSyncRunEvent").mockResolvedValue({
      id: 1,
    } as never);

    await expect(telemetry.startAttempt({
      logicalRequestId: "account_me:test",
      attemptNumber: 1,
      operation: "account_me",
      requestShape: {},
    })).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalled();
    expect(telemetry.getRequestTotalsSnapshot()).toMatchObject({
      totalAttempts: 1,
      logicalRequests: 1,
    });
  });
});
