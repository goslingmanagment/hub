import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createUser, getConfigOverrides, setConfigOverride } from "@agency_hub_core/db";
import { getDescriptor, type ConfigOverrideValue } from "@agency_hub_core/shared";

import { loadBootConfig } from "../apps/runtime/src/services/boot-config.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

/**
 * Step 4, S4-26: the config keys of the legacy Fansly engine leave the registry
 * and the stored overrides of those keys leave `config_settings` in the same
 * release, each with an audit row (plan §14: a key is not removed silently).
 *
 * The migration is found by its name (its number is the next free one at
 * merge) and applied here over rows seeded the way the owner's console and the
 * CLI wrote them; the test database is a clone that already ran it once, on an
 * empty table.
 */

const MIGRATIONS_DIR = "packages/db/migrations";
const NOTE = "step 4: retired with the legacy Fansly engine (migration retire_fansly_legacy_config_overrides)";

function retireMigrationSql(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith("_retire_fansly_legacy_config_overrides.sql"));
  if (found.length !== 1) throw new Error(`expected one retire migration, found ${found.length}`);
  return readFileSync(`${MIGRATIONS_DIR}/${found[0]!}`, "utf8");
}

/** The keys the migration names, in its order. */
function retiredKeys(): string[] {
  const list = /with retired \(key\) as \(\s*values([\s\S]*?)\n\),/.exec(retireMigrationSql())?.[1];
  if (list === undefined) throw new Error("the migration's key list was not found");
  return [...list.matchAll(/\('([A-Za-z0-9]+)'\)/g)].map((match) => match[1]!);
}

/** One stored value of each kind an override takes, some of them the shapes
 *  production holds: a switch, a number, a page list, a JSON policy. */
const SEED_VALUES: ConfigOverrideValue[] = [
  true,
  156,
  "ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3",
  "{\"lilly-1\":{\"fullIntervalMinutes\":360}}",
  false,
  0,
  "none",
];

/** Keys this release keeps, with an override each. */
const KEPT: Array<[string, ConfigOverrideValue]> = [
  ["fanslyDefaultDelayMs", 2500],
  ["fanslyRepliesRewalkCycleDays", 30],
  ["fanslyLiveOverlayReadPages", "all"],
  ["agentHydrationMode", "dispatch"],
  ["healthSyncLightMaxAgeMinutes", 240],
];

interface AuditRow {
  group_id: string;
  user_id: string | null;
  scope_type: string;
  scope_id: string;
  key: string;
  old_value: unknown;
  new_value: unknown;
  old_version: number | null;
  new_version: number | null;
  note: string | null;
}

let testDb: StartedTestDatabase | null = null;
let userId: number;

const pool = () => testDb!.pool;

async function applyMigration(): Promise<void> {
  await pool().query(retireMigrationSql());
}

async function storedKeys(): Promise<string[]> {
  return (await pool().query<{ key: string }>(
    "select scope_type || ':' || scope_id || ':' || key as key from config_settings order by 1",
  )).rows.map((row) => row.key);
}

async function auditRows(where: string): Promise<AuditRow[]> {
  return (await pool().query<AuditRow>(
    `select group_id::text, user_id::text, scope_type, scope_id::text, key, old_value, new_value, old_version,
            new_version, note
       from config_audit_log where ${where} order by id`,
  )).rows;
}

/** An override per retired key (the first one written twice, so its version is
 *  2; the second also for one page), and one per kept key. Returns what each
 *  retired row holds. */
async function seedOverrides(): Promise<Map<string, { value: ConfigOverrideValue; version: number }>> {
  const db = testDb!.db;
  const seeded = new Map<string, { value: ConfigOverrideValue; version: number }>();
  const keys = retiredKeys();
  for (const [index, key] of keys.entries()) {
    const value = SEED_VALUES[index % SEED_VALUES.length]!;
    await setConfigOverride(db, { key, value, userId, groupId: randomUUID(), note: "owner console" });
    seeded.set(`global:0:${key}`, { value, version: 1 });
  }
  await setConfigOverride(db, { key: keys[0]!, value: "rewritten", userId, groupId: randomUUID() });
  seeded.set(`global:0:${keys[0]!}`, { value: "rewritten", version: 2 });
  await setConfigOverride(db, { key: keys[1]!, value: 7, scopeType: "page", scopeId: 4, userId: null, groupId: randomUUID() });
  seeded.set(`page:4:${keys[1]!}`, { value: 7, version: 1 });
  for (const [key, value] of KEPT) {
    await setConfigOverride(db, { key, value, userId, groupId: randomUUID(), note: "kept" });
  }
  return seeded;
}

