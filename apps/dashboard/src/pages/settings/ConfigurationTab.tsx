import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import {
  useAdminConfig,
  useClearConfig,
  useStagedConfig,
  useUpdateConfig,
} from "@/api/adminConfig";
import { ApiError } from "@/api/client";
import { ModalShell } from "@/components/shared/ModalShell";

// The 3 staged flags that drive a sync stream: after a restart their paused Sync blocks
// must be manually resumed on the Sync tab (no resume-all button by design).
const STREAM_FLAG_KEYS = new Set([
  "ofapiDmSyncEnabled",
  "ofapiAudienceSyncEnabled",
  "onlyFansTopSpendersEnabled",
]);

// DISPLAY-ONLY client summary of the per-instance fleet, used solely to detect a "partial"
// (mixed) fleet so the per-instance breakdown can be shown. It is NOT the lock/desired
// truth — that comes from the server-computed item.runningState / item.desiredEffective
// (app-config-service.ts), the single source the staged gate enforces. "partial" exists
// only here for the breakdown; the server collapses a mixed fleet to "off".
type RunningFlagState = "on" | "off" | "partial" | "unknown";

function clientRunningFlagState(item: ConfigItem): RunningFlagState {
  if (item.running.length === 0) return "unknown";
  if (item.running.some((r) => r.state === "unknown")) return "unknown";
  const onCount = item.running.filter((r) => r.value === true).length;
  if (onCount === item.running.length) return "on";
  if (onCount === 0) return "off";
  return "partial";
}

// "on" for lock purposes: the SERVER-computed applied truth (role-complete, fail-closed).
function isRunningOn(item: ConfigItem): boolean {
  return item.runningState === "on";
}

// The desired-on intent for a staged flag: the SERVER-computed desiredEffective (the
// override boolean when one exists, else the env baseline). Used for the Enable/Disable
// decision AND the disable-lock dependent check so both agree with validateStagedTransition.
function desiredOnFor(item: ConfigItem): boolean {
  return item.desiredEffective === true;
}

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

// Wiring class (runtimeApply): 'live' applies without a restart; 'boot' is captured at
// process start; 'none' is not overridable via the DB at all (env-only / read-only) —
// it must NOT read as "restart"/"live".
const RUNTIME_APPLY_LABEL: Record<string, string> = {
  live: "live",
  boot: "applies after restart",
  none: "env only",
};

const RUNTIME_APPLY_TONE: Record<string, string> = {
  live: "bg-emerald-500/15 text-emerald-600",
  boot: "bg-orange-500/15 text-orange-600",
  none: "bg-zinc-500/15 text-zinc-500",
};

const RUNTIME_APPLY_TITLE: Record<string, string> = {
  live: "Applies live (no restart)",
  boot: "Captured at boot — applies after restart",
  none: "Not overridable here — env-only / read-only",
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

  // An instance reporting under an older/mismatched snapshot shape shows as "unknown
  // (stale snapshot)" per row instead of a misleading value, and any unknown row forces
  // the per-instance breakdown so it can't hide behind a single trusted value.
  const hasUnknown = item.running.some((r) => r.state === "unknown");
  if (item.drift || hasUnknown) {
    return (
      <div className="flex flex-col gap-0.5">
        {item.running.map((r) => (
          <span key={`${r.role}:${r.instanceId}`} className="font-mono text-xs">
            <span className="text-text-muted">{r.role}:</span>{" "}
            {r.state === "unknown" ? (
              <span className="text-amber-600">unknown (stale snapshot)</span>
            ) : (
              formatScalar(r.value)
            )}
          </span>
        ))}
      </div>
    );
  }

  return <span className="font-mono text-text-primary">{formatScalar(item.running[0]!.value)}</span>;
}

function seedValue(item: ConfigItem): string {
  if (item.desired !== null && item.desired !== undefined) return String(item.desired);
  const running = item.running[0]?.value;
  if (running !== null && running !== undefined) return String(running);
  return item.default;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Save failed.";
}

