import { and, desc, eq } from "drizzle-orm";
import type { ConfigOverrideValue } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { configAuditLog, configSettings } from "../schema.ts";

export type ConfigSettingRow = typeof configSettings.$inferSelect;
export type ConfigAuditLogRow = typeof configAuditLog.$inferSelect;

const DEFAULT_SCOPE_TYPE = "global";
const DEFAULT_SCOPE_ID = 0;

/** Walk the error chain looking for a Postgres error code (mirrors catalog.ts). */
function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && (current as { code?: unknown }).code === code) {
      return true;
    }
    if (!("cause" in current)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface ConfigOverrideRecord {
  value: ConfigOverrideValue;
  version: number;
}

/** All override rows for a scope (default: global), keyed by config key. The
 *  resolver layers these over the env-loaded config. */
export async function getConfigOverrides(
  db: Database,
  scope?: { scopeType?: string; scopeId?: number },
): Promise<Map<string, ConfigOverrideRecord>> {
  const scopeType = scope?.scopeType ?? DEFAULT_SCOPE_TYPE;
  const scopeId = scope?.scopeId ?? DEFAULT_SCOPE_ID;

  const rows = await db.query.configSettings.findMany({
    where: and(eq(configSettings.scopeType, scopeType), eq(configSettings.scopeId, scopeId)),
  });

  const overrides = new Map<string, ConfigOverrideRecord>();
  for (const row of rows) {
    overrides.set(row.key, { value: row.value, version: row.version });
  }
  return overrides;
}

/** Optimistic-lock conflict raised when expectedVersion does not match the row's
 *  current version (or a concurrent writer won the race for a brand-new key). */
export class ConfigOverrideVersionConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | null,
  ) {
    super(
      `Config override version conflict for "${key}": expected ${expectedVersion}, found ${actualVersion ?? "none"}`,
    );
    this.name = "ConfigOverrideVersionConflictError";
  }
}

export interface SetConfigOverrideInput {
  key: string;
  value: ConfigOverrideValue;
  scopeType?: string;
  scopeId?: number;
  expectedVersion?: number;
  userId: number | null;
  note?: string;
  groupId: string;
}

export interface AtomicConfigPatch {
  key: string;
  value: ConfigOverrideValue;
  expectedVersion?: number;
}

export interface SetConfigOverridesInput {
  patches: AtomicConfigPatch[];
  scopeType?: string;
  scopeId?: number;
  userId: number | null;
  note?: string;
  groupId: string;
}

/** Apply one or more overrides + their audit rows in a SINGLE transaction, all-or-
 *  nothing: if any key conflicts (stale expectedVersion) or loses a brand-new-key
 *  insert race, the whole patch rolls back and nothing is persisted. Each existing
 *  row is locked with SELECT ... FOR UPDATE in a deterministic (sorted) key order so
 *  two overlapping atomic patches cannot deadlock; a serialized writer then re-reads
 *  the bumped version and fails its own expectedVersion check. Version bumps current
 *  + 1 (or 1 for a new key). Returns {key,value,version} in the caller's patch order. */
