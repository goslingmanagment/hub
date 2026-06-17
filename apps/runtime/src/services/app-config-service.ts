// Read-only view of the effective runtime configuration across processes (Stage A).
// `running` values come ONLY from the heartbeat rows each process publishes — the
// view never recomputes them, so it cannot disagree with what a process actually
// uses. A stopped/slow process is surfaced explicitly: every row is classified
// active vs stale, and each expected role gets an active/stale/missing status so a
// vanished worker is a visible warning, not a silent omission. Drift is reported
// when ACTIVE instances disagree — on the value for plain settings, and on the
// set/unset state for secrets/complex values (where the value itself stays masked).

import type { ConfigOverrideRecord, Database, RuntimeInstanceRow } from "@agency_hub_core/db";
import { getConfigOverrides, INSTANCE_STALE_TTL_MS, listAllInstances } from "@agency_hub_core/db";
import type { ConfigDescriptor, ConfigOverrideValue, RunningSnapshot, RunningValue, SkippedOverride } from "@agency_hub_core/shared";
import { CONFIG_DESCRIPTORS, RUNNING_SCHEMA_VERSION } from "@agency_hub_core/shared";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";

// Display order for the grouped view; unknown subsystems fall to the end.
const SUBSYSTEM_ORDER = ["Core", "Security", "Sync", "Fansly", "OFAPI", "Telegram", "Workboard"];

// Roles we always expect a live process for, so a missing one is flagged even when
// it has never reported (no row at all). Exported so the staged gate (getRunningFlagState)
// can require an active instance of EVERY expected role before treating a flag as 'on'.
export const EXPECTED_ROLES = ["api", "worker"] as const;

// Marker for a row written under an older/mismatched snapshot shape: we can't trust its
// value, but (unlike Stage A's silent drop) we surface the instance as state "unknown"
// so a not-yet-redeployed process shows as "unknown (stale snapshot)" and counts as
// not-applied for pendingApply, instead of vanishing.
const SCHEMA_MISMATCH = Symbol("schema-mismatch");

function readRunning(row: RuntimeInstanceRow, key: string): RunningValue | typeof SCHEMA_MISMATCH | undefined {
  const snap = row.running as RunningSnapshot | null;
  if (!snap || snap.schemaVersion !== RUNNING_SCHEMA_VERSION) return SCHEMA_MISMATCH;
  return snap.values?.[key];
}

/** The APPLIED (running) truth for a boolean flag across every ACTIVE instance, used to
 *  gate ordered staged enables (a prerequisite must be running, not merely desired).
 *  Returns:
 *   - 'on'  — EVERY expected role (api, worker) has ≥1 active instance, AND every active
 *             instance (all roles) reports the key as boolean `true`, with none
 *             schema-mismatched or missing the key.
 *   - 'unknown' — there are no active instances, an EXPECTED ROLE has no active instance
 *             (a vanished worker must not let the next step unlock), or any active instance
 *             reports under a mismatched snapshot shape or does not report the key at all
 *             (we cannot prove the prerequisite is live, so a dependent enable is blocked).
 *   - 'off' — present across all expected roles but at least one active instance reports
 *             the key as not-true.
 *  Mirrors the readRunning / SCHEMA_MISMATCH handling the read-only view uses, so the
 *  gate agrees with what each process actually consumes. */
export function getRunningFlagState(
  activeInstances: RuntimeInstanceRow[],
  key: string,
): "on" | "off" | "unknown" {
  if (activeInstances.length === 0) return "unknown";

  // Fail-closed when any expected role has no active instance: a missing worker (or api)
  // means we cannot prove the prerequisite is live everywhere it runs.
  const activeRoles = new Set(activeInstances.map((instance) => instance.role));
  for (const role of EXPECTED_ROLES) {
    if (!activeRoles.has(role)) return "unknown";
  }

  let allOn = true;
  for (const instance of activeInstances) {
    const value = readRunning(instance, key);
    // A mismatched snapshot or a missing key means we cannot trust this instance's
    // applied value for the flag — treat the whole fleet as unknown (fail-closed).
    if (value === SCHEMA_MISMATCH || value === undefined) return "unknown";
    if (value.value !== true) allOn = false;
  }

  return allOn ? "on" : "off";
}

/** The APPLIED truth for a NON-boot key across active instances, summarized for the
 *  server-computed `runningState`. Boot keys use the stricter getRunningFlagState (which
 *  is role-complete + fail-closed); a non-boot key has no ordered-enable gate, so this is a
 *  best-effort summary of what the fleet reports: "on" when every active instance reports
 *  the key as boolean `true`, "off" when at least one reports a non-true (boolean) value,
 *  and "unknown" when no active instance reports a usable boolean (no fleet, a masked/non-
 *  boolean value, a stale snapshot, or the key missing from the snapshot). Mirrors the
 *  readRunning / SCHEMA_MISMATCH handling so it agrees with what each process consumes. */