function ConfigEditor({ item }: { item: ConfigItem }) {
  const update = useUpdateConfig();
  const clear = useClearConfig();
  const [input, setInput] = useState(() => seedValue(item));
  // Two-click confirm gate for cost/destructive keys. Save AND revert both change the
  // live value, so both pass through it; the state tracks which action is armed.
  const [confirm, setConfirm] = useState<null | "save" | "revert">(null);

  const needsConfirm = Boolean(item.costWarning) || item.destructive;
  const seeded = seedValue(item);
  const dirty = input.trim() !== seeded && input.trim() !== "";
  const pending = update.isPending || clear.isPending;
  const error = update.error ?? clear.error;
  const isConflict = error instanceof ApiError && error.status === 409;

  function save() {
    update.mutate({
      patches: [{ key: item.key, value: Number(input), expectedVersion: item.overrideVersion ?? 0 }],
    });
    setConfirm(null);
  }

  function revert() {
    clear.mutate({ key: item.key, expectedVersion: item.overrideVersion ?? undefined });
    setConfirm(null);
  }

  function onSaveClick() {
    if (needsConfirm && confirm !== "save") {
      setConfirm("save");
      return;
    }
    save();
  }

  function onRevertClick() {
    if (needsConfirm && confirm !== "revert") {
      setConfirm("revert");
      return;
    }
    revert();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="number"
          aria-label={`${item.label} value`}
          value={input}
          disabled={pending}
          onChange={(e) => {
            setInput(e.target.value);
            setConfirm(null);
          }}
          className="w-24 rounded border border-border bg-card px-1.5 py-0.5 text-xs font-mono text-text-primary disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onSaveClick}
          disabled={pending || !dirty}
          className={`rounded px-2 py-0.5 text-xs font-medium text-white transition-colors disabled:opacity-40 ${
            confirm === "save" ? "bg-danger hover:opacity-90" : "bg-accent hover:opacity-90"
          }`}
        >
          {confirm === "save" ? "Confirm" : "Save"}
        </button>
        {item.source === "override" && (
          <button
            type="button"
            onClick={onRevertClick}
            disabled={pending}
            className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
              confirm === "revert"
                ? "bg-danger text-white hover:opacity-90"
                : "border border-border bg-card text-text-secondary hover:bg-hover"
            }`}
          >
            {confirm === "revert" ? "Confirm revert" : "Revert to env"}
          </button>
        )}
        {confirm !== null && (
          <button
            type="button"
            onClick={() => setConfirm(null)}
            disabled={pending}
            className="rounded border border-border bg-card px-2 py-0.5 text-xs text-text-secondary hover:bg-hover disabled:opacity-40"
          >
            Cancel
          </button>
        )}
        {item.pendingApply && (
          <Badge
            tone="bg-amber-500/15 text-amber-600"
            title="Saved — can take up to ~60s (one heartbeat) to reflect across processes"
          >
            applying…
          </Badge>
        )}
      </div>
      {confirm !== null && needsConfirm && (
        <div className="text-[11px] text-amber-600">
          {item.destructive ? "Destructive: lowering/clearing this drops data irreversibly. " : ""}
          {item.costWarning ?? ""}{" "}
          {confirm === "revert" ? "Revert to the env default?" : "Click Confirm to apply."}
        </div>
      )}
      {error && (
        <div className="text-[11px] text-red-600">
          {isConflict
            ? "Changed elsewhere — values were refreshed, review and retry."
            : errorMessage(error)}
        </div>
      )}
    </div>
  );
}

function SettingRow({ item }: { item: ConfigItem }) {
  // Only numeric live keys get an inline editor today (all 8 live keys are numbers).
  // A future non-numeric live key stays read-only until it gets a proper editor,
  // which keeps the Number()-based editor honest.
  const isEditable = item.runtimeApply === "live" && item.kind === "number";
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
      <td className="py-2 pr-4">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={EDITABILITY_TONE[item.editability] ?? "bg-zinc-500/15 text-zinc-500"}>
            {EDITABILITY_LABEL[item.editability] ?? item.editability}
          </Badge>
          <Badge
            tone={RUNTIME_APPLY_TONE[item.runtimeApply] ?? "bg-zinc-500/15 text-zinc-500"}
            title={RUNTIME_APPLY_TITLE[item.runtimeApply] ?? ""}
          >
            {RUNTIME_APPLY_LABEL[item.runtimeApply] ?? item.runtimeApply}
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
      <td className="py-2">
        {isEditable ? (
          <ConfigEditor key={`${item.overrideVersion ?? "env"}:${seedValue(item)}`} item={item} />
        ) : null}
      </td>
    </tr>
  );
}

// --- Staged rollout (Stage C) ---------------------------------------------------------

type ItemMap = Map<string, ConfigItem>;

// Walk the transitive `requires` chain (DAG; the registry chain is linear), nearest-first,
// excluding the key itself. Mirrors transitiveRequires in staged-config.ts.
function transitiveRequires(key: string, items: ItemMap): string[] {
  const out: string[] = [];
  const seen = new Set<string>([key]);
  const queue = [...(items.get(key)?.requires ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(items.get(next)?.requires ?? []));
  }
  return out;
}

// Every staged flag that (transitively) requires `key` — used to block disabling a flag
// while a dependent is still desired-on. Mirrors transitiveDependents in staged-config.ts.
function transitiveDependents(key: string, items: ItemMap, all: ConfigItem[]): string[] {
  return all
    .filter((it) => it.runtimeApply === "boot" && transitiveRequires(it.key, items).includes(key))
    .map((it) => it.key);
}

function RUNNING_STATE_TONE(state: RunningFlagState): string {
  switch (state) {
    case "on":
      return "bg-emerald-500/15 text-emerald-600";
    case "off":
      return "bg-zinc-500/15 text-zinc-500";
    case "partial":
      return "bg-amber-500/15 text-amber-600";
    default:
      return "bg-amber-500/15 text-amber-600";
  }
}

function RUNNING_STATE_LABEL(state: RunningFlagState): string {
  switch (state) {
    case "partial":
      return "partial (per-instance)";
    default:
      return state;
  }
}

function StagedConfirmModal({
  item,
  target,
  keys,
  items,
  onClose,
}: {
  item: ConfigItem;
  // true = enable, false = disable, null = revert to env (clear the override).
  target: boolean | null;
  // The full atomic patch: this key plus, for a disable, its still-on dependents. Each
  // desired is the literal to send (false for a disable, null for a revert).
  keys: Array<{ key: string; desired: boolean | null }>;
  items: ItemMap;
  onClose: () => void;
}) {
  const staged = useStagedConfig();
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState("");
  const ackId = useId();
  const noteId = useId();

  const verb = target === null ? "Revert" : target ? "Enable" : "Disable";
  const isStream = STREAM_FLAG_KEYS.has(item.key);
  // Cost-warning copy: spend flags carry costWarning; balance-ping only carries a note
  // (~1 cr/day) — surface whichever is present in the same warning region (enable only).
  const warning = item.costWarning ?? (target === true ? item.note : null);
  // The dependents a disable also flips off (everything in the patch except this key).
  const alsoKeys = keys.filter((k) => k.key !== item.key);
  const error = staged.error;
  const isConflict = error instanceof ApiError && error.status === 409;

  function submit() {
    if (!ack) return;
    staged.mutate(
      {
        // Per-key expectedVersion from the current view so each key is version-checked.
        patches: keys.map((k) => ({
          key: k.key,
          desired: k.desired,
          expectedVersion: items.get(k.key)?.overrideVersion ?? 0,
        })),
        note: note.trim() === "" ? undefined : note.trim(),
        ack: true,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell title={`${verb} ${item.label}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div>
          <div className="font-mono text-[11px] text-text-muted">{item.envName}</div>
          {item.note && <p className="mt-1 text-text-secondary">{item.note}</p>}
        </div>

        {target === true && warning && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700">
            ⚠ {warning}
          </div>
        )}

        {alsoKeys.length > 0 && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700">
            This also disables {alsoKeys.length} dependent flag{alsoKeys.length === 1 ? "" : "s"} in the
            same atomic change:{" "}
            <span className="font-mono">
              {alsoKeys.map((k) => items.get(k.key)?.envName ?? k.key).join(", ")}
            </span>
            .
          </div>
        )}

        {target === null && (
          <div className="rounded border border-border bg-hover px-3 py-2 text-[13px] text-text-secondary">
            Reverting drops the explicit override and inherits the deployed env default after a
            restart.
          </div>
        )}

        {target === true && isStream && (
          <div className="rounded border border-border bg-hover px-3 py-2 text-[13px] text-text-secondary">
            After restart, resume the paused sync blocks for affected pages on the{" "}
            <Link to="/settings?tab=sync" className="text-accent underline hover:opacity-90">
              Sync tab
            </Link>
            .
          </div>
        )}

        <div className="rounded border border-border bg-card px-3 py-2 text-[13px] text-text-secondary">
          This is a boot-applied flag: it is saved as a desired override now and{" "}
          <span className="font-medium text-text-primary">takes effect after a restart/deploy</span>.
        </div>

        <label htmlFor={ackId} className="flex items-start gap-2 text-text-secondary">
          <input
            id={ackId}
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I understand this applies after a restart and I&apos;ve verified the previous phase is
            running.
          </span>
        </label>

        <div>
          <label htmlFor={noteId} className="mb-1 block text-[12px] text-text-muted">
            Note (optional — stored in the audit log)
          </label>
          <input
            id={noteId}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-text-primary"
          />
        </div>

        {error && (
          <div className="text-[12px] text-red-600">
            {isConflict
              ? "Changed elsewhere — values were refreshed, review and retry."
              : errorMessage(error)}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={staged.isPending}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!ack || staged.isPending}
          className={`rounded-lg px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 ${
            target === true ? "bg-accent" : "bg-danger"
          }`}
        >
          {staged.isPending ? "Saving…" : verb}
        </button>
      </div>
    </ModalShell>
  );
}

