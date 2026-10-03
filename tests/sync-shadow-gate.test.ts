import { describe, expect, it } from "vitest";

import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { FANSLY_ROUTES, ROUTE_POLICY_HASH } from "../apps/runtime/src/sync/fansly/routes.ts";
import {
  FANSLY_REGISTRY_HASH,
  judgeShadowFingerprint,
  judgeSyncBuild,
  OWNER_START_SKEW_MS,
  registryHashOf,
  SHADOW_FINGERPRINT_VERSION,
  type SyncBuildFacts,
} from "../apps/runtime/src/sync/report/shadow-fingerprint.ts";
import { checkedBudgets, routeBudgetBound, walkKeys } from "../apps/runtime/src/sync/report/shadow-routes.ts";

// The shadow gate's pure rules (step 3b ruling 12): which sync build a
// window's shadow ran on, what the switch requires of a report's fingerprint,
// the route budget bound of amendment A1 and the keys the endless-walk check
// judges. The SQL halves run in tests/sync-shadow-report.integration.test.ts.

const START = new Date("2026-10-03T09:00:00.000Z");
const WINDOW = { start: START };
const before = (ms: number) => new Date(START.getTime() - ms);

function facts(overrides: Partial<SyncBuildFacts> = {}): SyncBuildFacts {
  return {
    instances: [{ imageTag: "abc123", startedAt: before(20 * 60_000) }],
    pages: [
      { page: "ari-1", acquiredAt: before(19 * 60_000), foreignAttempts: 0 },
      { page: "lora-1", acquiredAt: before(19 * 60_000), foreignAttempts: 0 },
    ],
    ...overrides,
  };
}

describe("the window's sync build (fingerprint)", () => {
  it("is the one fresh sync build that started before the window and owned every page through it", () => {
    expect(judgeSyncBuild(facts(), WINDOW)).toEqual({ sync: "abc123", unproven: null });
    // Two instances of one build (a deploy's overlap) prove it as well.
    expect(judgeSyncBuild(facts({ instances: [
      { imageTag: "abc123", startedAt: before(20 * 60_000) }, { imageTag: "abc123", startedAt: before(30 * 60_000) },
    ] }), WINDOW)).toEqual({ sync: "abc123", unproven: null });
    // An owner acquisition a little before the heartbeat's start: the app
    // clock against the database clock.
    expect(judgeSyncBuild(facts({ pages: [{ page: "ari-1", acquiredAt: before(20 * 60_000 + OWNER_START_SKEW_MS), foreignAttempts: 0 }] }), WINDOW).sync)
      .toBe("abc123");
  });

  it.each<[string, Partial<SyncBuildFacts> | null, string]>([
    ["no window", null, "no window"],
    ["no fresh heartbeat", { instances: [] }, "no fresh sync heartbeat"],
    ["a heartbeat without a build", { instances: [{ imageTag: null, startedAt: before(60_000) }] }, "without a build identity"],
    ["an unknown build", { instances: [{ imageTag: "unknown", startedAt: before(60_000) }] }, "without a build identity"],
    ["two builds", { instances: [{ imageTag: "abc123", startedAt: before(60_000) }, { imageTag: "def456", startedAt: before(60_000) }] },
      "sync heartbeats of 2 builds (abc123, def456)"],
    ["a process started in the window (a deploy)", { instances: [{ imageTag: "abc123", startedAt: new Date(START.getTime() + 60_000) }] },
      "after the window start: a deploy or restart in or after the window"],
    ["no page in shadow", { pages: [] }, "no listed page is in shadow"],
    ["an ownerless page", { pages: [{ page: "ari-1", acquiredAt: null, foreignAttempts: 0 }] }, "ari-1 has no owner"],
    ["a page taken in the window", { pages: [{ page: "ari-1", acquiredAt: new Date(START.getTime() + 1_000), foreignAttempts: 0 }] },
      "ari-1's owner took it 2026-10-03T09:00:01.000Z, after the window start"],
    ["a page owned by an earlier process", { pages: [{ page: "ari-1", acquiredAt: before(25 * 60_000), foreignAttempts: 0 }] },
      "before the running sync process started"],
    ["another generation's attempts in the window", { pages: [{ page: "lora-1", acquiredAt: before(19 * 60_000), foreignAttempts: 3 }] },
      "lora-1 has 3 shadow attempt(s) of another owner generation in the window"],
  ])("is not proven with %s", (_name, overrides, why) => {
    const judged = judgeSyncBuild(facts(overrides ?? {}), overrides === null ? null : WINDOW);
    expect(judged.sync).toBeNull();
    expect(judged.unproven).toContain(why);
  });
});