export async function setConfigOverridesAtomic(
  db: Database,
  input: SetConfigOverridesInput,
): Promise<Array<{ key: string; value: ConfigOverrideValue; version: number }>> {
  const scopeType = input.scopeType ?? DEFAULT_SCOPE_TYPE;
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;
  // Lock rows in a stable key order so two overlapping multi-key patches can't deadlock.
  const ordered = [...input.patches].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const byKey = new Map<string, { key: string; value: ConfigOverrideValue; version: number }>();

    for (const patch of ordered) {
      const [current] = await database
        .select({ value: configSettings.value, version: configSettings.version })
        .from(configSettings)
        .where(
          and(
            eq(configSettings.scopeType, scopeType),
            eq(configSettings.scopeId, scopeId),
            eq(configSettings.key, patch.key),
          ),
        )
        .for("update");

      const currentVersion = current?.version ?? null;
      if (patch.expectedVersion != null && patch.expectedVersion !== (currentVersion ?? 0)) {
        throw new ConfigOverrideVersionConflictError(patch.key, patch.expectedVersion, currentVersion);
      }

      const newVersion = (currentVersion ?? 0) + 1;

      if (current) {
        await database
          .update(configSettings)
          .set({
            value: patch.value,
            version: newVersion,
            updatedByUserId: input.userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(configSettings.scopeType, scopeType),
              eq(configSettings.scopeId, scopeId),
              eq(configSettings.key, patch.key),
            ),
          );
      } else {
        try {
          await database.insert(configSettings).values({
            scopeType,
            scopeId,
            key: patch.key,
            value: patch.value,
            version: newVersion,
            updatedByUserId: input.userId,
            updatedAt: new Date(),
          });
        } catch (error) {
          if (hasErrorCode(error, "23505")) {
            // A concurrent insert of the same brand-new key won the race.
            throw new ConfigOverrideVersionConflictError(patch.key, patch.expectedVersion ?? 0, null);
          }
          throw error;
        }
      }

      await database.insert(configAuditLog).values({
        groupId: input.groupId,
        userId: input.userId,
        scopeType,
        scopeId,
        key: patch.key,
        oldValue: current?.value ?? null,
        newValue: patch.value,
        oldVersion: currentVersion,
        newVersion,
        note: input.note ?? null,
      });

      byKey.set(patch.key, { key: patch.key, value: patch.value, version: newVersion });
    }

    return input.patches.map((patch) => byKey.get(patch.key)!);
  });
}

/** Single-key convenience wrapper over setConfigOverridesAtomic. */
export async function setConfigOverride(
  db: Database,
  input: SetConfigOverrideInput,
): Promise<{ key: string; value: ConfigOverrideValue; version: number }> {
  const [result] = await setConfigOverridesAtomic(db, {
    patches: [{ key: input.key, value: input.value, expectedVersion: input.expectedVersion }],
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    userId: input.userId,
    note: input.note,
    groupId: input.groupId,
  });
  return result!;
}

export interface ClearConfigOverrideInput {
  key: string;
  scopeType?: string;
  scopeId?: number;
  expectedVersion?: number;
  userId: number | null;
  note?: string;
  groupId: string;
}

/** Delete an override (revert to the env value) and append an audit row with
 *  new_value / new_version null. The row is locked with FOR UPDATE; we only delete a
 *  row we actually observed under the lock, never a blind delete that could remove a
 *  row inserted concurrently. A no-op when no row exists, but still audited. */
export async function clearConfigOverride(
  db: Database,
  input: ClearConfigOverrideInput,
): Promise<void> {
  const scopeType = input.scopeType ?? DEFAULT_SCOPE_TYPE;
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;

    const [current] = await database
      .select({ value: configSettings.value, version: configSettings.version })
      .from(configSettings)
      .where(
        and(
          eq(configSettings.scopeType, scopeType),
          eq(configSettings.scopeId, scopeId),
          eq(configSettings.key, input.key),
        ),
      )
      .for("update");

    const currentVersion = current?.version ?? null;
    if (input.expectedVersion != null && input.expectedVersion !== (currentVersion ?? 0)) {
      throw new ConfigOverrideVersionConflictError(input.key, input.expectedVersion, currentVersion);
    }

    if (current) {
      await database
        .delete(configSettings)
        .where(
          and(
            eq(configSettings.scopeType, scopeType),
            eq(configSettings.scopeId, scopeId),
            eq(configSettings.key, input.key),
          ),
        );
    }

    await database.insert(configAuditLog).values({
      groupId: input.groupId,
      userId: input.userId,
      scopeType,
      scopeId,
      key: input.key,
      oldValue: current?.value ?? null,
      newValue: null,
      oldVersion: currentVersion,
      newVersion: null,
      note: input.note ?? null,
    });
  });
}

/** Recent audit rows, newest first, optionally filtered by key. */
export async function listConfigAudit(
  db: Database,
  opts?: { key?: string; limit?: number },
): Promise<ConfigAuditLogRow[]> {
  const clauses = [];
  if (opts?.key) {
    clauses.push(eq(configAuditLog.key, opts.key));
  }

  return db.query.configAuditLog.findMany({
    where: clauses.length > 0 ? and(...clauses) : undefined,
    orderBy: [desc(configAuditLog.changedAt), desc(configAuditLog.id)],
    limit: opts?.limit ?? 50,
  });
}
