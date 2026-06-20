import { describe, expect, it, vi } from "vitest";

import {
  ensureOfapiDmAnalyticsQueues,
  ensureOfapiDmAnalyticsSchedules,
  OFAPI_DM_ANALYTICS_REBUILD_QUEUE,
  resolveDmAnalyticsRebuildWindow,
  startOfapiDmAnalyticsWorker,
} from "../apps/runtime/src/services/ofapi-dm-analytics.ts";

describe("OFAPI DM analytics queue", () => {
  it("uses an exclusive hourly UTC rebuild over a bounded rolling window", async () => {
    expect(resolveDmAnalyticsRebuildWindow(
      new Date("2026-06-20T01:02:03.000Z"),
      3,
    )).toEqual({
      fromBusinessDate: "2026-06-18",
      throughBusinessDate: "2026-06-20",
    });

    const createQueue = vi.fn(async () => undefined);
    await ensureOfapiDmAnalyticsQueues({ createQueue });
    expect(createQueue).toHaveBeenCalledWith(
      OFAPI_DM_ANALYTICS_REBUILD_QUEUE,
      { policy: "exclusive" },
    );

    const schedule = vi.fn(async () => undefined);
    await ensureOfapiDmAnalyticsSchedules({ createQueue, schedule });
    expect(schedule).toHaveBeenCalledWith(
      OFAPI_DM_ANALYTICS_REBUILD_QUEUE,
      "10 * * * *",
      null,
      { tz: "UTC" },
    );

    const work = vi.fn(async () => "worker-id");
    await startOfapiDmAnalyticsWorker(
      {
        logger: { info: vi.fn() },
      } as never,
      { work },
    );
    expect(work).toHaveBeenCalledWith(
      OFAPI_DM_ANALYTICS_REBUILD_QUEUE,
      { batchSize: 1 },
      expect.any(Function),
    );
  });
});
