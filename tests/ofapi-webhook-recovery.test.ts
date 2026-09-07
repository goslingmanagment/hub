import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfapiClient, type OfapiCreditSpendObservation } from "../apps/runtime/src/services/ofapi.ts";
import { parseWebhookDeliveryPage } from "../apps/runtime/src/services/ofapi-webhook-recovery.ts";
import { parseOfapiWebhookEventCatalog } from "../apps/runtime/src/services/ofapi-webhook-event-catalog.ts";

afterEach(() => vi.unstubAllGlobals());
describe("OFAPI webhook recovery wire contract", () => {
  it("reads the free event catalog without query or subscription mutation even while accounting is pending", async () => {
    const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({data:[{value:"messages.received",description:"Message received"}]})));
    vi.stubGlobal("fetch",fetch);
    const spend=vi.fn<(row: OfapiCreditSpendObservation)=>boolean>(()=>false);
    const client=createOfapiClient({apiKey:"synthetic",restDelayMs:0,onCreditSpend:spend});
    await client.listWebhookEvents!();await client.listWebhookEvents!();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url,init])=>String(url)==="https://app.onlyfansapi.com/api/webhooks/events"&&init?.method==="GET")).toBe(true);
    expect(spend.mock.calls[0]?.[0]).toMatchObject({operation:"ofapi_webhook_event_catalog",credits:0,estimated:false});
    expect(parseOfapiWebhookEventCatalog({data:[{value:"new_family.future_event",description:"New provider event"}]})).toHaveLength(1);
    expect(()=>parseOfapiWebhookEventCatalog({data:[{value:"bad"}]})).toThrow();
    expect(()=>parseOfapiWebhookEventCatalog({data:[{value:"messages.received",description:"a"},{value:"messages.received",description:"b"}]})).toThrow();
  });
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
