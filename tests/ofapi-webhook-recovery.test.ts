import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfapiClient, type OfapiCreditSpendObservation } from "../apps/runtime/src/services/ofapi.ts";
import { parseWebhookDeliveryPage } from "../apps/runtime/src/services/ofapi-webhook-recovery.ts";

afterEach(() => vi.unstubAllGlobals());
describe("OFAPI webhook recovery wire contract", () => {
  it("uses bounded date_start/date_end history without a succeeded filter and never estimates a credit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [], _pagination: { next_page: null } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch); const spend: OfapiCreditSpendObservation[] = [];
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, onCreditSpend: row => { spend.push(row); } });
    await client.listWebhookDeliveries!("wh_example", { from: "2026-09-05T00:00:00Z", to: "2026-09-06T00:00:00Z", limit: 100, offset: 100 });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/webhooks/wh_example/deliveries");
    expect(Object.fromEntries(url.searchParams)).toEqual({ date_start: "2026-09-05T00:00:00Z", date_end: "2026-09-06T00:00:00Z", limit: "100", offset: "100" });
    expect(spend).toMatchObject([{ operation: "ofapi_webhook_deliveries", credits: 0, estimated: false }]);
  });
  it("does not treat a malformed page as completed coverage", () => {
    expect(() => parseWebhookDeliveryPage({ data: [{ id: 1 }] })).toThrow("identity");
    expect(() => parseWebhookDeliveryPage({ data: [], _pagination: { next_page: "next" } })).toThrow("continuation");
    expect(parseWebhookDeliveryPage({ data: [], _pagination: { next_page: null } })).toEqual({ attempts: [], complete: true });
  });
});
