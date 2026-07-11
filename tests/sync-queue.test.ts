import { describe, expect, it, vi } from "vitest";

import {
  ensureSyncQueues,
  SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
  SYNC_PAGE_EXECUTE_RETRY_LIMIT,
  SYNC_PAGE_EXECUTE_QUEUE,
} from "../apps/runtime/src/services/sync-queue.ts";

describe("sync page queue lifecycle", () => {
  it("reconciles the existing queue instead of relying on createQueue", async () => {
    const createQueue = vi.fn(async () => undefined);
    const updateQueue = vi.fn(async () => undefined);
    const getQueue = vi.fn(async () => ({
      name: SYNC_PAGE_EXECUTE_QUEUE,
      policy: "exclusive",
      expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
      heartbeatSeconds: 30,
      retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
    }));

    await ensureSyncQueues({ createQueue, updateQueue, getQueue } as never);

    expect(SYNC_PAGE_EXECUTE_EXPIRE_SECONDS).toBe(15 * 60);
    expect(SYNC_PAGE_EXECUTE_RETRY_LIMIT).toBe(0);
    expect(createQueue).toHaveBeenCalledWith(
      SYNC_PAGE_EXECUTE_QUEUE,
      expect.objectContaining({
        policy: "exclusive",
        expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
        heartbeatSeconds: 30,
        retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
      }),
    );
    expect(updateQueue).toHaveBeenCalledWith(
      SYNC_PAGE_EXECUTE_QUEUE,
      expect.objectContaining({
        expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
        heartbeatSeconds: 30,
        retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
      }),
    );
    expect(getQueue).toHaveBeenCalledWith(SYNC_PAGE_EXECUTE_QUEUE);
  });

  it("reconciles even when queue creation is cached and fails closed on drift", async () => {
    const createQueue = vi.fn(async () => undefined);
    const updateQueue = vi.fn(async () => undefined);
    const getQueue = vi.fn(async () => ({
      name: SYNC_PAGE_EXECUTE_QUEUE,
      policy: "exclusive",
      expireInSeconds: 180,
      heartbeatSeconds: 30,
      retryLimit: 2,
    }));

    await expect(ensureSyncQueues(
      { createQueue, updateQueue, getQueue } as never,
      new Set([SYNC_PAGE_EXECUTE_QUEUE]),
    )).rejects.toThrow("configuration drift");

    expect(createQueue).not.toHaveBeenCalledWith(
      SYNC_PAGE_EXECUTE_QUEUE,
      expect.anything(),
    );
    expect(updateQueue).toHaveBeenCalledWith(
      SYNC_PAGE_EXECUTE_QUEUE,
      expect.objectContaining({
        expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
        retryLimit: 0,
      }),
    );
  });
});
