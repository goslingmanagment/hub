import { describe, expect, it, vi } from "vitest";

import {
  createKernelClient,
  subscribeSyncEvents,
} from "../packages/contracts/src/sdk-runtime.ts";

// The options contract promises onAuthError on every 401/403, with a null
// operation for raw/stream calls (review R3-3). Only the typed call() path
// invoked it — expired auth on raw() (dashboard CSV export) or SSE bypassed
// the central logout hook.

const operations = { ping: { method: "GET", path: "/ping" } } as never;

describe("onAuthError coverage beyond the typed path", () => {
  it("raw() notifies the hook on 401 and still returns the response", async () => {
    const onAuthError = vi.fn();
    const client = createKernelClient(operations, {
      baseUrl: "http://kernel.test",
      onAuthError,
      fetch: (async () => new Response("{}", { status: 401 })) as never,
    }) as unknown as { raw: (key: string) => Promise<Response> };

    const response = await client.raw("ping");
    expect(response.status).toBe(401);
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(onAuthError.mock.calls[0]![0].category).toBe("auth");
    expect(onAuthError.mock.calls[0]![1]).toBeNull();
  });

  it("raw() stays silent on non-auth statuses", async () => {
    const onAuthError = vi.fn();
    const client = createKernelClient(operations, {
      baseUrl: "http://kernel.test",
      onAuthError,
      fetch: (async () => new Response("{}", { status: 500 })) as never,
    }) as unknown as { raw: (key: string) => Promise<Response> };

    const response = await client.raw("ping");
    expect(response.status).toBe(500);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("SSE subscribe notifies the hook before throwing on 401", async () => {
    const onAuthError = vi.fn();
    const handle = subscribeSyncEvents({
      baseUrl: "http://kernel.test",
      onAuthError,
      fetch: (async () => new Response("nope", { status: 401 })) as never,
    }, { onFrame: () => {} });

    await expect(handle.done).rejects.toMatchObject({ category: "auth" });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(onAuthError.mock.calls[0]![1]).toBeNull();
  });
});
