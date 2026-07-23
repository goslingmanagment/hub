import { describe, expect, it } from "vitest";

import { buildRunningSnapshot, RUNNING_SCHEMA_VERSION } from "@agency_hub_core/shared";
import type { ConfigOverrideRecord, RuntimeInstanceRow } from "@agency_hub_core/db";

import { assembleConfigView, getRunningFlagState } from "../apps/runtime/src/services/app-config-service.ts";
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

  it("shows every service-proxy field as masked set/unset metadata only", () => {
    const config = {
      serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
      serviceEgressProxyUsername: "fake-service-user",
      serviceEgressProxyPassword: "fake-service-password",
    };
    const view = assembleConfigView([row("api", "a1", config, FRESH)], NOW);

    for (const key of [
      "serviceEgressProxyUrl",
      "serviceEgressProxyUsername",
      "serviceEgressProxyPassword",
    ]) {
      const proxyItem = item(view, key);
      expect(proxyItem.editability).toBe("never");
      expect(proxyItem.runtimeApply).toBe("none");
      expect(proxyItem.running).toEqual([
        expect.objectContaining({ value: null, masked: true, state: "set" }),
      ]);
    }
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("proxy.example.internal");
    expect(serialized).not.toContain("fake-service-user");
    expect(serialized).not.toContain("fake-service-password");
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

describe("assembleConfigView overlay (Stage B1 live overrides)", () => {
  // transactionLookbackDays is a runtimeApply:'live' editable key (env default 7), so the
  // overlay surfaces an override and pendingApply reflects override-vs-running.
  const RUNNING = { transactionLookbackDays: 7 };

  it("populates desired/source/pendingApply for a live override that differs from running", () => {
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 14, version: 1 }],
    ]);
    const view = assembleConfigView([row("api", "a1", RUNNING, FRESH)], NOW, overrides);

    const lookback = item(view, "transactionLookbackDays");
    expect(lookback.source).toBe("override");
    expect(lookback.desired).toBe(14);
    expect(lookback.pendingApply).toBe(true);
  });

  it("leaves env defaults when no override is present", () => {
    const view = assembleConfigView([row("api", "a1", RUNNING, FRESH)], NOW, new Map());
    const lookback = item(view, "transactionLookbackDays");
    expect(lookback.source).toBe("env");
    expect(lookback.desired).toBeNull();
    expect(lookback.pendingApply).toBe(false);
  });

  it("surfaces a boot (staged) override so it shows desired/source/pendingApply", () => {
    // ofapiDmProjectionEnabled is runtimeApply 'boot' — overridable, applies after restart.
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["ofapiDmProjectionEnabled", { value: true, version: 1 }],
    ]);
    const view = assembleConfigView(
      [row("api", "a1", { ofapiDmProjectionEnabled: false }, FRESH)],
      NOW,
      overrides,
    );
    const flag = item(view, "ofapiDmProjectionEnabled");
    expect(flag.source).toBe("override");
    expect(flag.desired).toBe(true);
    // The running process still reports false (boot override needs a restart), so pending.
    expect(flag.pendingApply).toBe(true);
  });

  it("ignores an override for a runtimeApply:'none' key", () => {
    // ofapiDmDailyCreditBudget is editable but runtimeApply 'none' — not overridable.
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["ofapiDmDailyCreditBudget", { value: 750, version: 1 }],
    ]);
    const view = assembleConfigView([row("api", "a1", { ofapiDmDailyCreditBudget: 500 }, FRESH)], NOW, overrides);
    const budget = item(view, "ofapiDmDailyCreditBudget");
    expect(budget.source).toBe("env");
    expect(budget.desired).toBeNull();
    expect(budget.pendingApply).toBe(false);
  });

  it("does not flag pendingApply when the override matches the running value across all roles", () => {
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 7, version: 1 }],
    ]);
    // Both expected roles active and matching → not pending (role-complete; see M1 below).
    const view = assembleConfigView(
      [row("api", "a1", RUNNING, FRESH), row("worker", "w1", RUNNING, FRESH)],
      NOW,
      overrides,
    );
    const lookback = item(view, "transactionLookbackDays");
    expect(lookback.source).toBe("override");
    expect(lookback.desired).toBe(7);
    expect(lookback.pendingApply).toBe(false);
  });

  it("stays pending when an expected role is absent, even if the active api matches (M1, role-complete)", () => {
    // Only api is active and already reports the override value; the worker — which also
    // consumes it — has no active instance. pendingApply must stay true so the staged
    // 'pending restart' banner / 'applying…' badge does not wrongly clear during a worker
    // outage or rolling deploy. (runningState stays fail-closed 'unknown' alongside this.)
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 14, version: 1 }],
    ]);
    const view = assembleConfigView(
      [row("api", "a1", { transactionLookbackDays: 14 }, FRESH)],
      NOW,
      overrides,
    );
    expect(item(view, "transactionLookbackDays").pendingApply).toBe(true);
  });

  it("stays pending under partial apply (api applied, worker not)", () => {
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 14, version: 1 }],
    ]);
    const view = assembleConfigView(
      [
        row("api", "a1", { transactionLookbackDays: 14 }, FRESH),
        row("worker", "w1", { transactionLookbackDays: 7 }, FRESH),
      ],
      NOW,
      overrides,
    );
    expect(item(view, "transactionLookbackDays").pendingApply).toBe(true);
  });

  it("clears pendingApply only once every active instance runs the override", () => {
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 14, version: 1 }],
    ]);
    const view = assembleConfigView(
      [
        row("api", "a1", { transactionLookbackDays: 14 }, FRESH),
        row("worker", "w1", { transactionLookbackDays: 14 }, FRESH),
      ],
      NOW,
      overrides,
    );
    expect(item(view, "transactionLookbackDays").pendingApply).toBe(false);
  });
});

