import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfapiClient, OfapiApiError, OfapiHistoryRequestError } from "../apps/runtime/src/services/ofapi.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const params = { from: "2026-09-06T00:00:00Z", to: "2026-09-07T00:00:00Z", limit: 100, offset: 100 };
const privateUrl = "https://private.invalid/path?secret=private-key";
const failure = () => Object.assign(new TypeError(`private-error ${privateUrl}`, {
  cause: Object.assign(new Error("private-body"), { name: privateUrl, code: "private-code" }),
}), { code: "ECONNRESET" });

describe("delivery-history GET phase diagnostics", () => {
  it.each(["admission", "authorization", "response_headers", "response_body", "response_capture"] as const)("identifies %s without extra dispatch or raw material", async stage => {
    const cause = failure();
    const spend = vi.fn(); const capture = vi.fn(async () => {
      if (stage === "response_capture") throw Object.assign(new Error(`private SQL ${privateUrl}`), { code: "42501" });
      return { observationId: 1, receivedAt: new Date() };
    });
    const fetch = vi.fn(async () => {
      if (stage === "response_headers") throw cause;
      if (stage === "response_body") return new Response(new ReadableStream({ start(controller) { controller.error(cause); } }));
      return new Response(JSON.stringify({ data: [], _pagination: { next_page: null } }));
    });
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "private-key", restDelayMs: 0, onCreditSpend: spend, onAdminResponse: capture,
      pacer: { mode: "enforce", plan: async () => ({ scheduledAt: new Date(), waitMs: 0 }), pace: async () => { if (stage === "admission") throw cause; return 0; } },
      beforeOperationRequest: async () => { if (stage === "authorization") throw cause; },
    });
    let caught: unknown;
    try { await client.listWebhookDeliveries!("wh_private", params); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OfapiHistoryRequestError);
    expect(caught).toBeInstanceOf(OfapiApiError);
    const error = caught as OfapiHistoryRequestError;
    expect(error).toMatchObject({ status: null, body: null, diagnostics: { stage,
      status: ["response_body", "response_capture"].includes(stage) ? 200 : null,
      causeCode: stage === "response_capture" ? "42501" : "ECONNRESET", timeoutMs: 60000,
      transportClass: ["response_headers", "response_body"].includes(stage) ? "transport" : null } });
    expect(error.diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fetch).toHaveBeenCalledTimes(["admission", "authorization"].includes(stage) ? 0 : 1);
    expect(capture).toHaveBeenCalledTimes(stage === "response_capture" ? 1 : 0);
    expect(spend).not.toHaveBeenCalled();
    const exposed = JSON.stringify(error);
    for (const secret of [privateUrl, "private-key", "private-body", "private-code", "private SQL", "wh_private"])
      expect(exposed).not.toContain(secret);
  });

  it.each([403, 503])("preserves vendor HTTP %s after capture and accounting", async status => {
    const capture = vi.fn(async () => ({ observationId: 1, receivedAt: new Date() }));
    const spend = vi.fn(); const fetch = vi.fn(async () => new Response(JSON.stringify({ error: privateUrl, _meta: { _credits: { used: 0, balance: 10000 } } }), { status }));
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "private-key", restDelayMs: 0, onAdminResponse: capture, onCreditSpend: spend });
    await expect(client.listWebhookDeliveries!("wh_private", params)).rejects.toMatchObject({ status, body: null,
      diagnostics: { stage: "response_contract", status, transportClass: null } });
    expect(capture).toHaveBeenCalledTimes(1); expect(spend).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses a 60-second signal only for history GET while admin GET and writes keep 15 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith("/whoami")
      ? { team: { slug: "expected" } } : { data: [], _pagination: { next_page: null } })));
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "private-key", restDelayMs: 0, credentialPolicy: { expectedTeamSlug: "expected" } });
    await client.listWebhookDeliveries!("wh_private", params);
    await client.listWebhooks!();
    await client.redeliverWebhookDelivery!("wh_private", 1);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([60000, 15000, 15000, 15000]);
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET", "GET", "POST"]);
    expect(fetch.mock.calls.map(([, options]) => options?.signal)).toEqual(timeout.mock.results.map(result => result.value));
  });

  it("keeps non-history admin GET and mutation failures on their existing path", async () => {
    const fetch = vi.fn(async () => { throw failure(); }); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "private-key", restDelayMs: 0 });
    let caught: unknown;
    try { await client.listWebhooks!(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OfapiApiError); expect(caught).not.toBeInstanceOf(OfapiHistoryRequestError);
    // The history-only class never becomes a new retry authority for writes.
    const mutation = createOfapiClient({ apiKey: "private-key", restDelayMs: 0,
      credentialPolicy: { expectedTeamSlug: "expected" } });
    await expect(mutation.redeliverWebhookDelivery!("wh_private", 1)).rejects.not.toBeInstanceOf(OfapiHistoryRequestError);
  });
});
