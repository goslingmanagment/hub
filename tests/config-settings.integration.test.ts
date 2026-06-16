import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearConfigOverride,
  ConfigOverrideVersionConflictError,
  createUser,
  getConfigOverrides,
  listConfigAudit,
  setConfigOverride,
} from "@agency_hub_core/db";

import { buildConfigView } from "../apps/runtime/src/services/app-config-service.ts";
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

    await setConfigOverride(testDb.db, {
      key: "ofapiDmDailyCreditBudget",
      value: 750,
      userId,
      groupId: randomUUID(),
    });

    const view = await buildConfigView(testDb.db);
    const budget = viewItem(view, "ofapiDmDailyCreditBudget");
    expect(budget.source).toBe("override");
    expect(budget.desired).toBe(750);
    // No active instance is reporting a value, so the override is pending.
    expect(budget.pendingApply).toBe(true);
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
});
