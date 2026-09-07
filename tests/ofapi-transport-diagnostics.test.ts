import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfapiClient, OfapiGovernedRequestError } from "../apps/runtime/src/services/ofapi.ts";

let server: Server | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  server?.closeAllConnections();
  server?.close();
  server = null;
});

async function listen() {
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("loopback required");
  return `http://127.0.0.1:${address.port}`;
}

async function failure(baseUrl: string, maxResponseBytes = 1024, timeoutMs = 1000) {
  const client = createOfapiClient({ baseUrl, apiKey: "secret-provider-key", restDelayMs: 0 });
  try {
    await client.dispatchGovernedRaw!({ pageId: 42 }, {
      attemptId: "diagnostic-attempt", operation: "ofapi_capture_posts",
      method: "GET", pathname: "/acct_test/posts", query: { sensitive: "private-query" },
      priorityClass: "bulk", deadlineAt: new Date(Date.now() + 5000),
      beforeDispatch: async () => true, maxResponseBytes, timeoutMs,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(OfapiGovernedRequestError);
    return error as OfapiGovernedRequestError;
  }
  throw new Error("expected governed failure");
}

describe("OFAPI bounded transport diagnostics", () => {
  it("identifies refused TCP before headers without changing dispatch certainty", async () => {
    server = createServer();
    const baseUrl = await listen();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const error = await failure(baseUrl);
    expect(error).toMatchObject({
      phase: "post_dispatch", reason: "transport",
      diagnostics: {
        stage: "response_headers", transportClass: "connect", causeCode: "ECONNREFUSED",
        status: null, bytesRead: 0, timeoutMs: 1000,
      },
    });
    expect(error.diagnostics!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(error.diagnostics)).not.toContain("127.0.0.1");
  });

  it("distinguishes waiting for headers from reading a body", async () => {
    let requests = 0;
    server = createServer(() => { requests += 1; });
    const error = await failure(await listen(), 1024, 250);
    expect(requests).toBe(1);
    expect(error).toMatchObject({
      phase: "post_dispatch", reason: "transport",
      diagnostics: { stage: "response_headers", transportClass: "timeout", status: null, bytesRead: 0 },
    });
  });

  it("records bytes actually read when a response body fails", async () => {
    let pulls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(new Error("private-provider-body"));
      },
    }), { status: 200, headers: { "content-length": "10" } })));
    const error = await failure("https://vendor.invalid");
    expect(error).toMatchObject({
      phase: "post_dispatch", reason: "body_read",
      diagnostics: { stage: "response_body", status: 200, bytesRead: 3, declaredLength: 10 },
    });
    expect(JSON.stringify(error.diagnostics)).not.toContain("private-provider-body");
  });

  it.each([true, false])("cancels oversized bodies and preserves the size diagnosis (declared=%s)", async (declared) => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8)); },
      cancel,
    }), { status: 200, headers: declared ? { "content-length": "8" } : {} })));
    const error = await failure("https://vendor.invalid", 4);
    expect(error).toMatchObject({
      phase: "post_dispatch", reason: "body_too_large",
      diagnostics: {
        stage: "response_body", status: 200, transportClass: null,
        bytesRead: declared ? 0 : 8, declaredLength: declared ? 8 : null, maxResponseBytes: 4,
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("never copies arbitrary cause names, codes, messages, URLs or credentials into diagnostics", async () => {
    const secret = "socks5://private-user:private-password@private-proxy.invalid:1080";
    const nested = Object.assign(new Error(`Bearer secret-provider-key ${secret}`), {
      name: secret, code: "private-query", address: "private-proxy.invalid",
    });
    const wrapped = new TypeError("private-provider-body", { cause: nested });
    Object.assign(nested, { cause: wrapped });
    const fetch = vi.fn(async () => { throw wrapped; });
    vi.stubGlobal("fetch", fetch);
    const error = await failure("https://vendor.invalid");
    const exposed = JSON.stringify({ message: error.message, diagnostics: error.diagnostics });
    for (const value of [secret, "private-query", "private-proxy", "private-provider-body", "secret-provider-key"])
      expect(exposed).not.toContain(value);
    expect(error.diagnostics).toMatchObject({ causeName: "TypeError", causeCode: null });
    expect(fetch).toHaveBeenCalledOnce();
    expect(error.phase).toBe("post_dispatch");
  });
});
