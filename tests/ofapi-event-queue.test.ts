import { describe, expect, it, vi } from "vitest";

import {
  ensureOfapiQueues,
  OFAPI_EVENT_PROCESS_BATCH_SIZE,
  OFAPI_EVENT_PROCESS_QUEUE,
  sortOfapiEventJobs,
  startOfapiEventWorker,
} from "../apps/runtime/src/services/ofapi-events.ts";

describe("OFAPI event process queue", () => {
  it("deduplicates each event id and drains sequential batches", async () => {
    const createQueue = vi.fn(async () => undefined);
    await ensureOfapiQueues({ createQueue });

    expect(createQueue).toHaveBeenCalledWith(
      OFAPI_EVENT_PROCESS_QUEUE,
      expect.objectContaining({
        policy: "exclusive",
        retryLimit: 2,
      }),
    );

    const work = vi.fn(async () => "worker-id");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const release = vi.fn();
    const releaseWorker = await startOfapiEventWorker(
      {
        config: {},
        logger: { info: vi.fn(), warn: vi.fn() },
        pool: {
          connect: vi.fn(async () => ({ query, release })),
        },
      } as never,
      { work, send: vi.fn(async () => null) },
    );

    expect(work).toHaveBeenCalledWith(
      OFAPI_EVENT_PROCESS_QUEUE,
      { batchSize: OFAPI_EVENT_PROCESS_BATCH_SIZE },
      expect.any(Function),
    );
    expect(OFAPI_EVENT_PROCESS_BATCH_SIZE).toBe(100);
    expect(sortOfapiEventJobs([
      { data: { eventId: 9 } },
      { data: { eventId: 2 } },
      { data: { eventId: 5 } },
    ]).map((job) => job.data.eventId)).toEqual([2, 5, 9]);

    await releaseWorker();
    expect(query).toHaveBeenNthCalledWith(
      1,
      "select pg_try_advisory_lock($1, $2) as locked",
      expect.any(Array),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "select pg_advisory_unlock($1, $2) as unlocked",
      expect.any(Array),
    );
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("refuses multi-replica OFAPI event worker startup", async () => {
    const work = vi.fn(async () => "worker-id");

    await expect(startOfapiEventWorker(
      {
        config: { ofapiEventWorkerReplicas: 2 },
        logger: { info: vi.fn(), warn: vi.fn() },
        pool: {
          connect: vi.fn(),
        },
      } as never,
      { work, send: vi.fn(async () => null) },
    )).rejects.toThrow("OFAPI event worker requires exactly one replica");

    expect(work).not.toHaveBeenCalled();
  });

  it("refuses a second distributed OFAPI event worker", async () => {
    const work = vi.fn(async () => "worker-id");
    const release = vi.fn();

    await expect(startOfapiEventWorker(
      {
        config: {},
        logger: { info: vi.fn(), warn: vi.fn() },
        pool: {
          connect: vi.fn(async () => ({
            query: vi.fn(async () => ({ rows: [{ locked: false }] })),
            release,
          })),
        },
      } as never,
      { work, send: vi.fn(async () => null) },
    )).rejects.toThrow("OFAPI event worker advisory lock is already held");

    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
