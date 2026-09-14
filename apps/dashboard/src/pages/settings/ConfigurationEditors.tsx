import { useEffect, useState } from "react";
import type { ConfigItem, ConfigUpdateBody, ConfigUpdateResponse } from "@agency_hub_core/contracts";
import { useAdminConfig, useClearConfig, useUpdateConfig } from "@/api/adminConfig";
import { KernelApiError } from "@/api/sdk";
import { CONFIG_COPY_RU } from "./configCopyRu.js";
import { ConfigChoiceField } from "./ConfigChoiceField.js";
import { CONFIG_MODE_CHOICES, configPageScope } from "./configurationChoices.js";

type Scalar = string | number | boolean;

export function seedValue(item: ConfigItem): string {
  if (item.desired !== null && item.desired !== undefined) return String(item.desired);
  const running = item.running.find((value) => value.state !== "unknown" && !value.masked)?.value;
  if (running !== null && running !== undefined) return String(running);
  return item.default;
}

export function liveEditorKind(
  item: Pick<ConfigItem, "runtimeApply" | "kind">,
): "number" | "boolean" | "string" | null {
  if (item.runtimeApply !== "live") return null;
  return item.kind === "number" || item.kind === "boolean" || item.kind === "string"
    ? item.kind
    : null;
}

export function booleanPatchBody(
  item: Pick<ConfigItem, "key" | "overrideVersion">,
  target: boolean,
): ConfigUpdateBody {
  return { patches: [{ key: item.key, value: target, expectedVersion: item.overrideVersion ?? 0 }] };
}

type BooleanConfirm = { action: "save"; target: boolean } | { action: "revert" };

export function resolveBooleanToggle(opts: {
  item: Pick<ConfigItem, "key" | "overrideVersion" | "costWarning" | "destructive">;
  target: boolean;
  confirm: BooleanConfirm | null;
}): { kind: "arm" } | { kind: "save"; body: ConfigUpdateBody } {
  const needsConfirm = Boolean(opts.item.costWarning) || opts.item.destructive;
  const armed = opts.confirm?.action === "save" && opts.confirm.target === opts.target;
  if (needsConfirm && !armed) return { kind: "arm" };
  return { kind: "save", body: booleanPatchBody(opts.item, opts.target) };
}

// A draft owns the version it started from. Polling may refresh the surrounding row,
// but it must never silently rebase an unsaved edit onto a different override.
export type ConfigSnapshot = {
  key: string;
  version: number;
  source: ConfigItem["source"];
  value: string;
};

export function captureConfigSnapshot(item: ConfigItem): ConfigSnapshot {
  return {
    key: item.key,
    version: item.overrideVersion ?? 0,
    source: item.source,
    value: seedValue(item),
  };
}

export function configSnapshotChanged(snapshot: ConfigSnapshot, item: ConfigItem): boolean {
  const next = captureConfigSnapshot(item);
  return snapshot.key !== next.key || snapshot.version !== next.version
    || snapshot.source !== next.source || snapshot.value !== next.value;
}

export function parseScalarInput(kind: ConfigItem["kind"], input: string):
  | { valid: true; value: string | number }
  | { valid: false; message: string } {
  // The live API rejects every empty string override, including page allowlists.
  // Clearing an override is a separate operation that inherits the deployed env.
  if (kind === "string") {
    const value = input.trim();
    return value === ""
      ? { valid: false, message: "Пустое значение сохранить нельзя. Возврат к настройке сервера выполняется отдельно." }
      : { valid: true, value };
  }
  if (input.trim() === "" || !Number.isFinite(Number(input))) {
    return { valid: false, message: "Введите число. Пустое поле не сбрасывает настройку." };
  }
  const value = Number(input);
  if (!Number.isInteger(value)) {
    return { valid: false, message: "Введите целое число." };
  }
  return { valid: true, value };
}

export function prepareScalarSave(item: ConfigItem, snapshot: ConfigSnapshot, input: string):
  | { kind: "conflict" }
  | { kind: "invalid"; message: string }
  | { kind: "save"; body: ConfigUpdateBody } {
  if (configSnapshotChanged(snapshot, item)) return { kind: "conflict" };
  const parsed = parseScalarInput(item.kind, input);
  if (!parsed.valid) return { kind: "invalid", message: parsed.message };
  return {
    kind: "save",
    body: { patches: [{ key: snapshot.key, value: parsed.value, expectedVersion: snapshot.version }] },
  };
}

function displayValue(value: Scalar): string {
  if (typeof value === "boolean") return value ? "включено" : "выключено";
  return value === "" ? "пустая строка" : String(value);
}

