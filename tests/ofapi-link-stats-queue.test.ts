import { describe, expect, it, vi } from "vitest";

import {
  ensureOfapiLinkStatsQueue,
  OFAPI_LINK_STATS_RECONCILE_QUEUE,
  OFAPI_LINK_STATS_RETRY_QUEUE,
  parseOfapiLinkStatsTargetedJob,
} from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";

interface StoredQueue {
  name: string;
  policy: string;
  retryLimit: number;
}

/** pg-boss's queue table, as far as the lifecycle touches it: createQueue is
 * INSERT ... ON CONFLICT DO NOTHING, updateQueue changes mutable fields only. */
function queueStore(existing: StoredQueue[] = []) {
  const queues = new Map(existing.map((queue) => [queue.name, { ...queue }]));
  const createQueue = vi.fn(async (name: string, options: { policy: string; retryLimit: number }) => {
    if (!queues.has(name)) {
      queues.set(name, { name, ...options });
    }
  });
  const updateQueue = vi.fn(async (name: string, options: { retryLimit?: number }) => {
    const queue = queues.get(name);
    if (queue) {
      queues.set(name, { ...queue, ...options });
    }
  });
  const getQueue = vi.fn(async (name: string) => queues.get(name) ?? null);
  return { queues, boss: { createQueue, updateQueue, getQueue } };
}

describe("OFAPI link-stats queue lifecycle", () => {
  it("creates a single-attempt queue and reconciles an existing retrying queue", async () => {
    const store = queueStore([
      { name: OFAPI_LINK_STATS_RECONCILE_QUEUE, policy: "exclusive", retryLimit: 2 },
    ]);

    await ensureOfapiLinkStatsQueue(store.boss as never);

    expect(store.boss.createQueue).toHaveBeenCalledWith(
      OFAPI_LINK_STATS_RECONCILE_QUEUE,
      { policy: "exclusive", retryLimit: 0 },
    );
    expect(store.boss.updateQueue).toHaveBeenCalledWith(
      OFAPI_LINK_STATS_RECONCILE_QUEUE,
      { retryLimit: 0 },
    );
    expect(store.queues.get(OFAPI_LINK_STATS_RECONCILE_QUEUE)!.retryLimit).toBe(0);
  });

  it("fails startup when the mutable retry policy did not reconcile", async () => {
    const store = queueStore([
      { name: OFAPI_LINK_STATS_RECONCILE_QUEUE, policy: "exclusive", retryLimit: 2 },
    ]);
    store.boss.updateQueue.mockImplementation(async () => undefined);

    await expect(ensureOfapiLinkStatsQueue(store.boss as never)).rejects.toThrow("configuration drift");
  });

  it("creates the retry queue beside it: one queued job per key, never retried by pg-boss", async () => {
    const store = queueStore();

    await ensureOfapiLinkStatsQueue(store.boss as never);

    // `short`, not `exclusive`: different retries (and a rebind run) wait
    // side by side, and a queued one never keeps the cron from creating the
    // next window's job on the scheduled queue.
    expect(store.boss.createQueue).toHaveBeenCalledWith(
      OFAPI_LINK_STATS_RETRY_QUEUE,
      { policy: "short", retryLimit: 0 },
    );
    expect(store.queues.get(OFAPI_LINK_STATS_RETRY_QUEUE)).toEqual({
      name: OFAPI_LINK_STATS_RETRY_QUEUE, policy: "short", retryLimit: 0,
    });
    expect(OFAPI_LINK_STATS_RETRY_QUEUE).toBe("ofapi.link-stats.retry");
  });

  it("fails startup when the retry queue exists under another policy", async () => {
    const store = queueStore([
      { name: OFAPI_LINK_STATS_RETRY_QUEUE, policy: "exclusive", retryLimit: 0 },
    ]);

    await expect(ensureOfapiLinkStatsQueue(store.boss as never)).rejects.toThrow(
      `Queue ${OFAPI_LINK_STATS_RETRY_QUEUE} configuration drift`,
    );
  });
});

describe("OFAPI link-stats targeted job payloads", () => {
  it("reads a window's retry and a rebind run", () => {
    expect(parseOfapiLinkStatsTargetedJob({
      trigger: "retry", windowAt: "2026-10-08T09:45:00.000Z", retry: 2,
    })).toEqual({ trigger: "retry", windowAt: new Date("2026-10-08T09:45:00.000Z"), retry: 2 });
    expect(parseOfapiLinkStatsTargetedJob({ trigger: "rebind", pageId: 9 }))
      .toEqual({ trigger: "rebind", pageId: 9 });
  });

  it("refuses anything else instead of guessing", () => {
    for (const data of [
      null,
      undefined,
      "retry",
      {},
      { trigger: "scheduled" },
      { trigger: "retry", windowAt: "2026-10-08T09:45:00.000Z" },
      { trigger: "retry", windowAt: "soon", retry: 1 },
      { trigger: "retry", windowAt: "2026-10-08T09:45:00.000Z", retry: 0 },
      { trigger: "retry", windowAt: "2026-10-08T09:45:00.000Z", retry: 4 },
      { trigger: "retry", windowAt: "2026-10-08T09:45:00.000Z", retry: 1.5 },
      { trigger: "rebind" },
      { trigger: "rebind", pageId: "9" },
      { trigger: "rebind", pageId: 0 },
    ]) {
      expect(parseOfapiLinkStatsTargetedJob(data), JSON.stringify(data)).toBeNull();
    }
  });
});
