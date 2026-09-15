import { describe, expect, it, vi } from "vitest";

import {
  createKernelClient,
  fetchVoiceNoteAudio,
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

  it.each([401, 403])(
    "fetchVoiceNoteAudio notifies the hook on %i and still returns the response",
    async (status) => {
      const onAuthError = vi.fn();
      const response = await fetchVoiceNoteAudio(
        {
          baseUrl: "http://kernel.test",
          onAuthError,
          fetch: (async () => new Response("nope", { status })) as never,
        },
        { pageLabel: "lana", id: 7 },
      );
      expect(response.status).toBe(status);
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(onAuthError.mock.calls[0]![0].category).toBe("auth");
      expect(onAuthError.mock.calls[0]![1]).toBeNull();
    },
  );

  it("fetchVoiceNoteAudio stays silent on a non-auth status (e.g. 410 artifact_expired)", async () => {
    const onAuthError = vi.fn();
    const response = await fetchVoiceNoteAudio(
      {
        baseUrl: "http://kernel.test",
        onAuthError,
        fetch: (async () => new Response("{}", { status: 410 })) as never,
      },
      { pageLabel: "lana", id: 7 },
    );
    expect(response.status).toBe(410);
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

// Decision 347 §4.5: the kernel's 401 for a revoked or expired device token
// carries a machine `reason`. A client heals itself from that reason, so every
// transport has to hand the parsed envelope over — a stringified body or a
// dropped `error` code would leave the desktop and the extension guessing.
describe("the 401 reason survives every transport", () => {
  const unauthorized = (reason: string) => new Response(
    JSON.stringify({
      error: "unauthorized",
      message: "Unauthorized",
      statusCode: 401,
      reason,
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );

  it("reaches the typed path as a parsed body with its code", async () => {
    const onAuthError = vi.fn();
    const client = createKernelClient(operations, {
      baseUrl: "http://kernel.test",
      onAuthError,
      fetch: (async () => unauthorized("token_revoked")) as never,
    }) as unknown as { ping: () => Promise<unknown> };

    await expect(client.ping()).rejects.toMatchObject({
      category: "auth",
      status: 401,
      code: "unauthorized",
      body: { reason: "token_revoked" },
    });
    expect(onAuthError.mock.calls[0]![0].body).toMatchObject({ reason: "token_revoked" });
  });

  it("reaches the raw path through the response the caller receives", async () => {
    const onAuthError = vi.fn();
    const client = createKernelClient(operations, {
      baseUrl: "http://kernel.test",
      onAuthError,
      fetch: (async () => unauthorized("token_expired")) as never,
    }) as unknown as { raw: (key: string) => Promise<Response> };

    const response = await client.raw("ping");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: "token_expired" });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it("reaches the SSE handshake failure instead of being flattened into text", async () => {
    const onAuthError = vi.fn();
    const handle = subscribeSyncEvents({
      baseUrl: "http://kernel.test",
      onAuthError,
      fetch: (async () => unauthorized("token_revoked")) as never,
    }, { onFrame: () => {} });

    await expect(handle.done).rejects.toMatchObject({
      category: "auth",
      status: 401,
      code: "unauthorized",
      body: { reason: "token_revoked" },
    });
    expect(onAuthError.mock.calls[0]![0].body).toMatchObject({ reason: "token_revoked" });
  });

  it("still classifies a 401 with no envelope at all", async () => {
    const handle = subscribeSyncEvents({
      baseUrl: "http://kernel.test",
      fetch: (async () => new Response("nope", { status: 401 })) as never,
    }, { onFrame: () => {} });

    await expect(handle.done).rejects.toMatchObject({
      category: "auth",
      status: 401,
      code: null,
      body: "nope",
    });
  });
});
