import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { OfapiAction, OfapiActionIntent } from "@agency_hub_core/contracts";
import { useAdminOfapiCollection } from "@/api/adminOfapiCollection";
import { accountActions, useOfapiActions } from "@/api/ofapiActions";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { ofapiAccountForms } from "./ofapi-actions/account-forms.ts";
import { ofapiPublishingForms } from "./ofapi-actions/publishing-forms.ts";
import { ofapiCollectionForms } from "./ofapi-actions/collection-forms.ts";
import type { OfapiActionField } from "./ofapi-actions/form-types.ts";
import { actionDraftMatches, buildOfapiAction, createActionAdmissionRegistry, initialActionValues, isUncertainActionFailure, reviewActionFieldValue, type FormValues } from "./ofapi-actions/form-values.ts";

const forms = [...ofapiCollectionForms, ...ofapiPublishingForms, ...ofapiAccountForms];
const sections = [...new Set(forms.map(form => form.section))];
/** The sections as the owner thinks of them; a section added later and not
 *  listed here still shows, under «Другое». */
const sectionGroupNames: Array<{ label: string; sections: string[] }> = [
  { label: "Контент", sections: ["Посты", "Комментарии", "Stories", "Highlights", "Очередь", "Медиатека"] },
  { label: "Фаны", sections: ["Списки фанов", "Рассылки", "Автоматические сценарии", "Модерация", "Заметки OnlyFans"] },
  { label: "Аккаунт", sections: ["Профиль и настройки", "Приветственное сообщение", "Социальные кнопки"] },
  { label: "Деньги", sections: ["Банкинг и выплаты"] },
];
const sectionGroups = [
  ...sectionGroupNames.map(group => ({ label: group.label, sections: group.sections.filter(section => sections.includes(section)) })),
  { label: "Другое", sections: sections.filter(section => !sectionGroupNames.some(group => group.sections.includes(section))) },
].filter(group => group.sections.length > 0);
const stateLabels: Record<OfapiActionIntent["state"], string> = { prepared: "Готово к выполнению", dispatching: "Запрос отправляется", confirmed: "Запрос подтверждён", partial: "Выполнено частично", rejected: "Отклонено провайдером", indeterminate: "Результат неизвестен", cancelled: "Отменено до отправки" };
const stateBadges: Record<OfapiActionIntent["state"], string> = { prepared: "badge badge-accent", dispatching: "badge badge-info", confirmed: "badge badge-success", partial: "badge badge-warning", rejected: "badge badge-danger", indeterminate: "badge badge-warning", cancelled: "badge" };
const credits = (count: number) => `${count} ${ruPlural(count, "кредит", "кредита", "кредитов")}`;
export function OfapiActionFields({ fields, values, update, disabled }: { fields: OfapiActionField[]; values: FormValues; update: (value: FormValues) => void; disabled: boolean }) {
  const put = (name: string, value: unknown) => update({ ...values, [name]: value });
  return <>{fields.map(field => {
    const value = values[field.name];
    const explicitEmpty = Array.isArray(value) && value.length === 0;
    const explicitEmptyText = field.allowEmptyText === true && value === null;
    const label = <span className="field-label">{field.label}{field.required ? " *" : ""}</span>;
    let input;
    if (field.type === "boolean") {
      input = field.required || field.defaultValue !== undefined
        ? <input type="checkbox" checked={value === true} disabled={disabled} onChange={event => put(field.name, event.target.checked)} aria-label={field.label} />
        : <select className="select" value={value === undefined ? "" : String(value)} disabled={disabled} onChange={event => put(field.name, event.target.value === "" ? undefined : event.target.value === "true")} aria-label={field.label}><option value="">Не изменять / по умолчанию</option><option value="true">Да</option><option value="false">Нет</option></select>;
    } else if (field.type === "select") {
      input = <select className="select" value={String(value ?? "")} disabled={disabled} required={field.required} onChange={event => put(field.name, event.target.value)} aria-label={field.label}><option value="">{field.required ? "Выберите значение" : "Не изменять / по умолчанию"}</option>{field.options?.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>;
    } else if (field.type === "strings" && field.options) {
      const selected = Array.isArray(value) ? value : [];
      input = <div className="grid gap-2">{field.options.map(option => <label key={String(option.value)} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(option.value)} disabled={disabled} onChange={event => put(field.name, event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} />{option.label}</label>)}</div>;
    } else if (field.type === "rows") {
      const rows = Array.isArray(value) ? value as FormValues[] : [];
      input = <div className="min-w-0 space-y-3">{rows.map((row, index) => <div key={index} className="min-w-0 space-y-4 rounded-lg border border-border p-3"><OfapiActionFields fields={field.fields ?? []} values={row} disabled={disabled} update={next => put(field.name, rows.map((existing, i) => i === index ? next : existing))} /><button type="button" className="btn btn-sm" disabled={disabled} onClick={() => put(field.name, rows.filter((_, i) => i !== index))}>Убрать строку {index + 1}</button></div>)}<button type="button" className="btn btn-sm" disabled={disabled} onClick={() => put(field.name, [...rows, initialActionValues(field.fields ?? [])])}>Добавить строку</button></div>;
    } else if (["textarea", "strings", "numbers", "money-list"].includes(field.type)) {
      input = <textarea className="textarea" rows={field.type === "textarea" ? 4 : 3} value={Array.isArray(value) ? value.join("\n") : String(value ?? "")} disabled={disabled || explicitEmptyText} required={field.required && !explicitEmpty && !explicitEmptyText} onChange={event => put(field.name, event.target.value)} aria-label={field.label} />;
    } else {
      const type = field.type === "datetime" ? "datetime-local" : field.type === "number" || field.type === "money" ? "number" : "text";
      input = <input className="input" type={type} step={field.type === "money" ? "0.01" : field.type === "datetime" ? "1" : "any"} value={String(value ?? "")} disabled={disabled} required={field.required} onChange={event => put(field.name, event.target.value)} aria-label={field.label} />;
    }
    return <div key={field.name} className="min-w-0">{label}{input}{field.help && <p className="field-hint break-words">{field.help}</p>}{field.allowEmptyText && <label className="mt-2 flex items-start gap-2 text-xs text-text-secondary"><input type="checkbox" checked={explicitEmptyText} disabled={disabled} onChange={event => put(field.name, event.target.checked ? null : undefined)} />Очистить текст</label>}{field.type === "datetime" && <p className="field-hint">Часовой пояс: {Intl.DateTimeFormat().resolvedOptions().timeZone}. В OnlyFans передаётся время UTC.</p>}{field.type === "money-list" && <p className="field-hint">Например: 5.00 и 10.00 с новой строки. Между суммами можно поставить запятую с пробелом.</p>}{["strings", "numbers", "money-list", "rows"].includes(field.type) && <label className="mt-2 flex items-start gap-2 text-xs text-text-secondary"><input type="checkbox" checked={explicitEmpty} disabled={disabled} onChange={event => put(field.name, event.target.checked ? [] : undefined)} />Передать пустой список</label>}</div>;
  })}</>;
}
function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [limit, setLimit] = useState(100);
  if (value === null || value === undefined) return <span className="text-text-muted">—</span>;
  if (typeof value !== "object") return <span className="whitespace-pre-wrap break-all">{typeof value === "boolean" ? value ? "Да" : "Нет" : String(value)}</span>;
  if (depth > 5) return <span>Вложенные данные сохранены в ответе</span>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
  if (!entries.length) return <span>Пустой список</span>;
  return <dl className="min-w-0 space-y-2 border-l border-border pl-3">{entries.slice(0, limit).map(([key, item]) => <div key={key}><dt className="break-all text-xs text-text-muted">{key}</dt><dd><Value value={item} depth={depth + 1} /></dd></div>)}{entries.length > limit && <div><dt className="text-xs text-text-muted">Показано {limit} из {entries.length}</dt><dd><button type="button" className="btn btn-sm" onClick={() => setLimit(current => current + 100)}>Показать ещё</button></dd></div>}</dl>;
}