describe("the switch's fingerprint check", () => {
  const fingerprint = { version: SHADOW_FINGERPRINT_VERSION, build: { sync: "abc123", unproven: null, report: "abc123" }, policyHash: ROUTE_POLICY_HASH, setting: { windowMs: [2_500] } };

  it("passes the same build and route policy, naming S of the window", () => {
    expect(judgeShadowFingerprint(fingerprint, { syncBuild: "abc123", policyHash: ROUTE_POLICY_HASH })).toEqual({
      ok: true, detail: `build abc123, route policy ${ROUTE_POLICY_HASH.slice(0, 12)}, S 2500 ms in the window`,
    });
  });

  it("refuses anything else", () => {
    const expected = { syncBuild: "abc123", policyHash: ROUTE_POLICY_HASH };
    expect(judgeShadowFingerprint(undefined, expected).ok).toBe(false);
    expect(judgeShadowFingerprint("x", expected).ok).toBe(false);
    expect(judgeShadowFingerprint({ ...fingerprint, build: {} }, expected).detail).toContain("proves no single sync build through its window (no build)");
    expect(judgeShadowFingerprint(fingerprint, { ...expected, syncBuild: "def456" }).detail).toContain("ran build abc123, sync runs def456");
    expect(judgeShadowFingerprint({ ...fingerprint, policyHash: undefined }, expected).detail).toContain("ran route policy none");
  });
});

describe("the registry's hash", () => {
  it("covers every entry's data in any key order, never its module", () => {
    const a = { key: "x.poll", kind: "poll", period: { everyMs: 60_000 }, module: async () => ({}) };
    const reordered = { period: { everyMs: 60_000 }, kind: "poll", key: "x.poll" };
    expect(registryHashOf([a])).toBe(registryHashOf([reordered]));
    expect(registryHashOf([a])).not.toBe(registryHashOf([{ ...reordered, period: { everyMs: 120_000 } }]));
    expect(FANSLY_REGISTRY_HASH).toBe(registryHashOf(FANSLY_RESOURCE_SPECS));
    expect(FANSLY_REGISTRY_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the shadow route checks' rules", () => {
  it("bounds a strict budget at ⌈W/T⌉ + 1 sends a span (amendment A1)", () => {
    expect(routeBudgetBound(60_000, 4_000)).toBe(16);
    expect(routeBudgetBound(60_000, 5_000)).toBe(13);
    expect(routeBudgetBound(60_000, 12_000)).toBe(6);
    expect(routeBudgetBound(300_000, 12_000)).toBe(26);
    expect(routeBudgetBound(60_000, 3_530)).toBe(18);
  });

  it("checks every wire route at its current rate and every family", () => {
    const budgets = new Map(checkedBudgets().map((budget) => [budget.budget, budget]));
    const wire = [...FANSLY_ROUTES.values()].filter((spec) => spec.wire !== null).map((spec) => spec.route);
    for (const route of wire) expect(budgets.get(route)?.operations).toEqual([route]);
    expect(budgets.get("messaging.groups")).toMatchObject({ perMin: 12, intervalMs: 5_000 });
    expect(budgets.get("media.offer_stats")).toMatchObject({ perMin: 5, intervalMs: 12_000 });
    expect(budgets.get("messages.page")).toMatchObject({ perMin: 15, intervalMs: 4_000 });
    expect(budgets.get("family:messaging")).toMatchObject({
      perMin: 15, intervalMs: 4_000, operations: ["messaging.groups", "group.detail", "messages.page"],
    });
    // The earnings family's legacy-only route never carries an engine send.
    expect(budgets.get("family:earnings")!.operations).not.toContain("earnings.overview");
    expect(budgets.get("family:earnings")).toMatchObject({ perMin: 17, intervalMs: 3_530 });
    expect(budgets.size).toBe(wire.length + 2);
  });

  it("judges the runs of every key but the polls", () => {
    const keys = walkKeys();
    expect(keys).toEqual(expect.arrayContaining(["media-stats.walk", "catalog.vault", "followers.reconcile", "dm-messages.history"]));
    for (const spec of FANSLY_RESOURCE_SPECS) expect(keys.includes(spec.key)).toBe(spec.kind !== "poll");
  });
});
