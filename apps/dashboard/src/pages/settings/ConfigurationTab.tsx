import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Search, RefreshCw, X, ChevronRight } from "lucide-react";
import { Link, useInRouterContext, useLocation } from "react-router";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import {
  useAdminConfig,
  useStagedConfig,
} from "@/api/adminConfig";
import { KernelApiError } from "@/api/sdk";
import { ModalShell } from "@/components/shared/ModalShell";
import { CONFIG_COPY_RU, SUBSYSTEM_COPY_RU } from "@/pages/settings/configCopyRu";

import { ConfigEditor, BooleanConfigEditor, liveEditorKind } from "./ConfigurationEditors.js";
import { CONFIG_FILTERS, CONFIG_SUBSYSTEM_LABELS, configSubsystemOrder, matchesConfigFilter, matchesConfigSearch, runningDiffersFromDefault, type ConfigFilter } from "./configurationView.js";
export { booleanPatchBody, liveEditorKind, resolveBooleanToggle } from "./ConfigurationEditors.js";

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
  if (typeof value === "boolean") return value ? "вкл." : "выкл.";
  return value === "" ? "Пустая строка" : String(value);
}

function formatSeen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "?" : date.toLocaleTimeString("ru-RU");
}

function settingTitle(item: ConfigItem): string {
  return CONFIG_COPY_RU[item.key]?.title ?? item.label;
}

const ROLE_LABELS: Record<string, string> = { api: "Интерфейс", worker: "Обработка данных", scheduler: "Расписание" };

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

const ROLE_STATUS_RU: Record<string, string> = {
  active: "активен",
  stale: "устарел",
  down: "недоступен",
  offline: "недоступен",
  missing: "нет данных",
};

// Sort within a subsystem so the few actionable (live-editable) rows surface to the top,
// then staged flags, then plain read-only, then secrets — without losing subsystem grouping.
function rowRank(item: ConfigItem): number {
  if (item.runtimeApply === "live") return 0;
  if (item.editability === "staged") return 1;
  if (item.secret) return 3;
  return 2;
}

