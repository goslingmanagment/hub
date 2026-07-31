import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  listFanslyPages: vi.fn(),
  reconcileFanslyBulkStreamGate: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});

vi.mock("../apps/runtime/src/services/effective-config.ts", () => configMocks);

import { reconcileFanslyBulkStreamScheduling } from
  "../apps/runtime/src/services/sync/fansly-stream-scheduling.ts";

describe("Fansly bulk-stream scheduling", () => {
  beforeEach(() => {
    dbMocks.listFanslyPages.mockReset();
    dbMocks.reconcileFanslyBulkStreamGate.mockReset();
    configMocks.loadEffectiveConfig.mockReset();

    dbMocks.listFanslyPages.mockResolvedValue([
      { id: 11, label: "lora-1" },
      { id: 12, label: "other-page" },
    ]);
    dbMocks.reconcileFanslyBulkStreamGate
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "paused", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "paused", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "resumed", createdRecoveryGeneration: true });
    configMocks.loadEffectiveConfig.mockResolvedValue({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: false,
      fanslyNewStreamPageAllowlist: "lora-1",
    });
  });

  it("uses the live flag and allowlist for every Fansly page and stream", async () => {
    const now = new Date("2026-07-31T03:00:00.000Z");
    const app = { db: {}, config: {} } as never;

    await expect(reconcileFanslyBulkStreamScheduling(app, now)).resolves.toEqual({
      paused: 2,
      resumed: 1,
      recoveryGenerations: 1,
    });
    expect(configMocks.loadEffectiveConfig).toHaveBeenCalledTimes(1);
    expect(dbMocks.reconcileFanslyBulkStreamGate.mock.calls.map(([, input]) => input)).toEqual([
      {
        pageId: 11,
        stream: "fan_earnings",
        gateState: "ramped",
        now,
      },
      {
        pageId: 11,
        stream: "purchase_history",
        gateState: "flag_off",
        now,
      },
      {
        pageId: 12,
        stream: "fan_earnings",
        gateState: "not_allowlisted",
        now,
      },
      {
        pageId: 12,
        stream: "purchase_history",
        gateState: "flag_off",
        now,
      },
    ]);
  });
});
