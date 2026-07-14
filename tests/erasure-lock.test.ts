import { describe, expect, it, vi } from "vitest";

import { withErasureExecutionLock } from "../apps/runtime/src/services/erasure/index.ts";

describe("global erasure execution lock", () => {
  it("destroys the session when lock acquisition has an ambiguous failure", async () => {
    const acquisitionError = new Error("connection lost during acquisition");
    const release = vi.fn();
    const query = vi.fn().mockRejectedValueOnce(acquisitionError);
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };
    const run = vi.fn(async () => "must not run");

    await expect(withErasureExecutionLock(
      { pool } as never,
      run,
    )).rejects.toBe(acquisitionError);

    expect(run).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys the dedicated session when advisory unlock fails", async () => {
    const runError = new Error("erasure failed");
    const unlockError = new Error("connection lost during unlock");
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(unlockError);
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };

    await expect(withErasureExecutionLock(
      { pool } as never,
      async () => { throw runError; },
    )).rejects.toBe(runError);

    expect(query).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("returns a cleanly unlocked session to the pool", async () => {
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };

    await expect(withErasureExecutionLock(
      { pool } as never,
      async () => "done",
    )).resolves.toBe("done");

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("destroys the session when PostgreSQL reports that no lock was released", async () => {
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };

    await expect(withErasureExecutionLock(
      { pool } as never,
      async () => "done",
    )).rejects.toThrow("Global erasure execution lock was not held");

    expect(release).toHaveBeenCalledWith(true);
  });
});
