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
