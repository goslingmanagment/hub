import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { OfapiMarketingResource } from "@agency_hub_core/contracts";
import { ofapiCollectionQueryOptions } from "@/api/ofapiCollection";
import { useOfLinks } from "@/api/ofLinks";
import { marketingActionInFlight, marketingActions, useOfapiMarketing, type MarketingDashboard, type MarketingIntent } from "@/api/ofapiMarketing";
import { ModalShell } from "@/components/shared/ModalShell";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { OfLinksTable } from "./marketing/OfLinksTable.js";
import { count, filterLinks, linkTotals, money as usd, moscowDateTime, pageWarnings, sortLinks, type LinkFilter } from "./marketing/ofLinksView.js";
import { actionLabels, buildMarketingCommand, conversionTypes, eventFields, eventLabels, newMarketingForm, marketingDisplayMoney, marketingFlag, marketingPixelCanTest, marketingPreviewFieldLabels, marketingPreviewValue, type MarketingForm } from "./marketing/marketingForm.js";

const field = "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary";
const button = "rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-40";
const primary = "rounded-lg border border-accent bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-40";
const card = "rounded-xl border border-border bg-card p-5";
const inventorySelections = new Set(["smart_links", "stored_tracking_links", "stored_trial_links", "stored_shared_tracking_links", "stored_shared_trial_links", "shared_tracking_links", "shared_trial_links"]);
const readSelections: [string, string][] = [
  ["smart_links", "Список Smart Links"], ["smart_link", "Сведения о Smart Link"], ["smart_link_pixels", "Пиксели ссылки"], ["smart_link_tags", "Теги ссылки"], ["smart_link_stats", "Статистика Smart Link"], ["smart_link_cohort_arps", "Когорты Smart Link"], ["smart_link_spenders", "Платящие фаны Smart Link"], ["smart_link_fans", "Подписчики Smart Link"], ["smart_link_clicks", "Клики Smart Link"], ["smart_link_conversions", "Конверсии Smart Link"],
  ...(["tracking", "trial"] as const).flatMap(kind => ([
    [`stored_${kind}_links`, `Сохранённые ${kind} links`], [`stored_shared_${kind}_links`, `Сохранённые общие ${kind} links`], [`shared_${kind}_links`, `Общие ${kind} links`], [`${kind}_link`, `Сведения ${kind}`], [`${kind}_link_tags`, `Теги ${kind}`], [`${kind}_link_subscribers`, `Подписчики ${kind}`], [`${kind}_link_spenders`, `Платящие фаны ${kind}`], [`${kind}_link_stats`, `Статистика ${kind}`], [`${kind}_link_cohort_arps`, `Когорты ${kind}`],
  ] as [string, string][])),
];
const stateLabels: Record<string, string> = { prepared: "Ждёт подтверждения", dispatching: "Запрос отправляется", succeeded: "Подтверждено провайдером", rejected: "Отклонено", indeterminate: "Результат неизвестен", complete: "Полный ответ", partial: "Частичные данные", unknown: "Полнота неизвестна" };
const value = (input: unknown) => input === null || input === undefined ? "—" : String(input);
const money = (input: string | null | undefined) => input == null ? "—" : formatUsdFromMills(input);
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-1.5 text-sm text-text-secondary">{label}{children}</label>; }
const toggle = (values: string[], item: string, checked: boolean) => checked ? [...new Set([...values, item])] : values.filter(value => value !== item);

