import { describe, expect, it } from "vitest";
import {
  OFAPI_COLLECTION_CATEGORIES,
  OFAPI_COLLECTION_REGISTRY,
  OFAPI_READ_CATALOG,
  OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES,
  classifyOfapiCollectionOperation,
  resolveOfapiCatalogPath,
} from "@agency_hub_core/shared";
import { ofapiCollectionCategorySchema } from "../packages/contracts/src/routes-ofapi-collection.ts";
import { resolveOfapiReadGatewayRequest } from "../apps/runtime/src/services/ofapi-read-gateway.ts";
import { validateOfapiInteractiveResponseShape } from "../apps/runtime/src/services/ofapi-capture-contract.ts";
import { normalizeOfapiRead, ofapiReadCoverage } from "../apps/runtime/src/services/ofapi-read-normalization.ts";
import { planOfapiReadCollection, type OfapiCollectionJob } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import {
  OFAPI_WELCOME_TEMPLATE_OPERATION,
  ofapiWelcomeTemplateFacts,
  ofapiWelcomeTemplateFromSnapshot,
  ofapiWelcomeTemplatePriceMills,
} from "../apps/runtime/src/services/ofapi-welcome-template.ts";

const welcome = OFAPI_READ_CATALOG.find((row) => row.id === "welcome_message")!;

// The documented GET /settings/welcome-message example (openapi.json, getWelcomeMessage).
const documented = {
  id: "12345678901",
  template: "reply_on_subscribe",
  text: "<p>Hey, welcome to my profile</p>",
  displayText: "<p>Hey, welcome to my profile</p>",
  price: 0,
  lockedText: false,
  previews: [],
  isMediaReady: true,
  mediaCount: 1,
  media: [{ id: 1234567890, type: "photo", canView: true }],
  createdAt: "2026-04-28T20:44:55+00:00",
  isActive: false,
};

function job(selection: string[] = []): OfapiCollectionJob {
  return {
    category: "account_settings",
    target: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z", selection },
  } as unknown as OfapiCollectionJob;
}