describe("assembleConfigView server-computed runningState + desiredEffective (Stage C / M3)", () => {
  it("boot key runningState='on' only when both expected roles report true (role-complete)", () => {
    const view = assembleConfigView(
      [
        row("api", "a1", { ofapiDmProjectionEnabled: true }, FRESH),
        row("worker", "w1", { ofapiDmProjectionEnabled: true }, FRESH),
      ],
      NOW,
    );
    expect(item(view, "ofapiDmProjectionEnabled").runningState).toBe("on");
  });

  it("boot key runningState='unknown' (fail-closed) when an expected role is missing", () => {
    // Only api reports; worker is absent → cannot prove the flag is live everywhere.
    const view = assembleConfigView([row("api", "a1", { ofapiDmProjectionEnabled: true }, FRESH)], NOW);
    expect(item(view, "ofapiDmProjectionEnabled").runningState).toBe("unknown");
  });

  it("boot key runningState='off' when any active instance reports non-true", () => {
    const view = assembleConfigView(
      [
        row("api", "a1", { ofapiDmProjectionEnabled: true }, FRESH),
        row("worker", "w1", { ofapiDmProjectionEnabled: false }, FRESH),
      ],
      NOW,
    );
    expect(item(view, "ofapiDmProjectionEnabled").runningState).toBe("off");
  });

  it("desiredEffective is the override boolean when an override exists", () => {
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["ofapiDmProjectionEnabled", { value: true, version: 1 }],
    ]);
    const view = assembleConfigView(
      [row("api", "a1", { ofapiDmProjectionEnabled: false }, FRESH)],
      NOW,
      overrides,
    );
    expect(item(view, "ofapiDmProjectionEnabled").desiredEffective).toBe(true);
  });

  it("desiredEffective falls back to the env baseline when no override exists", () => {
    // No override → desiredEffective reads the threaded env baseline (env-on here).
    const view = assembleConfigView(
      [row("api", "a1", { ofapiDmProjectionEnabled: true }, FRESH)],
      NOW,
      new Map(),
      { ofapiDmProjectionEnabled: true },
    );
    expect(item(view, "ofapiDmProjectionEnabled").desiredEffective).toBe(true);
  });

  it("desiredEffective is null for a non-boolean key (no env baseline meaning)", () => {
    // transactionLookbackDays is a number → no boolean desired meaning.
    const view = assembleConfigView([row("api", "a1", { transactionLookbackDays: 7 }, FRESH)], NOW);
    expect(item(view, "transactionLookbackDays").desiredEffective).toBeNull();
  });

  it("desiredEffective is null when the env baseline is unset (default {} baseline)", () => {
    const view = assembleConfigView([row("api", "a1", { ofapiDmProjectionEnabled: true }, FRESH)], NOW);
    expect(item(view, "ofapiDmProjectionEnabled").desiredEffective).toBeNull();
  });
});