function StagedFlagRow({
  item,
  items,
  all,
}: {
  item: ConfigItem;
  items: ItemMap;
  all: ConfigItem[];
}) {
  // The staged confirm modal carries the target (enable=true / disable=false / revert=null)
  // and the full set of keys to flip in one atomic patch (this key plus, for a disable, its
  // still-on dependents). Revert-to-env goes through the SAME staged endpoint (desired:null
  // + ack), never the generic DELETE (useClearConfig stays for live numeric keys only), so
  // the order rules + version check still apply.
  const [modal, setModal] = useState<
    null | { target: boolean | null; keys: Array<{ key: string; desired: boolean | null }> }
  >(null);

  // Authoritative running state for the lock/decision badge is the server's runningState.
  // The client summary is computed ONLY to surface a "partial" (mixed-fleet) breakdown.
  const state = item.runningState;
  const clientState = clientRunningFlagState(item);
  // The desired baseline (override boolean, else env) comes from the server's
  // desiredEffective — so an env-on staged flag shows Disable + the correct locks.
  const desiredOn = desiredOnFor(item);
  const isStream = STREAM_FLAG_KEYS.has(item.key);

  // ENABLE lock: every transitive prerequisite must be RUNNING-on and not pending. The
  // first unsatisfied prerequisite names the tooltip ("Enable + restart <prereq> first").
  const unsatisfiedPrereq = transitiveRequires(item.key, items).find((reqKey) => {
    const req = items.get(reqKey);
    if (!req) return true;
    return !isRunningOn(req) || req.pendingApply;
  });
  const enableLocked = unsatisfiedPrereq !== undefined;
  const enableTooltip = enableLocked
    ? `Enable + restart ${items.get(unsatisfiedPrereq!)?.envName ?? unsatisfiedPrereq} first`
    : undefined;

  // DISABLE: the transitive dependents still desired-on. A single-key disable would be
  // 400'd by the server while any remain, so we instead send ONE multi-key staged patch
  // that disables the dependents (deepest-first) + this key atomically — exactly what the
  // server's atomic multi-key disable accepts (validated on the resulting graph).
  const blockingDependents = transitiveDependents(item.key, items, all).filter((depKey) => {
    const dep = items.get(depKey);
    return dep ? desiredOnFor(dep) : false;
  });
  // Deepest dependents first so the resulting graph never has a dependent-on/prereq-off
  // intermediate; this key itself is appended last by the modal.
  const orderedDisableKeys = [...blockingDependents].sort(
    (a, b) => (items.get(b)?.stagedOrder ?? 0) - (items.get(a)?.stagedOrder ?? 0),
  );
  const disableTooltip =
    blockingDependents.length > 0
      ? `Also disables ${blockingDependents
          .map((depKey) => items.get(depKey)?.envName ?? depKey)
          .join(", ")}`
      : undefined;

  // Disable patch: dependents (deepest-first) then this key, all desired:false — one atomic
  // multi-key staged patch the server validates on the resulting graph.
  const disableKeys = [
    ...orderedDisableKeys.map((depKey) => ({ key: depKey, desired: false as const })),
    { key: item.key, desired: false as const },
  ];

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{item.label}</div>
          <div className="font-mono text-[11px] text-text-muted">{item.envName}</div>
          {item.note && <div className="mt-0.5 text-[11px] text-text-muted">{item.note}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-muted">running</span>
          <Badge tone={RUNNING_STATE_TONE(state)}>{RUNNING_STATE_LABEL(state)}</Badge>
          <span className="text-[11px] text-text-muted">· desired</span>
          <Badge tone={desiredOn ? "bg-emerald-500/15 text-emerald-600" : "bg-zinc-500/15 text-zinc-500"}>
            {desiredOn ? "on" : "off"}
          </Badge>
          {item.source === "override" && (
            <Badge tone="bg-sky-500/15 text-sky-600" title="An explicit DB override is set">
              override
            </Badge>
          )}
          {item.costWarning && (
            <Badge tone="bg-amber-500/15 text-amber-600" title={item.costWarning}>
              ⚠ cost
            </Badge>
          )}
          {item.pendingApply && (
            <Badge
              tone="bg-amber-500/15 text-amber-600"
              title="Desired is set but not yet running everywhere — apply on next restart/deploy"
            >
              pending restart{isStream ? " · resume on Sync after restart" : ""}
            </Badge>
          )}
        </div>
      </div>

      {clientState === "partial" && (
        <div className="flex flex-col gap-0.5 pl-1">
          {item.running.map((r) => (
            <span key={`${r.role}:${r.instanceId}`} className="font-mono text-[11px]">
              <span className="text-text-muted">{r.role}:</span> {formatScalar(r.value)}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {desiredOn ? (
          <button
            type="button"
            onClick={() => setModal({ target: false, keys: disableKeys })}
            title={disableTooltip}
            className="rounded px-2 py-0.5 text-xs font-medium text-white transition-colors hover:opacity-90 bg-danger"
          >
            Disable
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setModal({ target: true, keys: [{ key: item.key, desired: true }] })}
            disabled={enableLocked}
            title={enableTooltip}
            className="rounded px-2 py-0.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 bg-accent"
          >
            Enable
          </button>
        )}
        {item.source === "override" && (
          <button
            type="button"
            onClick={() => setModal({ target: null, keys: [{ key: item.key, desired: null }] })}
            title="Revert to the deployed env default (clears the override via the staged endpoint)"
            className="rounded border border-border bg-card px-2 py-0.5 text-xs text-text-secondary hover:bg-hover"
          >
            Revert to env
          </button>
        )}
        {enableLocked && !desiredOn && enableTooltip && (
          <span className="text-[11px] text-text-muted">{enableTooltip}</span>
        )}
        {desiredOn && disableTooltip && (
          <span className="text-[11px] text-text-muted">{disableTooltip}</span>
        )}
      </div>

      {modal && (
        <StagedConfirmModal
          item={item}
          target={modal.target}
          keys={modal.keys}
          items={items}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function StagedRolloutSection({ items }: { items: ConfigItem[] }) {
  const bootFlags = useMemo(() => items.filter((it) => it.runtimeApply === "boot"), [items]);
  const itemMap = useMemo<ItemMap>(() => new Map(items.map((it) => [it.key, it])), [items]);

  if (bootFlags.length === 0) return null;

  // Group by stagedGroup ("#49" then "#50", any others after), each ordered by stagedOrder.
  const byGroup = new Map<string, ConfigItem[]>();
  for (const flag of bootFlags) {
    const group = flag.stagedGroup ?? "ungrouped";
    const list = byGroup.get(group) ?? [];
    list.push(flag);
    byGroup.set(group, list);
  }
  const groupOrder = (g: string) => (g === "#49" ? 0 : g === "#50" ? 1 : 2);
  const groups = [...byGroup.entries()].sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]));

  return (
    <section>
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-text-secondary">
        Staged rollout
      </h2>
      <p className="mb-3 text-[12px] text-text-muted">
        Boot-applied feature flags. Saving sets the desired value now; it takes effect on the next
        restart/deploy. Each flag unlocks only once its prerequisite is running — enable in order.
      </p>
      <div className="space-y-5">
        {groups.map(([group, flags]) => {
          const ordered = [...flags].sort((a, b) => (a.stagedOrder ?? 0) - (b.stagedOrder ?? 0));
          return (
            <div key={group} className="rounded border border-border">
              <div className="border-b border-border bg-hover px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                {group}
              </div>
              <div className="px-3">
                {ordered.map((flag) => (
                  <StagedFlagRow key={flag.key} item={flag} items={itemMap} all={bootFlags} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StagedPendingBanner({ data }: { data: ConfigViewResponse }) {
  const allItems = data.subsystems.flatMap((g) => g.items);
  const pendingStaged = allItems.filter(
    (it) => it.runtimeApply === "boot" && it.pendingApply,
  );
  const skipped = data.instances.flatMap((inst) =>
    inst.skippedOverrides.map((s) => ({ role: inst.role, key: s.key, reason: s.reason })),
  );

  if (pendingStaged.length === 0 && skipped.length === 0) return null;

  return (
    <div className="space-y-2">
      {pendingStaged.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          {pendingStaged.length} staged flag{pendingStaged.length === 1 ? "" : "s"} saved — apply on
          next deploy/restart:{" "}
          <span className="font-mono">
            {pendingStaged.map((it) => it.envName).join(", ")}
          </span>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="rounded border border-red-500/40 bg-danger/10 px-3 py-2 text-sm text-red-600">
          <div className="font-semibold">Override rejected at boot:</div>
          <ul className="mt-1 list-disc pl-5">
            {skipped.map((s) => (
              <li key={`${s.role}:${s.key}`} className="font-mono text-[12px]">
                {s.role}: {s.key} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
        Effective runtime configuration as reported by each live process. Editable, live keys can be
        overridden here and apply without a restart (up to ~60s to propagate across processes); all other
        values are set via environment variables and apply after a deploy. Secrets show only set/unset state.
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

      <StagedPendingBanner data={data} />

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
                <th className="py-1.5 pr-4 font-medium">Status</th>
                <th className="py-1.5 font-medium">Edit</th>
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

      <StagedRolloutSection items={data.subsystems.flatMap((group) => group.items)} />
    </div>
  );
}
