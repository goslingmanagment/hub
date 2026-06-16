// Read-only view of the effective runtime configuration across processes (Stage A).
// `running` values come ONLY from the heartbeat rows each process publishes — the
// view never recomputes them, so it cannot disagree with what a process actually
// uses. A stopped/slow process is surfaced explicitly: every row is classified
// active vs stale, and each expected role gets an active/stale/missing status so a
// vanished worker is a visible warning, not a silent omission. Drift is reported
// when ACTIVE instances disagree — on the value for plain settings, and on the
// set/unset state for secrets/complex values (where the value itself stays masked).

import type { Database, RuntimeInstanceRow } from "@agency_hub_core/db";
import { INSTANCE_STALE_TTL_MS, listAllInstances } from "@agency_hub_core/db";
import type { ConfigDescriptor, RunningSnapshot, RunningValue } from "@agency_hub_core/shared";
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

function buildItem(descriptor: ConfigDescriptor, activeInstances: RuntimeInstanceRow[]): ConfigItem {
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
    // Stage A has no overlay: every value is env-sourced, nothing is pending.
    source: "env",
    desired: null,
    pendingApply: false,
    drift,
    running,
  };
}

/** Pure assembly of the view from raw rows + a clock, so the active/stale/drift
 *  logic is unit-testable without a database. */
export function assembleConfigView(
  rows: RuntimeInstanceRow[],
  nowMs: number,
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

  const items = CONFIG_DESCRIPTORS.map((descriptor) => buildItem(descriptor, activeInstances));
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
  const rows = await listAllInstances(db);
  return assembleConfigView(rows, Date.now());
}