function MarketingEditor({ form, setForm, links, busy, error, onPrepare, onClose }: {
  form: MarketingForm; setForm: (form: MarketingForm) => void; links: OfapiMarketingResource[]; busy: boolean; error: string; onPrepare: () => void; onClose: () => void;
}) {
  const put = <K extends keyof MarketingForm>(key: K, value: MarketingForm[K]) => setForm({ ...form, [key]: value });
  const pixel = form.action === "pixel_create" || form.action === "pixel_update";
  const postback = form.action === "postback_create" || form.action === "postback_update";
  const removal = ["smart_link_delete", "pixel_disconnect", "postback_delete"].includes(form.action);
  return <ModalShell title={actionLabels[form.action]} onClose={onClose}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); onPrepare(); }}>
      {error && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-700">{error}</p>}
      {form.linkId && <p className="break-all text-xs text-text-muted">Smart Link {form.linkId}</p>}
      {form.action === "smart_link_create" && <>
        <Field label="Название"><input className={field} required maxLength={255} value={form.name} onChange={e => put("name", e.target.value)} /></Field>
        <Field label="Предложение"><select className={field} value={form.linkType} onChange={e => put("linkType", e.target.value as MarketingForm["linkType"])}><option value="tracking_link">Обычная отслеживаемая ссылка</option><option value="free_trial">Бесплатный пробный период</option></select></Field>
        {form.linkType === "free_trial" && <Field label="Дней бесплатного доступа"><input className={field} type="number" min={1} max={360} required value={form.trialDays} onChange={e => put("trialDays", e.target.value)} /></Field>}
      </>}
      {(form.action === "tags_add" || form.action === "tags_remove") && <Field label="Теги — по одному на строку"><textarea className={field} rows={4} required value={form.tags} onChange={e => put("tags", e.target.value)} /></Field>}
      {pixel && <>
        <Field label="Название пикселя"><input className={field} maxLength={100} value={form.name} onChange={e => put("name", e.target.value)} /></Field>
        {form.action === "pixel_create" && <Field label="Платформа"><select className={field} value={form.platform} onChange={e => put("platform", e.target.value as MarketingForm["platform"])}>{["meta", "snapchat", "tiktok", "creatortraffic"].map(platform => <option key={platform}>{platform}</option>)}</select></Field>}
        <Field label="ID пикселя на рекламной платформе"><input className={field} required={form.action === "pixel_create" && form.platform !== "creatortraffic"} maxLength={255} value={form.platformPixelId} onChange={e => put("platformPixelId", e.target.value)} /></Field>
        <Field label={form.action === "pixel_create" ? "Токен доступа" : "Новый токен доступа — оставьте пустым, чтобы сохранить текущий"}><input className={field} type="password" autoComplete="new-password" required={form.action === "pixel_create"} maxLength={16000} value={form.token} onChange={e => put("token", e.target.value)} /></Field>
        <Field label="URL источника событий, если нужен"><input className={field} type="url" disabled={form.clearEventSourceUrl} value={form.eventSourceUrl} onChange={e => put("eventSourceUrl", e.target.value)} /></Field>
        {form.action==="pixel_update" && <label className="flex items-start gap-2 text-sm text-text-secondary"><input type="checkbox" checked={form.clearEventSourceUrl} onChange={e=>put("clearEventSourceUrl",e.target.checked)} />Удалить сохранённый URL источника событий</label>}
        <details><summary className="cursor-pointer text-sm text-text-secondary">Названия событий на рекламной платформе</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{eventFields.map(key => <Field key={key} label={eventLabels[key]!}><input className={field} maxLength={100} value={form.events[key] ?? ""} onChange={e => put("events", { ...form.events, [key]: e.target.value })} /></Field>)}</div></details>
        {form.action === "pixel_update" && <p className="rounded-lg bg-hover p-3 text-sm text-text-secondary">Изменяется общий пиксель. Отправятся только изменённые поля. Очистка заполненного названия события удалит это значение. Сервер покажет связанные ссылки до подтверждения.</p>}
      </>}
      {form.action === "pixel_test" && <>
        <p className="text-sm text-text-secondary">Провайдер отправит реальное тестовое событие в рекламную систему. Оно не подтверждает полноту сбора или рабочую атрибуцию.</p>
        <Field label="Тестовое событие"><select className={field} value={form.testEvent} onChange={e => put("testEvent", e.target.value)}>{["event_click", "event_new_subscriber_free", "event_new_subscriber_paid", "event_first_transaction", "event_new_transaction", "event_message_received_from_fan", "event_fan_sent_1_message", "event_fan_sent_3_messages"].map(key => <option key={key} value={key}>{eventLabels[key] ?? key}</option>)}</select></Field>
        <Field label="Код тестового события, если нужен"><input className={field} maxLength={100} value={form.testCode} onChange={e => put("testCode", e.target.value)} /></Field>
      </>}
      {postback && <>
        <p className="text-sm text-text-secondary">URL может содержать переменные провайдера. Секретные значения не загружаются в редактор и не показываются в истории.</p>
        <Field label="Полный URL получателя или шаблон URL"><input className={field} required maxLength={4000} autoComplete="off" value={form.url} onChange={e => put("url", e.target.value)} /></Field>
        <Field label="Метод"><select className={field} value={form.method} onChange={e => put("method", e.target.value as "GET" | "POST")}><option>POST</option><option>GET</option></select></Field>
        <Field label="Охват"><select className={field} value={form.scope} onChange={e => put("scope", e.target.value as MarketingForm["scope"])}><option value="campaign_specific">Выбранные Smart Links</option><option value="global">Все Smart Links команды</option></select></Field>
        {form.scope === "campaign_specific" && <fieldset className="space-y-2 rounded-lg border border-border p-3"><legend className="px-1 text-sm">Ссылки</legend>{links.map(link => <label key={link.id} className="flex gap-2 text-sm"><input type="checkbox" checked={form.linkIds.includes(link.id)} onChange={e => put("linkIds", toggle(form.linkIds, link.id, e.target.checked))} />{link.name ?? link.id}</label>)}{!links.length && <p className="text-sm text-text-muted">Сначала соберите список Smart Links.</p>}{form.linkIds.filter(id => !links.some(link => link.id === id)).map(id => <label key={id} className="flex gap-2 break-all text-xs"><input type="checkbox" checked onChange={() => put("linkIds", form.linkIds.filter(value => value !== id))} />{id} · сохранённая ссылка вне текущего списка</label>)}</fieldset>}
        <fieldset className="space-y-2"><legend className="mb-2 text-sm text-text-secondary">Когда отправлять</legend>{conversionTypes.map(type => <label key={type} className="flex gap-2 text-sm"><input type="checkbox" checked={form.conversions.includes(type)} onChange={e => put("conversions", toggle(form.conversions, type, e.target.checked))} />{eventLabels[type]}</label>)}</fieldset>
        <Field label="Шаблон тела запроса"><textarea className={field} disabled={form.clearBody} rows={3} maxLength={16000} autoComplete="off" value={form.body} onChange={e => put("body", e.target.value)} /></Field>
        <fieldset disabled={form.clearHeaders} className="space-y-2"><legend className="mb-2 text-sm text-text-secondary">Заголовки запроса</legend>{form.headers.map((header, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><input aria-label={`Имя заголовка ${index + 1}`} className={field} required placeholder="Authorization" value={header.name} onChange={e => put("headers", form.headers.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} /><input aria-label={`Значение заголовка ${index + 1}`} className={field} type="password" autoComplete="new-password" value={header.value} onChange={e => put("headers", form.headers.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} /><button className={button} type="button" onClick={() => put("headers", form.headers.filter((_, i) => i !== index))}>Убрать</button></div>)}<button type="button" className={button} disabled={form.headers.length >= 30} onClick={() => put("headers", [...form.headers, { name: "", value: "" }])}>Добавить заголовок</button></fieldset>
        {form.action==="postback_update" && <div className="space-y-2 text-sm text-text-secondary"><label className="flex items-start gap-2"><input type="checkbox" checked={form.clearBody} onChange={e=>put("clearBody",e.target.checked)} />Удалить сохранённое тело запроса</label><label className="flex items-start gap-2"><input type="checkbox" checked={form.clearHeaders} onChange={e=>put("clearHeaders",e.target.checked)} />Удалить все сохранённые заголовки</label></div>}
        {form.action === "postback_update" && <p className="text-xs text-text-muted">Без отметок удаления пустое тело и отсутствие заголовков сохранят текущие значения. Если указать заголовки, передайте весь нужный набор заново. Полный URL требуется заново.</p>}
      </>}
      {removal && <p className="text-sm text-text-secondary">{form.action === "pixel_disconnect" ? "Пиксель будет отключён только от этой ссылки. Остальные подключения сохранятся." : "Удаление изменяет объект у провайдера. Перед выполнением проверьте цель в следующем окне."}</p>}
      <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className={primary} disabled={busy}>{busy ? "Готовим…" : "Проверить действие"}</button></div>
    </form>
  </ModalShell>;
}

export function MarketingIntentReview({ intent, busy, error, onDispatch, onClose }: { intent: MarketingIntent; busy: boolean; error: string; onDispatch: (shared: boolean, external: boolean) => void; onClose: () => void }) {
  const [shared, setShared] = useState(false); const [external, setExternal] = useState(false);
  const needsShared = !intent.preview.affectedLinksComplete;
  return <ModalShell title={actionLabels[intent.action as MarketingForm["action"]] ?? intent.action} onClose={onClose}>
    <div className="space-y-4 text-sm text-text-secondary">
      {error && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-700">{error}</p>}
      <p>{intent.preview.effect}</p>
      <p>{intent.preview.pageId ? <>Страница: <strong>{intent.preview.pageLabel ?? intent.preview.pageId}</strong> · ID {intent.preview.pageId} · аккаунт {intent.preview.accountId}</> : "Настройка команды; не ограничена выбранной на экране страницей."}</p>
      {!!intent.preview.values.length && <dl className="space-y-2 rounded-lg border border-border p-3">{intent.preview.values.map(item=><div key={item.field}><dt className="text-xs text-text-muted">{marketingPreviewFieldLabels[item.field]}</dt><dd className="break-all font-medium">{marketingPreviewValue(item)}</dd></div>)}</dl>}
      {intent.preview.targetId && <p className="break-all">Объект: <strong>{intent.preview.targetId}</strong></p>}
      {!!intent.preview.changedFields.length && <p>Изменяемые поля: {intent.preview.changedFields.join(", ")}</p>}
      {!!intent.preview.conversionTypes.length && <p>События: {intent.preview.conversionTypes.map(type => eventLabels[type] ?? type).join(", ")}</p>}
      {intent.preview.scope && <p>Охват: {intent.preview.scope === "global" ? "Все Smart Links команды" : "Выбранные ссылки"}</p>}
      {intent.preview.destination && <p className="break-all">Получатель: <strong>{intent.preview.destination}</strong></p>}
      <p>Оценка: {intent.preview.estimatedCredits} кр. Фактический расход будет записан по ответу провайдера.</p>
      {!!intent.preview.affectedLinkIds.length && <div><p className="font-medium">Затронутые ссылки:</p><ul className="mt-1 list-inside list-disc break-all text-xs">{intent.preview.affectedLinkIds.map(id => <li key={id}>{id}</li>)}</ul></div>}
      {!intent.preview.affectedLinksComplete && <p className="rounded-lg border border-amber-500/40 p-3 text-amber-700">Список затронутых ссылок может быть неполным: текущие данные или права ключа не подтверждают весь охват.</p>}
      {!!intent.preview.templateVariables.length && <p>Переменные: {intent.preview.templateVariables.join(", ")}</p>}
      {!!intent.preview.headerNames.length && <p>Заголовки: {intent.preview.headerNames.join(", ")}. Значения скрыты.</p>}
      {needsShared && <label className="flex items-start gap-2"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />{intent.action === "pixel_update" ? "Подтверждаю изменение общего пикселя для связанных ссылок." : "Подтверждаю изменение передачи событий с указанным охватом, включая ссылки вне текущего списка."}</label>}
      {intent.preview.externalTest && <label className="flex items-start gap-2"><input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} />Подтверждаю отправку тестового события во внешнюю рекламную систему.</label>}
      <div className="flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>Закрыть</button><button type="button" className={primary} disabled={busy || (needsShared && !shared) || (intent.preview.externalTest && !external)} onClick={() => onDispatch(shared, external)}>{busy ? "Отправляем…" : "Подтвердить и выполнить"}</button></div>
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
  return <div className="max-w-7xl space-y-5 px-4 pb-12 pt-4 md:px-0 md:pt-0">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-extrabold text-text-primary">Ссылки OnlyFans</h1><p className="mt-1 max-w-3xl text-sm text-text-secondary">Tracking- и trial-ссылки страниц: клики, фаны и деньги чистыми — после комиссии OnlyFans. Данные — из ряда ссылок Hub, он собирается четыре раза в сутки; экран к провайдеру не обращается.</p></div><Link className="text-sm font-medium text-accent" to="/settings?tab=collection">Управление сбором</Link></header>
    <div className="flex flex-wrap items-end gap-3">
      <Field label="OF-страница"><select disabled={busy || !pages.length} className={field} value={page?.pageLabel ?? ""} onChange={e => selectPage(e.target.value)}>{pages.map(row => <option key={row.pageId} value={row.pageLabel}>{row.pageLabel}</option>)}</select></Field>
      <button className={button} disabled={busy} onClick={() => void run(async () => {}, "Данные обновлены из базы Hub. Запросов к провайдеру не было.")}>Обновить</button>
      {links.data && <span className="pb-2 text-xs text-text-muted">Прочитано {moscowDateTime(links.data.generatedAt)} МСК · обновляется раз в 5 минут</span>}
    </div>
    {(error || links.error) && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-700">{error || links.error?.message}</p>}
    {links.isPending && <p role="status" className="text-sm text-text-muted">Загружаем ряд ссылок…</p>}
    {links.isError && links.data && <p className="text-sm text-warning-dark">Показаны предыдущие данные. Обновите экран, чтобы проверить текущее состояние.</p>}
    {links.data && !links.isError && !pages.length && <p className="text-sm text-text-muted">Нет активных OF-страниц.</p>}
    {notice && <p role="status" className="rounded-lg bg-hover p-3 text-sm text-text-primary">{notice}</p>}
    {warnings.length > 0 && <div role="alert" className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-800" data-of-links="warnings">{warnings.map(line => <p key={line}>{line}</p>)}</div>}
    {page && <section className={`${card} space-y-4`} aria-labelledby="of-links-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="of-links-title" className="font-semibold">Ссылки страницы {page.pageLabel}</h2>
        <nav className="flex flex-wrap gap-2" aria-label="Какие ссылки показать">{linkFilters.map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} className={filter === id ? primary : button} onClick={() => setFilter(id)}>{label} · {filterLinks(pageLinks, id).length}</button>)}</nav>
      </div>
      {shownLinks.length > 0 && <p className="text-sm text-text-secondary" data-of-links="totals">Показано {shownLinks.length} · клики {count(totals.clicks)} · фаны {count(totals.fans)} · OFAPI {usd(totals.vendorMills)} чистыми{totals.unknownMoney > 0 ? ` (у ${totals.unknownMoney} — сумма неизвестна)` : ""}</p>}
      {!pageLinks.length && <p className="text-sm text-text-muted">{page.kinds.some(kind => kind.lastUsableAt !== null) ? "В ряду нет ссылок этой страницы." : "Ряд ссылок этой страницы ещё не собирался."}</p>}
      {pageLinks.length > 0 && !shownLinks.length && <p className="text-sm text-text-muted">Таких ссылок нет.</p>}
      {shownLinks.length > 0 && <OfLinksTable links={shownLinks} now={now} />}
      <p className="text-xs text-text-muted">Фаны: у trial-ссылок — активации пробного периода (claims), у tracking — подписчики. «OFAPI» — расчёт провайдера по подпискам с этой ссылки; он бывает пересчитан задним числом. «Hub» — собственный расчёт Hub по журналу транзакций с даты, когда Hub начал видеть фанов ссылки. Обе суммы — чистыми, после комиссии OnlyFans.</p>
    </section>}
    <section className={`${card} space-y-4`} aria-labelledby="smart-links-title" data-smart-links={smartOpen ? "open" : "closed"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 id="smart-links-title" className="font-semibold">Smart Links</h2><p className="mt-1 text-sm text-text-secondary">{data.data && !smartLinksHaveData(data.data) ? "Не используются: нет ни ссылок, ни пикселей, ни postbacks, ни действий." : "Ссылки, пиксели и postbacks провайдера и история действий с ними."}</p></div>
        <button type="button" className={button} aria-expanded={smartOpen} onClick={() => setSmartToggle(!smartOpen)}>{smartOpen ? "Скрыть" : "Показать"}</button>
      </div>
      {data.error && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-700">Smart Links не прочитаны: {data.error.message}</p>}
      {smartOpen && <>
        <p className="text-sm text-text-secondary">Окно атрибуции — 6 часов. Эти суммы не прибавляются к финансовому журналу Hub.</p>
        {data.isPending && <p role="status" className="text-sm text-text-muted">Загружаем сохранённые данные Smart Links…</p>}
        {data.isError && data.data && <p className="text-sm text-warning-dark">Показаны предыдущие данные. Обновите экран, чтобы проверить текущее состояние.</p>}
        <nav className="flex flex-wrap gap-2" aria-label="Данные Smart Links">{([ ["links", "Ссылки и пиксели"], ["postbacks", "Postbacks"], ["analytics", "Результаты"], ["history", "История действий"] ] as const).map(([id, label]) => <button type="button" aria-pressed={tab === id} key={id} className={tab === id ? primary : button} onClick={() => setTab(id)}>{label}</button>)}</nav>
        {tab === "links" && <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Smart Links этой страницы</h3><button className={button} disabled={!pageId || busy} onClick={() => edit("smart_link_create")}>Создать ссылку</button></div>
          {data.data && !data.isError && pageId > 0 && !smartLinks.length && <p className="text-sm text-text-muted">Ссылок в сохранённых данных пока нет. Запустите ограниченный сбор ниже или создайте ссылку.</p>}
          {smartLinks.map(link => <article key={link.id} className="space-y-3 border-t border-border-light pt-4"><div className="flex flex-wrap justify-between gap-2"><div><h4 className="font-semibold text-text-primary">{link.name ?? link.id}</h4><p className="break-all text-xs text-text-muted">{link.id} · {link.linkType} · сохранено {new Date(link.observedAt).toLocaleString()}</p></div><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => edit("tags_add", link)}>Добавить теги</button><button className={button} disabled={busy || !link.tags.length} onClick={() => edit("tags_remove", link)}>Снять теги</button><button className={button} disabled={busy} onClick={() => edit("pixel_create", link)}>Подключить пиксель</button><button className={`${button} text-red-700`} disabled={busy} onClick={() => edit("smart_link_delete", link)}>Удалить</button></div></div>
            {link.publicUrl && <a className="inline-block max-w-full break-all text-sm text-accent underline" href={link.publicUrl} target="_blank" rel="noreferrer">{link.publicUrl}</a>}
            <p className="text-sm text-text-secondary">Клики {value(link.clicks)} · Подписки {value(link.subscribers)} · Платящие {value(link.spenders)} · Доход {money(link.revenueMills)} ({link.revenueBasis})</p>
            {!!link.tags.length && <div className="flex flex-wrap gap-1.5">{link.tags.map(tag => <span key={tag} className="rounded bg-hover px-2 py-1 text-xs">{tag}</span>)}</div>}
            {link.cost && <p className="text-xs text-text-muted">Расход кампании по настройкам провайдера: {value(link.cost.inputValue)} {value(link.cost.currency)} · {value(link.cost.inputMode)}. Это не фактическое списание из банка.</p>}
            {pixels.filter(pixel => pixel.parentId === link.id && pixel.pageId===link.pageId).map(pixel => <div key={pixel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-hover p-3"><div className="text-sm"><strong>{pixel.name ?? pixel.platform}</strong><p className="text-xs text-text-muted">{pixel.platform} · ID платформы {pixel.platformPixelId} · {value(pixel.status)}</p></div><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => edit("pixel_update", pixel)}>Изменить</button><button className={button} disabled={busy || !marketingPixelCanTest(pixel.platform)} title={!marketingPixelCanTest(pixel.platform) ? "CreatorTraffic не поддерживает тестовые события" : undefined} onClick={() => edit("pixel_test", pixel)}>Тест</button>{!marketingPixelCanTest(pixel.platform) && <span className="text-xs text-text-muted">CreatorTraffic не поддерживает тестовые события</span>}<button className={button} disabled={busy} onClick={() => edit("pixel_disconnect", pixel)}>Отключить от ссылки</button></div></div>)}
          </article>)}
        </div>}
        {tab === "postbacks" && <div className="space-y-4"><div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">Postbacks команды</h3><p className="mt-1 text-xs text-text-muted">Глобальные настройки могут охватывать несколько страниц. Секретные шаблоны и значения заголовков скрыты.</p></div><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => { await marketingActions.postbacks({}); setNotice("Список postbacks прочитан у провайдера."); })}>Прочитать у провайдера</button><button className={button} disabled={busy} onClick={() => edit("postback_create")}>Создать postback</button></div></div>
          {data.data && !data.isError && !postbacks.length && <p className="text-sm text-text-muted">Сохранённого списка пока нет.</p>}{postbacks.map(row => <article key={row.id} className="space-y-2 border-t border-border-light pt-4"><div className="flex flex-wrap justify-between gap-3"><h4 className="font-medium">{row.httpMethod} {row.destination ?? `Postback ${row.id}`}</h4><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => edit("postback_update", row)}>Изменить</button><button className={`${button} text-red-700`} disabled={busy} onClick={() => edit("postback_delete", row)}>Удалить</button></div></div><p className="text-sm text-text-secondary">{row.scope === "global" ? "Все Smart Links команды" : `${row.linkIds.length} выбранных ссылок`} · {row.conversionTypes.map(type => eventLabels[type] ?? type).join(", ")}</p><p className="text-xs text-text-muted">Переменные: {row.templateVariables.join(", ") || "нет"}. Заголовки: {row.headerNames.join(", ") || "нет"}. Сохранено {new Date(row.observedAt).toLocaleString()}.</p></article>)}
        </div>}
        {tab === "analytics" && <div className="space-y-4">
          <h3 className="font-semibold">Сохранённые результаты</h3>
          <p className="text-sm text-text-secondary">
            Доход относится к атрибуции ссылки. Клики, повторные клики, боты, органика и прошлые подписки сохраняют собственные признаки.
          </p>
          {data.data && !data.isError && pageId > 0 && !data.data.analytics.some(row => row.pageId === pageId) &&
            <p className="text-sm text-text-muted">Выберите нужный отчёт и выполните ограниченный сбор ниже.</p>}
          {data.data?.analytics.filter(row => row.pageId === pageId).map((snapshot, index) =>
            <article key={`${snapshot.operation}:${snapshot.linkId}:${index}`} className="space-y-2 border-t border-border-light pt-4">
              <h4 className="text-sm font-medium">
                {snapshot.linkId} · {snapshot.operation.replace(/^ofapi_read_/, "").replaceAll("_", " ")}
              </h4>
              <p className="text-xs text-text-muted">
                {stateLabels[snapshot.coverage.state]}{
                  snapshot.coverage.reason ? ` · ${snapshot.coverage.reason}` : ""
                } · {new Date(snapshot.observedAt).toLocaleString()} · окно {
                  snapshot.window.from ?? "не указано"
                } — {snapshot.window.to ?? "не указано"}{
                  snapshot.requestedRevenueBasis ? ` · запрошено ${snapshot.requestedRevenueBasis}` : ""
                }
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      {["Период / фан", "Клики", "Подписки", "Платящие", "Доход", "Признаки / метрика"].map(label =>
                        <th key={label} className="p-2 font-medium text-text-muted">{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.rows.map((row, i) => {
                      const amount = marketingDisplayMoney(row);
                      return <tr key={i} className="border-t border-border-light">
                        <td className="p-2">{row.timestamp ?? row.occurredAt ?? row.username ?? row.fanId ?? row.period ?? "Итог"}</td>
                        <td className="p-2">{value(row.clicks)}</td>
                        <td className="p-2">{value(row.subscribers)}</td>
                        <td className="p-2">{value(row.spenders)}</td>
                        <td className="p-2">{money(amount.mills)} · {amount.basis ?? "—"}</td>
                        <td className="p-2">
                          {[
                            row.conversionType,
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
            <h3 className="font-semibold">История действий всех страниц</h3>
            <button
              className={button}
              disabled={busy}
              onClick={() => void run(async () => {
                await marketingActions.rebuild();
                setNotice(
                  "Локальное восстановление начато. Незавершённые действия показаны в истории; обработка продолжится при обновлении экрана. Запросов к провайдеру не было."
                );
              })}
            >Восстановить из сохранённых ответов</button>
          </div>
          {data.data && !data.isError && !data.data.intents.length &&
            <p className="text-sm text-text-muted">Действий пока нет.</p>}
          {data.data?.intents.map(intent =>
            <article key={intent.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3">
              <div>
                <h4 className="text-sm font-medium">{actionLabels[intent.action as MarketingForm["action"]] ?? intent.action}</h4>
                <p className="text-sm text-text-secondary">
                  {stateLabels[intent.state] ?? intent.state}{intent.errorCode ? ` · ${intent.errorCode}` : ""}
                </p>
                {intent.remoteId && <p className="break-all text-xs text-text-secondary">ID у провайдера: {intent.remoteId}</p>}
                {intent.state === "succeeded" && (intent.accountingState === "pending" || intent.projectionState === "pending") &&
                  <p className="text-xs text-amber-700">
                    Действие подтверждено; {intent.accountingState === "pending" ? "учёт расхода" : ""}{
                      intent.accountingState === "pending" && intent.projectionState === "pending" ? " и " : ""
                    }{
                      intent.projectionState === "pending" ? "обновление сохранённых данных" : ""
                    } ещё восстанавливается.
                  </p>}
                <p className="text-xs text-text-muted">
                  {intent.preview.pageId
                    ? `Страница ${intent.preview.pageLabel ?? intent.preview.pageId} · ${intent.preview.accountId}`
                    : "Настройки команды"} · {new Date(intent.createdAt).toLocaleString()} · {intent.id}
                </p>
              </div>
              {intent.state === "prepared" &&
                <button className={button} disabled={busy} onClick={() => setReview(intent)}>Проверить и подтвердить</button>}
            </article>)}
        </div>}
      </>}
    </section>
    <details className={card}><summary className="cursor-pointer font-semibold">Собрать данные по выбранной странице</summary><p className="mt-3 text-sm text-text-secondary">Разовый сбор у провайдера: сохранённые и общие списки ссылок, сведения и списки по одной ссылке, Smart Links. Он не меняет расписание, сохраняет шаги и останавливается на указанных лимитах. Общая пауза фонового сбора действует и здесь.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Что собрать"><select className={field} value={selection} onChange={e => { setSelection(e.target.value); setPickedLink(null); }}>{readSelections.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      {perLink && <Field label="Ссылка"><select required className={field} value={selectedLink} onChange={e => setPickedLink({ pageId, selection, id: e.target.value })}><option value="">Выберите ссылку</option>{selectableLinks.map(link => <option key={link.id} value={link.id}>{link.name ?? link.id}{link.name ? ` · ${link.id}` : ""}</option>)}</select></Field>}
      <Field label="С даты (UTC)"><input className={field} type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="По дату включительно (UTC)"><input className={field} type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
      <Field label="Не более запросов"><input className={field} type="number" min={1} max={100} value={calls} onChange={e => setCalls(Number(e.target.value))} /></Field><Field label="Не более кредитов"><input className={field} type="number" min={1} max={100} value={credits} onChange={e => setCredits(Number(e.target.value))} /></Field>
    </div><div className="mt-4 flex flex-wrap items-center gap-3"><button className={button} disabled={busy || !pageId || !collection.data || (perLink && !selectedLink) || !Number.isInteger(calls) || calls < 1 || calls > 100 || !Number.isInteger(credits) || credits < 1 || credits > 100 || !from || !to || from > to} onClick={() => void run(async () => { if (perLink && effectivePickedLink(pickedLink, { pageId, selection, links: selectableLinks }) === "") throw new Error("Выберите ссылку этой страницы."); await marketingActions.collect({ pageId, category: selection.startsWith("smart_") ? "smart_links" : "tracking_links", expectedRevision: collection.data!.revision, maxCalls: calls, maxCredits: credits, maxBytes: 4 * 1024 * 1024, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, selection: [`${selection}${perLink ? `:${selectedLink}` : ""}`] }); setNotice("Ограниченный сбор поставлен в очередь. Состояние и возобновление — на экране управления сбором."); })}>Запустить один сбор</button><span className="text-xs text-text-muted">До 4 МиБ ответа; общие ограничения расхода продолжают действовать.</span></div></details>
    {form && <MarketingEditor form={form} setForm={setForm} links={allLinks} busy={busy} error={error} onClose={() => { if (!busy) setForm(null); }} onPrepare={() => void run(prepare)} />}
    {review && <MarketingIntentReview key={review.id} intent={review} busy={busy} error={error} onClose={() => { if (!busy) setReview(null); }} onDispatch={(shared, external) => void run(async () => { const result = await marketingActions.dispatch(review.id, { acknowledgeSharedImpact: shared, acknowledgeExternalTest: external }); setReview(null); setSmartToggle(true); setTab("history"); setNotice(stateLabels[result.state] ?? result.state); })} />}
  </div>;
}
