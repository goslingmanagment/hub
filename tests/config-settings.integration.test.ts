import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearConfigOverride,
  ConfigOverrideVersionConflictError,
  createUser,
  getConfigOverrides,
  listAllInstances,
  listConfigAudit,
  setConfigOverride,
  setConfigOverridesAtomic,
  upsertInstanceHeartbeat,
} from "@agency_hub_core/db";
import type { AppConfig, RunningSnapshot } from "@agency_hub_core/shared";

import { buildConfigView } from "../apps/runtime/src/services/app-config-service.ts";
import { applyEffectiveOverrides } from "../apps/runtime/src/services/effective-config.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let userId: number;

function viewItem(view: Awaited<ReturnType<typeof buildConfigView>>, key: string) {
  const found = view.subsystems.flatMap((group) => group.items).find((item) => item.key === key);
  if (!found) throw new Error(`item ${key} not found`);
  return found;
}

describe("config_settings repository (Stage B0)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    const user = await createUser(testDb.db, { username: "owner", role: "owner", passwordHash: "x" });
    userId = user.id;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("inserts a row at version 1 and reads it back via getConfigOverrides", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const result = await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 750,
      userId,
      groupId: randomUUID(),
      note: "first patch",
    });
    expect(result).toEqual({ key: "ofapiDmDailyCreditBudget", value: 750, version: 1 });

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmDailyCreditBudget")).toEqual({ value: 750, version: 1 });

    const audit = await listConfigAudit(testDb.db, { key: "ofapiDmDailyCreditBudget" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.oldValue).toBeNull();
    expect(audit[0]!.newValue).toBe(750);
    expect(audit[0]!.oldVersion).toBeNull();
    expect(audit[0]!.newVersion).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("bumps to version 2 on a second set and writes a second audit row under a new group", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const firstGroup = randomUUID();
    const secondGroup = randomUUID();
    await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 750,
      userId,
      groupId: firstGroup,
    });
    const second = await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 900,
      userId,
      groupId: secondGroup,
    });
    expect(second).toEqual({ key: "ofapiDmDailyCreditBudget", value: 900, version: 2 });

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmDailyCreditBudget")).toEqual({ value: 900, version: 2 });

    const audit = await listConfigAudit(testDb.db, { key: "ofapiDmDailyCreditBudget" });
    expect(audit).toHaveLength(2);
    // newest-first ordering
    expect(audit[0]!.newValue).toBe(900);
    expect(audit[0]!.oldValue).toBe(750);
    expect(audit[0]!.oldVersion).toBe(1);
    expect(audit[0]!.newVersion).toBe(2);
    // Each patch carries its own group id.
    expect(new Set(audit.map((r) => r.groupId)).size).toBe(2);
    expect(audit[0]!.groupId).toBe(secondGroup);
    expect(audit[1]!.groupId).toBe(firstGroup);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("throws a version-conflict when expectedVersion does not match", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 750,
      userId,
      groupId: randomUUID(),
    });

    await expect(
      setConfigOverride(testDb.db, {
        key: "ofapiDmDailyCreditBudget",
        value: 800,
        expectedVersion: 5,
        userId,
        groupId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConfigOverrideVersionConflictError);

    // The conflicting write left the row untouched at version 1.
    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmDailyCreditBudget")).toEqual({ value: 750, version: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("surfaces the override in buildConfigView (desired/source/pendingApply)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Use a runtimeApply:'live' key so the override actually surfaces in the view.
    // ofapiDmDailyCreditBudget is 'none' (not overridable), so its override is intentionally
    // NOT surfaced (source stays 'env') — the unit suite covers that 'none' case separately.
    await setConfigOverride(testDb.db, {
      key: "healthSyncLightMaxAgeMinutes",
      value: 14,
      userId,
      groupId: randomUUID(),
    });

    const view = await buildConfigView(testDb.db);
    const lookback = viewItem(view, "healthSyncLightMaxAgeMinutes");
    expect(lookback.source).toBe("override");
    expect(lookback.desired).toBe(14);
    // No active instance is reporting a value, so the override is pending.
    expect(lookback.pendingApply).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("clears an override and writes a clearing audit row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 750,
      userId,
      groupId: randomUUID(),
    });

    await clearConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      userId,
      groupId: randomUUID(),
      note: "revert to env",
    });

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.has("ofapiDmDailyCreditBudget")).toBe(false);

    const audit = await listConfigAudit(testDb.db, { key: "ofapiDmDailyCreditBudget" });
    expect(audit).toHaveLength(2);
    // newest-first: the clear row carries the old value but null new value/version.
    expect(audit[0]!.oldValue).toBe(750);
    expect(audit[0]!.newValue).toBeNull();
    expect(audit[0]!.oldVersion).toBe(1);
    expect(audit[0]!.newVersion).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  const KEY = "ofapiDmDailyCreditBudget";

  it("serializes concurrent sets on an existing row: exactly one wins, version bumps once", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await setConfigOverride(testDb.db, { key: KEY, value: 500, userId, groupId: randomUUID() }); // version 1

    // Both writers read version 1 and try to bump with expectedVersion 1 concurrently.
    const results = await Promise.allSettled([
      setConfigOverride(testDb.db, { key: KEY, value: 600, expectedVersion: 1, userId, groupId: randomUUID() }),
      setConfigOverride(testDb.db, { key: KEY, value: 700, expectedVersion: 1, userId, groupId: randomUUID() }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConfigOverrideVersionConflictError);

    // No lost-update double-bump: the row advanced by exactly one version.
    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get(KEY)!.version).toBe(2);
    const audit = await listConfigAudit(testDb.db, { key: KEY });
    expect(audit).toHaveLength(2); // seed + the one winner; the loser rolled back
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serializes concurrent inserts of a brand-new key (absent-row, expectedVersion 0)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const results = await Promise.allSettled([
      setConfigOverride(testDb.db, { key: KEY, value: 600, expectedVersion: 0, userId, groupId: randomUUID() }),
      setConfigOverride(testDb.db, { key: KEY, value: 700, expectedVersion: 0, userId, groupId: randomUUID() }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConfigOverrideVersionConflictError);

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get(KEY)!.version).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serializes a concurrent set and clear: exactly one wins", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await setConfigOverride(testDb.db, { key: KEY, value: 500, userId, groupId: randomUUID() }); // version 1

    const results = await Promise.allSettled([
      setConfigOverride(testDb.db, { key: KEY, value: 600, expectedVersion: 1, userId, groupId: randomUUID() }),
      clearConfigOverride(testDb.db, { key: KEY, expectedVersion: 1, userId, groupId: randomUUID() }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConfigOverrideVersionConflictError);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("setConfigOverridesAtomic applies a mixed set + clear patch in one transaction", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Seed two override rows; one will be re-set (upsert), the other cleared, atomically.
    await setConfigOverride(testDb.db, { key: "ofapiDmDailyCreditBudget", value: 500, userId, groupId: randomUUID() });
    await setConfigOverride(testDb.db, { key: "ofapiCreditFloor", value: 200, userId, groupId: randomUUID() });

    const groupId = randomUUID();
    const results = await setConfigOverridesAtomic(testDb.db, {
      patches: [
        { key: "ofapiDmDailyCreditBudget", value: 750, expectedVersion: 1 },
        { key: "ofapiCreditFloor", clear: true, expectedVersion: 1 },
      ],
      userId,
      groupId,
    });
    // The cleared key reports value null / version null; the upsert reports the bumped row.
    expect(results).toEqual([
      { key: "ofapiDmDailyCreditBudget", value: 750, version: 2 },
      { key: "ofapiCreditFloor", value: null, version: null },
    ]);

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmDailyCreditBudget")).toEqual({ value: 750, version: 2 });
    expect(overrides.has("ofapiCreditFloor")).toBe(false);

    // The cleared key's audit row carries the old value and a null new value/version.
    const clearedAudit = await listConfigAudit(testDb.db, { key: "ofapiCreditFloor" });
    expect(clearedAudit[0]!.oldValue).toBe(200);
    expect(clearedAudit[0]!.newValue).toBeNull();
    expect(clearedAudit[0]!.newVersion).toBeNull();
    expect(clearedAudit[0]!.groupId).toBe(groupId);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("setConfigOverridesAtomic rolls back the whole mixed patch when the clear conflicts", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await setConfigOverride(testDb.db, { key: "ofapiDmDailyCreditBudget", value: 500, userId, groupId: randomUUID() });
    await setConfigOverride(testDb.db, { key: "ofapiCreditFloor", value: 200, userId, groupId: randomUUID() });

    await expect(
      setConfigOverridesAtomic(testDb.db, {
        patches: [
          { key: "ofapiDmDailyCreditBudget", value: 750, expectedVersion: 1 },
          // Stale expectedVersion on the clear → the whole patch rolls back.
          { key: "ofapiCreditFloor", clear: true, expectedVersion: 99 },
        ],
        userId,
        groupId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConfigOverrideVersionConflictError);

    // Neither key changed: the upsert rolled back with the conflicting clear.
    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("ofapiDmDailyCreditBudget")).toEqual({ value: 500, version: 1 });
    expect(overrides.get("ofapiCreditFloor")).toEqual({ value: 200, version: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  // ── jsonb reads are SINGLE-parse (decision #216) ───────────────────────────
  // drizzle 0.45.2's builtin jsonb ran JSON.parse on a value node-postgres had
  // ALREADY parsed. An override stored as the string "4" therefore read back as
  // the NUMBER 4, validateConfigOverride rejected it ("expects a string"), the
  // live overlay silently dropped it, and the G5 CAS canary never turned on in
  // production on 2026-08-16 — with no error logged anywhere. These pins run the
  // real repository writes and the real overlay, so they fail if the schema ever
  // goes back to the builtin type.

  /** A minimal AppConfig carrying only the fields the overlay writes below. */
  function overlayBase(): AppConfig {
    return {
      captureCasDualWritePages: "",
      fanslyReplayMode: "off",
      retentionTieringEnabled: false,
      healthSyncLightMaxAgeMinutes: 7,
    } as unknown as AppConfig;
  }

  it("keeps a numeric-looking string override a STRING end to end", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The exact production value that broke: a CSV of canary page ids, one page.
    await setConfigOverride(testDb.db, {
      key: "captureCasDualWritePages",
      value: "4",
      userId,
      groupId: randomUUID(),
    });

    const overrides = await getConfigOverrides(testDb.db);
    const stored = overrides.get("captureCasDualWritePages")!.value;
    // The bug handed back the NUMBER 4 here.
    expect(stored).toBe("4");
    expect(typeof stored).toBe("string");

    // ...so the override survives re-validation and actually reaches the merged
    // config instead of being dropped as "expects a string".
    expect(applyEffectiveOverrides(overlayBase(), overrides).captureCasDualWritePages).toBe("4");

    // The audit trail records the same string, not a coerced number.
    const audit = await listConfigAudit(testDb.db, { key: "captureCasDualWritePages" });
    expect(audit[0]!.newValue).toBe("4");
    expect(typeof audit[0]!.newValue).toBe("string");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("round-trips string, number and boolean overrides verbatim", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await setConfigOverridesAtomic(testDb.db, {
      patches: [
        { key: "fanslyReplayMode", value: "shadow" },
        { key: "healthSyncLightMaxAgeMinutes", value: 14 },
        { key: "retentionTieringEnabled", value: true },
      ],
      userId,
      groupId: randomUUID(),
    });

    const overrides = await getConfigOverrides(testDb.db);
    expect(overrides.get("fanslyReplayMode")!.value).toBe("shadow");
    expect(overrides.get("healthSyncLightMaxAgeMinutes")!.value).toBe(14);
    expect(overrides.get("retentionTieringEnabled")!.value).toBe(true);

    const merged = applyEffectiveOverrides(overlayBase(), overrides);
    expect(merged.fanslyReplayMode).toBe("shadow");
    expect(merged.healthSyncLightMaxAgeMinutes).toBe(14);
    expect(merged.retentionTieringEnabled).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps strings that are themselves valid JSON as strings", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Every one of these re-parses into a DIFFERENT type (or value) under a
    // second JSON.parse. captureCasDualWritePages is a free-form CSV string with
    // no enum, so the repository must hand each one back unchanged.
    const traps = ["4", "007", "true", "false", "null", "1,2", "[1,2]", '{"a":1}', "1e3", "-0"];

    for (const trap of traps) {
      await setConfigOverride(testDb.db, {
        key: "captureCasDualWritePages",
        value: trap,
        userId,
        groupId: randomUUID(),
      });

      const overrides = await getConfigOverrides(testDb.db);
      const stored = overrides.get("captureCasDualWritePages")!.value;
      expect(stored).toBe(trap);
      expect(typeof stored).toBe("string");
      expect(applyEffectiveOverrides(overlayBase(), overrides).captureCasDualWritePages).toBe(trap);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns an object-payload jsonb column as an object, nested scalars intact", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // runtime_instances.running is one of the object-only jsonb columns switched
    // to the safe type for uniformity: this pins that the switch changed nothing
    // for them. It also reads through the relational query builder, a different
    // mapping path than the plain selects above.
    const snapshot: RunningSnapshot = {
      schemaVersion: 2,
      values: {
        // A NESTED string that looks like a number: safe even before the fix
        // (drizzle only re-parsed the top level), and it must stay safe now.
        captureCasDualWritePages: { value: "4" },
        healthSyncLightMaxAgeMinutes: { value: 14 },
        retentionTieringEnabled: { value: false },
        encryptionKey: { value: null, masked: true, state: "set" },
      },
      skippedOverrides: [{ key: "logLevel", reason: "not a boot key" }],
    };

    await upsertInstanceHeartbeat(testDb.db, {
      role: "api",
      instanceId: "instance-1",
      startedAt: new Date(),
      imageTag: "test-image",
      running: snapshot,
    });

    const rows = await listAllInstances(testDb.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.running).toEqual(snapshot);
    expect(rows[0]!.running.values.captureCasDualWritePages!.value).toBe("4");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
