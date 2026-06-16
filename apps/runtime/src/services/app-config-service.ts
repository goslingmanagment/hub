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
import type { ConfigDescriptor, ConfigOverrideValue, RunningSnapshot, RunningValue } from "@agency_hub_core/shared";
import { CONFIG_DESCRIPTORS, RUNNING_SCHEMA_VERSION } from "@agency_hub_core/shared";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";

// Display order for the grouped view; unknown subsystems fall to the end.
const SUBSYSTEM_ORDER = ["Core", "Security", "Sync", "Fansly", "OFAPI", "Telegram", "Workboard"];

// Roles we always expect a live process for, so a missing one is flagged even when
// it has never reported (no row at all).
const EXPECTED_ROLES = ["api", "worker"];

function readRunning(row: RuntimeInstanceRow, key: string): RunningValue | undefined {
  const snap = row.running as RunningSnapshot | null;
  // A row written by a not-yet-redeployed process under an older snapshot shape is
  // ignored rather than misread (prevents false drift across a rolling deploy).
  if (!snap || snap.schemaVersion !== RUNNING_SCHEMA_VERSION) return undefined;
  return snap.values?.[key];
}

function buildItem(
  descriptor: ConfigDescriptor,
  activeInstances: RuntimeInstanceRow[],
  overrides: Map<string, ConfigOverrideRecord>,
): ConfigItem {
  const running: ConfigItem["running"] = [];
  const scalarValues: string[] = [];
  const states: string[] = [];

  for (const instance of activeInstances) {
    const value = readRunning(instance, descriptor.key);
    if (!value) continue;

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

  // An override only counts when the key is actually editable — a stray row for a
  // non-editable key (should never exist, but fail closed) is ignored here.
  const override = descriptor.editability === "editable" ? overrides.get(descriptor.key) : undefined;
  const desired: ConfigOverrideValue | null = override ? override.value : null;
  const source: "env" | "override" = override ? "override" : "env";
  // Pending until EVERY active instance reports the override value — if api has
  // applied it but worker has not, it is still partially applied, not done. Also
  // pending when no process is reporting one to compare to. (B0 wires no read-site,
  // so this is effectively always true while an override differs from env.)
  const pendingApply =
    override != null &&
    (running.length === 0 ||
      running.some((entry) => entry.masked || entry.value !== override.value));

  return {
    key: descriptor.key,
    envName: descriptor.envName,
    configField: (descriptor.configField as string | null) ?? null,
    kind: descriptor.kind,
    subsystem: descriptor.subsystem,
    label: descriptor.label,
    default: descriptor.default,
    editability: descriptor.editability,
    applyMode: descriptor.applyMode,
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
    pendingApply,
    drift,
    running,
  };
}

/** Pure assembly of the view from raw rows + a clock (+ the override overlay), so
 *  the active/stale/drift/overlay logic is unit-testable without a database. The
 *  overrides map defaults to empty, matching the no-overlay Stage A behavior. */
export function assembleConfigView(
  rows: RuntimeInstanceRow[],
  nowMs: number,
  overrides: Map<string, ConfigOverrideRecord> = new Map(),
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
    buildItem(descriptor, activeInstances, overrides),
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
    })),
    subsystems: orderedSubsystems.map((subsystem) => ({
      subsystem,
      items: bySubsystem.get(subsystem)!,
    })),
  };
}

export async function buildConfigView(db: Database): Promise<ConfigViewResponse> {
  const [rows, overrides] = await Promise.all([listAllInstances(db), getConfigOverrides(db)]);
  return assembleConfigView(rows, Date.now(), overrides);
}
