import { describe, expect, it, vi } from "vitest";

import {
  executeStreamChunk,
  onlyfansTransactionsChunk,
} from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";

function createTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
}

describe("sync executor handlers", () => {
  it("rejects the retired history stream before registry dispatch", async () => {
    const telemetry = createTelemetry();
    await expect(executeStreamChunk({
      db: {},
      config: {
        onlyFansDmPollingEnabled: false,
      },
    } as never, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 55,
          label: "onlyfans-page",
          platformAccountId: "of-55",
          metadata: {},
        },
        auth: { token: "secret" },
        proxy: null,
      },
      streamState: {
        stream: "dm_messages",
      },
      syncRunId: 910,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow(/Unsupported executor stream "dm_messages"/);
    expect(telemetry.addNote).not.toHaveBeenCalled();
  });

  it("records OnlyFans transaction pulls as skips (webhook-sourced since Stage 18)", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
    } as never;

    const result = await onlyfansTransactionsChunk(app, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 99,
          label: "onlyfans-page",
          platformAccountId: "of-99",
          metadata: {},
          commissionRate: 0.2,
        },
        auth: { token: "" },
        proxy: null,
      },
      streamState: {
        requestSeq: 7,
        requestPayload: null,
      },
      syncRunId: 200,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    // The stream completes without egress: OF transaction truth arrives via
    // the Stage 13 webhook writer gate, never a pull walker.
    expect(result.satisfied).toBe(true);
    expect(result.yieldReason).toBe(null);
    expect(result.stats).toMatchObject({ skipped: "onlyfans_transactions_webhook_sourced" });
  });
});
