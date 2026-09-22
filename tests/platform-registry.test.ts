import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SYNC_STREAMS } from "@agency_hub_core/db";
import { PLATFORM_STREAMS, checkAdapterConformance } from "@agency_hub_core/platform-core";

import {
  appPlatformRegistry,
  fanslyPlatformAdapter,
  onlyfansPlatformAdapter,
} from "../apps/runtime/src/platforms/registry.ts";
import { resolveStreamsForScope } from "../apps/runtime/src/services/sync-control.ts";

describe("platform registry (Stage 18)", () => {
  it("the platform-core stream vocabulary mirrors the db SYNC_STREAMS exactly", () => {
    expect([...PLATFORM_STREAMS]).toEqual([...SYNC_STREAMS]);
  });

  it("capabilities cover resolveStreamsForScope outputs for every scope", () => {
    for (const platform of ["fansly", "onlyfans"] as const) {
      const capabilities = new Set(appPlatformRegistry.get(platform).capabilities.streams);
      for (const scope of ["light", "followers", "all", "data", "messages", "posts"] as const) {
        let streams: ReturnType<typeof resolveStreamsForScope>;
        try {
          streams = resolveStreamsForScope(platform, scope);
        } catch {
          continue; // followers scope is fansly-only by design
        }
        for (const stream of streams) {
          expect(capabilities.has(stream), `${platform}/${scope}/${stream}`).toBe(true);
        }
      }
    }
  });

  it("scope policies are subsets of capabilities (a scope can never schedule an unservable stream)", () => {
    for (const adapter of appPlatformRegistry.all()) {
      const capabilities = new Set(adapter.capabilities.streams);
      for (const [scope, streams] of Object.entries(adapter.syncScopes)) {
        for (const stream of streams ?? []) {
          expect(capabilities.has(stream), `${adapter.key}/${scope}/${stream}`).toBe(true);
        }
      }
    }
  });

  it("adapters conform: every declared stream has a handler, none undeclared", () => {
    expect(checkAdapterConformance(fanslyPlatformAdapter)).toEqual([]);
    expect(checkAdapterConformance(onlyfansPlatformAdapter)).toEqual([]);
  });

  it("the registry resolves both platforms and fails loudly on unknowns", () => {
    expect(appPlatformRegistry.get("fansly").displayName).toBe("Fansly");
    expect(appPlatformRegistry.get("onlyfans").capabilities.webhooks).toBe(true);
    expect(appPlatformRegistry.keys().sort()).toEqual(["fansly", "onlyfans"]);
    expect(() => appPlatformRegistry.get("myspace")).toThrow(/Unknown platform "myspace"/);
    expect(appPlatformRegistry.maybeGet("myspace")).toBeUndefined();
  });

  it("declares the honest custody kinds (browser session vs vendor API key)", () => {
    expect(fanslyPlatformAdapter.session.kind).toBe("browser_session");
    expect(onlyfansPlatformAdapter.session.kind).toBe("api_key");
    expect(onlyfansPlatformAdapter.capabilities.billing).toBe("credit_metered");
    expect(fanslyPlatformAdapter.capabilities.writes).toEqual([]);
  });

  it("the platform-branch ratchet holds its budget", () => {
    const output = execFileSync(
      "node",
      [join(__dirname, "..", "scripts", "check-platform-branches.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toMatch(/platform === branch sites: \d+ \(budget \d+\)/);
  });
});
