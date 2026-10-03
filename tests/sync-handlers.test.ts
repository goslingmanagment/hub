import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as FanHydrationWritersModule from "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts";

const dbMocks = vi.hoisted(() => ({
  // The transactions executor now resolves live effective config (one read per
  // chunk); these chunk tests use a bare db so stub it to "no overrides".
  getConfigOverrides: vi.fn(async () => new Map()),
  getCheckpoint: vi.fn(),
  requestPageSync: vi.fn(),
  updatePageSyncTimestampCache: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
}));


// The capture trims and their capture-shape versions are pure helpers
// (apps/runtime/src/sync/fansly/lib/) and run for real.
const sharedMocks = vi.hoisted(() => ({
  persistRawPayload: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  upsertHydratedFansForPage: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/sync/fansly/lib/fan-hydration.ts", async () => {
  const actual = await vi.importActual<typeof FanHydrationWritersModule>(
    "../apps/runtime/src/sync/fansly/lib/fan-hydration.ts",
  );
  return {
    ...actual,
    upsertHydratedFansForPage: fanHydrationMocks.upsertHydratedFansForPage,
  };
});

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
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    sharedMocks.persistRawPayload.mockReset();
    fanHydrationMocks.upsertHydratedFansForPage.mockReset();

    dbMocks.upsertCheckpointProgress.mockResolvedValue({});
    dbMocks.upsertCheckpoint.mockResolvedValue({});
    dbMocks.updatePageSyncTimestampCache.mockResolvedValue(undefined);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockResolvedValue([]);
    sharedMocks.persistRawPayload.mockResolvedValue({
      id: 444,
      capturedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockImplementation(async (
      db: object,
      input: {
        platformAccountId: number;
        accounts: Array<{
          id: string;
          username: string | null;
          displayName: string | null;
          createdAt?: number | null;
        }>;
        fallbackIds?: string[];
        unverifiedIds?: string[];
      },
    ) => {
      const fans: Array<{ id: number; platformUserId: string }> = await dbMocks.upsertFans(db, [
        ...input.accounts.map((account: {
          id: string;
          username: string | null;
          displayName: string | null;
          createdAt?: number | null;
        }) => ({
          platform: "fansly" as const,
          platformUserId: account.id,
          username: account.username,
          displayName: account.displayName,
          createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
          metadata: {},
        })),
        ...(input.fallbackIds ?? []).map((platformUserId: string) => ({
          platform: "fansly" as const,
          platformUserId,
          metadata: {},
        })),
        ...(input.unverifiedIds ?? []).map((platformUserId: string) => ({
          platform: "fansly" as const,
          platformUserId,
        })),
      ]);

      if (fans.length > 0) {
        await dbMocks.upsertFanPages(db, fans.map((fan: { id: number; platformUserId: string }) => ({
          fanId: fan.id,
          platformAccountId: input.platformAccountId,
        })));
      }

      return new Map(fans.map((fan: { id: number; platformUserId: string }) => [fan.platformUserId, fan.id] as const));
    });
  });

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