describe("assembleConfigView schema-mismatch (unknown) handling", () => {
  // A row whose snapshot was written under an older schema version: not silently
  // dropped, surfaced as state "unknown" and counted as not-applied for pendingApply.
  function staleSnapshotRow(role: string, instanceId: string, lastSeenAt: Date): RuntimeInstanceRow {
    return {
      role,
      instanceId,
      startedAt: new Date(NOW - 60_000),
      lastSeenAt,
      imageTag: null,
      // Force a version mismatch (RUNNING_SCHEMA_VERSION is current; 1 is older).
      running: { schemaVersion: 1, values: { transactionLookbackDays: { value: 14 } } } as never,
    };
  }

  it("surfaces a mismatched-snapshot instance as state 'unknown' instead of dropping it", () => {
    const view = assembleConfigView([staleSnapshotRow("worker", "w1", FRESH)], NOW);
    const lookback = item(view, "transactionLookbackDays");
    expect(lookback.running).toHaveLength(1);
    expect(lookback.running[0]!.state).toBe("unknown");
    expect(lookback.running[0]!.value).toBeNull();
    // An unknown instance is not comparable, so no false drift.
    expect(lookback.drift).toBe(false);
  });

  it("treats a current-schema active instance that omits a key as unknown (keeps pendingApply true)", () => {
    // A current-RUNNING_SCHEMA_VERSION snapshot that simply OMITS the key — e.g. an older build
    // on the same schema version that predates it, mid rolling deploy. The omitting instance must
    // surface as 'unknown' and keep pendingApply true, not be silently dropped (which would let
    // the override read as fully applied while an active instance never reported it).
    function currentSchemaMissingKeyRow(role: string, instanceId: string): RuntimeInstanceRow {
      return {
        role,
        instanceId,
        startedAt: new Date(NOW - 60_000),
        lastSeenAt: FRESH,
        imageTag: null,
        running: { schemaVersion: RUNNING_SCHEMA_VERSION, values: {} } as never,
      };
    }
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 14, version: 1 }],
    ]);
    const view = assembleConfigView(
      [
        row("api", "a1", { transactionLookbackDays: 14 }, FRESH),
        currentSchemaMissingKeyRow("worker", "w1"),
      ],
      NOW,
      overrides,
    );
    const lookback = item(view, "transactionLookbackDays");
    // api matches the override, but the worker omitted it → unknown → still pending.
    expect(lookback.running.find((entry) => entry.role === "worker")?.state).toBe("unknown");
    expect(lookback.pendingApply).toBe(true);
  });

  it("keeps pendingApply true while any instance reports an unknown (stale) value", () => {
    const overrides = new Map<string, ConfigOverrideRecord>([
      ["transactionLookbackDays", { value: 14, version: 1 }],
    ]);
    const view = assembleConfigView(
      [
        row("api", "a1", { transactionLookbackDays: 14 }, FRESH),
        staleSnapshotRow("worker", "w1", FRESH),
      ],
      NOW,
      overrides,
    );
    // api applied the override, but worker's snapshot is unknown → still pending.
    expect(item(view, "transactionLookbackDays").pendingApply).toBe(true);
  });
});

describe("assembleConfigView skippedOverrides", () => {
  function rowWithSkips(
    role: string,
    instanceId: string,
    skipped: Array<{ key: string; reason: string }>,
  ): RuntimeInstanceRow {
    return {
      role,
      instanceId,
      startedAt: new Date(NOW - 60_000),
      lastSeenAt: FRESH,
      imageTag: null,
      running: buildRunningSnapshot({ transactionLookbackDays: 7 } as never, skipped),
    };
  }

  it("surfaces each instance's boot-skipped overrides on the instance entry", () => {
    const view = assembleConfigView(
      [rowWithSkips("worker", "w1", [{ key: "ofapiDmSyncEnabled", reason: "bad value" }])],
      NOW,
    );
    const worker = view.instances.find((i) => i.role === "worker")!;
    expect(worker.skippedOverrides).toEqual([{ key: "ofapiDmSyncEnabled", reason: "bad value" }]);
  });

  it("reports an empty skip list for a clean boot", () => {
    const view = assembleConfigView([rowWithSkips("api", "a1", [])], NOW);
    expect(view.instances.find((i) => i.role === "api")!.skippedOverrides).toEqual([]);
  });
});

describe("getRunningFlagState", () => {
  const KEY = "ofapiDmProjectionEnabled";

  it("returns 'unknown' when there are no active instances", () => {
    expect(getRunningFlagState([], KEY)).toBe("unknown");
  });

  it("returns 'unknown' when an EXPECTED role (worker) has no active instance", () => {
    // Only api reports the flag true; worker is missing → a vanished worker must NOT let a
    // dependent step unlock, so the gate is 'unknown' (fail-closed), not 'on'.
    const rows = [row("api", "a1", { [KEY]: true }, FRESH)];
    expect(getRunningFlagState(rows, KEY)).toBe("unknown");
  });

  it("returns 'on' only when BOTH expected roles are active and every instance reports true", () => {
    const rows = [
      row("api", "a1", { [KEY]: true }, FRESH),
      row("worker", "w1", { [KEY]: true }, FRESH),
    ];
    expect(getRunningFlagState(rows, KEY)).toBe("on");
  });

  it("returns 'off' when all expected roles are present but one instance reports not-true", () => {
    const rows = [
      row("api", "a1", { [KEY]: true }, FRESH),
      row("worker", "w1", { [KEY]: false }, FRESH),
    ];
    expect(getRunningFlagState(rows, KEY)).toBe("off");
  });
});
