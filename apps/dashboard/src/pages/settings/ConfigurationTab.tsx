import type { ReactNode } from "react";
import type { ConfigItem } from "@agency_hub_core/contracts";
import { useAdminConfig } from "@/api/adminConfig";

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function formatSeen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "?" : date.toLocaleTimeString();
}

function Badge({
  tone,
  title,
  children,
}: {
  tone: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {children}
    </span>
  );
}

const EDITABILITY_TONE: Record<string, string> = {
  never: "bg-zinc-500/15 text-zinc-500",
  staged: "bg-amber-500/15 text-amber-600",
  editable: "bg-sky-500/15 text-sky-600",
};

const EDITABILITY_LABEL: Record<string, string> = {
  never: "ops-only",
  staged: "staged",
  editable: "editable",
};

function RunningCell({ item }: { item: ConfigItem }) {
  if (item.running.length === 0) {
    return <span className="text-text-muted">awaiting heartbeat…</span>;
  }

  if (item.secret || item.running[0]?.masked) {
    const stateTone = (state: string | null) =>
      state === "set" ? "bg-emerald-500/15 text-emerald-600" : "bg-zinc-500/15 text-zinc-500";
    // When live processes disagree on set/unset, show each one — a key set in api
    // but unset in worker is an operationally important drift.
    if (item.drift) {
      return (
        <div className="flex flex-col gap-0.5">
          {item.running.map((r) => (
            <span key={`${r.role}:${r.instanceId}`} className="text-xs">
              <span className="text-text-muted">{r.role}:</span>{" "}
              <Badge tone={stateTone(r.state)}>{r.state ?? "unset"}</Badge>
            </span>
          ))}
        </div>
      );
    }
    const state = item.running[0]?.state ?? "unset";
    return <Badge tone={stateTone(state)}>{state}</Badge>;
  }

  if (item.drift) {
    return (
      <div className="flex flex-col gap-0.5">
        {item.running.map((r) => (
          <span key={`${r.role}:${r.instanceId}`} className="font-mono text-xs">
            <span className="text-text-muted">{r.role}:</span> {formatScalar(r.value)}
          </span>
        ))}
      </div>
    );
  }

  return <span className="font-mono text-text-primary">{formatScalar(item.running[0]!.value)}</span>;
}

function SettingRow({ item }: { item: ConfigItem }) {
  const runningDiffersFromDefault =
    item.running.length > 0
    && !item.secret
    && !item.running[0]?.masked
    && formatScalar(item.running[0]!.value) !== item.default;

  return (
    <tr className="border-b border-border/60 last:border-0 align-top">
      <td className="py-2 pr-4">
        <div className="text-sm font-medium text-text-primary">{item.label}</div>
        <div className="font-mono text-[11px] text-text-muted">{item.envName}</div>
        {item.note && <div className="mt-0.5 text-[11px] text-text-muted">{item.note}</div>}
      </td>
      <td className="py-2 pr-4 text-sm">
        <RunningCell item={item} />
      </td>
      <td className="py-2 pr-4 text-sm">
        <span className={runningDiffersFromDefault ? "font-mono text-text-secondary" : "font-mono text-text-muted"}>
          {item.default}
        </span>
      </td>
      <td className="py-2">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={EDITABILITY_TONE[item.editability] ?? "bg-zinc-500/15 text-zinc-500"}>
            {EDITABILITY_LABEL[item.editability] ?? item.editability}
          </Badge>
          <Badge
            tone={item.applyMode === "reload" ? "bg-emerald-500/15 text-emerald-600" : "bg-orange-500/15 text-orange-600"}
            title={item.applyMode === "reload" ? "Applies live (no restart)" : "Captured at boot — applies after restart"}
          >
            {item.applyMode === "reload" ? "live" : "needs restart"}
          </Badge>
          {item.drift && (
            <Badge tone="bg-red-500/15 text-red-600" title="Live processes disagree on this value">
              drift
            </Badge>
          )}
          {item.costWarning && (
            <Badge tone="bg-amber-500/15 text-amber-600" title={item.costWarning}>
              ⚠ cost
            </Badge>
          )}
          {item.destructive && (
            <Badge tone="bg-red-500/15 text-red-600" title="Lowering/clearing this drops data irreversibly">
              destructive
            </Badge>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ConfigurationTab() {
  const { data, isLoading, isError } = useAdminConfig();

  if (isLoading) {
    return <div className="text-sm text-text-muted">Loading configuration…</div>;
  }
  if (isError || !data) {
    return <div className="text-sm text-red-600">Failed to load configuration.</div>;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">
        Effective runtime configuration as reported by each live process. Read-only — values are set via
        environment variables and apply after a deploy. Secrets show only set/unset state.
      </p>

      {data.roleStatuses.some((role) => role.status !== "active") && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          {data.roleStatuses
            .filter((role) => role.status !== "active")
            .map((role) => `${role.role} is ${role.status}`)
            .join(" · ")}
          {" — running values below reflect only the live process(es)."}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {data.roleStatuses.map((role) => (
          <span
            key={`role:${role.role}`}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium ${
              role.status === "active"
                ? "bg-emerald-500/15 text-emerald-600"
                : role.status === "stale"
                  ? "bg-amber-500/15 text-amber-600"
                  : "bg-red-500/15 text-red-600"
            }`}
          >
            {role.role}: {role.status}
          </span>
        ))}
        {data.instances.map((instance) => (
          <span
            key={`${instance.role}:${instance.instanceId}`}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${instance.status === "active" ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span className="font-medium text-text-primary">{instance.role}</span>
            <span className="font-mono text-text-muted">{instance.instanceId.slice(0, 8)}</span>
            <span className="text-text-muted">· seen {formatSeen(instance.lastSeenAt)}</span>
            {instance.imageTag && <span className="text-text-muted">· {instance.imageTag}</span>}
          </span>
        ))}
      </div>

      {data.subsystems.map((group) => (
        <section key={group.subsystem}>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-text-secondary">
            {group.subsystem}
          </h2>
          <table className="w-full table-auto">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="py-1.5 pr-4 font-medium">Setting</th>
                <th className="py-1.5 pr-4 font-medium">Running</th>
                <th className="py-1.5 pr-4 font-medium">Default</th>
                <th className="py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((item) => (
                <SettingRow key={item.key} item={item} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
