import { describe, expect, it } from "vitest";

import {
  getSyncStreamsForPlatform,
  SYNC_STREAM_DEPENDENCIES,
  SYNC_STREAM_POLICY,
  SYNC_STREAMS,
} from "@agency_hub_core/db";

describe("Stage 16 stream registration", () => {
  it("registers fan_earnings and purchase_history as Fansly-only bulk streams", () => {
    expect(SYNC_STREAMS).toContain("fan_earnings");
    expect(SYNC_STREAMS).toContain("purchase_history");

    const fansly = getSyncStreamsForPlatform("fansly");
    expect(fansly).toContain("fan_earnings");
    expect(fansly).toContain("purchase_history");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("fan_earnings");
    expect(getSyncStreamsForPlatform("onlyfans")).not.toContain("purchase_history");

    // Bulk class: never ahead of transactions/DMs.
    expect(SYNC_STREAM_POLICY.fan_earnings.basePriority)
      .toBeLessThan(SYNC_STREAM_POLICY.dm_messages.basePriority);
    expect(SYNC_STREAM_POLICY.purchase_history.basePriority)
      .toBeLessThan(SYNC_STREAM_POLICY.fan_earnings.basePriority);
    // Earnings are slow-moving (daily); order history a few hours.
    expect(SYNC_STREAM_POLICY.fan_earnings.cadenceSeconds).toBe(86400);
    expect(SYNC_STREAM_POLICY.purchase_history.cadenceSeconds).toBe(4 * 3600);
    // purchase_history depends on light/account mapping only.
    expect(SYNC_STREAM_DEPENDENCIES.purchase_history).toEqual(["light"]);
  });
});
