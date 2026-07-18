import { describe, expect, it, vi } from "vitest";

import {
  ensureOfapiChargebacksQueue,
  OFAPI_CHARGEBACKS_RECONCILE_QUEUE,
} from "../apps/runtime/src/services/ofapi-chargebacks-sync.ts";

describe("OFAPI chargebacks queue lifecycle", () => {
  it("creates a single-attempt queue and reconciles an existing retrying queue", async () => {
    let queue = {
      name: OFAPI_CHARGEBACKS_RECONCILE_QUEUE,
      policy: "exclusive",
      retryLimit: 2,
    };
    // pg-boss createQueue is a no-op when the production queue already exists.
    const createQueue = vi.fn(async () => undefined);
    const updateQueue = vi.fn(async (_name: string, options: { retryLimit?: number }) => {
      queue = { ...queue, ...options };
    });
    const getQueue = vi.fn(async () => queue);

    await ensureOfapiChargebacksQueue({ createQueue, updateQueue, getQueue } as never);

    expect(createQueue).toHaveBeenCalledWith(
      OFAPI_CHARGEBACKS_RECONCILE_QUEUE,
      {
        policy: "exclusive",
        retryLimit: 0,
      },
    );
    expect(updateQueue).toHaveBeenCalledWith(
      OFAPI_CHARGEBACKS_RECONCILE_QUEUE,
      { retryLimit: 0 },
    );
    expect(getQueue).toHaveBeenCalledWith(OFAPI_CHARGEBACKS_RECONCILE_QUEUE);
    expect(queue.retryLimit).toBe(0);
  });

  it("fails startup when the mutable retry policy did not reconcile", async () => {
    const createQueue = vi.fn(async () => undefined);
    const updateQueue = vi.fn(async () => undefined);
    const getQueue = vi.fn(async () => ({
      name: OFAPI_CHARGEBACKS_RECONCILE_QUEUE,
      policy: "exclusive",
      retryLimit: 2,
    }));

    await expect(ensureOfapiChargebacksQueue({
      createQueue,
      updateQueue,
      getQueue,
    } as never)).rejects.toThrow("configuration drift");
  });
});