function savedValue(item: ConfigItem): string {
  if (item.desired !== null && item.desired !== undefined) return displayValue(item.desired);
  if (item.desiredEffective !== null && item.desiredEffective !== undefined) return displayValue(item.desiredEffective);
  return "ручное значение не задано; используется настройка сервера";
}

type PersistedConfigState = Pick<ConfigItem, "key" | "source" | "desired" | "overrideVersion">;
export type ConfigWriteReceipt = ({
  action: "save";
  key: string;
  value: Scalar;
  version: number;
} | {
  action: "clear";
  key: string;
  previousVersion: number;
}) & { observed?: boolean; verified?: PersistedConfigState };

export function savedConfigReceipt(result: ConfigUpdateResponse["results"][number]): ConfigWriteReceipt {
  return { action: "save", key: result.key, value: result.value, version: result.version };
}

export function configReceiptState(receipt: ConfigWriteReceipt, item: ConfigItem): "waiting" | "current" | "replaced" {
  const verified = receipt.verified;
  const matchesVerified = verified && verified.key === item.key && verified.source === item.source
    && verified.overrideVersion === item.overrideVersion && verified.desired === item.desired;
  if (verified && !matchesVerified) {
    // refetch() may resolve just before the parent renders its result. Do not
    // unlock an old item while that authoritative response is still propagating.
    return "waiting";
  }
  const matches = item.key === receipt.key && (receipt.action === "save"
    ? item.source === "override" && item.overrideVersion === receipt.version && item.desired === receipt.value
    : item.source === "env" && item.overrideVersion === null);
  if (matches) return "current";
  // Once seen in the read model, a later change invalidates the success message.
  // A strictly newer version is also authoritative even if our own version was missed.
  if (receipt.observed || (item.overrideVersion ?? 0) > (receipt.action === "save" ? receipt.version : receipt.previousVersion)) return "replaced";
  if (matchesVerified) return "replaced";
  return "waiting";
}

function useConfigReceipt(item: ConfigItem) {
  const [receipt, setReceipt] = useState<ConfigWriteReceipt | null>(null);
  const state = receipt ? configReceiptState(receipt, item) : null;
  useEffect(() => {
    if (state === "replaced") setReceipt(null);
    else if (state === "current" && receipt && (!receipt.observed || receipt.verified)) {
      const confirmed = { ...receipt, observed: true };
      delete confirmed.verified;
      setReceipt(confirmed);
    }
  }, [receipt, state]);
  return {
    receipt,
    setReceipt,
    waiting: state === "waiting",
    success: state === "current" && receipt
      ? receipt.action === "save" ? `Сохранено: ${displayValue(receipt.value)}.` : "Ручное значение убрано. Hub возьмёт настройку сервера."
      : null,
    verified(current: ConfigItem) {
      setReceipt((previous) => previous ? { ...previous, verified: {
        key: current.key, source: current.source, desired: current.desired, overrideVersion: current.overrideVersion,
      } } : previous);
    },
  };
}

function ReceiptReconciliation({ receipt, onVerified }: { receipt: ConfigWriteReceipt; onVerified: (item: ConfigItem) => void }) {
  // Mount an additional observer only while a write needs reconciliation. The hook
  // owns the authoritative cache; a receipt never manufactures running/desired data.
  const query = useAdminConfig();
  const [failed, setFailed] = useState(false);
  async function refresh() {
    setFailed(false);
    const result = await query.refetch();
    const current = !result.isError && !result.isFetching && result.data?.subsystems.flatMap((group) => group.items).find((entry) => entry.key === receipt.key);
    if (current) onVerified(current);
    else setFailed(true);
  }
  return (
    <div className="space-y-2 text-xs text-text-secondary">
      <p role="status">{receipt.action === "save" ? `Сервер сохранил: ${displayValue(receipt.value)}.` : "Сервер убрал ручное значение."} Актуальное состояние ещё не подтверждено. Следующее изменение доступно после проверки.</p>
      {failed && <p role="alert" className="text-danger">Не удалось получить актуальное состояние. Сохранённое изменение не потеряно.</p>}
      <button type="button" className={secondaryButton} disabled={query.isFetching} onClick={() => void refresh()}>
        {query.isFetching ? "Проверяем…" : "Проверить состояние"}
      </button>
    </div>
  );
}

function isConflict(error: unknown): boolean {
  return error instanceof KernelApiError && error.status === 409;
}

function useEditorMutations() {
  const update = useUpdateConfig();
  const clear = useClearConfig();
  return {
    update,
    clear,
    pending: update.isPending || clear.isPending,
    error: update.error ?? clear.error,
    resetErrors() {
      update.reset();
      clear.reset();
    },
  };
}

