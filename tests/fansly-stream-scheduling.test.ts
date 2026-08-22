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
      // Page 11: fan_earnings, purchase_history, stats_snapshot, notifications,
      // catalog, post_replies.
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "paused", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "resumed", createdRecoveryGeneration: true })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      // Page 12: the same six.
      .mockResolvedValueOnce({ action: "paused", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "resumed", createdRecoveryGeneration: true })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false })
      .mockResolvedValueOnce({ action: "unchanged", createdRecoveryGeneration: false });
    configMocks.loadEffectiveConfig.mockResolvedValue({
      fanslyFanEarningsSyncEnabled: true,
      fanslyPurchaseHistorySyncEnabled: false,
      fanslyNewStreamPageAllowlist: "lora-1",
      // WP-F1: the stats lane reads its OWN allowlist, on the FAIL-CLOSED
      // template. `lora-1` is listed; `other-page` is not, and an empty key
      // would list nobody — the OPPOSITE of fanslyNewStreamPageAllowlist above.
      fanslyStatsSnapshotSyncEnabled: true,
      fanslyStatsSnapshotPageAllowlist: "lora-1",
      // WP-F2: its OWN fail-closed key, on the same template.
      fanslyNotificationsSyncEnabled: true,
      fanslyNotificationsPageAllowlist: "lora-1",
      // WP-F3: its OWN fail-closed key, on the same template.
      fanslyCatalogSyncEnabled: true,
      fanslyCatalogPageAllowlist: "lora-1",
      // WP-F5: its OWN fail-closed key, on the same template.
      fanslyPostRepliesSyncEnabled: true,
      fanslyPostRepliesPageAllowlist: "lora-1",
    });
  });

  it("uses the live flag and allowlist for every Fansly page and stream", async () => {
    const now = new Date("2026-07-31T03:00:00.000Z");
    const app = { db: {}, config: {} } as never;

    await expect(reconcileFanslyBulkStreamScheduling(app, now)).resolves.toEqual({
      paused: 2,
      resumed: 2,
      recoveryGenerations: 2,
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
        pageId: 11,
        stream: "stats_snapshot",
        gateState: "ramped",
        now,
      },
      {
        pageId: 11,
        stream: "notifications",
        gateState: "ramped",
        now,
      },
      {
        pageId: 11,
        stream: "catalog",
        gateState: "ramped",
        now,
      },
      {
        pageId: 11,
        stream: "post_replies",
        gateState: "ramped",
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
      {
        pageId: 12,
        stream: "stats_snapshot",
        gateState: "not_allowlisted",
        now,
      },
      {
        // WP-F2's key is fail-closed too: `other-page` is not listed, so the
        // lane is `not_allowlisted` even though its flag is ON.
        pageId: 12,
        stream: "notifications",
        gateState: "not_allowlisted",
        now,
      },
      {
        // WP-F3's key, same rule.
        pageId: 12,
        stream: "catalog",
        gateState: "not_allowlisted",
        now,
      },
      {
        // WP-F5's key, same rule again.
        pageId: 12,
        stream: "post_replies",
        gateState: "not_allowlisted",
        now,
      },
    ]);
  });
});
