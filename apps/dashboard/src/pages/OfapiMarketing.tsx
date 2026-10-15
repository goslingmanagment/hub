import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { OfapiMarketingResource } from "@agency_hub_core/contracts";
import { ofapiCollectionQueryOptions } from "@/api/ofapiCollection";
import { useOfLinks } from "@/api/ofLinks";
import { marketingActionInFlight, marketingActions, useOfapiMarketing, type MarketingDashboard, type MarketingIntent } from "@/api/ofapiMarketing";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { RowMenu } from "@/components/ui/RowMenu";
import { formatDate, formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { OfLinksTable } from "./marketing/OfLinksTable.js";
import { count, filterLinks, linkTotals, money as usd, moscowDateTime, pageWarnings, sortLinks, type LinkFilter } from "./marketing/ofLinksView.js";
import { actionLabels, buildMarketingCommand, conversionTypes, eventFields, eventLabels, newMarketingForm, marketingDisplayMoney, marketingFlag, marketingPixelCanTest, marketingPreviewFieldLabels, marketingPreviewValue, platformLabels, revenueBasisLabels, smartLinkTypeLabels, type MarketingForm } from "./marketing/marketingForm.js";

const inventorySelections = new Set(["smart_links", "stored_tracking_links", "stored_trial_links", "stored_shared_tracking_links", "stored_shared_trial_links", "shared_tracking_links", "shared_trial_links"]);
const kindSelections = (kind: "tracking" | "trial"): [string, string][] => [
  [`stored_${kind}_links`, `Сохранённые ${kind}-ссылки`], [`stored_shared_${kind}_links`, `Сохранённые общие ${kind}-ссылки`], [`shared_${kind}_links`, `Общие ${kind}-ссылки`],
  [`${kind}_link`, `Сведения о ${kind}-ссылке`], [`${kind}_link_tags`, `Теги ${kind}-ссылки`], [`${kind}_link_subscribers`, `Подписчики ${kind}-ссылки`],
  [`${kind}_link_spenders`, `Платящие фаны ${kind}-ссылки`], [`${kind}_link_stats`, `Статистика ${kind}-ссылки`], [`${kind}_link_cohort_arps`, `Когорты ${kind}-ссылки`],
];
/** The one-off reads, grouped as the select shows them. */
const readSelectionGroups: Array<{ label: string; options: [string, string][] }> = [
  { label: "Smart Links", options: [["smart_links", "Список Smart Links"], ["smart_link", "Сведения о Smart Link"], ["smart_link_pixels", "Пиксели ссылки"], ["smart_link_tags", "Теги ссылки"], ["smart_link_stats", "Статистика Smart Link"], ["smart_link_cohort_arps", "Когорты Smart Link"], ["smart_link_spenders", "Платящие фаны Smart Link"], ["smart_link_fans", "Подписчики Smart Link"], ["smart_link_clicks", "Клики Smart Link"], ["smart_link_conversions", "Конверсии Smart Link"]] },
  { label: "Tracking-ссылки", options: kindSelections("tracking") },
  { label: "Trial-ссылки", options: kindSelections("trial") },
];
const readSelectionLabels = new Map(readSelectionGroups.flatMap(group => group.options));
/** "ofapi_read_smart_link_stats" → "Статистика Smart Link". */
const operationLabel = (operation: string) => {
  const read = operation.replace(/^ofapi_read_/, "");
  return readSelectionLabels.get(read) ?? read.replaceAll("_", " ");
};
const stateLabels: Record<string, string> = { prepared: "Ждёт подтверждения", dispatching: "Запрос отправляется", succeeded: "Подтверждено провайдером", rejected: "Отклонено", indeterminate: "Результат неизвестен", complete: "Полный ответ", partial: "Частичные данные", unknown: "Полнота неизвестна" };
const stateBadges: Record<string, string> = { prepared: "badge badge-accent", dispatching: "badge badge-info", succeeded: "badge badge-success", rejected: "badge badge-danger", indeterminate: "badge badge-warning" };
const pixelStatusLabels: Record<string, string> = { active: "активен", inactive: "отключён", disabled: "отключён", paused: "на паузе" };
const value = (input: unknown) => input === null || input === undefined ? "—" : String(input);
const money = (input: string | null | undefined) => input == null ? "—" : formatUsdFromMills(input);
const basis = (input: string | null | undefined) => input == null ? "—" : revenueBasisLabels[input] ?? input;
const credits = (count: number) => `${count} ${ruPlural(count, "кредит", "кредита", "кредитов")}`;
const toggle = (values: string[], item: string, checked: boolean) => checked ? [...new Set([...values, item])] : values.filter(value => value !== item);

function MarketingEditor({ form, setForm, links, busy, error, onPrepare, onClose }: {
  form: MarketingForm; setForm: (form: MarketingForm) => void; links: OfapiMarketingResource[]; busy: boolean; error: string; onPrepare: () => void; onClose: () => void;
}) {
  const put = <K extends keyof MarketingForm>(key: K, value: MarketingForm[K]) => setForm({ ...form, [key]: value });
  const pixel = form.action === "pixel_create" || form.action === "pixel_update";
  const postback = form.action === "postback_create" || form.action === "postback_update";
  const removal = ["smart_link_delete", "pixel_disconnect", "postback_delete"].includes(form.action);
  const target = form.linkId ? links.find(link => link.id === form.linkId)?.name ?? null : null;
  return <ModalShell title={actionLabels[form.action]} onClose={onClose}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); onPrepare(); }}>
      {error && <p role="alert" className="notice notice-danger">{error}</p>}
      {form.linkId && <p className="break-all text-sm text-text-secondary" title={`ID ${form.linkId}`}>Ссылка: <strong className="text-text-primary">{target ?? form.linkId}</strong></p>}
      {form.action === "smart_link_create" && <>
        <Field label="Название"><input className="input" required maxLength={255} value={form.name} onChange={e => put("name", e.target.value)} /></Field>
        <Field label="Предложение"><select className="select" value={form.linkType} onChange={e => put("linkType", e.target.value as MarketingForm["linkType"])}><option value="tracking_link">Обычная отслеживаемая ссылка</option><option value="free_trial">Бесплатный пробный период</option></select></Field>
        {form.linkType === "free_trial" && <Field label="Дней бесплатного доступа"><input className="input" type="number" min={1} max={360} required value={form.trialDays} onChange={e => put("trialDays", e.target.value)} /></Field>}
      </>}
      {(form.action === "tags_add" || form.action === "tags_remove") && <Field label="Теги — по одному на строку"><textarea className="textarea" rows={4} required value={form.tags} onChange={e => put("tags", e.target.value)} /></Field>}
      {pixel && <>
        <Field label="Название пикселя"><input className="input" maxLength={100} value={form.name} onChange={e => put("name", e.target.value)} /></Field>
        {form.action === "pixel_create" && <Field label="Платформа"><select className="select" value={form.platform} onChange={e => put("platform", e.target.value as MarketingForm["platform"])}>{(["meta", "snapchat", "tiktok", "creatortraffic"] as const).map(platform => <option key={platform} value={platform}>{platformLabels[platform]}</option>)}</select></Field>}
        <Field label="ID пикселя на рекламной платформе"><input className="input" required={form.action === "pixel_create" && form.platform !== "creatortraffic"} maxLength={255} value={form.platformPixelId} onChange={e => put("platformPixelId", e.target.value)} /></Field>
        <Field label={form.action === "pixel_create" ? "Токен доступа" : "Новый токен доступа"} hint={form.action === "pixel_create" ? undefined : "Оставьте пустым, чтобы сохранить текущий."}><input className="input" type="password" autoComplete="new-password" required={form.action === "pixel_create"} maxLength={16000} value={form.token} onChange={e => put("token", e.target.value)} /></Field>
        <Field label="URL источника событий, если нужен"><input className="input" type="url" disabled={form.clearEventSourceUrl} value={form.eventSourceUrl} onChange={e => put("eventSourceUrl", e.target.value)} /></Field>
        {form.action === "pixel_update" && <label className="flex items-start gap-2 text-sm text-text-secondary"><input type="checkbox" className="mt-1" checked={form.clearEventSourceUrl} onChange={e => put("clearEventSourceUrl", e.target.checked)} />Удалить сохранённый URL источника событий</label>}
        <details className="help"><summary>Названия событий на рекламной платформе</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{eventFields.map(key => <Field key={key} label={eventLabels[key]!}><input className="input" maxLength={100} value={form.events[key] ?? ""} onChange={e => put("events", { ...form.events, [key]: e.target.value })} /></Field>)}</div></details>
        {form.action === "pixel_update" && <p className="notice">Изменяется общий пиксель. Отправятся только изменённые поля. Очистка заполненного названия события удалит это значение. Сервер покажет связанные ссылки до подтверждения.</p>}
      </>}
      {form.action === "pixel_test" && <>
        <p className="text-sm text-text-secondary">Провайдер отправит реальное тестовое событие в рекламную систему. Оно не подтверждает полноту сбора или рабочую атрибуцию.</p>
        <Field label="Тестовое событие"><select className="select" value={form.testEvent} onChange={e => put("testEvent", e.target.value)}>{["event_click", "event_new_subscriber_free", "event_new_subscriber_paid", "event_first_transaction", "event_new_transaction", "event_message_received_from_fan", "event_fan_sent_1_message", "event_fan_sent_3_messages"].map(key => <option key={key} value={key}>{eventLabels[key] ?? key}</option>)}</select></Field>
        <Field label="Код тестового события, если нужен"><input className="input" maxLength={100} value={form.testCode} onChange={e => put("testCode", e.target.value)} /></Field>
      </>}
      {postback && <>
        <p className="text-sm text-text-secondary">URL может содержать переменные провайдера. Секретные значения не загружаются в редактор и не показываются в истории.</p>
        <Field label="Полный URL получателя или шаблон URL"><input className="input" required maxLength={4000} autoComplete="off" value={form.url} onChange={e => put("url", e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Метод"><select className="select" value={form.method} onChange={e => put("method", e.target.value as "GET" | "POST")}><option>POST</option><option>GET</option></select></Field>
          <Field label="Охват"><select className="select" value={form.scope} onChange={e => put("scope", e.target.value as MarketingForm["scope"])}><option value="campaign_specific">Выбранные Smart Links</option><option value="global">Все Smart Links команды</option></select></Field>
        </div>
        {form.scope === "campaign_specific" && <fieldset className="space-y-2 rounded-lg border border-border p-3"><legend className="field-label px-1">Ссылки</legend>{links.map(link => <label key={link.id} className="flex gap-2 text-sm"><input type="checkbox" checked={form.linkIds.includes(link.id)} onChange={e => put("linkIds", toggle(form.linkIds, link.id, e.target.checked))} />{link.name ?? link.id}</label>)}{!links.length && <p className="text-sm text-text-muted">Сначала соберите список Smart Links.</p>}{form.linkIds.filter(id => !links.some(link => link.id === id)).map(id => <label key={id} className="flex gap-2 break-all text-xs"><input type="checkbox" checked onChange={() => put("linkIds", form.linkIds.filter(value => value !== id))} />{id} · сохранённая ссылка вне текущего списка</label>)}</fieldset>}
        <fieldset className="space-y-2"><legend className="field-label">Когда отправлять</legend>{conversionTypes.map(type => <label key={type} className="flex gap-2 text-sm"><input type="checkbox" checked={form.conversions.includes(type)} onChange={e => put("conversions", toggle(form.conversions, type, e.target.checked))} />{eventLabels[type]}</label>)}</fieldset>
        <Field label="Шаблон тела запроса"><textarea className="textarea" disabled={form.clearBody} rows={3} maxLength={16000} autoComplete="off" value={form.body} onChange={e => put("body", e.target.value)} /></Field>
        <fieldset disabled={form.clearHeaders} className="space-y-2"><legend className="field-label">Заголовки запроса</legend>{form.headers.map((header, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><input aria-label={`Имя заголовка ${index + 1}`} className="input" required placeholder="Authorization" value={header.name} onChange={e => put("headers", form.headers.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} /><input aria-label={`Значение заголовка ${index + 1}`} className="input" type="password" autoComplete="new-password" value={header.value} onChange={e => put("headers", form.headers.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} /><button className="btn" type="button" onClick={() => put("headers", form.headers.filter((_, i) => i !== index))}>Убрать</button></div>)}<button type="button" className="btn btn-sm" disabled={form.headers.length >= 30} onClick={() => put("headers", [...form.headers, { name: "", value: "" }])}>Добавить заголовок</button></fieldset>
        {form.action === "postback_update" && <div className="space-y-2 text-sm text-text-secondary"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={form.clearBody} onChange={e => put("clearBody", e.target.checked)} />Удалить сохранённое тело запроса</label><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={form.clearHeaders} onChange={e => put("clearHeaders", e.target.checked)} />Удалить все сохранённые заголовки</label></div>}
        {form.action === "postback_update" && <p className="field-hint">Без отметок удаления пустое тело и отсутствие заголовков сохранят текущие значения. Если указать заголовки, передайте весь нужный набор заново. Полный URL требуется заново.</p>}
      </>}
      {removal && <p className="text-sm text-text-secondary">{form.action === "pixel_disconnect" ? "Пиксель будет отключён только от этой ссылки. Остальные подключения сохранятся." : "Удаление изменяет объект у провайдера. Перед выполнением проверьте цель в следующем окне."}</p>}
      <div className="flex justify-end gap-2 pt-2"><button type="button" className="btn" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Готовим…" : "Проверить действие"}</button></div>
    </form>
  </ModalShell>;
}

export function MarketingIntentReview({ intent, busy, error, onDispatch, onClose }: { intent: MarketingIntent; busy: boolean; error: string; onDispatch: (shared: boolean, external: boolean) => void; onClose: () => void }) {
  const [shared, setShared] = useState(false); const [external, setExternal] = useState(false);
  const needsShared = !intent.preview.affectedLinksComplete;
  return <ModalShell title={actionLabels[intent.action as MarketingForm["action"]] ?? intent.action} onClose={onClose}>
    <div className="space-y-4 text-sm text-text-secondary">
      {error && <p role="alert" className="notice notice-danger">{error}</p>}
      <p className="text-text-primary">{intent.preview.effect}</p>
      <p>{intent.preview.pageId ? <>Страница: <strong className="text-text-primary">{intent.preview.pageLabel ?? intent.preview.pageId}</strong> · ID {intent.preview.pageId} · аккаунт {intent.preview.accountId}</> : "Настройка команды; не ограничена выбранной на экране страницей."}</p>
      {!!intent.preview.values.length && <dl className="space-y-2 rounded-lg border border-border p-3">{intent.preview.values.map(item => <div key={item.field}><dt className="text-xs text-text-muted">{marketingPreviewFieldLabels[item.field]}</dt><dd className="break-all font-medium text-text-primary">{marketingPreviewValue(item)}</dd></div>)}</dl>}
      {intent.preview.targetId && <p className="break-all">Объект: <strong className="text-text-primary">{intent.preview.targetId}</strong></p>}
      {!!intent.preview.changedFields.length && <p>Изменяемые поля: {intent.preview.changedFields.join(", ")}</p>}
      {!!intent.preview.conversionTypes.length && <p>События: {intent.preview.conversionTypes.map(type => eventLabels[type] ?? type).join(", ")}</p>}
      {intent.preview.scope && <p>Охват: {intent.preview.scope === "global" ? "Все Smart Links команды" : "Выбранные ссылки"}</p>}
      {intent.preview.destination && <p className="break-all">Получатель: <strong className="text-text-primary">{intent.preview.destination}</strong></p>}
      <p>Оценка: {credits(intent.preview.estimatedCredits)}. Фактический расход будет записан по ответу провайдера.</p>
      {!!intent.preview.affectedLinkIds.length && <div><p className="font-medium text-text-primary">Затронутые ссылки:</p><ul className="mt-1 list-inside list-disc break-all text-xs">{intent.preview.affectedLinkIds.map(id => <li key={id}>{id}</li>)}</ul></div>}
      {!intent.preview.affectedLinksComplete && <p className="notice notice-warning">Список затронутых ссылок может быть неполным: текущие данные или права ключа не подтверждают весь охват.</p>}
      {!!intent.preview.templateVariables.length && <p>Переменные: {intent.preview.templateVariables.join(", ")}</p>}
      {!!intent.preview.headerNames.length && <p>Заголовки: {intent.preview.headerNames.join(", ")}. Значения скрыты.</p>}
      {needsShared && <label className="flex items-start gap-2 text-text-primary"><input type="checkbox" className="mt-1" checked={shared} onChange={e => setShared(e.target.checked)} />{intent.action === "pixel_update" ? "Подтверждаю изменение общего пикселя для связанных ссылок." : "Подтверждаю изменение передачи событий с указанным охватом, включая ссылки вне текущего списка."}</label>}
      {intent.preview.externalTest && <label className="flex items-start gap-2 text-text-primary"><input type="checkbox" className="mt-1" checked={external} onChange={e => setExternal(e.target.checked)} />Подтверждаю отправку тестового события во внешнюю рекламную систему.</label>}
      <div className="flex justify-end gap-2 pt-2"><button type="button" className="btn" disabled={busy} onClick={onClose}>Закрыть</button><button type="button" className="btn btn-primary" disabled={busy || (needsShared && !shared) || (intent.preview.externalTest && !external)} onClick={() => onDispatch(shared, external)}>{busy ? "Отправляем…" : "Подтвердить и выполнить"}</button></div>
      <p className="text-xs text-text-muted">При неизвестном результате действие не отправляется повторно автоматически. Его состояние останется в истории.</p>
    </div>
  </ModalShell>;
}

/** Smart Links are frozen (plan §2.9): their block shows only when something
 * of them exists — a link, a pixel, a postback or an action — or when the
 * owner opens it on purpose. */
export function smartLinksHaveData(data: MarketingDashboard | undefined): boolean {
  if (!data) return false;
  return data.intents.length > 0
    || data.resources.some(row => row.kind === "smart_link" || row.kind === "pixel" || row.kind === "postback");
}

/** The link picked in the one-off collection form, with the page and the
 * read it was picked for. */
export interface PickedLink { pageId: number; selection: string; id: string }

/** The pick that still holds: same page, same read, and still offered —
 * else "" (nothing picked). A page that drops out on refresh moves the form
 * to another page; the old page's link must not travel with it. */
export function effectivePickedLink(
  picked: PickedLink | null,
  current: { pageId: number; selection: string; links: ReadonlyArray<{ id: string }> },
): string {
  if (picked === null || picked.pageId !== current.pageId || picked.selection !== current.selection) return "";
  return current.links.some(link => link.id === picked.id) ? picked.id : "";
}

const linkFilters: Array<[LinkFilter, string]> = [["all", "Все"], ["active", "Активные"], ["closed", "Завершённые и истёкшие"]];
const smartTabs = [["links", "Ссылки и пиксели"], ["postbacks", "Postbacks"], ["analytics", "Результаты"], ["history", "История действий"]] as const;

export function OfapiMarketing() {
  const links = useOfLinks();
  const collection = useQuery({ ...ofapiCollectionQueryOptions(), placeholderData: (previous) => previous });
  const [smartToggle, setSmartToggle] = useState<boolean | null>(null);
  // Read once; polled every 15 s only while the block is open and an action is in flight.
  const data = useOfapiMarketing({ poll: (dashboard) => (smartToggle ?? smartLinksHaveData(dashboard)) && marketingActionInFlight(dashboard?.intents) });
  const smartOpen = smartToggle ?? smartLinksHaveData(data.data);
  const [searchParams, setSearchParams] = useSearchParams();
  const pages = links.data?.pages ?? [];
  const page = pages.find(row => row.pageLabel === searchParams.get("page")) ?? pages[0] ?? null;
  const pageId = page?.pageId ?? 0;
  const [filter, setFilter] = useState<LinkFilter>("all");
  const [tab, setTab] = useState<"links" | "postbacks" | "analytics" | "history">("links");
  const [form, setForm] = useState<MarketingForm | null>(null); const [review, setReview] = useState<MarketingIntent | null>(null);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [selection, setSelection] = useState("smart_links"); const [pickedLink, setPickedLink] = useState<PickedLink | null>(null);
  const [calls, setCalls] = useState(5); const [credits, setCredits] = useState(10);
  const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const resources = data.data?.resources ?? []; const allLinks = resources.filter(row => row.kind === "smart_link");
  const smartLinks = allLinks.filter(row => row.pageId === pageId); const pixels = resources.filter(row => row.kind === "pixel");
  const postbacks = resources.filter(row => row.kind === "postback");
  const pageLinks = sortLinks((links.data?.links ?? []).filter(link => link.pageId === pageId));
  const shownLinks = filterLinks(pageLinks, filter);
  const totals = linkTotals(shownLinks);
  const warnings = page && links.data ? pageWarnings(page, links.data.staleAfterHours) : [];
  const now = links.data ? Date.parse(links.data.generatedAt) : 0;
  const inFlight = useRef(false);
  async function run(action: () => Promise<void>, refreshedNotice?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setNotice(""); setError("");
    try {
      await action();
      const results = await Promise.all([links.refetch(), data.refetch(), collection.refetch()]);
      if (results.some(result => result.isError)) setError("Не удалось обновить сохранённые данные. Полученный результат действия сохранён; проверьте его через «Обновить».");
      else if (refreshedNotice) setNotice(refreshedNotice);
    }
    catch (error) { setError(error instanceof Error ? error.message : "Действие не выполнено"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const edit = (action: MarketingForm["action"], resource?: OfapiMarketingResource) => { setError(""); setForm(newMarketingForm(action, resource?.pageId ?? pageId, resource)); };
  async function prepare() {
    if (!form) return;
    const command = buildMarketingCommand(form);
    const intent = await marketingActions.prepare({ id: crypto.randomUUID(), command });
    setForm(null); setReview(intent);
  }
  const perLink = !inventorySelections.has(selection);
  // Tracking and trial links come from the link series; Smart Links from their own saved list.
  const selectableLinks = selection.startsWith("smart_")
    ? smartLinks.map(link => ({ id: link.id, name: link.name }))
    : pageLinks.filter(link => link.linkKind === (selection.startsWith("trial_") ? "trial" : "tracking")).map(link => ({ id: link.linkRef, name: link.name }));
  // A paid read goes to the effective page: a link picked on another page, or
  // for another read, or no longer offered, is no pick at all.
  const selectedLink = effectivePickedLink(pickedLink, { pageId, selection, links: selectableLinks });
  const selectPage = (label: string) => {
    setPickedLink(null);
    setSearchParams(previous => { const next = new URLSearchParams(previous); next.set("page", label); return next; }, { replace: true });
  };
  const linkName = (id: string) => allLinks.find(link => link.id === id)?.name ?? pageLinks.find(link => link.linkRef === id)?.name ?? `Ссылка ${id}`;
  const collectCategory = selection.startsWith("smart_") ? "smart_links" : "tracking_links";
  return <div className="space-y-5">
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <label className="w-full sm:w-64"><span className="field-label">Страница</span><select disabled={busy || !pages.length} className="select" value={page?.pageLabel ?? ""} onChange={e => selectPage(e.target.value)}>{pages.map(row => <option key={row.pageId} value={row.pageLabel}>{row.pageLabel}</option>)}</select></label>
      <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {}, "Данные перечитаны из Hub. Запросов к OnlyFans API не было.")}>Обновить</button>
      {links.data && <span className="order-last w-full text-xs text-text-muted sm:order-none sm:w-auto sm:pb-2" title={`Прочитано ${moscowDateTime(links.data.generatedAt)} МСК`}>Данные обновляются 4 раза в сутки · экран перечитывает их каждые 5 минут</span>}
      <Link className="link ml-auto pb-2 text-sm" to="/settings?tab=collection">Настройки сбора</Link>
    </div>
    {(error || links.error) && <p role="alert" className="notice notice-danger">{error || links.error?.message}</p>}
    {links.isPending && <p role="status" className="text-sm text-text-muted">Загружаем ссылки…</p>}
    {links.isError && links.data && <p className="notice notice-warning">Показаны прежние данные. Нажмите «Обновить», чтобы проверить текущее состояние.</p>}
    {links.data && !links.isError && !pages.length && <StatusPanel title="Нет активных страниц OnlyFans" description="Ссылки появятся, когда у агентства будет активная страница OnlyFans." />}
    {notice && <p role="status" className="notice">{notice}</p>}
    {warnings.length > 0 && <div role="alert" className="notice notice-warning" data-of-links="warnings"><div className="min-w-0 space-y-1">{warnings.map(line => <p key={line}>{line}</p>)}</div></div>}
    {page && <section className="card" aria-labelledby="of-links-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="of-links-title" className="card-title">Ссылки страницы {page.pageLabel}</h2>
          {shownLinks.length > 0 && <p className="card-description" data-of-links="totals">Показано {shownLinks.length} · клики {count(totals.clicks)} · фаны {count(totals.fans)} · доход по OnlyFans {usd(totals.vendorMills)} чистыми{totals.unknownMoney > 0 ? ` (у ${totals.unknownMoney} — сумма неизвестна)` : ""}</p>}
        </div>
        <div className="segmented max-w-full flex-wrap" role="group" aria-label="Какие ссылки показать">{linkFilters.map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} className="segment" onClick={() => setFilter(id)}>{label}<span className="segment-count">{filterLinks(pageLinks, id).length}</span></button>)}</div>
      </div>
      {!pageLinks.length && <div className="empty"><p className="empty-title">{page.kinds.some(kind => kind.lastUsableAt !== null) ? "В последнем сборе нет ссылок этой страницы" : "Ссылки этой страницы ещё не собирались"}</p></div>}
      {pageLinks.length > 0 && !shownLinks.length && <div className="empty"><p className="empty-title">Таких ссылок нет</p></div>}
      {shownLinks.length > 0 && <OfLinksTable links={shownLinks} now={now} />}
      <div className="border-t border-border-light px-5 py-3">
        <details className="help"><summary>Как считаются фаны и доход</summary><div className="help-body">
          <p>Фаны: у trial-ссылок — активации пробного периода, у tracking-ссылок — подписчики.</p>
          <p>«Доход по OnlyFans» — расчёт OnlyFans API по подпискам с этой ссылки; его иногда пересчитывают задним числом. «Доход по Hub» — собственный расчёт Hub по журналу транзакций с даты, когда Hub начал видеть фанов ссылки.</p>
          <p>Обе суммы — чистыми, после комиссии OnlyFans. «Разница» сравнивает их за один и тот же период — он указан в ячейке.</p>
        </div></details>
      </div>
    </section>}
    <section className="card" aria-labelledby="smart-links-title" data-smart-links={smartOpen ? "open" : "closed"}>
      <div className={`card-header ${smartOpen ? "" : "border-b-0"}`}>
        <div className="min-w-0"><h2 id="smart-links-title" className="card-title">Smart Links</h2><p className="card-description">{data.data && !smartLinksHaveData(data.data) ? "Не используются: нет ни ссылок, ни пикселей, ни postbacks, ни действий." : "Ссылки, пиксели и postbacks OnlyFans API и история действий с ними."}</p></div>
        <button type="button" className="btn btn-sm" aria-expanded={smartOpen} onClick={() => setSmartToggle(!smartOpen)}>{smartOpen ? "Скрыть" : "Показать"}</button>
      </div>
      {data.error && <div className="px-5 pb-4"><p role="alert" className="notice notice-danger">Smart Links не прочитаны: {data.error.message}</p></div>}
      {smartOpen && <div className="card-body space-y-4">
        <p className="text-sm text-text-secondary">Окно атрибуции — 6 часов. Эти суммы не прибавляются к финансовому журналу Hub.</p>
        {data.isPending && <p role="status" className="text-sm text-text-muted">Загружаем сохранённые данные Smart Links…</p>}
        {data.isError && data.data && <p className="notice notice-warning">Показаны прежние данные. Нажмите «Обновить», чтобы проверить текущее состояние.</p>}
        <div className="segmented max-w-full flex-wrap" role="group" aria-label="Данные Smart Links">{smartTabs.map(([id, label]) => <button type="button" aria-pressed={tab === id} key={id} className="segment" onClick={() => setTab(id)}>{label}</button>)}</div>
        {tab === "links" && <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="section-title">Smart Links этой страницы</h3><button type="button" className="btn btn-sm" disabled={!pageId || busy} onClick={() => edit("smart_link_create")}>Создать ссылку</button></div>
          {data.data && !data.isError && pageId > 0 && !smartLinks.length && <p className="text-sm text-text-muted">Ссылок в сохранённых данных пока нет. Соберите их разовым сбором ниже или создайте ссылку.</p>}
          {smartLinks.map(link => <article key={link.id} className="space-y-2 border-t border-border-light pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h4 className="font-medium text-text-primary">{link.name ?? "Smart Link без названия"}</h4><p className="text-xs text-text-muted">{link.linkType ? smartLinkTypeLabels[link.linkType] ?? link.linkType : "Тип неизвестен"} · сохранено {formatDateTime(link.observedAt)}</p></div>
              <RowMenu label={`Действия: ${link.name ?? "Smart Link"}`} items={[
                { label: "Добавить теги", disabled: busy, onSelect: () => edit("tags_add", link) },
                { label: "Снять теги", disabled: busy || !link.tags.length, onSelect: () => edit("tags_remove", link) },
                { label: "Подключить пиксель", disabled: busy, onSelect: () => edit("pixel_create", link) },
                { label: "Удалить", danger: true, disabled: busy, onSelect: () => edit("smart_link_delete", link) },
              ]} />
            </div>
            {link.publicUrl && <a className="link inline-block max-w-full break-all text-sm" href={link.publicUrl} target="_blank" rel="noreferrer">{link.publicUrl}</a>}
            <p className="text-sm text-text-secondary">Клики {value(link.clicks)} · Подписки {value(link.subscribers)} · Платящие {value(link.spenders)} · Доход {money(link.revenueMills)} ({basis(link.revenueBasis)})</p>
            {!!link.tags.length && <div className="flex flex-wrap gap-1.5">{link.tags.map(tag => <span key={tag} className="badge">{tag}</span>)}</div>}
            {link.cost && <p className="text-xs text-text-muted">Расход кампании по настройкам OnlyFans API: {value(link.cost.inputValue)} {value(link.cost.currency)}. Это не фактическое списание из банка.</p>}
            {pixels.filter(pixel => pixel.parentId === link.id && pixel.pageId === link.pageId).map(pixel => {
              const canTest = marketingPixelCanTest(pixel.platform);
              const platform = pixel.platform ? platformLabels[pixel.platform] ?? pixel.platform : "Платформа неизвестна";
              return <div key={pixel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-hover-alt px-3 py-2">
                <div className="min-w-0 text-sm"><span className="font-medium text-text-primary">{pixel.name ?? platform}</span><span className="block break-all text-xs text-text-muted">{platform} · ID пикселя {value(pixel.platformPixelId)} · {pixel.status ? pixelStatusLabels[pixel.status] ?? pixel.status : "статус неизвестен"}</span></div>
                <div className="flex items-center gap-1">
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => edit("pixel_update", pixel)}>Изменить</button>
                  <RowMenu label={`Действия с пикселем ${pixel.name ?? platform}`} items={[
                    { label: "Отправить тестовое событие", disabled: busy || !canTest, title: canTest ? undefined : "CreatorTraffic не поддерживает тестовые события", onSelect: () => edit("pixel_test", pixel) },
                    { label: "Отключить от ссылки", danger: true, disabled: busy, onSelect: () => edit("pixel_disconnect", pixel) },
                  ]} />
                </div>
              </div>;
            })}
            <details className="help"><summary>Технические детали</summary><div className="help-body break-all text-xs">
              <p>ID ссылки: {link.id}</p>
              {link.cost && <p>Режим расхода: {value(link.cost.inputMode)} · единица: {link.cost.unit}</p>}
            </div></details>
          </article>)}
        </div>}
        {tab === "postbacks" && <div className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="section-title">Postbacks команды</h3><p className="mt-1 text-xs text-text-muted">Общие настройки могут охватывать несколько страниц. Секретные шаблоны и значения заголовков скрыты.</p></div><div className="flex flex-wrap gap-2"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => { await marketingActions.postbacks({}); setNotice("Список postbacks прочитан из OnlyFans API."); })}>Прочитать из OnlyFans API</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => edit("postback_create")}>Создать postback</button></div></div>
          {data.data && !data.isError && !postbacks.length && <p className="text-sm text-text-muted">Сохранённого списка пока нет.</p>}
          {postbacks.map(row => <article key={row.id} className="space-y-1 border-t border-border-light pt-4">
            <div className="flex items-start justify-between gap-3"><h4 className="min-w-0 break-all font-medium text-text-primary">{row.httpMethod} {row.destination ?? `Postback ${row.id}`}</h4><div className="flex shrink-0 items-center gap-1"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => edit("postback_update", row)}>Изменить</button><RowMenu label="Другие действия с postback" items={[{ label: "Удалить", danger: true, disabled: busy, onSelect: () => edit("postback_delete", row) }]} /></div></div>
            <p className="text-sm text-text-secondary">{row.scope === "global" ? "Все Smart Links команды" : `${row.linkIds.length} выбранных ссылок`} · {row.conversionTypes.map(type => eventLabels[type] ?? type).join(", ")}</p>
            <p className="text-xs text-text-muted">Переменные: {row.templateVariables.join(", ") || "нет"}. Заголовки: {row.headerNames.join(", ") || "нет"}. Сохранено {formatDateTime(row.observedAt)}.</p>
          </article>)}
        </div>}
        {tab === "analytics" && <div className="space-y-4">
          <div><h3 className="section-title">Сохранённые результаты</h3><p className="mt-1 text-sm text-text-secondary">Доход относится к атрибуции ссылки. Клики, повторные клики, боты, органика и прошлые подписки сохраняют собственные признаки.</p></div>
          {data.data && !data.isError && pageId > 0 && !data.data.analytics.some(row => row.pageId === pageId) &&
            <p className="text-sm text-text-muted">Выберите нужный отчёт в разовом сборе ниже и запустите его.</p>}
          {data.data?.analytics.filter(row => row.pageId === pageId).map((snapshot, index) =>
            <article key={`${snapshot.operation}:${snapshot.linkId}:${index}`} className="space-y-2 border-t border-border-light pt-4">
              <h4 className="text-sm font-medium text-text-primary" title={`ID ${snapshot.linkId} · ${snapshot.operation}`}>{linkName(snapshot.linkId)} · {operationLabel(snapshot.operation)}</h4>
              <p className="text-xs text-text-muted" title={snapshot.coverage.reason ?? undefined}>
                {stateLabels[snapshot.coverage.state]} · {formatDateTime(snapshot.observedAt)} · период {snapshot.window.from ? formatDate(snapshot.window.from, { includeYear: true }) : "не указан"} — {snapshot.window.to ? formatDate(snapshot.window.to, { includeYear: true }) : "не указан"}{
                  snapshot.requestedRevenueBasis ? ` · доход ${basis(snapshot.requestedRevenueBasis)}` : ""
                }
              </p>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Период или фан</th><th className="num">Клики</th><th className="num">Подписки</th><th className="num">Платящие</th><th className="num">Доход</th><th>Признаки</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.rows.map((row, i) => {
                      const amount = marketingDisplayMoney(row);
                      return <tr key={i}>
                        <td>{row.timestamp ?? row.occurredAt ?? row.username ?? row.fanId ?? row.period ?? "Итог"}</td>
                        <td className="num">{value(row.clicks)}</td>
                        <td className="num">{value(row.subscribers)}</td>
                        <td className="num">{value(row.spenders)}</td>
                        <td className="num">{money(amount.mills)} · {basis(amount.basis)}</td>
                        <td className="muted text-xs">
                          {[
                            row.conversionType ? eventLabels[row.conversionType] ?? row.conversionType : null,
                            row.country,
                            ...(row.period === "row" ? [
                              marketingFlag("Бот", row.isBot),
                              marketingFlag("Повтор", row.isDuplicate),
                              marketingFlag("Органика", row.organic),
                              marketingFlag("Подписывался ранее", row.previouslySubscribed),
                              marketingFlag("Промо-подписка", row.subscribedUsingPromo),
                              marketingFlag("Подписка по этой ссылке", row.currentSubscriptionFromSmartLink)
                            ] : []),
                            row.metricPath ? `${row.metricPath}: ${row.providerValue ?? "—"}` : null
                          ].filter(Boolean).join(" · ") || "—"}
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </article>)}
        </div>}
        {tab === "history" && <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="section-title">История действий всех страниц</h3>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void run(async () => {
                await marketingActions.rebuild();
                setNotice(
                  "Восстановление начато. Незавершённые действия показаны в истории; обработка продолжится при обновлении экрана. Запросов к OnlyFans API не было."
                );
              })}
            >Восстановить из сохранённых ответов</button>
          </div>
          {data.data && !data.isError && !data.data.intents.length &&
            <p className="text-sm text-text-muted">Действий пока нет.</p>}
          {data.data?.intents.map(intent =>
            <article key={intent.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-border-light pt-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-medium text-text-primary">{actionLabels[intent.action as MarketingForm["action"]] ?? intent.action}</h4>
                  <span className={stateBadges[intent.state] ?? "badge"}>{stateLabels[intent.state] ?? intent.state}</span>
                </div>
                {intent.errorCode && <p className="text-xs text-text-secondary">Код ошибки: {intent.errorCode}</p>}
                {intent.remoteId && <p className="break-all text-xs text-text-secondary">ID у провайдера: {intent.remoteId}</p>}
                {intent.state === "succeeded" && (intent.accountingState === "pending" || intent.projectionState === "pending") &&
                  <p className="text-xs text-warning-dark">
                    Действие подтверждено; {intent.accountingState === "pending" ? "учёт расхода" : ""}{
                      intent.accountingState === "pending" && intent.projectionState === "pending" ? " и " : ""
                    }{
                      intent.projectionState === "pending" ? "обновление сохранённых данных" : ""
                    } ещё восстанавливается.
                  </p>}
                <p className="text-xs text-text-muted" title={`ID действия ${intent.id}`}>
                  {intent.preview.pageId
                    ? `Страница ${intent.preview.pageLabel ?? intent.preview.pageId} · аккаунт ${intent.preview.accountId}`
                    : "Настройки команды"} · {formatDateTime(intent.createdAt)}
                </p>
              </div>
              {intent.state === "prepared" &&
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setReview(intent)}>Проверить и подтвердить</button>}
            </article>)}
        </div>}
      </div>}
    </section>
    <details className="help">
      <summary>Разовый сбор данных</summary>
      <div className="help-body max-w-none gap-4">
        <p>Платный разовый сбор у OnlyFans API по выбранной странице: списки ссылок, сведения и списки по одной ссылке, Smart Links. Расписание не меняется; сбор останавливается на указанных лимитах, общая пауза фонового сбора действует и здесь.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Что собрать"><select className="select" value={selection} onChange={e => { setSelection(e.target.value); setPickedLink(null); }}>{readSelectionGroups.map(group => <optgroup key={group.label} label={group.label}>{group.options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</optgroup>)}</select></Field>
          {perLink && <Field label="Ссылка"><select required className="select" value={selectedLink} onChange={e => setPickedLink({ pageId, selection, id: e.target.value })}><option value="">Выберите ссылку</option>{selectableLinks.map(link => <option key={link.id} value={link.id}>{link.name ?? `Ссылка ${link.id}`}</option>)}</select></Field>}
          <Field label="С даты (UTC)"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="По дату включительно (UTC)"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          <Field label="Не более запросов"><input className="input" type="number" min={1} max={100} value={calls} onChange={e => setCalls(Number(e.target.value))} /></Field>
          <Field label="Не более кредитов"><input className="input" type="number" min={1} max={100} value={credits} onChange={e => setCredits(Number(e.target.value))} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn" disabled={busy || !pageId || !collection.data || (perLink && !selectedLink) || !Number.isInteger(calls) || calls < 1 || calls > 100 || !Number.isInteger(credits) || credits < 1 || credits > 100 || !from || !to || from > to} onClick={() => void run(async () => { if (perLink && effectivePickedLink(pickedLink, { pageId, selection, links: selectableLinks }) === "") throw new Error("Выберите ссылку этой страницы."); await marketingActions.collect({ pageId, category: collectCategory, expectedRevision: collection.data!.revision, maxCalls: calls, maxCredits: credits, maxBytes: 4 * 1024 * 1024, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, selection: [`${selection}${perLink ? `:${selectedLink}` : ""}`] }); setNotice("Сбор поставлен в очередь. Ход и возобновление — в «Настройки сбора»."); })}>Запустить один сбор</button><span className="text-xs text-text-muted">Не больше 4 МБ ответа; общие лимиты расхода тоже действуют.</span></div>
        <details className="help"><summary>Технические детали</summary><div className="help-body break-all text-xs">
          <p>Чтение: {selection}{perLink ? `:${selectedLink || "…"}` : ""}</p>
          <p>Категория сбора: {collectCategory} · страница {pageId || "—"}</p>
        </div></details>
      </div>
    </details>
    {form && <MarketingEditor form={form} setForm={setForm} links={allLinks} busy={busy} error={error} onClose={() => { if (!busy) setForm(null); }} onPrepare={() => void run(prepare)} />}
    {review && <MarketingIntentReview key={review.id} intent={review} busy={busy} error={error} onClose={() => { if (!busy) setReview(null); }} onDispatch={(shared, external) => void run(async () => { const result = await marketingActions.dispatch(review.id, { acknowledgeSharedImpact: shared, acknowledgeExternalTest: external }); setReview(null); setSmartToggle(true); setTab("history"); setNotice(stateLabels[result.state] ?? result.state); })} />}
  </div>;
}
