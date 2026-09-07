import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OFAPI_COLLECTION_LEGACY_OPERATIONS,
  OFAPI_COLLECTION_REGISTRY,
  OFAPI_READ_CATALOG,
  classifyOfapiCollectionOperation,
  findOfapiReadDefinition,
} from "@agency_hub_core/shared";
import {
  OFAPI_READ_GATEWAY_OPERATIONS,
  resolveOfapiReadGatewayRequest,
} from "../apps/runtime/src/services/ofapi-read-gateway.ts";

const GATEWAY_SOURCE = new URL("../apps/runtime/src/services/ofapi-read-gateway.ts", import.meta.url);

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

  // Review #136: `ofapi_gateway_fans_all` fell through the regex classifier
  // into profile_notifications (off by default) and was absent from the
  // legacy list, so the read gateway refused the desktop's fan roster with
  // collection_off while `fans_active` worked. The audit below is derived
  // from the gateway's own operation table, never from a hand-kept list.
  describe("every read-gateway operation is admitted deliberately", () => {
    const baseline = new Set(OFAPI_COLLECTION_REGISTRY.filter(row => row.baseline).map(row => row.id));
    const legacy = new Set<string>(OFAPI_COLLECTION_LEGACY_OPERATIONS);

    it("lists in the table every gateway operation literal the resolver source can emit", () => {
      const source = readFileSync(GATEWAY_SOURCE, "utf8");
      const literals = new Set(Array.from(source.matchAll(/"(ofapi_gateway_[a-z_]+)"/g), match => match[1]!));
      expect([...literals].sort()).toEqual([...OFAPI_READ_GATEWAY_OPERATIONS].sort());
      // No template-built operation names: those escape both the table and the
      // compiler (`ofapi_gateway_fans_${segments[2]}` is how fans_all got lost).
      expect(source).not.toMatch(/`ofapi_gateway_[a-z_]*\$\{/);
    });

    it("admits every table operation as an enumerated legacy read or an on-by-default category", () => {
      for (const operation of OFAPI_READ_GATEWAY_OPERATIONS) {
        const classification = classifyOfapiCollectionOperation(operation);
        expect(classification, `${operation} must classify`).not.toBeNull();
        const explicit = legacy.has(operation)
          || classification === "diagnostic"
          || classification === "command"
          || baseline.has(classification as never);
        expect(explicit, `${operation} classifies as ${classification} without a legacy entry: it would be refused collection_off by default`).toBe(true);
      }
    });

    it("carries an explicit registry category for every catalog read the gateway forwards", () => {
      for (const definition of OFAPI_READ_CATALOG) {
        expect(findOfapiReadDefinition(definition.operation)?.category, definition.operation).toBeDefined();
        expect(OFAPI_COLLECTION_REGISTRY.some(row => row.id === definition.category), definition.operation).toBe(true);
      }
    });

    it("resolves both fan roster routes into admitted core_audience reads", () => {
      for (const variant of ["all", "active"] as const) {
        const request = resolveOfapiReadGatewayRequest(`acct_test/fans/${variant}`, { limit: "5" });
        expect(request).toMatchObject({ kind: "proxy", operation: `ofapi_gateway_fans_${variant}` });
        const operation = (request as { operation: string }).operation;
        expect(classifyOfapiCollectionOperation(operation)).toBe("core_audience");
        expect(legacy.has(operation)).toBe(true);
      }
      expect(OFAPI_COLLECTION_REGISTRY.find(row => row.id === "core_audience")?.legacyOperations).toEqual(
        expect.arrayContaining(["ofapi_gateway_fans_all", "ofapi_gateway_fans_active"]),
      );
    });
  });
});
