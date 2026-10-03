import { describe, expect, it } from "vitest";
import type { ConfigItem } from "@agency_hub_core/contracts";
import { CONFIG_DESCRIPTORS } from "@agency_hub_core/shared";
import { CONFIG_COPY_RU } from "../apps/dashboard/src/pages/settings/configCopyRu.ts";
import {
  matchesConfigFilter,
  matchesConfigSearch,
  runningDiffersFromDefault,
} from "../apps/dashboard/src/pages/settings/configurationView.ts";

function item(overrides: Partial<ConfigItem> = {}): ConfigItem {
  return {
    key: "fanslyLiveOverlayReadPages",
    envName: "FANSLY_LIVE_OVERLAY_READ_PAGES",
    configField: "fanslyLiveOverlayReadPages",
    kind: "string",
    subsystem: "Fansly",
    label: "Fansly live overlay readers",
    default: "",
    editability: "editable",
    runtimeApply: "live",
    comparable: true,
    secret: false,
    note: null,
    costWarning: null,
    destructive: false,
    stagedGroup: null,
    stagedOrder: null,
    requires: [],
    source: "env",
    desired: null,
    runningState: "off",
    desiredEffective: null,
    overrideVersion: null,
    pendingApply: false,
    drift: false,
    live: true,
    running: [{
      role: "api", instanceId: "api-1", value: "", masked: false,
      state: null, lastSeenAt: "2026-09-10T10:00:00Z",
    }],
    ...overrides,
  };
}

describe("configuration discovery", () => {
  it("provides friendly explanations for every registry entry and cost warning", () => {
    for (const descriptor of CONFIG_DESCRIPTORS) {
      const copy = CONFIG_COPY_RU[descriptor.key];
      expect(copy, descriptor.key).toBeDefined();
      expect(copy?.title, descriptor.key).toBeTruthy();
      expect(copy?.short, descriptor.key).toBeTruthy();
      expect(copy?.long, descriptor.key).toBeTruthy();
      if (descriptor.costWarning) expect(copy?.warning, descriptor.key).toBeTruthy();
    }
  });

  it("searches case-insensitive words in labels, machine keys and Russian explanations", () => {
    expect(matchesConfigSearch(item(), "FANSLY OVERLAY")).toBe(true);
    expect(matchesConfigSearch(item(), "ещё не подтверждены")).toBe(true);
    expect(matchesConfigSearch(item(), "unknown_key")).toBe(false);
  });

  it("never searches running or desired secret values", () => {
    const secret = item({
      key: "testSecret", envName: "TEST_SECRET", kind: "secret", secret: true,
      desired: "do-not-index", running: [],
    });
    expect(matchesConfigSearch(secret, "do-not-index")).toBe(false);
  });

  it("includes partial fleet boot state in attention without treating scalar state as a flag", () => {
    expect(matchesConfigFilter(item({ runtimeApply: "boot", runningState: "unknown" }), "attention")).toBe(true);
    expect(matchesConfigFilter(item({ runningState: "unknown" }), "attention")).toBe(false);
    expect(matchesConfigFilter(item({ pendingApply: true }), "attention")).toBe(true);
  });

  it("does not confuse false with its translated display label when comparing defaults", () => {
    const flag = item({ kind: "boolean", default: "false" });
    flag.running[0]!.value = false;
    expect(runningDiffersFromDefault(flag)).toBe(false);
    flag.running[0]!.value = true;
    expect(runningDiffersFromDefault(flag)).toBe(true);
  });
});