function RunningCell({ item }: { item: ConfigItem }) {
  if (item.running.length === 0) {
    return <span className="text-text-muted">Нет сигнала от процессов</span>;
  }

  if (item.secret || item.running[0]?.masked) {
    const stateTone = (state: string | null) =>
      state === "set" ? "bg-emerald-500/15 text-emerald-600" : state === "unknown" ? "bg-amber-500/15 text-amber-600" : "bg-zinc-500/15 text-zinc-500";
    // When live processes disagree on set/unset, show each one — a key set in api
    // but unset in worker is an operationally important drift.
    if (item.drift || item.running.some((running) => running.state === "unknown")) {
      return (
        <div className="flex flex-col gap-0.5">
          {item.running.map((r) => (
            <span key={`${r.role}:${r.instanceId}`} className="text-xs">
              <span className="text-text-muted">{ROLE_LABELS[r.role] ?? r.role}:</span>{" "}
              <Badge tone={stateTone(r.state)}>{r.state === "set" ? "задан" : r.state === "unknown" ? "нет данных" : "не задан"}</Badge>
            </span>
          ))}
        </div>
      );
    }
    const state = item.running[0]?.state ?? "unset";
    return <Badge tone={stateTone(state)}>{state === "set" ? "задан" : state === "unknown" ? "нет данных" : "не задан"}</Badge>;
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
            <span className="text-text-muted">{ROLE_LABELS[r.role] ?? r.role}:</span>{" "}
            {r.state === "unknown" ? (
              <span className="text-amber-600">Нет актуального значения</span>
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Не удалось сохранить.";
}

function SettingLabel({ item }: { item: ConfigItem }) {
  const copy = CONFIG_COPY_RU[item.key];
  return (
    <>
      <div className="break-words text-sm font-semibold leading-6 text-text-primary">{settingTitle(item)}</div>
      {copy?.short && <p id={`config-description-${item.key}`} className="mt-1 text-[13px] leading-[1.65] text-text-secondary">{copy.short}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
          {item.drift && (
            <Badge tone="bg-red-500/15 text-red-600" title="Запущенные процессы сообщают разные значения">
              значения различаются
            </Badge>
          )}
          {item.costWarning && (
            <Badge tone="bg-amber-500/15 text-amber-600" title={CONFIG_COPY_RU[item.key]?.warning ?? item.costWarning}>
              влияет на расходы
            </Badge>
          )}
          {item.destructive && (
            <Badge tone="bg-red-500/15 text-red-600" title="Снижение или очистка безвозвратно удаляет данные">
              может удалить данные
            </Badge>
          )}
        </div>
      <details className="config-help">
        <summary aria-label={`Подробнее: ${settingTitle(item)}`}><ChevronRight size={13} aria-hidden="true" />Подробнее</summary>
        <div className="config-help-body">
          {copy?.long && <p>{copy.long}</p>}
          {item.costWarning && <p className="text-amber-700">{copy?.warning ?? item.costWarning}</p>}
          <details>
            <summary className="w-fit cursor-pointer text-xs text-text-muted">Технические сведения</summary>
            <div className="mt-2 space-y-2 text-xs">
              <p>{item.label}</p>
              {item.note && <p>{item.note}</p>}
              <div className="break-all font-mono text-[11px]">{item.envName}</div>
              {runningDiffersFromDefault(item) && <p>Исходное значение программы: <span className="font-mono">{item.default}</span>. Настройка сервера может отличаться.</p>}
            </div>
          </details>
        </div>
      </details>
    </>
  );
}

function SettingRow({ item }: { item: ConfigItem }) {
  // Number/string live keys get the scalar editor; boolean live keys get the
  // on/off switch. Other kinds stay read-only — see liveEditorKind.
  const editorKind = liveEditorKind(item);

  return (
    <div
      id={`config-${item.key}`}
      tabIndex={-1}
      className="config-setting"
    >
      <div className="config-setting-main">
        <SettingLabel item={item} />
      </div>
      <div className="config-setting-control">
        <div className="config-setting-current">
          <span>Сейчас:</span><RunningCell item={item} />
          {CONFIG_COPY_RU[item.key]?.unit && <span>{CONFIG_COPY_RU[item.key]?.unit}</span>}
        </div>

        {editorKind === "number" && (
          <ConfigEditor item={item} />
        )}
        {editorKind === "string" && (
          <ConfigEditor item={item} />
        )}
        {editorKind === "boolean" && (
          <BooleanConfigEditor item={item} />
        )}
        {!editorKind && <p className="text-xs leading-relaxed text-text-muted">Меняется в настройках сервера.</p>}
      </div>
    </div>
  );
}

// --- Staged rollout (Stage C) ---------------------------------------------------------

type ItemMap = Map<string, ConfigItem>;
type StagedModalRequest = {
  item: ConfigItem;
  target: boolean | null;
  keys: Array<{ key: string; desired: boolean | null }>;
};

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
      return "разные значения";
    case "on": return "вкл.";
    case "off": return "выкл.";
    default: return "нет данных";
  }
}

function StagedConfirmModal({
  item,
  target,
  keys,
  items,
  onClose,
  restoreFocusRef,
}: {
  item: ConfigItem;
  // true = enable, false = disable, null = revert to env (clear the override).
  target: boolean | null;
  // The full atomic patch: this key plus, for a disable, its still-on dependents. Each
  // desired is the literal to send (false for a disable, null for a revert).
  keys: Array<{ key: string; desired: boolean | null }>;
  items: ItemMap;
  onClose: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  const staged = useStagedConfig();
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState("");
  const ackId = useId();
  const noteId = useId();

  const verb = target === null ? "Вернуть настройку сервера" : target ? "Включить" : "Выключить";
  const [prepared] = useState(() => keys.map((patch) => ({
    ...patch,
    expectedVersion: items.get(patch.key)?.overrideVersion ?? 0,
    previous: items.get(patch.key)?.desiredEffective ?? null,
  })));
  const changed = prepared.some((patch) =>
    !items.has(patch.key)
    || patch.expectedVersion !== (items.get(patch.key)?.overrideVersion ?? 0)
    || patch.previous !== (items.get(patch.key)?.desiredEffective ?? null));
  const isStream = STREAM_FLAG_KEYS.has(item.key);
  // Cost-warning copy: spend flags carry costWarning; balance-ping only carries a note
  // (~1 cr/day) — surface whichever is present in the same warning region (enable only).
  const warning = CONFIG_COPY_RU[item.key]?.warning ?? item.costWarning;
  // The dependents a disable also flips off (everything in the patch except this key).
  const alsoKeys = keys.filter((k) => k.key !== item.key);
  const error = staged.error;
  const isConflict = error instanceof KernelApiError && error.status === 409;

  function submit() {
    if (!ack || changed || staged.isPending) return;
    staged.mutate(
      {
        // The acknowledgement belongs to the reviewed snapshot, not the next poll.
        patches: prepared.map(({ key, desired, expectedVersion }) => ({ key, desired, expectedVersion })),
        note: note.trim() === "" ? undefined : note.trim(),
        ack: true,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <ModalShell
      closeLabel="Закрыть"
      title={`${verb}: ${settingTitle(item)}`}
      onClose={() => { if (!staged.isPending) onClose(); }}
      restoreFocusRef={restoreFocusRef}
    >
      <div className="space-y-4 text-sm">
        {CONFIG_COPY_RU[item.key]?.short && <p className="leading-relaxed text-text-secondary">{CONFIG_COPY_RU[item.key]?.short}</p>}
        <div className="space-y-2 rounded-lg border border-border bg-hover px-3 py-3 text-[13px] leading-relaxed text-text-secondary">
          <p className="font-medium text-text-primary">Перед применением</p>
          {CONFIG_COPY_RU[item.key]?.long && <p>{CONFIG_COPY_RU[item.key]?.long}</p>}
          {item.note && <p className="break-words text-xs"><span className="font-medium">Условия сервера: </span>{item.note}</p>}
        </div>

        <div className="rounded-lg border border-border bg-hover px-3 py-2">
          <div className="mb-2 text-xs font-medium text-text-secondary">Сейчас задано → Будет задано</div>
          {prepared.map((patch) => <div key={patch.key} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-1 text-xs"><span>{CONFIG_COPY_RU[patch.key]?.title ?? items.get(patch.key)?.label ?? patch.key}</span><span className="shrink-0 font-medium">{formatScalar(patch.previous)} → {patch.desired === null ? "настройка сервера" : formatScalar(patch.desired)}</span></div>)}
          {item.pendingApply && <p className="mt-2 border-t border-border pt-2 text-xs text-text-secondary">Предыдущее изменение ещё не применилось. Сейчас работает: {RUNNING_STATE_LABEL(item.runningState)}.</p>}
        </div>
        {changed && <p role="alert" className="text-sm text-danger">Настройки изменились после открытия окна. Закройте его и проверьте изменения заново.</p>}

        {target === true && warning && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700">
            {warning}
          </div>
        )}

        {alsoKeys.length > 0 && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700">
            Заодно выключатся функции, которым нужна эта настройка ({alsoKeys.length}):{" "}
            <span>
              {alsoKeys.map((k) => CONFIG_COPY_RU[k.key]?.title ?? items.get(k.key)?.label ?? k.key).join(", ")}
            </span>
            .
          </div>
        )}

        {target === null && (
          <div className="rounded border border-border bg-hover px-3 py-2 text-[13px] text-text-secondary">
            Уберём ваше ручное значение. После перезапуска Hub возьмёт настройку сервера. Она может отличаться от исходного значения программы.
          </div>
        )}

        {target === true && isStream && (
          <div className="rounded border border-border bg-hover px-3 py-2 text-[13px] text-text-secondary">
            После перезапуска откройте{" "}
            <Link to="/settings?tab=sync" className="text-accent underline hover:opacity-90">
              «Синхронизация»
            </Link>
            {" "}и возобновите нужные потоки данных.
          </div>
        )}

        <div className="rounded border border-border bg-card px-3 py-2 text-[13px] text-text-secondary">
          Сохраним ваш выбор сейчас. Настройка начнёт работать{" "}
          <span className="font-medium text-text-primary">после перезапуска Hub</span> — его нужно выполнить отдельно.
        </div>

        <label htmlFor={ackId} className="flex items-start gap-2 text-text-secondary">
          <input
            id={ackId}
            type="checkbox"
            checked={ack}
            disabled={staged.isPending || changed}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Изменения проверены. Понимаю, что нужен перезапуск Hub.
          </span>
        </label>

        <div>
          <label htmlFor={noteId} className="mb-1 block text-[12px] text-text-muted">
            Комментарий к изменению · необязательно
          </label>
          <input
            id={noteId}
            type="text"
            value={note}
            disabled={staged.isPending}
            onChange={(e) => setNote(e.target.value)}
            className="settings-input"
          />
        </div>

        {error && (
          <div role="alert" className="text-[12px] text-red-600">
            {isConflict
              ? "Настройки изменились. Закройте окно и проверьте актуальные значения перед повтором."
              : errorMessage(error)}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={staged.isPending}
          className="settings-button"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!ack || changed || isConflict || staged.isPending}
          className={`settings-button ${
            target === false ? "settings-button-danger" : "settings-button-primary"
          }`}
        >
          {staged.isPending ? "Сохраняем…" : verb}
        </button>
      </div>
    </ModalShell>
  );
}

function StagedFlagRow({
  item,
  items,
  all,
  onReveal,
  onOpen,
}: {
  item: ConfigItem;
  items: ItemMap;
  all: ConfigItem[];
  onReveal: (key: string) => void;
  onOpen: (request: StagedModalRequest) => void;
}) {
  // The staged confirm modal carries the target (enable=true / disable=false / revert=null)
  // and the full set of keys to flip in one atomic patch (this key plus, for a disable, its
  // still-on dependents). Revert-to-env goes through the SAME staged endpoint (desired:null
  // + ack), never the generic DELETE (useClearConfig stays for live editable keys only), so
  // the order rules + version check still apply.
  // Authoritative running state for the lock/decision badge is the server's runningState.
  // The client summary is computed ONLY to surface a "partial" (mixed-fleet) breakdown.
  const state = item.runningState;
  const clientState = clientRunningFlagState(item);
  // The desired baseline (override boolean, else env) comes from the server's
  // desiredEffective — so an env-on staged flag shows Disable + the correct locks.
  const desiredOn = desiredOnFor(item);

  // ENABLE lock: every transitive prerequisite must be RUNNING-on and not pending. The
  // first unsatisfied prerequisite names the tooltip ("Enable + restart <prereq> first").
  const unsatisfiedPrereq = transitiveRequires(item.key, items).find((reqKey) => {
    const req = items.get(reqKey);
    if (!req) return true;
    return !isRunningOn(req) || !desiredOnFor(req) || req.pendingApply;
  });
  const enableLocked = unsatisfiedPrereq !== undefined;
  const prerequisite = unsatisfiedPrereq ? items.get(unsatisfiedPrereq) : undefined;
  const prerequisiteTitle = prerequisite ? settingTitle(prerequisite) : unsatisfiedPrereq;
  const enableTooltip = !enableLocked ? undefined : !prerequisite || prerequisite.runningState === "unknown"
    ? `Пока нет актуальных данных о настройке «${prerequisiteTitle}». Проверьте её состояние.`
    : prerequisite.pendingApply
      ? `Дождитесь применения настройки «${prerequisiteTitle}» после перезапуска.`
      : `Сначала включите «${prerequisiteTitle}» и перезапустите Hub.`;

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
      ? `Также выключит: ${blockingDependents
          .map((depKey) => CONFIG_COPY_RU[depKey]?.title ?? items.get(depKey)?.label ?? depKey)
          .join(", ")}`
      : undefined;

  // Disable patch: dependents (deepest-first) then this key, all desired:false — one atomic
  // multi-key staged patch the server validates on the resulting graph.
  const disableKeys = [
    ...orderedDisableKeys.map((depKey) => ({ key: depKey, desired: false as const })),
    { key: item.key, desired: false as const },
  ];

  return (
    <div id={`config-${item.key}`} tabIndex={-1} className="config-setting">
      <div className="config-setting-main">
        <SettingLabel item={item} />
      </div>
      <div className="config-setting-control">
        <div className="config-setting-current">
          <span>Сейчас работает:</span>
          <Badge tone={RUNNING_STATE_TONE(state)}>{RUNNING_STATE_LABEL(state)}</Badge>
        </div>
        <div className="config-setting-current">
          <span>{item.source === "override" ? "Задано вручную:" : "Задано на сервере:"}</span>
          <span className="font-medium text-text-primary">{desiredOn ? "вкл." : "выкл."}</span>
        </div>
        {item.pendingApply && <p className="text-xs leading-relaxed text-amber-700">Сохранено. Начнёт работать после перезапуска Hub.</p>}
        {item.costWarning && <p className="text-xs text-amber-700">{CONFIG_COPY_RU[item.key]?.warning ?? item.costWarning}</p>}
        {(clientState === "partial" || clientState === "unknown") && item.running.length > 0 && (
          <div className="flex flex-col gap-1">
            {item.running.map((r) => (
              <span key={`${r.role}:${r.instanceId}`} className="text-xs">
                <span className="text-text-muted">{ROLE_LABELS[r.role] ?? r.role}:</span> {r.state === "unknown" ? "нет актуального значения" : formatScalar(r.value)}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {desiredOn ? (
            <button type="button" onClick={() => onOpen({ item, target: false, keys: disableKeys })} title={disableTooltip} className="settings-button">
              Выключить
            </button>
          ) : (
            <button type="button" onClick={() => onOpen({ item, target: true, keys: [{ key: item.key, desired: true }] })} disabled={enableLocked} title={enableTooltip} className="settings-button settings-button-primary">
              Включить
            </button>
          )}
          {item.source === "override" && (
            <button type="button" onClick={() => onOpen({ item, target: null, keys: [{ key: item.key, desired: null }] })} title="Убрать ручное значение. Настройка сервера применится после перезапуска." className="settings-button">
              Вернуть настройку сервера
            </button>
          )}
        </div>
        {enableLocked && !desiredOn && enableTooltip && (
          <p className="text-xs leading-relaxed text-text-muted">
            {enableTooltip}{" "}
            {unsatisfiedPrereq && <a href={`#config-${unsatisfiedPrereq}`} onClick={() => onReveal(unsatisfiedPrereq)} className="text-accent underline underline-offset-2">Перейти к настройке</a>}
          </p>
        )}
        {desiredOn && disableTooltip && <p className="text-xs leading-relaxed text-text-muted">{disableTooltip}</p>}
      </div>

    </div>
  );
}

function StagedPendingBanner({ data, onReveal }: { data: ConfigViewResponse; onReveal: (key: string) => void }) {
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
        <div className="config-notice">
          <div className="font-medium">Сохранено — нужен перезапуск: {pendingStaged.length}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {pendingStaged.map((item) => <a key={item.key} href={`#config-${item.key}`} onClick={() => onReveal(item.key)} className="text-xs underline underline-offset-2">{settingTitle(item)}</a>)}
          </div>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="rounded border border-red-500/40 bg-danger/10 px-3 py-2 text-sm text-red-600">
          <div className="font-semibold">Некоторые настройки не удалось применить при запуске:</div>
          <ul className="mt-1 list-disc pl-5">
            {skipped.map((s) => (
              <li key={`${s.role}:${s.key}`} className="break-all font-mono text-[12px]">
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
  const routed = useInRouterContext();
  return routed ? <RoutedConfiguration /> : <ConfigurationView hash="" />;
}

function RoutedConfiguration() {
  const { hash } = useLocation();
  return <ConfigurationView hash={hash} />;
}

function ConfigurationView({ hash }: { hash: string }) {
  const { data, isLoading, isError, isFetching, refetch } = useAdminConfig();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [subsystem, setSubsystem] = useState("");
  const [filter, setFilter] = useState<ConfigFilter>("live");
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const [stagedModal, setStagedModal] = useState<StagedModalRequest | null>(null);
  const groups = useMemo(() => [...(data?.subsystems ?? [])].sort((a, b) => configSubsystemOrder(a.subsystem) - configSubsystemOrder(b.subsystem)), [data]);
  const allItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const itemMap = useMemo<ItemMap>(() => new Map(allItems.map((item) => [item.key, item])), [allItems]);
  const bootFlags = useMemo(() => allItems.filter((item) => item.runtimeApply === "boot"), [allItems]);
  const searchMatches = useMemo(() => allItems.filter((item) =>
    (!subsystem || item.subsystem === subsystem) && matchesConfigSearch(item, query)), [allItems, query, subsystem]);
  const visibleKeys = useMemo(() => new Set(searchMatches.filter((item) => matchesConfigFilter(item, filter)).map((item) => item.key)), [searchMatches, filter]);

  function resetFilters() { setQuery(""); setSubsystem(""); setFilter("live"); }
  function reveal(key: string) { setQuery(""); setSubsystem(""); setFilter("all"); setPendingAnchor(key); }

  useEffect(() => {
    if (!hash.startsWith("#config-")) return;
    setQuery(""); setSubsystem(""); setFilter("all");
    setPendingAnchor(hash.slice("#config-".length));
  }, [hash]);

  useEffect(() => {
    if (!pendingAnchor || !visibleKeys.has(pendingAnchor)) return;
    const element = document.getElementById(`config-${pendingAnchor}`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    setPendingAnchor(null);
  }, [pendingAnchor, visibleKeys]);

  if (!data) {
    return <div role={isError ? "alert" : "status"} className="rounded-xl border border-border bg-card p-6 text-sm text-text-secondary">
      {isLoading ? "Загружаем настройки…" : "Не удалось загрузить настройки."}
      {isError && <button type="button" onClick={() => void refetch()} className="ml-3 text-accent underline">Повторить</button>}
    </div>;
  }

  return (
    <div className="space-y-5">
      {isError && <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">Не удалось обновить настройки. Показаны последние полученные значения — {formatSeen(data.generatedAt)}. Попробуйте «Обновить».</div>}

      {data.roleStatuses.some((role) => role.status !== "active") && (
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-dark">
          {data.roleStatuses.filter((role) => role.status !== "active").map((role) => `${ROLE_LABELS[role.role] ?? role.role}: ${ROLE_STATUS_RU[role.status] ?? role.status}`).join(" · ")}
          {". Часть Hub давно не выходила на связь. Её значения пока нельзя подтвердить."}
        </div>
      )}
      <div className="space-y-3">
        <div className="config-searchbar">
          <label className="config-search-field relative min-w-0">
            <span className="sr-only">Поиск настроек</span>
            <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-text-muted" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setFilter(event.target.value ? "all" : "live");
              }}
              placeholder={subsystem ? "Поиск в выбранном разделе" : "Найти настройку…"}
              className="settings-input"
              style={{ paddingLeft: 36 }}
            />
          </label>
          <label>
            <span className="sr-only">Подсистема</span>
            <select value={subsystem} onChange={(event) => setSubsystem(event.target.value)} className="settings-input">
              <option value="">Все разделы</option>
              {groups.map((group) => <option key={group.subsystem} value={group.subsystem}>{CONFIG_SUBSYSTEM_LABELS[group.subsystem] ?? group.subsystem}</option>)}
            </select>
          </label>
          <label className="config-mobile-filter">
            <span className="sr-only">Показать настройки</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value as ConfigFilter)} className="settings-input">
              {CONFIG_FILTERS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
            </select>
          </label>
        </div>
        <div className="config-filters" role="group" aria-label="Фильтр настроек">
          {CONFIG_FILTERS.map((entry) => (
            <button key={entry.key} type="button" aria-pressed={filter === entry.key} onClick={() => setFilter(entry.key)}>
              {entry.label} <span className="config-filter-count">{searchMatches.filter((item) => matchesConfigFilter(item, entry.key)).length}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
          <span className="shrink-0" role="status" aria-live="polite">Показано {visibleKeys.size} из {allItems.length}</span>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {(query || subsystem || filter !== "live") && <button type="button" onClick={resetFilters} className="inline-flex min-h-9 items-center gap-1 text-accent hover:underline"><X size={13} aria-hidden="true" />Сбросить фильтры</button>}
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 text-text-secondary hover:text-accent disabled:opacity-50">
              <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
              {isFetching ? "Обновляем…" : "Обновить"}
            </button>
          </div>
        </div>
        {!query && filter === "live" && <p className="hidden text-xs sm:block leading-relaxed text-text-muted">Изменения в этом списке начнут работать без перезапуска — обычно в течение минуты.</p>}
      </div>

      <StagedPendingBanner data={data} onReveal={reveal} />

      {visibleKeys.size === 0 && (
        <div className="config-empty">
          <p className="text-sm font-semibold text-text-primary">{query ? "По этому запросу ничего не нашлось" : filter === "attention" ? "Всё в порядке" : "Здесь пока нет таких настроек"}</p>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{query ? "Попробуйте более короткое название или ключ настройки." : filter === "attention" ? "Среди выбранных настроек нет ожидающих применения или требующих проверки." : filter === "live" ? "Посмотрите настройки, для которых нужен перезапуск или доступ к серверу." : "Выберите другой раздел или откройте полный список."}</p>
          {query && subsystem ? <button type="button" onClick={() => { setSubsystem(""); setFilter("all"); }} className="settings-button mt-4">Искать во всех разделах</button>
            : filter !== "all" && <button type="button" onClick={() => setFilter("all")} className="settings-button mt-4">Показать все настройки</button>}
        </div>
      )}

      {/* Hide rather than unmount: searching and filtering must not discard a draft. */}
      <div className="space-y-5">
        {groups.map((group) => (
          <section className="config-group" key={group.subsystem} hidden={!group.items.some((item) => visibleKeys.has(item.key))}>
            <div className="config-group-heading">
              <h3 className="text-sm font-semibold text-text-primary">
                {CONFIG_SUBSYSTEM_LABELS[group.subsystem] ?? group.subsystem}
                <span className="ml-2 text-xs font-normal tabular-nums text-text-muted">
                  {group.items.filter((item) => visibleKeys.has(item.key)).length}
                </span>
              </h3>
              {SUBSYSTEM_COPY_RU[group.subsystem] && <p className="mt-1 text-xs leading-relaxed text-text-secondary">{SUBSYSTEM_COPY_RU[group.subsystem]}</p>}
            </div>
            <div className="config-group-items">
              {[...group.items]
                .sort((a, b) => rowRank(a) - rowRank(b) || (a.stagedOrder ?? 0) - (b.stagedOrder ?? 0))
                .map((item) => (
                  <div key={item.key} hidden={!visibleKeys.has(item.key)}>
                    {item.runtimeApply === "boot" ? (
                      <StagedFlagRow
                        item={item}
                        items={itemMap}
                        all={bootFlags}
                        onReveal={reveal}
                        onOpen={setStagedModal}
                      />
                    ) : <SettingRow item={item} />}
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>
      {/* A poll may remove a row from the attention filter while its dialog is open.
          Keep the dialog outside hidden groups, with its reviewed patch and version. */}
      {stagedModal && (
        <StagedConfirmModal
          key={stagedModal.item.key}
          item={itemMap.get(stagedModal.item.key) ?? stagedModal.item}
          target={stagedModal.target}
          keys={stagedModal.keys}
          items={itemMap}
          onClose={() => setStagedModal(null)}
          restoreFocusRef={searchRef}
        />
      )}
      <details className="config-status-strip">
        <summary className="w-fit cursor-pointer py-2 text-xs text-text-secondary">
          <span className="font-medium text-text-primary">Связь с сервером</span>
          <span className="ml-2">{data.roleStatuses.length > 0 && data.roleStatuses.every((role) => role.status === "active") ? "Все на связи" : "Требует проверки"}</span>
        </summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.instances.map((instance) => (
            <span key={`${instance.role}:${instance.instanceId}`} className="min-w-0 break-all rounded-md border border-border px-2 py-1 text-xs text-text-secondary">
              <span className="font-medium text-text-primary">{ROLE_LABELS[instance.role] ?? instance.role}</span> · {ROLE_STATUS_RU[instance.status] ?? instance.status} · сигнал {formatSeen(instance.lastSeenAt)}
              {instance.imageTag && ` · ${instance.imageTag}`}
              <span className="block text-text-muted">{instance.instanceId}</span>
            </span>
          ))}
          {data.instances.length === 0 && <p className="text-xs text-text-muted">Процессы ещё не сообщили свои значения.</p>}
        </div>
      </details>

    </div>
  );
}