function summarizeNonBootRunningState(
  activeInstances: RuntimeInstanceRow[],
  key: string,
): "on" | "off" | "unknown" {
  let sawBoolean = false;
  let allOn = true;
  for (const instance of activeInstances) {
    const value = readRunning(instance, key);
    if (value === SCHEMA_MISMATCH || value === undefined) continue;
    if (value.masked || typeof value.value !== "boolean") continue;
    sawBoolean = true;
    if (value.value !== true) allOn = false;
  }
  if (!sawBoolean) return "unknown";
  return allOn ? "on" : "off";
}

/** The boot-apply overrides an instance reported as skipped, or [] for an older
 *  (mismatched-shape) snapshot that carries no skip data. */
function readSkippedOverrides(row: RuntimeInstanceRow): SkippedOverride[] {
  const snap = row.running as RunningSnapshot | null;
  if (!snap || snap.schemaVersion !== RUNNING_SCHEMA_VERSION) return [];
  return (snap.skippedOverrides ?? []).map((entry) => ({ key: entry.key, reason: entry.reason }));
}

function buildItem(
  descriptor: ConfigDescriptor,
  activeInstances: RuntimeInstanceRow[],
  overrides: Map<string, ConfigOverrideRecord>,
  // The PRE-boot-apply env config (rawConfig), the env baseline for desiredEffective. An
  // empty record (the no-baseline default) yields env-undefined → null for boolean keys.
  envBaseline: Record<string, unknown>,
): ConfigItem {
  const running: ConfigItem["running"] = [];
  const scalarValues: string[] = [];
  const states: string[] = [];
  // Tracks whether any active instance reported under a mismatched snapshot shape, so
  // pendingApply can never clear while a process's value is unknown.
  let hasUnknown = false;

  for (const instance of activeInstances) {
    const value = readRunning(instance, descriptor.key);

    // A mismatched snapshot shape (SCHEMA_MISMATCH) OR a current-schema snapshot that simply
    // omits this key (undefined — e.g. an older build on the SAME RUNNING_SCHEMA_VERSION that
    // predates the key, mid rolling deploy) is not a trustworthy value. Surface the instance as
    // "unknown" rather than dropping it: it does not feed drift, but it DOES keep pendingApply
    // true (fail-closed), so an override can't read as fully applied while an active instance
    // never reported it.
    if (value === SCHEMA_MISMATCH || value === undefined) {
      hasUnknown = true;
      running.push({
        role: instance.role,
        instanceId: instance.instanceId,
        value: null,
        masked: false,
        state: "unknown",
        lastSeenAt: instance.lastSeenAt.toISOString(),
      });
      continue;
    }

    running.push({
      role: instance.role,
      instanceId: instance.instanceId,
      value: value.value ?? null,
      masked: value.masked ?? false,
      state: value.state ?? null,
      lastSeenAt: instance.lastSeenAt.toISOString(),
    });

    if (value.masked) {
      // Secrets/complex values never carry a real value, but a set-in-one /
      // unset-in-the-other split is operationally important — compare state.
      if (value.state) states.push(value.state);
    } else if (descriptor.comparable) {
      scalarValues.push(JSON.stringify(value.value ?? null));
    }
  }

  const drift = new Set(scalarValues).size > 1 || new Set(states).size > 1;

  // Surface an override for any key wired to the DB overlay — live (runtime) OR boot
  // (staged, applies after restart) — so a boot override shows desired/source/version/
  // pendingApply. A 'none' key never carries one (fail-closed against a stray row).
  const overridable = descriptor.runtimeApply === "live" || descriptor.runtimeApply === "boot";
  const override = overridable ? overrides.get(descriptor.key) : undefined;
  const desired: ConfigOverrideValue | null = override ? override.value : null;
  const source: "env" | "override" = override ? "override" : "env";
  // Pending until EVERY expected role reports the override value. An unknown
  // (mismatched-snapshot) instance counts as not-applied, as does a masked entry or a
  // value that still differs. Also pending when no process is reporting at all, OR when an
  // EXPECTED role (api/worker) has no active instance — role-complete like getRunningFlagState,
  // so a single api heartbeat can't clear pendingApply while the worker (which also consumes
  // the value) is down/stale.
  const activeRoles = new Set(activeInstances.map((instance) => instance.role));
  const missingExpectedRole = EXPECTED_ROLES.some((role) => !activeRoles.has(role));
  const pendingApply =
    override != null &&
    (running.length === 0 ||
      missingExpectedRole ||
      hasUnknown ||
      running.some((entry) => entry.masked || entry.state === "unknown" || entry.value !== override.value));

  // SERVER-computed APPLIED truth (the staged UI's lock/Enable-Disable source). Boot keys
  // use the strict role-complete, fail-closed getRunningFlagState; non-boot keys get a
  // best-effort fleet summary.
  const runningState =
    descriptor.runtimeApply === "boot"
      ? getRunningFlagState(activeInstances, descriptor.key)
      : summarizeNonBootRunningState(activeInstances, descriptor.key);

  // SERVER-computed desired baseline: the override boolean when one exists, else the env
  // (rawConfig) boolean; null for any key with no boolean meaning here. For a boot key the
  // override is always a boolean; this also covers a boolean non-boot key with an override.
  let desiredEffective: boolean | null;
  if (override != null && typeof override.value === "boolean") {
    desiredEffective = override.value;
  } else if (override == null) {
    const envValue = envBaseline[descriptor.key];
    desiredEffective = typeof envValue === "boolean" ? envValue : null;
  } else {
    // A non-boolean override (e.g. a numeric live key) has no boolean desired meaning.
    desiredEffective = null;
  }

  return {
    key: descriptor.key,
    envName: descriptor.envName,
    configField: (descriptor.configField as string | null) ?? null,
    kind: descriptor.kind,
    subsystem: descriptor.subsystem,
    label: descriptor.label,
    default: descriptor.default,
    editability: descriptor.editability,
    runtimeApply: descriptor.runtimeApply,
    comparable: descriptor.comparable,
    secret: descriptor.kind === "secret",
    note: descriptor.note ?? null,
    costWarning: descriptor.costWarning ?? null,
    destructive: descriptor.destructive ?? false,
    stagedGroup: descriptor.stagedGroup ?? null,
    stagedOrder: descriptor.stagedOrder ?? null,
    requires: descriptor.requires ?? [],
    // Effective-overlay metadata: when an editable override exists, `desired` is its
    // value and `source` is "override"; `pendingApply` flags that the override has
    // not yet reached the running processes (always true in B0, which wires no
    // read-site). With no override the value is env-sourced and nothing is pending.
    source,
    desired,
    runningState,
    desiredEffective,
    overrideVersion: override ? override.version : null,
    pendingApply,
    drift,
    // Wired to take effect at runtime now (Stage B1): only `runtimeApply === 'live'`
    // keys are PATCHable and applied without a restart.
    live: descriptor.runtimeApply === "live",
    running,
  };
}