describe("the stored overrides of the retired legacy Fansly config keys (step 4, S4-26)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    const owner = await createUser(testDb.db, { username: "owner", role: "owner", passwordHash: "x" });
    if (!owner) throw new Error("the owner was not created");
    userId = owner.id;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("removes every stored override of a retired key, in any scope, and audits each one as a clear: the old value "
    + "and version, no user, one group", async (context) => {
    if (!testDb) return context.skip();
    const seeded = await seedOverrides();
    const keptBefore = await pool().query(
      "select key, value, version, updated_by_user_id, updated_at from config_settings where key = any($1) order by key",
      [KEPT.map(([key]) => key)],
    );
    const auditBefore = await auditRows("true");
    expect(await storedKeys()).toHaveLength(seeded.size + KEPT.length);

    await applyMigration();

    // Only the kept keys' overrides are left, exactly as they were.
    expect(await storedKeys()).toEqual(KEPT.map(([key]) => `global:0:${key}`).sort());
    expect((await pool().query(
      "select key, value, version, updated_by_user_id, updated_at from config_settings where key = any($1) order by key",
      [KEPT.map(([key]) => key)],
    )).rows).toEqual(keptBefore.rows);

    // One audit row per removed row: what a clear writes, by nobody.
    const written = await auditRows(`note = '${NOTE}'`);
    expect(written.map((row) => `${row.scope_type}:${row.scope_id}:${row.key}`).sort()).toEqual([...seeded.keys()].sort());
    for (const row of written) {
      const was = seeded.get(`${row.scope_type}:${row.scope_id}:${row.key}`)!;
      expect(row, row.key).toMatchObject({
        user_id: null,
        old_value: was.value,
        new_value: null,
        old_version: was.version,
        new_version: null,
      });
    }
    // The whole removal is one group, and a group of its own.
    const groups = new Set(written.map((row) => row.group_id));
    expect(groups.size).toBe(1);
    expect(auditBefore.some((row) => groups.has(row.group_id))).toBe(false);
    // The history these keys already had stays, beside every other key's.
    expect(await auditRows(`note is distinct from '${NOTE}'`)).toEqual(auditBefore);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("changes nothing on a second run, or on a database that holds none of these overrides", async (context) => {
    if (!testDb) return context.skip();
    // A new database: only overrides of keys that stay.
    for (const [key, value] of KEPT) {
      await setConfigOverride(testDb.db, { key, value, userId, groupId: randomUUID() });
    }
    const snapshot = async () => ({
      settings: (await pool().query("select * from config_settings order by id")).rows,
      audit: (await pool().query("select * from config_audit_log order by id")).rows,
    });
    const fresh = await snapshot();
    await applyMigration();
    expect(await snapshot()).toEqual(fresh);

    await seedOverrides();
    await applyMigration();
    const applied = await snapshot();
    await applyMigration();
    expect(await snapshot()).toEqual(applied);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves no stored override a booting process skips: every remaining row has a descriptor", async (context) => {
    if (!testDb) return context.skip();
    const app = createTestAppContext(testDb);
    const quiet = { warn: () => {}, error: () => {} };
    const keys = retiredKeys();
    await seedOverrides();

    // With the keys gone from the registry and their rows still stored, every
    // process reports each row as skipped at boot (the Configuration tab lists
    // them per instance).
    const before = await loadBootConfig(testDb.db, app.config, quiet);
    expect(before.bootSkipped.map((entry) => entry.key).sort()).toEqual([...keys].sort());
    expect(before.bootSkipped[0]!.reason).toMatch(/^Config key is not overridable via the DB overlay: /);

    await applyMigration();

    const after = await loadBootConfig(testDb.db, app.config, quiet);
    expect(after.bootSkipped).toEqual([]);
    const left = [...(await getConfigOverrides(testDb.db)).keys()];
    expect(left.sort()).toEqual(KEPT.map(([key]) => key).sort());
    expect(left.filter((key) => getDescriptor(key) === undefined)).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