describe("account_settings: the welcome-template collection category", () => {
  it("registers a scheduled read category that is off by default and feeds the contract enum", () => {
    expect(OFAPI_COLLECTION_CATEGORIES).toContain("account_settings");
    expect(OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES).toContain("account_settings");
    expect(ofapiCollectionCategorySchema.options).toContain("account_settings");
    expect(OFAPI_COLLECTION_REGISTRY.find((row) => row.id === "account_settings")).toMatchObject({
      label: "Account settings: welcome message",
      modes: ["off", "on_demand", "scheduled"],
      baseline: false,
      consumers: ["dashboard"],
      supportsOneOff: true,
      priceUnit: "physical_calls",
      legacyOperations: [],
    });
  });

  it("catalogs one default 1-credit snapshot read of the template", () => {
    expect(welcome).toMatchObject({
      operation: OFAPI_WELCOME_TEMPLATE_OPERATION,
      path: "settings/welcome-message",
      category: "account_settings",
      shape: "object",
      pagination: "none",
      query: {},
      detail: false,
      defaultCollect: true,
      granularity: "snapshot",
      collectionOnly: true,
    });
    expect(welcome.reservedCredits).toBeUndefined();
    expect(OFAPI_READ_CATALOG.filter((row) => row.category === "account_settings")).toEqual([welcome]);
    expect(classifyOfapiCollectionOperation(OFAPI_WELCOME_TEMPLATE_OPERATION)).toBe("account_settings");
  });

  it("plans exactly one GET with no query for a scheduled run", () => {
    expect(planOfapiReadCollection(job(), "acct_test")).toEqual([{
      operation: OFAPI_WELCOME_TEMPLATE_OPERATION,
      pathname: "/acct_test/settings/welcome-message",
      query: {},
      detail: false,
    }]);
    expect(() => planOfapiReadCollection(job(["welcome_message?limit=1"]), "acct_test")).toThrow();
    expect(() => planOfapiReadCollection(job(["me"]), "acct_test")).toThrow();
    expect(resolveOfapiCatalogPath("acct_test/settings/welcome-message", {})?.definition.operation)
      .toBe(OFAPI_WELCOME_TEMPLATE_OPERATION);
  });

  it("leaves the desktop's capture-first gateway read and its admission unchanged", () => {
    const request = resolveOfapiReadGatewayRequest("acct_test/settings/welcome-message", {});
    expect(request).toMatchObject({ kind: "proxy", operation: "ofapi_gateway_welcome_message", captureFirst: true });
    expect(request).not.toHaveProperty("collectionContext");
    expect(classifyOfapiCollectionOperation("ofapi_gateway_welcome_message")).toBe("core_messages");
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_welcome_message", { data: {} })).toBe(false);
  });

  it("normalizes the documented template into one complete snapshot item with explicit facts", () => {
    const body = { data: documented, _meta: { _credits: { used: 1, balance: 9 } } };
    const items = normalizeOfapiRead(welcome, body, "/acct_test/settings/welcome-message");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nativeId: "12345678901",
      kind: "welcome_message",
      fanId: null,
      welcomeTemplate: { enabled: false, hasText: true, hasMedia: true, priceMills: 0 },
    });
    expect(ofapiReadCoverage(welcome, body, "/acct_test/settings/welcome-message", {}))
      .toMatchObject({ state: "complete", reason: null, nextQuery: null });
    // No template object (null, a list) is a contract rejection: the scheduled
    // run parks as paused with the raw response retained (runbook, "Welcome
    // template snapshot"), as the desktop's gateway read of this path refuses it.
    expect(() => normalizeOfapiRead(welcome, { data: [] })).toThrow("contract rejected");
    expect(() => normalizeOfapiRead(welcome, { data: null })).toThrow("contract rejected");
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_welcome_message", { data: null })).toBe(false);
  });

  it("converts the provider's dollar price to mills explicitly", () => {
    // OnlyFans prices the template in US dollars: $5 is 5000 mills, never 5 or 500.
    expect(ofapiWelcomeTemplatePriceMills(5)).toBe(5000);
    expect(ofapiWelcomeTemplatePriceMills(200)).toBe(200_000);
    expect(ofapiWelcomeTemplatePriceMills(4.99)).toBe(4990);
    expect(ofapiWelcomeTemplatePriceMills("12.5")).toBe(12_500);
    expect(ofapiWelcomeTemplatePriceMills(0)).toBe(0);
    for (const invalid of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, "free", "-3", "1e3", " 5", true, 1e21,
      "99999999999999999999"])
      expect(ofapiWelcomeTemplatePriceMills(invalid), String(invalid)).toBeNull();
    // One cap ($1,000,000) for a number and a decimal string alike.
    expect(ofapiWelcomeTemplatePriceMills(1_000_000)).toBe(1_000_000_000);
    expect(ofapiWelcomeTemplatePriceMills("1000000")).toBe(1_000_000_000);
    expect(ofapiWelcomeTemplatePriceMills(5_000_000)).toBeNull();
    expect(ofapiWelcomeTemplatePriceMills("5000000")).toBeNull();
    const [paid] = normalizeOfapiRead(welcome, { data: { ...documented, price: 7 } });
    expect(paid).toMatchObject({ welcomeTemplate: { priceMills: 7000 } });
  });

  it("derives enabled, text and media facts without guessing", () => {
    expect(ofapiWelcomeTemplateFacts({ isActive: true, text: "<p></p>", media: [], mediaCount: 0 }))
      .toEqual({ enabled: true, hasText: false, hasMedia: false, priceMills: null });
    expect(ofapiWelcomeTemplateFacts({ text: " <p>&nbsp;</p> ", mediaCount: 2 }))
      .toEqual({ enabled: null, hasText: false, hasMedia: true, priceMills: null });
    expect(ofapiWelcomeTemplateFacts({ isActive: "yes", text: "hi", price: 3 }))
      .toEqual({ enabled: null, hasText: true, hasMedia: false, priceMills: 3000 });
  });

  it("reads a stored snapshot back as the H-7c welcomeTemplate shape and refuses foreign items", () => {
    const [item] = normalizeOfapiRead(welcome, { data: { ...documented, isActive: true, price: 10 } });
    const observedAt = "2026-10-03T00:05:00.000Z";
    expect(ofapiWelcomeTemplateFromSnapshot({ observedAt, items: [item] })).toEqual({
      ref: "12345678901", observedAt, enabled: true, hasText: true, hasMedia: true, priceMills: 10_000,
    });
    expect(ofapiWelcomeTemplateFromSnapshot({ observedAt, items: [] })).toBeNull();
    expect(ofapiWelcomeTemplateFromSnapshot({ observedAt, items: [{ nativeId: "1", attributes: {} }] })).toBeNull();
    expect(ofapiWelcomeTemplateFromSnapshot({ observedAt, items: [{
      nativeId: "1", welcomeTemplate: { enabled: true, hasText: true, hasMedia: false, priceMills: 4.5 },
    }] })).toBeNull();
  });
});