const secondaryButton = "settings-button";
const primaryButton = "settings-button settings-button-primary";
const confirmButton = "settings-button settings-button-danger";

function ChangeWarning({ item, action, before, after }: {
  item: ConfigItem;
  action: "save" | "revert";
  before: Scalar;
  after?: Scalar;
}) {
  const warning = CONFIG_COPY_RU[item.key]?.warning ?? item.costWarning;
  return (
    <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
      <p className="font-medium">
        {action === "revert"
          ? "Убрать ваше ручное значение и вернуть настройку сервера?"
          : `${displayValue(before)} → ${displayValue(after ?? "")}`}
      </p>
      {action === "revert" && (
        <p>Hub возьмёт значение из настроек сервера. Оно может отличаться от исходного значения программы.</p>
      )}
      {item.destructive && <p>Снижение или очистка может безвозвратно удалить данные.</p>}
      {warning && <p>{warning}</p>}
      <p>Применяется без перезапуска, обычно в течение минуты.</p>
    </div>
  );
}

function MutationStatus({ pending, pendingApply, error, success, conflict }: {
  pending: boolean;
  pendingApply: boolean;
  error: unknown;
  success: string | null;
  conflict: boolean;
}) {
  const message = pending
    ? "Сохраняем…"
    : pendingApply
      ? "Сохранено. Ждём, пока настройку подхватят все части Hub — обычно до минуты."
      : success;
  const visibleError = error != null && !conflict;
  if (!message && !visibleError) return null;
  return (
    <>
      {message && <p role="status" aria-live="polite" className="text-xs text-text-muted">{message}</p>}
      {visibleError && (
        <p role="alert" className="text-xs text-red-600">
          {error instanceof Error ? error.message : "Не удалось сохранить. Повторите попытку."}
        </p>
      )}
    </>
  );
}

