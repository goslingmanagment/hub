import { describe, expect, it, vi } from "vitest";

import {
  KernelApiError,
  SDK_EXCLUDED_OPERATIONS,
  createKernelClient,
  routeSchemas,
} from "@agency_hub_core/contracts";

import { kernelOperations } from "../packages/sdk/src/operations.ts";

// Kernel Stage 20: the SDK runtime against a fake fetch — path templating,
// query serialization, auth plumbing, the error taxonomy, and response
// validation, all driven by the REAL manifest + contracts.

type Captured = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body?: unknown; text?: string }>) {
  const calls: Captured[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    const payload = next.text ?? JSON.stringify(next.body ?? null);
    return new Response(payload, {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("kernel SDK runtime", () => {
  it("templates path params with encoding and serializes query arrays", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: [] }]);
    const client = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: impl });

    await client.pageSubscribers({
      params: { pageLabel: "lana b/c" },
      query: { limit: 10, query: undefined, expiringWithinDays: 7 },
    }).catch(() => undefined); // response shape not under test here

    expect(calls[0].url).toBe(
      "http://hub/api/v1/pages/lana%20b%2Fc/subscribers?limit=10&expiringWithinDays=7",
    );
    expect(calls[0].init.method).toBe("GET");
  });

  it("throws a contract error when a path param is missing", async () => {
    const { impl } = fakeFetch([{ status: 200, body: {} }]);
    const client = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: impl });

    await expect(
      client.raw("pageSubscribers", { params: {} }),
    ).rejects.toMatchObject({ category: "contract", code: "missing_path_param" });
  });

  it("plumbs bearer auth, cookie mode, extra headers, and JSON bodies", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const bearer = createKernelClient(kernelOperations, {
      baseUrl: "http://hub",
      fetch: impl,
      auth: { mode: "bearer", token: () => "sk-test" },
      headers: { "x-client-version": "sdk-test" },
    });
    await bearer.logout();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["x-client-version"]).toBe("sdk-test");
    expect(calls[0].init.credentials).toBeUndefined();

    const { impl: impl2, calls: calls2 } = fakeFetch([{ status: 200, body: { id: 1, slug: "m", name: "M" } }]);
    const cookie = createKernelClient(kernelOperations, {
      baseUrl: "http://hub",
      fetch: impl2,
      auth: { mode: "cookie" },
    });
    await cookie.adminCreateModel({ body: { slug: "m", name: "M" } });
    expect(calls2[0].init.credentials).toBe("include");
    expect((calls2[0].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls2[0].init.body))).toEqual({ slug: "m", name: "M" });
  });

  it("maps the error taxonomy from status codes and fires the auth hook", async () => {
    const grid: Array<[number, string]> = [
      [400, "validation"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [409, "conflict"],
      [418, "http"],
      [429, "rate_limit"],
      [500, "server"],
    ];
    for (const [status, category] of grid) {
      const { impl } = fakeFetch([{
        status,
        body: { error: "some_code", message: "boom", statusCode: status },
      }]);
      const onAuthError = vi.fn();
      const client = createKernelClient(kernelOperations, {
        baseUrl: "http://hub",
        fetch: impl,
        onAuthError,
      });
      const error = await client.logout().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KernelApiError);
      expect((error as KernelApiError).category, `status ${status}`).toBe(category);
      expect((error as KernelApiError).status).toBe(status);
      expect((error as KernelApiError).code).toBe("some_code");
      expect(onAuthError).toHaveBeenCalledTimes(category === "auth" ? 1 : 0);
    }
  });

  it("categorizes network failures", async () => {
    const impl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const client = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: impl });
    await expect(client.logout()).rejects.toMatchObject({ category: "network" });
  });

  it("validates the response against the contract and returns the parsed value", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const client = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: impl });
    await expect(client.logout()).resolves.toEqual({ ok: true });

    const { impl: badImpl } = fakeFetch([{ status: 200, body: { ok: "yep" } }]);
    const badClient = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: badImpl });
    await expect(badClient.logout()).rejects.toMatchObject({
      category: "contract",
      code: "response_validation_failed",
    });
  });

  it("rejects undeclared success statuses", async () => {
    const { impl } = fakeFetch([{ status: 203, body: { ok: true } }]);
    const client = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: impl });
    await expect(client.logout()).rejects.toMatchObject({
      category: "contract",
      code: "undeclared_status",
    });
  });

  it("exposes no plain method for excluded operations, but raw() reaches them", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, text: "id,amount\n" }]);
    const client = createKernelClient(kernelOperations, { baseUrl: "http://hub", fetch: impl });

    for (const key of SDK_EXCLUDED_OPERATIONS) {
      expect((client as unknown as Record<string, unknown>)[key], key).toBeUndefined();
    }
    const response = await client.raw("adminOfapiCreditsLedgerCsv", { query: {} });
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe("http://hub/api/v1/admin/ofapi/credits/ledger.csv");
  });

  it("covers every registry key with a manifest entry (join is total)", () => {
    expect(Object.keys(kernelOperations).sort()).toEqual(Object.keys(routeSchemas).sort());
  });
});

