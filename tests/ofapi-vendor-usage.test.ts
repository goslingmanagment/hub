import { describe, expect, it, vi } from "vitest";
import { ofapiUsageWindowSchema } from "@agency_hub_core/contracts";
import { parseOfapiVendorUsage } from "../apps/runtime/src/services/ofapi-vendor-usage.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiResponseEvidence } from "../apps/runtime/src/services/ofapi-response-evidence.ts";
import { parseOfapiJsonBytes } from "../apps/runtime/src/services/ofapi-capture-contract.ts";

const window = { from: "2026-01-01", to: "2026-01-02", groupBy: "endpoint" as const, accountId: null, includeToday: false };
const response = { data: { from: window.from, to: window.to, group_by: "endpoint", includes_today: false,
  totals: { credits: 7, requests: 2 }, results: [{ endpoint: null, credit_type: "webhook", credits: 7, requests: 2 }] } };
describe("vendor usage evidence", () => {
  it("prefers current response headers to stale cached body cost and retains the conflict", () => {
    const result = ofapiResponseEvidence({ _meta: { _credits: { used: 1, balance: 100 } } }, {
      "x-ofapi-credits-used": "0", "x-ofapi-credits-balance": "99", "idempotent-replayed": "true",
    });
    expect(result.meta).toMatchObject({ creditsUsed: 0, creditBalance: 99 });
    expect(result.evidence).toMatchObject({ bodyUsed: 1, headerUsed: 0, conflict: true, replayed: true });
  });
  it("accounts bodyless 304, binary and failed JSON via headers without calling them successful parses", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([255, 216, 255]), Buffer.from("{broken")]) {
      expect(parseOfapiJsonBytes(bytes, { "x-ofapi-credits-used": "3", "x-ofapi-credits-balance": "0" }))
        .toMatchObject({ validJson: false, creditsUsed: 3, balanceAfter: 0 });
    }
    expect(ofapiResponseEvidence({}, { "idempotent-replayed": "true" }).meta.creditsUsed).toBeNull();
    expect(ofapiResponseEvidence({}, { "x-ofapi-credits-used": "NaN" }).meta.creditsUsed).toBeNull();
  });
  it("preserves unattributed usage separately from account endpoints", () => {
    expect(parseOfapiVendorUsage(response, window).results[0]).toMatchObject({ accountId: null, endpoint: null, credits: 7 });
  });
  it("refuses malformed, mismatched and incomplete scope instead of fabricating zero", () => {
    expect(() => parseOfapiVendorUsage({ data: {} }, window)).toThrow();
    expect(() => parseOfapiVendorUsage(response, { ...window, groupBy: "day" })).toThrow("different scope");
    expect(() => parseOfapiVendorUsage({ data: { ...response.data, includes_today: true } }, window)).toThrow("different scope");
  });
  it("validates real dates and the bounded window before a free request", () => {
    expect(ofapiUsageWindowSchema.safeParse({ ...window, from: "2026-02-30" }).success).toBe(false);
    expect(ofapiUsageWindowSchema.safeParse({ ...window, from: "2024-01-01" }).success).toBe(false);
    expect(ofapiUsageWindowSchema.safeParse(window).success).toBe(true);
  });
  it("uses exact filters, raw capture and zero fallback even at zero balance", async () => {
    const sink = vi.fn(async () => true);
    const capture = vi.fn(async () => ({ observationId: 1, receivedAt: new Date() }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...response, _meta: { _credits: { balance: 0 } } }))));
    try {
      const client = createOfapiClient({ apiKey: "test", restDelayMs: 0, onCreditSpend: sink, onAdminResponse: capture });
      const result = await client.getCreditUsage!({ ...window, accountId: "acct_test" });
      expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("group_by=endpoint&include_today=false&account_id=acct_test");
      expect(capture).toHaveBeenCalledTimes(1);
      expect(result.evidence?.observationId).toBe(1);
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ credits: 0, estimated: false, balanceAfter: 0 }));
    } finally { vi.unstubAllGlobals(); }
  });
});
