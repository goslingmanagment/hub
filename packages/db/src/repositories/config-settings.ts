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

/** Upsert a single override and append one audit row, atomically. The existing row
 *  is locked with SELECT ... FOR UPDATE so a concurrent writer serializes behind us
 *  and then re-reads the bumped version — failing its own expectedVersion check
 *  instead of silently lost-updating. A brand-new key has no row to lock; the unique
 *  constraint guards that race (a concurrent insert surfaces as a version conflict).
 *  Version is bumped (current + 1, or 1 for a new key). When expectedVersion is
 *  provided it must match the current version (0/undefined for a new key). Returns
 *  the new {key, value, version}. */
export async function setConfigOverride(
  db: Database,
  input: SetConfigOverrideInput,
): Promise<{ key: string; value: ConfigOverrideValue; version: number }> {
  const scopeType = input.scopeType ?? DEFAULT_SCOPE_TYPE;
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;

  return db.transaction(async (tx) => {
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

    const newVersion = (currentVersion ?? 0) + 1;

    if (current) {
      // Row is locked; a serialized concurrent writer already failed its version
      // check above, so a plain update by scope/key is safe.
      await database
        .update(configSettings)
        .set({
          value: input.value,
          version: newVersion,
          updatedByUserId: input.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(configSettings.scopeType, scopeType),
            eq(configSettings.scopeId, scopeId),
            eq(configSettings.key, input.key),
          ),
        );
    } else {
      try {
        await database.insert(configSettings).values({
          scopeType,
          scopeId,
          key: input.key,
          value: input.value,
          version: newVersion,
          updatedByUserId: input.userId,
          updatedAt: new Date(),
        });
      } catch (error) {
        if (hasErrorCode(error, "23505")) {
          // A concurrent insert of the same brand-new key won the race.
          throw new ConfigOverrideVersionConflictError(input.key, input.expectedVersion ?? 0, null);
        }
        throw error;
      }
    }

    await database.insert(configAuditLog).values({
      groupId: input.groupId,
      userId: input.userId,
      scopeType,
      scopeId,
      key: input.key,
      oldValue: current?.value ?? null,
      newValue: input.value,
      oldVersion: currentVersion,
      newVersion,
      note: input.note ?? null,
    });

    return { key: input.key, value: input.value, version: newVersion };
  });
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
