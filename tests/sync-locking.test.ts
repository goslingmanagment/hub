import { describe, expect, it, vi } from "vitest";

import {
  PageSyncLockReleaseError,
  withPageSyncLock,
} from "../apps/runtime/src/services/sync/locking.ts";

describe("withPageSyncLock", () => {
  it("discards the pooled client and fails when advisory unlock errors", async () => {
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    const connect = vi.fn(async () => ({
      query,
      release,
    }));

    await expect(withPageSyncLock({
      pool: {
        connect,
      },
    } as never, {
      pageId: 42,
      pageLabel: "lora-main",
    }, async () => "ok")).rejects.toBeInstanceOf(PageSyncLockReleaseError);

    expect(query).toHaveBeenNthCalledWith(
      2,
      "select pg_advisory_unlock($1, $2) as unlocked",
      [43101, 42],
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(PageSyncLockReleaseError);
  });

  it("preserves the original business error when advisory unlock also fails", async () => {
    const release = vi.fn();
    const runError = new Error("sync chunk failed");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    const connect = vi.fn(async () => ({
      query,
      release,
    }));

    let caught: unknown;
    try {
      await withPageSyncLock({
        pool: {
          connect,
        },
      } as never, {
        pageId: 42,
        pageLabel: "lora-main",
      }, async () => {
        throw runError;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(runError);
    expect((caught as Error & { lockReleaseError?: unknown }).lockReleaseError).toBeInstanceOf(
      PageSyncLockReleaseError,
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(PageSyncLockReleaseError);
  });
});