export function ConfigEditor({ item, friendly = false }: { item: ConfigItem; friendly?: boolean }) {
  const mutations = useEditorMutations();
  const [draft, setDraft] = useState<{ input: string; snapshot: ConfigSnapshot } | null>(null);
  const [confirm, setConfirm] = useState<{ action: "save" | "revert"; snapshot: ConfigSnapshot } | null>(null);
  const receipt = useConfigReceipt(item);
  const input = receipt.waiting && receipt.receipt?.action === "save"
    ? String(receipt.receipt.value) : draft?.input ?? seedValue(item);
  const parsed = parseScalarInput(item.kind, input);
  const dirty = draft !== null && input.trim() !== draft.snapshot.value;
  const staleDraft = draft !== null && configSnapshotChanged(draft.snapshot, item);
  const staleConfirmation = confirm !== null && configSnapshotChanged(confirm.snapshot, item);
  const conflict = isConflict(mutations.error);
  const needsReview = staleDraft || staleConfirmation || conflict;
  const needsConfirm = Boolean(item.costWarning) || item.destructive;
  const pending = mutations.pending || receipt.waiting;
  const copy = CONFIG_COPY_RU[item.key];
  const label = copy?.title ?? item.label;
  const unit = item.kind === "number" ? copy?.unit : undefined;
  const showCancel = (draft !== null || confirm !== null) && !needsReview;
  const useChoices = friendly && Boolean(CONFIG_MODE_CHOICES[item.key] || configPageScope(item.key));
  function changeInput(next: string) {
    setDraft((previous) => ({ input: next, snapshot: previous?.snapshot ?? captureConfigSnapshot(item) }));
    setConfirm(null);
    receipt.setReceipt(null);
  }

  function resetDraft() {
    setDraft(null);
    setConfirm(null);
    receipt.setReceipt(null);
    mutations.resetErrors();
  }

  function keepDraft() {
    // Explicitly accepting the newly displayed server value as the baseline is the
    // only way to rebase. Saving (and any cost confirmation) remains a separate act.
    setDraft({ input, snapshot: captureConfigSnapshot(item) });
    setConfirm(null);
    receipt.setReceipt(null);
    mutations.resetErrors();
  }

  function save() {
    if (!draft || !dirty || pending || needsReview) return;
    const action = prepareScalarSave(item, draft.snapshot, input);
    if (action.kind !== "save") return;
    if (needsConfirm && confirm?.action !== "save") {
      setConfirm({ action: "save", snapshot: draft.snapshot });
      return;
    }
    mutations.resetErrors();
    receipt.setReceipt(null);
    mutations.update.mutate(action.body, {
      onSuccess: (response) => {
        // One submitted patch produces one stored result, including server clamps.
        receipt.setReceipt(savedConfigReceipt(response.results[0]!));
        setDraft(null);
      },
    });
    setConfirm(null);
  }

  function revert() {
    if (pending || needsReview || dirty) return;
    if (needsConfirm && confirm?.action !== "revert") {
      setConfirm({ action: "revert", snapshot: captureConfigSnapshot(item) });
      return;
    }
    const snapshot = confirm?.snapshot ?? captureConfigSnapshot(item);
    if (configSnapshotChanged(snapshot, item)) return;
    mutations.resetErrors();
    receipt.setReceipt(null);
    mutations.clear.mutate({ key: snapshot.key, expectedVersion: snapshot.version }, {
      onSuccess: () => {
        receipt.setReceipt({ action: "clear", key: snapshot.key, previousVersion: snapshot.version });
        setDraft(null);
      },
    });
    setConfirm(null);
  }

  return (
    <div className="settings-editor space-y-2">
      <div className="settings-editor-controls">
        <div className="settings-editor-field flex min-w-0 items-center gap-2">
          {useChoices ? <ConfigChoiceField configKey={item.key} label={label} value={input} disabled={pending} invalid={draft !== null && !parsed.valid} isDraft={draft !== null} onChange={changeInput} /> : <input
            type={item.kind === "string" ? "text" : "number"}
            aria-label={`${label}${unit ? `, ${unit}` : ""} value`}
            aria-describedby={copy?.short ? `config-description-${item.key}` : undefined}
            aria-invalid={draft !== null && !parsed.valid}
            value={input}
            disabled={pending}
            onChange={(event) => changeInput(event.target.value)}
            className="settings-input min-w-0 flex-1 font-mono"
            style={unit ? { paddingRight: Math.min(106, 20 + unit.length * 6) } : undefined}
          />}
          {unit && <span className="settings-unit" aria-hidden="true">{unit}</span>}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || !parsed.valid || needsReview}
          className={confirm?.action === "save" ? confirmButton : primaryButton}
        >
          {confirm?.action === "save" ? "Подтвердить" : "Сохранить"}
        </button>
      </div>
      {(showCancel || item.source === "override") && (
        <div className="settings-editor-actions flex flex-wrap items-center gap-2">
          {showCancel && (
            <button type="button" onClick={resetDraft} disabled={pending} className={secondaryButton}>
              Отмена
            </button>
          )}
          {item.source === "override" && (
            <button
              type="button"
              onClick={revert}
              disabled={pending || dirty || needsReview}
              title={dirty ? "Сначала сохраните или отмените ваш ввод" : "Убрать ручное значение и использовать настройку сервера"}
              className={confirm?.action === "revert" ? confirmButton : secondaryButton}
            >
              {confirm?.action === "revert" ? "Подтвердить возврат" : "Вернуть настройку сервера"}
            </button>
          )}
        </div>
      )}
      {draft !== null && !parsed.valid && <p role="alert" className="text-xs text-red-600">{parsed.message}</p>}
      {dirty && !needsReview && <p className="text-xs text-text-muted">Изменение ещё не сохранено.</p>}
      {needsReview && (
        <div role="alert" className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
          <p>Пока вы редактировали, настройку изменили. Сравните значения и выберите, что оставить.</p>
          <p>Сохранено на сервере: <strong className="break-all font-mono">{savedValue(item)}</strong></p>
          {draft !== null && <p>Ваше значение: <strong className="break-all font-mono">{displayValue(input)}</strong></p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={resetDraft} disabled={pending} className={secondaryButton}>Оставить значение сервера</button>
            {draft !== null && (
              <button type="button" onClick={keepDraft} disabled={pending} className={secondaryButton}>Продолжить с моим значением</button>
            )}
          </div>
          {draft !== null && <p>Выбор вашего значения пока ничего не меняет на сервере. Для применения нажмите «Сохранить».</p>}
        </div>
      )}
      {confirm !== null && !needsReview && (
        <ChangeWarning item={item} action={confirm.action} before={confirm.snapshot.value} {...(parsed.valid ? { after: parsed.value } : {})} />
      )}
      {receipt.waiting && receipt.receipt && <ReceiptReconciliation receipt={receipt.receipt} onVerified={receipt.verified} />}
      <MutationStatus pending={mutations.pending} pendingApply={!receipt.waiting && item.pendingApply} error={mutations.error} success={receipt.success} conflict={conflict} />
    </div>
  );
}