import {
  AI_STREAM_CAPABILITIES,
  streamAiFeature,
  streamAiGateway,
  subscribeSyncEvents,
} from "@agency_hub_core/contracts";

import * as generatedSdk from "../packages/sdk/src/index.ts";

function sseFetch(chunks: string[], init?: { status?: number }) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  const impl = (async () => new Response(stream, {
    status: init?.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  })) as unknown as typeof fetch;
  return impl;
}

describe("AI gateway stream helper (protocol conformance on a fake stream)", () => {
  it("feature stream advertises capability and accepts debug_input_v1", async () => {
    const frames: unknown[] = [];
    let requestInit: RequestInit | undefined;
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return sseFetch([
        'event: ai\ndata: {"type":"debug_input_v1","systemBlocks":[{"text":"system","cache":"1h"}],"userBlocks":[{"text":"user","cache":"5m"}],"contextManifest":null}\n\n',
      ])("http://unused");
    }) as unknown as typeof fetch;
    const handle = streamAiFeature(
      { baseUrl: "http://hub", fetch: impl },
      {
        feature: "fast-reply",
        body: {} as never,
        debugPromptEcho: true,
        onFrame: (frame) => frames.push(frame),
      },
    );
    await handle.done;
    expect(new Headers(requestInit?.headers).get("x-kernel-ai-capabilities")).toBe("debug-input-v1");
    expect(frames).toEqual([expect.objectContaining({ type: "debug_input_v1" })]);
  });

  // H-4a: the capability list. The header is the union of `capabilities` and
  // the legacy `debugPromptEcho`, deduplicated, in AI_STREAM_CAPABILITIES
  // order, ", "-joined; nothing to advertise → no header at all.
  async function capabilitiesHeaderFor(
    input: Pick<Parameters<typeof streamAiFeature>[1], "debugPromptEcho" | "capabilities">,
  ): Promise<string | null> {
    let requestInit: RequestInit | undefined;
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return sseFetch(['event: ai\ndata: {"type":"done","stopReason":"end_turn"}\n\n'])("http://unused");
    }) as unknown as typeof fetch;
    const handle = streamAiFeature(
      { baseUrl: "http://hub", fetch: impl },
      { feature: "fast-reply", body: {} as never, onFrame: () => undefined, ...input },
    );
    await handle.done;
    return new Headers(requestInit?.headers).get("x-kernel-ai-capabilities");
  }

  it("feature stream writes the capability list in constant order, without repeats", async () => {
    expect(AI_STREAM_CAPABILITIES).toEqual(["debug-input-v1", "context-v1", "split-all-v1"]);
    // Old callers: unchanged wire.
    expect(await capabilitiesHeaderFor({})).toBeNull();
    expect(await capabilitiesHeaderFor({ debugPromptEcho: false })).toBeNull();
    expect(await capabilitiesHeaderFor({ debugPromptEcho: true })).toBe("debug-input-v1");
    // New option.
    expect(await capabilitiesHeaderFor({ capabilities: [] })).toBeNull();
    expect(await capabilitiesHeaderFor({ capabilities: ["split-all-v1", "context-v1"] }))
      .toBe("context-v1, split-all-v1");
    expect(await capabilitiesHeaderFor({ capabilities: ["debug-input-v1"] })).toBe("debug-input-v1");
    // Union with the legacy flag, deduplicated.
    expect(await capabilitiesHeaderFor({
      debugPromptEcho: true,
      capabilities: ["context-v1", "debug-input-v1", "context-v1"],
    })).toBe("debug-input-v1, context-v1");
    expect(await capabilitiesHeaderFor({ debugPromptEcho: true, capabilities: ["split-all-v1"] }))
      .toBe("debug-input-v1, split-all-v1");
    // A value outside the constant (an untyped JS caller) is never sent.
    expect(await capabilitiesHeaderFor({ capabilities: ["future-v9" as never, "context-v1"] })).toBe("context-v1");
    expect(await capabilitiesHeaderFor({ capabilities: ["future-v9" as never] })).toBeNull();
  });

  it("the generated SDK re-exports the capability list", () => {
    expect(generatedSdk.AI_STREAM_CAPABILITIES).toBe(AI_STREAM_CAPABILITIES);
  });

  it("raw gateway remains strict against debug_input_v1", async () => {
    const handle = streamAiGateway(
      { baseUrl: "http://hub", fetch: sseFetch([
        'event: ai\ndata: {"type":"debug_input_v1","systemBlocks":[{"text":"system","cache":"1h"}],"userBlocks":[{"text":"user","cache":"5m"}],"contextManifest":null}\n\n',
      ]) },
      { body: {} as never, onFrame: () => undefined },
    );
    await expect(handle.done).rejects.toMatchObject({ code: "frame_validation_failed" });
  });

  it("parses and validates event:ai frames, tolerating split chunks and heartbeats", async () => {
    const frames: unknown[] = [];
    const handle = streamAiGateway(
      {
        baseUrl: "http://hub",
        fetch: sseFetch([
          "event: ai\ndata: {\"type\":\"content_delta\",",
          "\"text\":\"hel\"}\n\n: keep-alive\n\n",
          "event: ai\ndata: {\"type\":\"content_delta\",\"text\":\"lo\"}\n\n",
          "event: ai\ndata: {\"type\":\"error\",\"code\":\"provider_stream_failed\",\"message\":\"boom\",\"retryAfterMs\":null}\n\n",
        ]),
      },
      {
        body: {} as never, // wire shape irrelevant against the fake fetch
        onFrame: (frame) => frames.push(frame),
      },
    );
    await handle.done;
    expect(frames).toEqual([
      { type: "content_delta", text: "hel" },
      { type: "content_delta", text: "lo" },
      { type: "error", code: "provider_stream_failed", message: "boom", retryAfterMs: null },
    ]);
  });

  it("rejects frames that fail the contract", async () => {
    const handle = streamAiGateway(
      { baseUrl: "http://hub", fetch: sseFetch(['event: ai\ndata: {"type":"content_delta"}\n\n']) },
      { body: {} as never, onFrame: () => undefined },
    );
    await expect(handle.done).rejects.toMatchObject({
      category: "contract",
      code: "frame_validation_failed",
    });
  });

  it("maps non-2xx openings onto the error taxonomy", async () => {
    const impl = (async () => new Response(
      JSON.stringify({ error: "gateway_disabled", message: "off", statusCode: 503 }),
      { status: 503 },
    )) as unknown as typeof fetch;
    const handle = streamAiGateway(
      { baseUrl: "http://hub", fetch: impl },
      { body: {} as never, onFrame: () => undefined },
    );
    await expect(handle.done).rejects.toMatchObject({
      category: "server",
      status: 503,
      code: "gateway_disabled",
    });
  });

  it("surfaces a 429 quota denial as rate_limit with the ledger code, not validation", async () => {
    const impl = (async () => new Response(
      JSON.stringify({ error: "quota_denied", message: "ChatMuse AI gateway daily quota exceeded", statusCode: 429 }),
      { status: 429 },
    )) as unknown as typeof fetch;
    const handle = streamAiGateway(
      { baseUrl: "http://hub", fetch: impl },
      { body: {} as never, onFrame: () => undefined },
    );
    await expect(handle.done).rejects.toMatchObject({
      category: "rate_limit",
      status: 429,
      code: "quota_denied",
      message: "ChatMuse AI gateway daily quota exceeded",
    });
  });
});

describe("sync events helper (protocol conformance on a fake stream)", () => {
  it("delivers only event:sync frames with numeric ids, skipping retry/heartbeat noise", async () => {
    const frames: Array<{ id: number; event: unknown }> = [];
    const handle = subscribeSyncEvents(
      {
        baseUrl: "http://hub",
        fetch: sseFetch([
          "retry: 3000\n\n",
          'id: 7\nevent: sync\ndata: {"type":"typing","accountId":"acct-1","chatId":"9"}\n\n',
          ": keep-alive\n\n",
          'id: 8\nevent: sync\ndata: {"type":"typing","accountId":"acct-1","chatId":"9"}\n\n',
        ]),
      },
      { onFrame: (frame) => frames.push(frame) },
    );
    await handle.done;
    expect(frames.map((frame) => frame.id)).toEqual([7, 8]);
    expect(frames[0].event).toEqual({ type: "typing", accountId: "acct-1", chatId: "9" });
  });
});
