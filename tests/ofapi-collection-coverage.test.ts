import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFAPI_COLLECTION_LEGACY_OPERATIONS, OFAPI_COLLECTION_REGISTRY, classifyOfapiCollectionOperation } from "@agency_hub_core/shared";

describe("OFAPI collection dispatch coverage", () => {
  it("keeps managed HTTP seams behind physical admission", () => {
    const source = readFileSync(new URL("../apps/runtime/src/services/ofapi.ts", import.meta.url), "utf8");
    for (const name of ["observedListRequest", "proxyReadRequest", "dispatchGovernedRawRequest"]) {
      const start = source.indexOf(`async function ${name}(`);
      const next = source.indexOf("\n  async function ", start + 1);
      const body = source.slice(start, next < 0 ? undefined : next);
      expect(body.indexOf("beforeCollectionRequest"), name).toBeGreaterThan(0);
      expect(body.indexOf("beforeCollectionRequest"), name).toBeLessThan(body.indexOf("await fetch("));
    }
  });
  it("registers the closed migration list and keeps new categories off", () => {
    for (const operation of OFAPI_COLLECTION_LEGACY_OPERATIONS) expect(classifyOfapiCollectionOperation(operation), operation).not.toBeNull();
    expect(OFAPI_COLLECTION_REGISTRY.filter(row => row.baseline).map(row => row.id)).toEqual(["core_messages", "core_payments", "core_audience"]);
    expect(classifyOfapiCollectionOperation("ofapi_unclassified_new_call")).toBeNull();
  });
});