export function BooleanConfigEditor({ item }: { item: ConfigItem }) {
  const mutations = useEditorMutations();
  const [confirm, setConfirm] = useState<(BooleanConfirm & { snapshot: ConfigSnapshot }) | null>(null);
  const receipt = useConfigReceipt(item);
  const current = receipt.waiting && receipt.receipt?.action === "save"
    ? receipt.receipt.value === true : seedValue(item) === "true";
  const needsConfirm = Boolean(item.costWarning) || item.destructive;
  const conflict = isConflict(mutations.error);
  const staleConfirmation = confirm !== null && configSnapshotChanged(confirm.snapshot, item);
  const needsReview = conflict || staleConfirmation;
  const pending = mutations.pending || receipt.waiting;
  const label = CONFIG_COPY_RU[item.key]?.title ?? item.label;

  function reset() {
    setConfirm(null);
    receipt.setReceipt(null);
    mutations.resetErrors();
  }

  function toggle() {
    if (pending || needsReview) return;
    const target = !current;
    const action = resolveBooleanToggle({ item, target, confirm });
    if (action.kind === "arm") {
      setConfirm({ action: "save", target, snapshot: captureConfigSnapshot(item) });
      return;
    }
    mutations.resetErrors();
    receipt.setReceipt(null);
    mutations.update.mutate(action.body, {
      onSuccess: (response) => receipt.setReceipt(savedConfigReceipt(response.results[0]!)),
    });
    setConfirm(null);
  }

  function revert() {
    if (pending || needsReview) return;
    if (needsConfirm && confirm?.action !== "revert") {
      setConfirm({ action: "revert", snapshot: captureConfigSnapshot(item) });
      return;
    }
    const snapshot = confirm?.snapshot ?? captureConfigSnapshot(item);
    if (configSnapshotChanged(snapshot, item)) return;
    mutations.resetErrors();
    receipt.setReceipt(null);
    mutations.clear.mutate({ key: snapshot.key, expectedVersion: snapshot.version }, {
      onSuccess: () => receipt.setReceipt({ action: "clear", key: snapshot.key, previousVersion: snapshot.version }),
    });
    setConfirm(null);
  }

  return (
    <div className="settings-editor space-y-2">
      <div className="settings-editor-controls">
        <div className="flex min-h-10 min-w-0 items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={current}
            aria-label={`${label} value`}
            aria-describedby={CONFIG_COPY_RU[item.key]?.short ? `config-description-${item.key}` : undefined}
            onClick={toggle}
            disabled={pending || needsReview}
            className="inline-flex h-10 w-11 shrink-0 items-center disabled:opacity-50"
          >
            <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${current ? "bg-accent" : "bg-border"}`}>
              <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${current ? "translate-x-[22px]" : "translate-x-0.5"}`} />
            </span>
          </button>
          <span className="text-xs text-text-primary">{current ? "Включено" : "Выключено"}</span>
        </div>
        {confirm?.action === "save" && !needsReview && (
          <button type="button" onClick={toggle} disabled={pending} className={confirmButton}>
            {confirm.target ? "Подтвердить включение" : "Подтвердить выключение"}
          </button>
        )}
      </div>
      {(item.source === "override" || (confirm !== null && !needsReview)) && (
        <div className="settings-editor-actions flex flex-wrap items-center gap-2">
          {item.source === "override" && (
            <button
              type="button"
              onClick={revert}
              disabled={pending || needsReview}
              title="Убрать ручное значение и использовать настройку сервера"
              className={confirm?.action === "revert" ? confirmButton : secondaryButton}
            >
              {confirm?.action === "revert" ? "Подтвердить возврат" : "Вернуть настройку сервера"}
            </button>
          )}
          {confirm !== null && !needsReview && (
            <button type="button" onClick={reset} disabled={pending} className={secondaryButton}>Отмена</button>
          )}
        </div>
      )}
      {needsReview && (
        <div role="alert" className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700">
          <p>Пока вы выбирали действие, настройку изменили. Проверьте значения перед повторной попыткой.</p>
          <p>Сохранено на сервере: <strong>{savedValue(item)}</strong>.</p>
          {confirm?.action === "save" && <p>Вы выбрали: <strong>{displayValue(confirm.target)}</strong>.</p>}
          <button type="button" onClick={reset} disabled={pending} className={secondaryButton}>Продолжить с текущей настройкой</button>
        </div>
      )}
      {confirm !== null && !needsReview && (
        <ChangeWarning item={item} action={confirm.action} before={current} {...(confirm.action === "save" ? { after: confirm.target } : {})} />
      )}
      {receipt.waiting && receipt.receipt && <ReceiptReconciliation receipt={receipt.receipt} onVerified={receipt.verified} />}
      <MutationStatus pending={mutations.pending} pendingApply={!receipt.waiting && item.pendingApply} error={mutations.error} success={receipt.success} conflict={conflict} />
    </div>
  );
}
