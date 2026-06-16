import { describe, expect, it } from "vitest";

import { buildRunningSnapshot } from "@agency_hub_core/shared";
import type { RuntimeInstanceRow } from "@agency_hub_core/db";

import { assembleConfigView } from "../apps/runtime/src/services/app-config-service.ts";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";

const NOW = new Date("2026-06-16T12:00:00.000Z").getTime();
const FRESH = new Date(NOW - 30_000); // 30s ago -> active
const STALE = new Date(NOW - 5 * 60_000); // 5min ago -> stale (> 3min window)

function row(
  role: string,
  instanceId: string,
  config: Record<string, unknown>,
  lastSeenAt: Date,
): RuntimeInstanceRow {
  return {
    role,
    instanceId,
    startedAt: new Date(NOW - 60_000),
    lastSeenAt,
    imageTag: null,
    running: buildRunningSnapshot(config as never),
  };
}

function item(view: ConfigViewResponse, key: string): ConfigItem {
  const found = view.subsystems.flatMap((group) => group.items).find((candidate) => candidate.key === key);
  if (!found) throw new Error(`item ${key} not found`);
  return found;
}

function roleStatus(view: ConfigViewResponse, role: string): string {
  return view.roleStatuses.find((entry) => entry.role === role)?.status ?? "absent";
}

const API_CONFIG = { ofapiDmDailyCreditBudget: 500, ofapiApiKey: "SECRET_LEAK_123" };
const WORKER_CONFIG = { ofapiDmDailyCreditBudget: 999, ofapiApiKey: undefined };

describe("assembleConfigView", () => {
  it("flags scalar drift and never leaks secret material", () => {
    const view = assembleConfigView(
      [row("api", "a1", API_CONFIG, FRESH), row("worker", "w1", WORKER_CONFIG, FRESH)],
      NOW,
    );

    expect(roleStatus(view, "api")).toBe("active");
    expect(roleStatus(view, "worker")).toBe("active");

    const budget = item(view, "ofapiDmDailyCreditBudget");
    expect(budget.drift).toBe(true);
    expect(budget.running.map((r) => r.value).sort()).toEqual([500, 999]);

    expect(JSON.stringify(view)).not.toContain("SECRET_LEAK_123");
  });

  it("reports set/unset drift on a masked secret", () => {
    const view = assembleConfigView(
      [row("api", "a1", API_CONFIG, FRESH), row("worker", "w1", WORKER_CONFIG, FRESH)],
      NOW,
    );

    const apiKey = item(view, "ofapiApiKey");
    expect(apiKey.secret).toBe(true);
    expect(apiKey.drift).toBe(true); // set in api, unset in worker
    expect(apiKey.running.every((r) => r.value === null && r.masked)).toBe(true);
    expect(apiKey.running.map((r) => r.state).sort()).toEqual(["set", "unset"]);
  });

  it("surfaces a stale instance instead of hiding it, and excludes it from drift", () => {
    const view = assembleConfigView(
      [row("api", "a1", API_CONFIG, FRESH), row("worker", "w1", WORKER_CONFIG, STALE)],
      NOW,
    );

    expect(roleStatus(view, "api")).toBe("active");
    expect(roleStatus(view, "worker")).toBe("stale");
    expect(view.instances).toHaveLength(2);
    expect(view.instances.find((i) => i.role === "worker")?.status).toBe("stale");

    // Only the active api instance feeds running/drift.
    const budget = item(view, "ofapiDmDailyCreditBudget");
    expect(budget.running).toHaveLength(1);
    expect(budget.running[0]!.value).toBe(500);
    expect(budget.drift).toBe(false);
  });

  it("flags an expected role with no row at all as missing", () => {
    const view = assembleConfigView([row("api", "a1", API_CONFIG, FRESH)], NOW);
    expect(roleStatus(view, "api")).toBe("active");
    expect(roleStatus(view, "worker")).toBe("missing");
  });
});
