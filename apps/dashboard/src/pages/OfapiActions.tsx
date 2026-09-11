import { useEffect, useState, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";
import { useSearchParams } from "react-router";
import type { OfapiAction, OfapiActionIntent } from "@agency_hub_core/contracts";
import { useAuthMe } from "@/api/auth";
import { acknowledgeActionCustody, clearActionCustody, readActionCustody, saveActionCustody, settleActionCustody, type PendingOfapiAction } from "@/lib/ofapiActionCustody";
import { useAdminOfapiCollection } from "@/api/adminOfapiCollection";
import { accountActions, useOfapiActions } from "@/api/ofapiActions";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { resolveOfapiPage } from "@/lib/ofapiNavigation";
import { ofapiAccountForms } from "./ofapi-actions/account-forms.ts";
import { ofapiPublishingForms } from "./ofapi-actions/publishing-forms.ts";
import { ofapiCollectionForms } from "./ofapi-actions/collection-forms.ts";
import type { OfapiActionField } from "./ofapi-actions/form-types.ts";
import { actionDraftMatches, buildOfapiAction, initialActionValues, isUncertainActionFailure, reviewActionFieldValue, type FormValues } from "./ofapi-actions/form-values.ts";

const forms = [...ofapiCollectionForms, ...ofapiPublishingForms, ...ofapiAccountForms];
const sections = [...new Set(forms.map(form => form.section))];
const fieldClass = "w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary";
const buttonClass = "rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-40";
const stateLabels: Record<OfapiActionIntent["state"], string> = { prepared: "Готово к выполнению", dispatching: "Запрос отправляется", confirmed: "Запрос подтверждён", partial: "Выполнено частично", rejected: "Отклонено провайдером", indeterminate: "Результат неизвестен", cancelled: "Отменено до отправки" };
export function OfapiActionFields({ fields, values, update, disabled }: { fields: OfapiActionField[]; values: FormValues; update: (value: FormValues) => void; disabled: boolean }) {
  const put = (name: string, value: unknown) => update({ ...values, [name]: value });
  return <>{fields.map(field => {
    const value = values[field.name];
    const explicitEmpty = Array.isArray(value) && value.length === 0;
    const explicitEmptyText = field.allowEmptyText === true && value === null;
    const label = <span className="text-sm font-medium">{field.label}{field.required ? " *" : ""}</span>;
    let input;
    if (field.type === "boolean") {
      input = field.required || field.defaultValue !== undefined
        ? <input type="checkbox" checked={value === true} disabled={disabled} onChange={event => put(field.name, event.target.checked)} aria-label={field.label} />
        : <select className={fieldClass} value={value === undefined ? "" : String(value)} disabled={disabled} onChange={event => put(field.name, event.target.value === "" ? undefined : event.target.value === "true")} aria-label={field.label}><option value="">Не изменять / по умолчанию</option><option value="true">Да</option><option value="false">Нет</option></select>;
    } else if (field.type === "select") {
      input = <select className={fieldClass} value={String(value ?? "")} disabled={disabled} required={field.required} onChange={event => put(field.name, event.target.value)} aria-label={field.label}><option value="">{field.required ? "Выберите значение" : "Не изменять / по умолчанию"}</option>{field.options?.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>;
    } else if (field.type === "strings" && field.options) {
      const selected = Array.isArray(value) ? value : [];
      input = <div className="grid gap-2">{field.options.map(option => <label key={String(option.value)} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(option.value)} disabled={disabled} onChange={event => put(field.name, event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} />{option.label}</label>)}</div>;
    } else if (field.type === "rows") {
      const rows = Array.isArray(value) ? value as FormValues[] : [];
      input = <div className="min-w-0 space-y-3">{rows.map((row, index) => <div key={index} className="min-w-0 space-y-2 rounded-lg border border-border p-3"><OfapiActionFields fields={field.fields ?? []} values={row} disabled={disabled} update={next => put(field.name, rows.map((existing, i) => i === index ? next : existing))} /><button type="button" className={buttonClass} disabled={disabled} onClick={() => put(field.name, rows.filter((_, i) => i !== index))}>Убрать строку {index + 1}</button></div>)}<button type="button" className={buttonClass} disabled={disabled} onClick={() => put(field.name, [...rows, initialActionValues(field.fields ?? [])])}>Добавить строку</button></div>;
    } else if (["textarea", "strings", "numbers", "money-list"].includes(field.type)) {
      input = <textarea className={fieldClass} rows={field.type === "textarea" ? 4 : 3} value={Array.isArray(value) ? value.join("\n") : String(value ?? "")} disabled={disabled || explicitEmptyText} required={field.required && !explicitEmpty && !explicitEmptyText} onChange={event => put(field.name, event.target.value)} aria-label={field.label} />;
    } else {
      const type = field.type === "datetime" ? "datetime-local" : field.type === "number" || field.type === "money" ? "number" : "text";
      input = <input className={fieldClass} type={type} step={field.type === "money" ? "0.01" : field.type === "datetime" ? "1" : "any"} value={String(value ?? "")} disabled={disabled} required={field.required} onChange={event => put(field.name, event.target.value)} aria-label={field.label} />;
    }
    return <div key={field.name} className="min-w-0 space-y-1.5">{label}{input}{field.help && <p className="break-words text-xs text-text-muted">{field.help}</p>}{field.allowEmptyText && <label className="flex items-start gap-2 text-xs text-text-secondary"><input type="checkbox" checked={explicitEmptyText} disabled={disabled} onChange={event => put(field.name, event.target.checked ? null : undefined)} />Очистить текст</label>}{field.type === "datetime" && <p className="text-xs text-text-muted">Часовой пояс: {Intl.DateTimeFormat().resolvedOptions().timeZone}. В OnlyFans передаётся время UTC.</p>}{field.type === "money-list" && <p className="text-xs text-text-muted">Например: 5.00 и 10.00 с новой строки. Между суммами можно поставить запятую с пробелом.</p>}{["strings", "numbers", "money-list", "rows"].includes(field.type) && <label className="flex items-start gap-2 text-xs text-text-secondary"><input type="checkbox" checked={explicitEmpty} disabled={disabled} onChange={event => put(field.name, event.target.checked ? [] : undefined)} />Передать пустой список</label>}</div>;
  })}</>;
}
function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [limit, setLimit] = useState(100);
  if (value === null || value === undefined) return <span className="text-text-muted">—</span>;
  if (typeof value !== "object") return <span className="whitespace-pre-wrap break-all">{typeof value === "boolean" ? value ? "Да" : "Нет" : String(value)}</span>;
  if (depth > 5) return <span>Вложенные данные сохранены в ответе</span>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
  if (!entries.length) return <span>Пустой список</span>;
  return <dl className="min-w-0 space-y-2 border-l border-border pl-3">{entries.slice(0, limit).map(([key, item]) => <div key={key}><dt className="break-all text-xs text-text-muted">{key}</dt><dd><Value value={item} depth={depth + 1} /></dd></div>)}{entries.length > limit && <div><dt className="text-xs text-text-muted">Показано {limit} из {entries.length}</dt><dd><button type="button" className={buttonClass} onClick={() => setLimit(current => current + 100)}>Показать ещё</button></dd></div>}</dl>;
}

type PendingAction = PendingOfapiAction;

export function OfapiActionCommandReview({ command, fields }: { command: FormValues; fields: OfapiActionField[] }) {
  return <dl className="space-y-2 text-sm">{fields.filter(field => field.name in command).map(field => <div key={field.name}><dt className="text-text-muted">{field.label}</dt><dd><Value value={reviewActionFieldValue(field, command[field.name])} /></dd></div>)}</dl>;
}

export function OfapiActions() {
  const auth = useAuthMe();
  const ownerId = auth.data?.user.id;
  if (ownerId === undefined) return <StatusPanel title="Проверяем сессию владельца…" />;
  return <OfapiActionsWorkspace key={ownerId} ownerId={ownerId} />;
}

function OfapiActionsWorkspace({ ownerId }: { ownerId: number }) {
  const collection = useAdminOfapiCollection();
  const pages = collection.data?.pages.filter(page => page.accountId) ?? [];
  const [search, setSearch] = useSearchParams();
  const requestedPage = search.get("page");
  const selectedPage = resolveOfapiPage(pages, requestedPage);
  const pageId = selectedPage?.id ?? null;
  function selectPage(label: string, replace = false) {
    if (search.get("page") === label) return;
    const next = new URLSearchParams(search);
    next.set("page", label);
    setSearch(next, { replace });
  }
  const history = useOfapiActions(pageId);
  const queryClient = useQueryClient();
  const action = forms.find(item => item.action === search.get("action"))?.action ?? forms[0]!.action;
  const form = forms.find(item => item.action === action)!;
  const section = form.section;
  type Workspace = {
    drafts: Record<string, FormValues>;
    intents: Record<number, OfapiActionIntent | null>;
    pending: PendingAction | null;
    busy: boolean;
    error: string;
    operationPage: string;
    admissions: Record<string, string>;
    storageError: string;
  };
  const [workspace, setWorkspace, readWorkspace] = useSessionWorkspace<Workspace>(`ofapi-actions:${ownerId}`, () => {
    let pending: PendingAction | null = null;
    let storageError = "";
    try { pending = readActionCustody(ownerId); }
    catch { storageError = "Не удалось восстановить незавершённый запрос этой вкладки. Новые действия недоступны до восстановления записи."; }
    return { drafts: {}, intents: {}, pending, busy: false, error: "", operationPage: "", storageError,
      admissions: pending ? { [JSON.stringify(pending.command)]: pending.id } : {} };
  });
  const draftKey = `${pageId}:${action}`;
  const values = workspace.drafts[draftKey] ?? initialActionValues(form.fields);
  const setValues = (next: FormValues) => setWorkspace(current => ({ ...current, drafts: { ...current.drafts, [draftKey]: next } }));
  const intent = pageId === null ? null : workspace.intents[pageId] ?? null;
  const setIntent = (next: SetStateAction<OfapiActionIntent | null>) => setWorkspace(current => {
    if (pageId === null) return current;
    const resolved = typeof next === "function" ? next(current.intents[pageId] ?? null) : next;
    return { ...current, intents: { ...current.intents, [resolved?.pageId ?? pageId]: resolved } };
  });
  const { busy, error, pending } = workspace;
  const setError = (message: string) => setWorkspace(current => ({ ...current, error: message }));
  const [allowNewAfterUnknown, setAllowNewAfterUnknown] = useState(false);
  function actionId(command: OfapiAction, renew = false) {
    const fingerprint = JSON.stringify(command);
    const savedId = readWorkspace().admissions[fingerprint];
    if (savedId && !renew) return savedId;
    const id = crypto.randomUUID();
    setWorkspace(current => ({ ...current, admissions: { ...current.admissions, [fingerprint]: id } }));
    return id;
  }
  useEffect(() => {
    if (requestedPage === null && selectedPage) selectPage(selectedPage.label, true);
  }, [requestedPage, selectedPage?.label]);
  useEffect(() => {
    const current = pageId === null ? null : readWorkspace().intents[pageId];
    if (!current || !["prepared", "dispatching"].includes(current.state)) return;
    const latest = history.data?.intents.find(item => item.id === current.id);
    if (latest && latest.state !== "prepared") setIntent(latest);
  }, [history.data]);
  function reset(nextAction: string) {
    const next = new URLSearchParams(search);
    next.set("action", nextAction);
    setSearch(next);
    setError("");
    setAllowNewAfterUnknown(false);
  }
  async function run(task: () => Promise<OfapiActionIntent>, recovery?: PendingAction) {
    // Query-cache custody covers Back/Forward and leaving the entire route while a request is pending.
    if (readWorkspace().busy || (recovery && readWorkspace().storageError)) return;
    if (recovery) {
      try { saveActionCustody(ownerId, recovery); }
      catch { setWorkspace(current => ({ ...current, storageError: "Не удалось сохранить запрос до отправки. Разрешите хранилище браузера и повторите проверку. Действие не отправлено." })); return; }
    }
    const operationPage = recovery ? pages.find(page => page.id === recovery.pageId)?.label ?? `Страница ${recovery.pageId}` : selectedPage?.label ?? "";
    setWorkspace(current => ({ ...current, busy: true, error: "", operationPage }));
    try {
      const result = await task();
      let storageError = "";
      let nextPending = readWorkspace().pending;
      try { nextPending = settleActionCustody(ownerId, result, forms.find(item => item.action === result.action)?.label ?? result.action); }
      catch { storageError = "Результат получен, но запись восстановления не закрылась. Проверьте хранилище перед новым действием."; }
      setWorkspace(current => ({
        ...current,
        intents: { ...current.intents, [result.pageId]: result },
        admissions: { ...current.admissions, [JSON.stringify(result.command)]: result.id },
        pending: nextPending,
        operationPage: result.pageLabel,
        storageError,
      }));
      setAllowNewAfterUnknown(false);
      // A late response belongs to its original account and never navigates the current screen.
      void queryClient.invalidateQueries({ queryKey: ["admin", "ofapi-actions", result.pageId] });
    } catch (reason) {
      // A later refusal cannot settle an earlier lost response with the same ID.
      if (recovery && !isUncertainActionFailure(reason) && readWorkspace().pending?.id !== recovery.id) {
        try { clearActionCustody(ownerId, recovery.id); } catch { /* Retain the marker conservatively on reload. */ }
      }
      setWorkspace(current => ({ ...current,
        pending: recovery && isUncertainActionFailure(reason) ? recovery : current.pending,
        error: reason instanceof Error ? reason.message : "Не удалось получить результат",
      }));
    } finally { setWorkspace(current => ({ ...current, busy: false })); }
  }
  async function prepare() {
    if (!pageId || pending || workspace.storageError) return;
    let command: OfapiAction;
    try { command = buildOfapiAction(form, pageId, values); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Проверьте поля"); return; }
    const id = actionId(command);
    await run(() => accountActions.prepare(id, command), { id, pageId, label: form.label, command, operation: "prepare" });
  }
  function mutateIntent(operation: "dispatch" | "cancel" | "repair") {
    if (!intent || (pending && !(operation === "repair" && pending.id === intent.id)) || workspace.storageError) return;
    const target = intent;
    void run(() => accountActions[operation](target.id), { id: target.id, pageId: target.pageId, label: forms.find(item => item.action === target.action)?.label ?? target.action, command: target.command, operation });
  }
  function acknowledgeUnknown() {
    const current = readWorkspace();
    if (current.busy || !current.pending || current.pending.outcome !== "indeterminate" || !allowNewAfterUnknown) return;
    const reviewed = current.pending;
    try { acknowledgeActionCustody(ownerId, reviewed.id); }
    catch { setError("Не удалось сохранить проверку результата. Запрос остаётся незавершённым."); return; }
    actionId(reviewed.command, true);
    setWorkspace(saved => ({ ...saved, pending: null, intents: { ...saved.intents, [reviewed.pageId]: null } }));
    setAllowNewAfterUnknown(false);
  }
  const primaryNames = new Set(["text", "mediaFiles", "previews", "priceCents", "scheduledDate", "saveForLater", "userIds", "userLists"]);
  const advancedFields = form.fields.length > 8 ? form.fields.filter(field => !field.required && !primaryNames.has(field.name)) : [];
  const mainFields = form.fields.filter(field => !advancedFields.includes(field));
  const reviewedForm = forms.find(item => item.action === intent?.action);
  const matches = intent !== null && actionDraftMatches(form, pageId, values, intent.command);
  const bindingMatches = intent !== null && pages.some(page => page.id === intent.pageId && page.accountId === intent.accountId);
  const canStartNew = intent !== null && matches && !pending && !["prepared", "dispatching"].includes(intent.state);
  return <div className="mx-auto max-w-6xl space-y-6 p-4 text-text-primary sm:p-6">
    <header><h1 className="text-2xl font-semibold">Управление OnlyFans</h1><p className="mt-1 text-sm text-text-secondary">Действия с аккаунтом, контентом и фанами. История запросов сохраняется здесь.</p></header>
    <QueryNotice error={collection.isError} stale={collection.data !== undefined} retry={() => collection.refetch()} />
    <label className="block max-w-md space-y-2"><span className="text-sm">Аккаунт</span><select className={fieldClass} value={selectedPage?.label ?? ""} disabled={busy || !pages.length} onChange={event => { selectPage(event.target.value); setError(""); setAllowNewAfterUnknown(false); }}>{!pageId && <option value="">Выберите доступную страницу</option>}{pages.map(page => <option key={page.id} value={page.label}>{page.label} · {page.accountId}</option>)}</select></label>
    {collection.isLoading && !collection.data && <StatusPanel title="Загружаем доступные аккаунты…" />}
    {collection.data && !pageId && <StatusPanel title={requestedPage !== null ? "Аккаунт из ссылки недоступен" : "Нет привязанных аккаунтов OFAPI"} description="Выберите доступную страницу. Для выполнения действий нужна действующая привязка OFAPI." />}
    {workspace.storageError && <section role="alert" className="space-y-2 rounded-xl border border-warning-dark p-4 text-sm"><p>{workspace.storageError}</p><button type="button" className={buttonClass} disabled={busy} onClick={() => {
      try { const restored = readActionCustody(ownerId); setWorkspace(current => ({ ...current, pending: restored ?? current.pending, storageError: "" })); }
      catch { /* Keep the readable error and the preserved record. */ }
    }}>Повторить чтение сохранённого запроса</button></section>}
    {pending && <section role="alert" className="space-y-3 rounded-xl border border-amber-500 p-4"><p>{pending.outcome ? stateLabels[pending.outcome] : "Не получен ответ"}: {pages.find(page => page.id === pending.pageId)?.label ?? `Страница ${pending.pageId}`} · {pending.label}. Проверьте сохранённое состояние этого запроса перед следующим действием.</p><p className="break-all text-xs text-text-muted">{pending.id}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => accountActions.get(pending.id))}>Найти сохранённый запрос</button>{pending.operation === "prepare" && !pending.outcome && <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => accountActions.prepare(pending.id, pending.command), pending)}>Повторить сохранение с тем же ID</button>}</div><p className="text-xs text-text-muted">Проверка и сохранение черновика не выполняют действие в OnlyFans.</p>{pending.outcome === "indeterminate" && <div className="space-y-2 border-t border-border pt-3"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allowNewAfterUnknown} disabled={busy} onChange={event => setAllowNewAfterUnknown(event.target.checked)} />Я проверил результат в OnlyFans и хочу подготовить отдельное новое действие.</label><button type="button" className={buttonClass} disabled={busy || !allowNewAfterUnknown} onClick={acknowledgeUnknown}>Завершить проверку и разрешить новое действие</button><p className="text-xs text-text-muted">Неизвестный результат останется в истории. Прежний запрос повторно не отправляется.</p></div>}</section>}
    {busy && <p role="status" className="rounded-lg border border-border bg-card p-3 text-sm">{workspace.operationPage} · ожидаем ответ. Вернувшись на страницу, вы увидите сохранённый результат.</p>}
    <label className="block space-y-2 md:hidden"><span className="text-sm">Раздел управления</span><select className={fieldClass} value={section} disabled={busy} onChange={event => reset(forms.find(item => item.section === event.target.value)!.action)}>{sections.map(item => <option key={item}>{item}</option>)}</select></label>
    <nav className="hidden flex-wrap gap-2 md:flex" aria-label="Разделы управления">{sections.map(item => <button key={item} type="button" disabled={busy} aria-pressed={item === section} className={`${buttonClass} ${item === section ? "bg-accent text-white" : ""}`} onClick={() => { reset(forms.find(entry => entry.section === item)!.action); }}>{item}</button>)}</nav>
    <div className="grid min-w-0 gap-6 lg:grid-cols-2">
      <form className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5" onSubmit={event => { event.preventDefault(); void prepare(); }}>
        <h2 className="font-semibold">1. Параметры действия</h2>
        <label className="grid gap-2"><span className="text-sm">Действие</span><select className={fieldClass} value={action} disabled={busy} onChange={event => reset(event.target.value)}>{forms.filter(item => item.section === section).map(item => <option key={item.action} value={item.action}>{item.label}</option>)}</select></label>
        <p className="text-sm text-text-secondary">{form.description}</p>
        <OfapiActionFields fields={mainFields} values={values} disabled={busy} update={next => { setValues(next); setAllowNewAfterUnknown(false); }} />
        {advancedFields.length > 0 && <details key={action} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">Дополнительные параметры ({advancedFields.length})</summary><div className="mt-4 space-y-4"><OfapiActionFields fields={advancedFields} values={values} disabled={busy} update={next => { setValues(next); setAllowNewAfterUnknown(false); }} /></div></details>}
        <button type="submit" disabled={busy || !pageId || pending !== null || Boolean(workspace.storageError)} className={`${buttonClass} bg-accent text-white`}>{busy ? "Обрабатываем…" : "Проверить действие"}</button>
      </form>
      <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5" aria-label="Результат действия">
        <h2 className="font-semibold">2. Проверка и результат</h2>
        {error && <p role="alert" className="rounded-lg border border-red-500 p-3 text-sm">{workspace.operationPage && `${workspace.operationPage} · `}{error}</p>}
        {intent ? <>
          <h2 className="font-semibold">{reviewedForm?.label ?? intent.action}</h2>
          <p className="break-all text-sm">{intent.pageLabel} · {intent.accountId}</p>
          <p className="text-sm text-text-secondary">{reviewedForm?.description}</p>
          <p role="status" className="font-medium">{stateLabels[intent.state]}</p>
          {!matches && <p className="rounded-lg border border-amber-500 p-3 text-sm">Здесь сохранён ранее проверенный запрос. Изменения в черновике слева в него не входят.</p>}
          {!bindingMatches && <p role="alert" className="text-sm text-red-600">Привязка аккаунта изменилась. Выполнение этого запроса недоступно.</p>}
          <p className="text-sm">Резерв запроса: {intent.estimatedCredits} credits. Фактический расход: {intent.actualCredits ?? "ещё не сообщён"}.</p>
          <OfapiActionCommandReview command={intent.command as unknown as FormValues} fields={reviewedForm?.fields ?? []} />
          {intent.state === "prepared" && !pending && <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !bindingMatches || Boolean(workspace.storageError)} className={`${buttonClass} bg-accent text-white`} onClick={() => mutateIntent("dispatch")}>Выполнить сохранённый запрос</button><button type="button" disabled={busy} className={buttonClass} onClick={() => mutateIntent("cancel")}>Отменить до отправки</button></div>}
          {intent.state === "indeterminate" && <p className="text-sm">Проверьте состояние в OnlyFans перед созданием нового действия. Этот запрос повторно не отправляется.</p>}
          {intent.state === "confirmed" && (intent.action.startsWith("campaign_") || intent.action.startsWith("queue_") || intent.action === "payout_withdrawal_request" || "scheduledDate" in intent.command) && <p className="text-xs text-text-muted">Провайдер подтвердил запрос. Доставка рассылки, публикация по расписанию и перевод выплаты могут завершиться позже.</p>}
          {intent.errorCode && <p className="text-sm">Причина: {intent.errorCode}</p>}
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={buttonClass} onClick={() => void run(() => accountActions.get(intent.id))}>Обновить сохранённый результат</button>{intent.responseObservationId !== null && (intent.state === "indeterminate" || intent.accountingState === "pending") && <button type="button" disabled={busy || (pending !== null && pending.id !== intent.id)} className={buttonClass} onClick={() => mutateIntent("repair")}>Обработать сохранённый ответ ещё раз</button>}</div>
          {intent.responseData !== null && <div className="max-h-96 overflow-auto text-sm"><Value value={intent.responseData} /></div>}
          {intent.responseMeta !== null && <div className="text-xs"><p>Продолжение списка</p><Value value={intent.responseMeta} /></div>}
          {canStartNew && <div className="space-y-2 border-t border-border pt-3">{intent.state === "indeterminate" && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allowNewAfterUnknown} disabled={busy} onChange={event => setAllowNewAfterUnknown(event.target.checked)} />Я проверил результат в OnlyFans и хочу подготовить отдельное новое действие.</label>}<button type="button" className={buttonClass} disabled={busy || (intent.state === "indeterminate" && !allowNewAfterUnknown)} onClick={() => { actionId(intent.command, true); setIntent(null); setAllowNewAfterUnknown(false); }}>Подготовить ещё одно такое действие</button></div>}
        </> : <p className="text-sm text-text-secondary">Заполните поля и проверьте действие. Перед выполнением здесь появятся аккаунт, выбранные параметры и оценка запроса.</p>}
      </section>
    </div>
    <section className="space-y-3"><h2 className="font-semibold">Последние действия{history.data ? ` · ${history.data.intents.length} в ответе` : ""}</h2>
      {pageId !== null && <QueryNotice error={history.isError} stale={history.data !== undefined} retry={() => history.refetch()} />}
      {pageId !== null && history.isLoading && !history.data && <StatusPanel title="Загружаем историю действий…" />}
      {history.data && !history.isError && !history.data.intents.length && <StatusPanel title="Действий для этого аккаунта пока нет" description="После проверки параметров запрос появится здесь." />}
      {history.data?.intents.map(item => <button type="button" key={item.id} disabled={busy} className="flex w-full flex-wrap justify-between gap-2 rounded-lg border border-border bg-card p-3 text-left text-sm" onClick={() => { setAllowNewAfterUnknown(false); void run(() => accountActions.get(item.id)); }}><span>{forms.find(form => form.action === item.action)?.label ?? item.action}</span><span>{stateLabels[item.state]} · {new Date(item.createdAt).toLocaleString()}</span></button>)}
    </section>
  </div>;
}