interface PendingAction { id: string; pageId: number; label: string; operation: "prepare" | "dispatch" | "cancel" | "repair"; command: OfapiAction }

export function OfapiActionCommandReview({ command, fields }: { command: FormValues; fields: OfapiActionField[] }) {
  return <dl className="space-y-3 text-sm">{fields.filter(field => field.name in command).map(field => <div key={field.name}><dt className="text-xs text-text-muted">{field.label}</dt><dd className="text-text-primary"><Value value={reviewActionFieldValue(field, command[field.name])} /></dd></div>)}</dl>;
}

export function OfapiActions() {
  const collection = useAdminOfapiCollection();
  const pages = collection.data?.pages.filter(page => page.accountId) ?? [];
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const pageId = selectedPage ?? pages[0]?.id ?? null;
  const history = useOfapiActions(pageId);
  const [section, setSection] = useState(sections[0]!);
  const [action, setAction] = useState(forms[0]!.action);
  const form = forms.find(item => item.action === action)!;
  const [values, setValues] = useState<FormValues>(() => initialActionValues(form.fields));
  const [selectedIntent, setIntent] = useState<OfapiActionIntent | null>(null);
  const intent = selectedIntent?.pageId === pageId ? selectedIntent : null;
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [allowNewAfterUnknown, setAllowNewAfterUnknown] = useState(false);
  const admission = useRef(createActionAdmissionRegistry(() => crypto.randomUUID()));
  useEffect(() => {
    setIntent(current => {
      if (!current || !["prepared", "dispatching"].includes(current.state)) return current;
      const latest = history.data?.intents.find(item => item.id === current.id);
      return latest && latest.state !== "prepared" ? latest : current;
    });
  }, [history.data]);
  function reset(nextAction: string) {
    setAction(nextAction); setValues(initialActionValues(forms.find(item => item.action === nextAction)!.fields)); setError(""); setAllowNewAfterUnknown(false);
    // Draft editing neither cancels an accepted intent nor replaces its identity.
  }
  async function run(task: () => Promise<OfapiActionIntent>, recovery?: PendingAction) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await task();
      if (result.pageId !== pageId) reset(action);
      setIntent(result); setSelectedPage(result.pageId); setAllowNewAfterUnknown(false);
      setPending(current => current?.id === result.id ? null : current);
      // A list refresh failure must not erase a received operation result.
      void history.refetch().catch(() => undefined);
    } catch (reason) {
      if (recovery && isUncertainActionFailure(reason)) setPending(recovery);
      setError(reason instanceof Error ? reason.message : "Не удалось получить результат");
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function prepare() {
    if (!pageId || pending) return;
    let command: OfapiAction;
    try { command = buildOfapiAction(form, pageId, values); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Проверьте поля"); return; }
    const id = admission.current.forCommand(command);
    await run(() => accountActions.prepare(id, command), { id, pageId, label: form.label, command, operation: "prepare" });
  }
  function mutateIntent(operation: "dispatch" | "cancel" | "repair") {
    if (!intent || pending) return;
    const target = intent;
    void run(() => accountActions[operation](target.id), { id: target.id, pageId: target.pageId, label: forms.find(item => item.action === target.action)?.label ?? target.action, command: target.command, operation });
  }
  const primaryNames = new Set(["text", "mediaFiles", "previews", "priceCents", "scheduledDate", "saveForLater", "userIds", "userLists"]);
  const advancedFields = form.fields.length > 8 ? form.fields.filter(field => !field.required && !primaryNames.has(field.name)) : [];
  const mainFields = form.fields.filter(field => !advancedFields.includes(field));
  const reviewedForm = forms.find(item => item.action === intent?.action);
  const matches = intent !== null && actionDraftMatches(form, pageId, values, intent.command);
  const bindingMatches = intent !== null && pages.some(page => page.id === intent.pageId && page.accountId === intent.accountId);
  const canStartNew = intent !== null && matches && !pending && !["prepared", "dispatching"].includes(intent.state);
  // The workspace stays while a result is on screen, even if the page lost its binding.
  const showWorkspace = pages.length > 0 || intent !== null;
  const errorNotice = error && <p role="alert" className="notice notice-danger">{error}</p>;
  return <div className="space-y-5">
    {pages.length > 0 && <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <label className="w-full sm:w-64"><span className="field-label">Страница</span><select className="select" value={pageId ?? ""} disabled={busy} onChange={event => { setSelectedPage(Number(event.target.value)); reset(action); }}>{pages.map(page => <option key={page.id} value={page.id}>{page.label}</option>)}</select></label>
    </div>}
    {(collection.error || history.error) && <div role="alert" className="notice notice-danger flex-wrap items-center"><p className="min-w-0 flex-1">Не удалось обновить локальные данные. Черновик и полученный результат действия сохранены.</p><button type="button" className="btn btn-sm" disabled={busy || collection.isFetching || history.isFetching} onClick={() => { if (collection.error) void collection.refetch(); if (history.error) void history.refetch(); }}>Повторить загрузку</button></div>}
    {collection.isPending && <p role="status" className="text-sm text-text-muted">Загружаем привязанные аккаунты…</p>}
    {collection.data && !collection.isError && !pages.length && <StatusPanel title="Нет страниц с привязанным OnlyFans API" description="Действия с аккаунтом доступны для страниц, к которым привязан аккаунт OnlyFans API." action={<Link to="/settings?tab=collection">Настройки сбора</Link>} />}
    {pending && <section role="alert" className="notice notice-warning flex-col items-stretch gap-3">
      <p className="font-medium">Не получен ответ: {pending.label}. Проверьте сохранённое состояние этого запроса перед следующим действием.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => accountActions.get(pending.id))}>Найти сохранённый запрос</button>{pending.operation === "prepare" && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => accountActions.prepare(pending.id, pending.command), pending)}>Повторить сохранение с тем же ID</button>}</div>
      <p className="text-xs">Проверка и сохранение черновика не выполняют действие в OnlyFans.</p>
      <details className="help"><summary>Технические детали</summary><div className="help-body break-all text-xs"><p>ID запроса: {pending.id}</p></div></details>
    </section>}
    {showWorkspace && <div className="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <form className="card min-w-0" aria-labelledby="ofapi-action-form-title" onSubmit={event => { event.preventDefault(); void prepare(); }}>
        <div className="card-header"><div className="min-w-0"><h2 id="ofapi-action-form-title" className="card-title">Новое действие</h2><p className="card-description">Сначала Hub проверит действие и покажет оценку, выполнение — отдельной кнопкой.</p></div></div>
        <div className="card-body space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0"><span className="field-label">Раздел</span><select className="select" value={section} disabled={busy} onChange={event => { const item = event.target.value; setSection(item); reset(forms.find(entry => entry.section === item)!.action); }}>{sectionGroups.map(group => <optgroup key={group.label} label={group.label}>{group.sections.map(item => <option key={item} value={item}>{item}</option>)}</optgroup>)}</select></label>
            <label className="block min-w-0"><span className="field-label">Действие</span><select className="select" value={action} disabled={busy} onChange={event => reset(event.target.value)}>{forms.filter(item => item.section === section).map(item => <option key={item.action} value={item.action}>{item.label}</option>)}</select></label>
          </div>
          <p className="text-sm text-text-secondary">{form.description}</p>
          <OfapiActionFields fields={mainFields} values={values} disabled={busy} update={next => { setValues(next); setAllowNewAfterUnknown(false); }} />
          {advancedFields.length > 0 && <details key={action} className="help"><summary>Дополнительные параметры ({advancedFields.length})</summary><div className="mt-4 space-y-4"><OfapiActionFields fields={advancedFields} values={values} disabled={busy} update={next => { setValues(next); setAllowNewAfterUnknown(false); }} /></div></details>}
        </div>
        <div className="card-footer"><button type="submit" disabled={busy || !pageId || pending !== null || collection.isError} className="btn btn-primary">{busy ? "Обрабатываем…" : "Проверить действие"}</button></div>
      </form>
      <section className="card min-w-0" aria-label="Результат действия">
        {intent ? <>
          <div className="card-header">
            <div className="min-w-0"><h2 className="card-title">{reviewedForm?.label ?? intent.action}</h2><p className="card-description break-all">{intent.pageLabel} · {intent.accountId}</p></div>
            <span role="status" className={stateBadges[intent.state]}>{stateLabels[intent.state]}</span>
          </div>
          <div className="card-body space-y-4">
            {errorNotice}
            {reviewedForm?.description && <p className="text-sm text-text-secondary">{reviewedForm.description}</p>}
            {!matches && <p className="notice notice-warning">Здесь сохранён ранее проверенный запрос. Изменения в черновике слева в него не входят.</p>}
            {!bindingMatches && <p role="alert" className="notice notice-danger">Привязка аккаунта изменилась. Выполнение этого запроса недоступно.</p>}
            <p className="text-sm text-text-primary">Резерв запроса: {credits(intent.estimatedCredits)}. Фактический расход: {intent.actualCredits === null ? "ещё не сообщён" : credits(intent.actualCredits)}.</p>
            <OfapiActionCommandReview command={intent.command as unknown as FormValues} fields={reviewedForm?.fields ?? []} />
            {intent.state === "prepared" && !pending && <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !bindingMatches || collection.isError} className="btn btn-primary" onClick={() => mutateIntent("dispatch")}>Выполнить сохранённый запрос</button><button type="button" disabled={busy} className="btn" onClick={() => mutateIntent("cancel")}>Отменить до отправки</button></div>}
            {intent.state === "indeterminate" && <p className="notice notice-warning">Проверьте состояние в OnlyFans перед созданием нового действия. Этот запрос повторно не отправляется.</p>}
            {intent.state === "confirmed" && (intent.action.startsWith("campaign_") || intent.action.startsWith("queue_") || intent.action === "payout_withdrawal_request" || "scheduledDate" in intent.command) && <p className="text-xs text-text-muted">Провайдер подтвердил запрос. Доставка рассылки, публикация по расписанию и перевод выплаты могут завершиться позже.</p>}
            {intent.errorCode && <p className="text-sm text-text-primary">Причина: {intent.errorCode}</p>}
            <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className="btn btn-sm" onClick={() => void run(() => accountActions.get(intent.id))}>Обновить сохранённый результат</button>{intent.responseObservationId !== null && (intent.state === "indeterminate" || intent.accountingState === "pending") && <button type="button" disabled={busy || pending !== null} className="btn btn-sm" onClick={() => mutateIntent("repair")}>Обработать сохранённый ответ ещё раз</button>}</div>
            <details className="help"><summary>{intent.responseData !== null ? "Технические детали · ответ OnlyFans" : "Технические детали"}</summary><div className="help-body max-w-none">
              {intent.responseData !== null && <div className="max-h-96 overflow-auto text-sm text-text-primary"><Value value={intent.responseData} /></div>}
              {intent.responseMeta !== null && <div className="text-xs"><p>Продолжение списка</p><Value value={intent.responseMeta} /></div>}
              <p className="break-all text-xs">ID запроса: {intent.id}{intent.remoteId ? ` · ID у провайдера: ${intent.remoteId}` : ""}</p>
            </div></details>
            {canStartNew && <div className="space-y-2 border-t border-border-light pt-4">{intent.state === "indeterminate" && <label className="flex items-start gap-2 text-sm text-text-primary"><input type="checkbox" className="mt-1" checked={allowNewAfterUnknown} disabled={busy} onChange={event => setAllowNewAfterUnknown(event.target.checked)} />Я проверил результат в OnlyFans и хочу подготовить отдельное новое действие.</label>}<button type="button" className="btn btn-sm" disabled={busy || (intent.state === "indeterminate" && !allowNewAfterUnknown)} onClick={() => { admission.current.startNew(intent.command); setIntent(null); setAllowNewAfterUnknown(false); }}>Подготовить ещё одно такое действие</button></div>}
          </div>
        </> : <div className="card-body space-y-4">
          {errorNotice}
          <div className="empty px-0 py-8"><p className="empty-title">Здесь появится проверка</p><p className="empty-text">Заполните поля и проверьте действие. Перед выполнением здесь появятся аккаунт, выбранные параметры и оценка запроса.</p></div>
        </div>}
      </section>
    </div>}
    {showWorkspace && <section className="card" aria-labelledby="ofapi-actions-history-title">
      <div className="card-header"><h2 id="ofapi-actions-history-title" className="card-title">Последние действия</h2></div>
      {pageId !== null && history.isPending && <p role="status" className="px-5 py-4 text-sm text-text-muted">Загружаем историю действий…</p>}
      {history.data && !history.isError && history.data.intents.length === 0 && <div className="empty py-8"><p className="empty-text">У этой страницы пока нет сохранённых действий.</p></div>}
      {history.data && history.data.intents.length > 0 && <ul className="divide-y divide-border-light">{history.data.intents.map(item => <li key={item.id}><button type="button" disabled={busy} className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-3 text-left text-sm transition-colors hover:bg-hover-alt disabled:cursor-not-allowed disabled:opacity-45" onClick={() => { setAllowNewAfterUnknown(false); void run(() => accountActions.get(item.id)); }}><span className="font-medium text-text-primary">{forms.find(form => form.action === item.action)?.label ?? item.action}</span><span className="flex items-center gap-3"><span className={stateBadges[item.state]}>{stateLabels[item.state]}</span><span className="text-xs text-text-muted">{formatDateTime(item.createdAt)}</span></span></button></li>)}</ul>}
    </section>}
  </div>;
}