/** Pure assembly of the view from raw rows + a clock (+ the override overlay), so
 *  the active/stale/drift/overlay logic is unit-testable without a database. The
 *  overrides map defaults to empty, matching the no-overlay Stage A behavior. The
 *  `envBaseline` is the PRE-boot-apply env config (rawConfig) used for desiredEffective;
 *  it defaults to {} so a key with no override resolves desiredEffective to null. */
export function assembleConfigView(
  rows: RuntimeInstanceRow[],
  nowMs: number,
  overrides: Map<string, ConfigOverrideRecord> = new Map(),
  envBaseline: Record<string, unknown> = {},
): ConfigViewResponse {
  const staleCutoff = nowMs - INSTANCE_STALE_TTL_MS;
  const classified = rows.map((row) => ({
    row,
    status: row.lastSeenAt.getTime() >= staleCutoff ? ("active" as const) : ("stale" as const),
  }));
  const activeInstances = classified.filter((entry) => entry.status === "active").map((entry) => entry.row);

  const observedRoles = new Set(rows.map((row) => row.role));
  const activeRoles = new Set(activeInstances.map((row) => row.role));
  const roles = [...new Set([...EXPECTED_ROLES, ...observedRoles])];
  const roleStatuses = roles.map((role) => ({
    role,
    status: activeRoles.has(role)
      ? ("active" as const)
      : observedRoles.has(role)
        ? ("stale" as const)
        : ("missing" as const),
  }));

  const items = CONFIG_DESCRIPTORS.map((descriptor) =>
    buildItem(descriptor, activeInstances, overrides, envBaseline),
  );
  const bySubsystem = new Map<string, ConfigItem[]>();
  for (const item of items) {
    const bucket = bySubsystem.get(item.subsystem) ?? [];
    bucket.push(item);
    bySubsystem.set(item.subsystem, bucket);
  }
  const orderedSubsystems = [
    ...SUBSYSTEM_ORDER.filter((name) => bySubsystem.has(name)),
    ...[...bySubsystem.keys()].filter((name) => !SUBSYSTEM_ORDER.includes(name)),
  ];

  return {
    generatedAt: new Date(nowMs).toISOString(),
    roleStatuses,
    instances: classified.map((entry) => ({
      role: entry.row.role,
      instanceId: entry.row.instanceId,
      startedAt: entry.row.startedAt.toISOString(),
      lastSeenAt: entry.row.lastSeenAt.toISOString(),
      imageTag: entry.row.imageTag ?? null,
      status: entry.status,
      // Boot-apply overrides this instance rejected at start (empty for a clean boot or
      // an older snapshot shape).
      skippedOverrides: readSkippedOverrides(entry.row),
    })),
    subsystems: orderedSubsystems.map((subsystem) => ({
      subsystem,
      items: bySubsystem.get(subsystem)!,
    })),
  };
}

export async function buildConfigView(
  db: Database,
  // The PRE-boot-apply env config (rawConfig), threaded so desiredEffective uses the env
  // baseline for keys with no override. Defaults to {} (env-undefined → null) when a caller
  // (a test, codegen) has no baseline to pass.
  envBaseline: Record<string, unknown> = {},
): Promise<ConfigViewResponse> {
  const [rows, overrides] = await Promise.all([listAllInstances(db), getConfigOverrides(db)]);
  return assembleConfigView(rows, Date.now(), overrides, envBaseline);
}
