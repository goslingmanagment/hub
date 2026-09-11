import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { ofapiPageHref, resolveOfapiPage } from "@/lib/ofapiNavigation";
import type { OfapiMarketingResource } from "@agency_hub_core/contracts";
import { useAdminOfapiCollection } from "@/api/adminOfapiCollection";
import { useAuthMe } from "@/api/queries";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";
import { acknowledgeCaptureCustody, clearCaptureCustody, readCaptureCustody, saveCaptureCustody, type OfapiCaptureCustody } from "@/lib/ofapiCaptureCustody";
import { clearEvidenceCustody, readEvidenceCustody, saveEvidenceCustody, type PendingOfapiEvidence } from "@/lib/ofapiEvidenceCustody";
import { marketingActions, useOfapiMarketing, type MarketingIntent } from "@/api/ofapiMarketing";
import { ModalShell } from "@/components/shared/ModalShell";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { actionLabels, createMarketingPreparation, marketingFailureUncertain, marketingMatches, conversionTypes, eventFields, eventLabels, newMarketingForm, marketingDisplayMoney, marketingFlag, marketingPixelCanTest, marketingPreviewFieldLabels, marketingPreviewValue, type MarketingForm } from "./marketing/marketingForm.js";

const field = "min-h-10 min-w-0 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-2";
const button = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary hover:bg-hover focus-visible:outline-2 disabled:opacity-40";
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

function MarketingEditor({ form, setForm, links, busy, frozen, targetLabel, error, onPrepare, onClose }: {
  form: MarketingForm; setForm: (form: MarketingForm) => void; links: OfapiMarketingResource[]; busy: boolean; frozen: boolean; targetLabel: string; error: string; onPrepare: () => void; onClose: () => void;
}) {
  const put = <K extends keyof MarketingForm>(key: K, value: MarketingForm[K]) => setForm({ ...form, [key]: value });
  const pixel = form.action === "pixel_create" || form.action === "pixel_update";
  const postback = form.action === "postback_create" || form.action === "postback_update";
  const removal = ["smart_link_delete", "pixel_disconnect", "postback_delete"].includes(form.action);
  return <ModalShell title={actionLabels[form.action]} onClose={onClose}>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); onPrepare(); }}>
      {error && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-700">{error}</p>}
      <p className="break-all text-sm font-medium">{form.action.startsWith("postback_") ? "Настройка всей команды" : `Страница: ${targetLabel}`}</p>
      {frozen && <p className="text-sm text-warning">Ответ подготовки не подтверждён. Сохранены исходные поля и идентификатор; повтор восстанавливает то же действие.</p>}
      <fieldset className="space-y-4" disabled={busy || frozen}>
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
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>{frozen ? "Свернуть" : "Закрыть черновик"}</button><button type="submit" className={primary} disabled={busy}>{busy ? "Готовим…" : frozen ? "Восстановить подготовленное действие" : "Проверить действие"}</button></div>
    </form>
  </ModalShell>;
}

export function MarketingIntentReview({ intent, busy, error, recovering = false, onDispatch, onClose }: { intent: MarketingIntent; busy: boolean; error: string; recovering?: boolean; onDispatch: (shared: boolean, external: boolean) => void; onClose: () => void }) {
  const [shared, setShared] = useState(false); const [external, setExternal] = useState(false);
  const needsShared = !intent.preview.affectedLinksComplete;
  return <ModalShell title={actionLabels[intent.action as MarketingForm["action"]] ?? intent.action} onClose={onClose}>
    <div className="space-y-4 text-sm text-text-secondary">
      {error && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-700">{error}</p>}
      <p role="status">Состояние: {stateLabels[intent.state] ?? intent.state} · {intent.id}</p>
      <p>{actionLabels[intent.action as MarketingForm["action"]] ?? intent.preview.effect}</p>
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
      {recovering && <p role="status" className="text-warning">Ответ прежней отправки не подтверждён. Сохранено то же действие. Запрос с этим ID вернёт его состояние либо выполнит его один раз, если отправка ещё не началась.</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onClose}>{recovering ? "Свернуть" : "Закрыть"}</button><button type="button" className={primary} disabled={busy || (!recovering && intent.state !== "prepared") || (needsShared && !shared) || (intent.preview.externalTest && !external)} onClick={() => onDispatch(shared, external)}>{busy ? "Отправляем…" : recovering ? "Запросить исход того же действия" : "Подтвердить и выполнить"}</button></div>
      <p className="text-xs text-text-muted">При неизвестном результате действие не отправляется повторно автоматически. Его состояние останется в истории.</p>
    </div>
  </ModalShell>;
}

export function OfapiMarketing() {
  const data = useOfapiMarketing(); const collection = useAdminOfapiCollection();
  const ownerId = useAuthMe().data?.user.id;
  const [search, setSearch] = useSearchParams();
  const requestedPage = search.get("page");
  const selectedPage = resolveOfapiPage(collection.data?.pages, requestedPage);
  const pageId = selectedPage?.id ?? 0;
  const requestedTab = search.get("tab");
  const tab = ["links", "postbacks", "analytics", "history"].includes(requestedTab ?? "") ? requestedTab! : "links";
  function selectPage(label: string, replace = false) {
    if (requestedPage === label) return;
    const next = new URLSearchParams(search); next.set("page", label); setSearch(next, { replace });
  }
  function setTab(tab: string) {
    if (search.get("tab") === tab) return;
    const next = new URLSearchParams(search); next.set("tab", tab); setSearch(next);
  }
  useEffect(() => {
    if (requestedPage === null && selectedPage) selectPage(selectedPage.label, true);
  }, [requestedPage, selectedPage?.label]);
  type CollectPreview = { body: Parameters<typeof marketingActions.collect>[0]; pageLabel: string; unknown: boolean; jobId: string | null; record: OfapiCaptureCustody | null };
  type Workspace = { form: MarketingForm | null; review: MarketingIntent | null; preparing: ReturnType<typeof createMarketingPreparation> | null; busy: boolean; notice: string; error: string; collectPreview: CollectPreview | null; custodyError: string; captureHistory: OfapiCaptureCustody[]; dispatchPending: PendingOfapiEvidence | null; intentStorageError: string };
  const [workspace, setWorkspace, readWorkspace] = useSessionWorkspace<Workspace>("ofapi-marketing", () => {
    const saved = readCaptureCustody(ownerId, "marketing");
    const dispatch = readEvidenceCustody(ownerId, "marketing");
    return { form: null, review: dispatch.request?.kind === "marketing" ? dispatch.request.intent : null, preparing: null, busy: false, notice: "", error: "", collectPreview: saved.record?.kind === "marketing" ? { body: saved.record.body, pageLabel: saved.record.pageLabel, unknown: true, jobId: null, record: saved.record } : null, custodyError: saved.error, captureHistory: saved.history, dispatchPending: dispatch.request, intentStorageError: dispatch.error };
  });
  const { form, review, preparing, busy, notice, error, collectPreview } = workspace;
  const setForm = (form: MarketingForm | null) => setWorkspace(current => ({ ...current, form }));
  const setReview = (review: MarketingIntent | null) => setWorkspace(current => ({ ...current, review }));
  const setPreparing = (preparing: Workspace["preparing"]) => setWorkspace(current => ({ ...current, preparing }));
  const setBusy = (busy: boolean) => setWorkspace(current => ({ ...current, busy }));
  const setNotice = (notice: string) => setWorkspace(current => ({ ...current, notice }));
  const setError = (error: string) => setWorkspace(current => ({ ...current, error }));
  const setCollectPreview = (collectPreview: CollectPreview | null) => setWorkspace(current => ({ ...current, collectPreview }));
  const [editorOpen, setEditorOpen] = useState(false);
  const [reviewCollapsed, setReviewCollapsed] = useState(false);
  useEffect(() => { setReviewCollapsed(false); }, [review?.id]);
  const [allowNewCapture, setAllowNewCapture] = useState(false);
  const inFlight = useRef(false);
  const [selection, setSelection] = useState("smart_links"); const [selectedLink, setSelectedLink] = useState("");
  const [calls, setCalls] = useState(5); const [credits, setCredits] = useState(10);
  const [from, setFrom] = useState(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(() => {
    setSelectedLink("");
  }, [pageId]);
  useEffect(() => {
    if (review && !busy) {
      const latest = data.data?.intents.find(intent => intent.id === review.id);
      if (latest && latest.state !== review.state) setReview(latest);
      if (latest && ["succeeded", "rejected", "indeterminate"].includes(latest.state) && workspace.dispatchPending) {
        clearEvidenceCustody(ownerId, workspace.dispatchPending); setWorkspace(current => ({ ...current, dispatchPending: null }));
      }
    }
  }, [data.data, busy, review?.id, review?.state]);
  const resources = data.data?.resources ?? []; const allLinks = resources.filter(row => row.kind === "smart_link");
  const links = allLinks.filter(row => row.pageId === pageId); const pixels = resources.filter(row => row.kind === "pixel");
  const postbacks = resources.filter(row => row.kind === "postback");
  async function run(action: () => Promise<void>) {
    if (inFlight.current || readWorkspace().busy) return;
    inFlight.current = true;
    setBusy(true); setNotice(""); setError("");
    try { await action(); await data.refetch(); await collection.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : "Действие не выполнено"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const edit = (action: MarketingForm["action"], resource?: OfapiMarketingResource) => { if (readWorkspace().busy || inFlight.current || form || preparing || review || !data.data || data.isError || collection.isError) return; setError(""); setForm(newMarketingForm(action, resource?.pageId ?? pageId, resource)); setEditorOpen(true); };
  async function prepare() {
    if (!form) return;
    const pending = preparing ?? createMarketingPreparation(form, crypto.randomUUID());
    setPreparing(pending);
    try { const intent = await marketingActions.prepare(pending); setForm(null); setPreparing(null); setEditorOpen(false); setReview(intent); }
    catch (reason) { if (!marketingFailureUncertain(reason)) setPreparing(null); throw reason; }
  }
  const perLink = !inventorySelections.has(selection);
  const legacyLinks = resources.filter(row => (row.kind === "tracking" || row.kind === "trial") && row.pageId === pageId);
  const selectableLinks = selection.startsWith("smart_") ? links : legacyLinks.filter(row => !row.shared && row.kind === (selection.startsWith("trial_") ? "trial" : "tracking"));
  const term = search.get("q") ?? "";
  const kind = ["smart_link", "tracking", "trial"].includes(search.get("kind") ?? "") ? search.get("kind")! : "all";
  const historyState = ["prepared", "dispatching", "succeeded", "rejected", "indeterminate"].includes(search.get("historyState") ?? "") ? search.get("historyState")! : "all";
  const historyScope = search.get("historyScope") === "page" ? "page" : "team";
  function filter(key: string, value: string) { const next = new URLSearchParams(search); value ? next.set(key, value) : next.delete(key); setSearch(next, { replace: key === "q" }); }
  const matchResource = (row: OfapiMarketingResource) => marketingMatches(term, row.name, row.id, row.publicUrl, row.tags.join(" "), row.destination, row.platformPixelId);
  const visibleLinks = kind === "all" || kind === "smart_link" ? links.filter(matchResource) : [];
  const visibleLegacy = legacyLinks.filter(row => (kind === "all" || row.kind === kind) && matchResource(row));
  const visiblePostbacks = postbacks.filter(matchResource);
  const analytics = data.data?.analytics.filter(row => row.pageId === pageId) ?? [];
  const visibleAnalytics = analytics.filter(row => marketingMatches(term, row.linkId, row.operation, JSON.stringify(row.rows)));
  const intents = data.data?.intents ?? [];
  const visibleIntents = intents.filter(intent => (historyScope === "team" || intent.preview.pageId === pageId) && (historyState === "all" || intent.state === historyState) && marketingMatches(term, intent.id, intent.action, intent.remoteId, intent.preview.pageLabel, intent.preview.targetId));
  const actionBlocked = busy || !!workspace.intentStorageError || form !== null || review !== null || preparing !== null || !data.data || data.isError || !collection.data || collection.isError;
  async function dispatchReview(shared: boolean, external: boolean) {
    if (!review || (review.state !== "prepared" && !workspace.dispatchPending)) return;
    const target = review;
    const recovering = workspace.dispatchPending !== null;
    const pending: PendingOfapiEvidence = { kind: "marketing", requestId: crypto.randomUUID(), intent: target };
    saveEvidenceCustody(ownerId, pending); setWorkspace(current => ({ ...current, dispatchPending: pending }));
    let result: MarketingIntent;
    try { result = await marketingActions.dispatch(target.id, { acknowledgeSharedImpact: shared, acknowledgeExternalTest: external }); }
    catch (reason) { if (!marketingFailureUncertain(reason, recovering)) { clearEvidenceCustody(ownerId, pending); setWorkspace(current => ({ ...current, dispatchPending: null })); } throw reason; }
    if (result.state !== "dispatching") { clearEvidenceCustody(ownerId, pending); setWorkspace(current => ({ ...current, dispatchPending: null })); }
    setReview(result.state === "prepared" || result.state === "dispatching" ? result : null);
    setNotice(`${target.preview.pageLabel ?? "Команда"} · ${target.id}: ${stateLabels[result.state] ?? result.state}. ${result.state === "indeterminate" ? "Не создавайте повтор: проверьте историю и состояние у провайдера." : ""}`);
  }
  return <div className="max-w-7xl space-y-5 p-4 pb-12 md:p-0 md:pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-extrabold text-text-primary">Smart Links и привлечение</h1><p className="mt-1 max-w-3xl text-sm text-text-secondary">Сохранённые ссылки, пиксели и postbacks. Окно атрибуции — 6 часов. Эти суммы не прибавляются к финансовому журналу Hub.</p></div><Link className="text-sm font-medium text-accent" to={ofapiPageHref("/settings?tab=collection", requestedPage)}>Управление сбором</Link></header>
    <div className="flex flex-wrap items-end gap-3"><Field label="OF-страница"><select className={field} value={selectedPage?.label ?? ""} disabled={busy || !collection.data?.pages.length} onChange={e => selectPage(e.target.value)}>{!pageId && <option value="">Выберите доступную страницу</option>}{collection.data?.pages.map(page => <option key={page.id} value={page.label}>{page.label}</option>)}</select></Field><button className={button} disabled={busy} onClick={() => void Promise.all([data.refetch(), collection.refetch()])}>Обновить экран</button></div>
    <QueryNotice error={collection.isError} stale={collection.data !== undefined} retry={() => collection.refetch()} />
    {collection.isLoading && !collection.data && <StatusPanel title="Загружаем доступные страницы…" />}
    {collection.data && !pageId && <StatusPanel title={requestedPage !== null ? "Страница из ссылки недоступна" : "Нет доступных OnlyFans-страниц"} description="Выберите доступный аккаунт для работы с его ссылками и отчётами." />}
    <QueryNotice error={data.isError} stale={data.data !== undefined} retry={() => data.refetch()} />
    {data.isLoading && !data.data && <StatusPanel title="Загружаем сохранённые данные и историю…" />}
    {workspace.custodyError && <p role="alert" className="text-sm text-warning">{workspace.custodyError}</p>}
    {workspace.intentStorageError && <p role="alert" className="text-sm text-warning">{workspace.intentStorageError}</p>}
    {error && <p role="alert" className="rounded-lg border border-danger/40 p-3 text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="break-words rounded-lg bg-hover p-3 text-sm text-text-primary">{notice}</p>}
    {review && reviewCollapsed && <section className={`${card} space-y-3`} aria-label="Незавершённая проверка действия"><p className="break-all text-sm">{review.preview.pageLabel ?? "Команда"} · {actionLabels[review.action as MarketingForm["action"]] ?? review.action} · {review.id}. {workspace.dispatchPending ? "Исход отправки не подтверждён; новое действие заблокировано." : stateLabels[review.state] ?? review.state}</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => setReviewCollapsed(false)}>Продолжить проверку</button>{!workspace.dispatchPending && <button type="button" className={button} disabled={busy} onClick={() => setReview(null)}>Закрыть результат</button>}</div></section>}
    {form && !editorOpen && <section className={`${card} space-y-3`}><p className="text-sm">{preparing ? "Незавершённая подготовка" : "Сохранённый черновик"}: {actionLabels[form.action]} · {collection.data?.pages.find(page => page.id === form.pageId)?.label ?? "Команда"}{preparing ? ` · ${preparing.id}` : ""}.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => setEditorOpen(true)}>Продолжить</button>{!preparing && <button type="button" className={button} disabled={busy} onClick={() => setForm(null)}>Удалить черновик</button>}</div></section>}
    <nav className="flex flex-wrap gap-2" aria-label="Данные привлечения">{([ ["links", "Ссылки и пиксели"], ["postbacks", "Postbacks"], ["analytics", "Результаты"], ["history", "История действий"] ] as const).map(([id, label]) => <button type="button" aria-pressed={tab === id} key={id} className={tab === id ? primary : button} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 basis-full sm:flex-1 sm:basis-auto"><Field label="Поиск в выбранном разделе"><input type="search" className={field} placeholder="Название, ID, тег или получатель" value={term} onChange={event => filter("q", event.target.value)} /></Field></div>{tab === "links" && <Field label="Вид ссылки"><select className={field} value={kind} onChange={event => filter("kind", event.target.value)}><option value="all">Все виды</option><option value="smart_link">Smart Links</option><option value="tracking">Отслеживаемые</option><option value="trial">Пробный доступ</option></select></Field>}{tab === "history" && <><Field label="Состояние действия"><select className={field} value={historyState} onChange={event => filter("historyState", event.target.value)}><option value="all">Все состояния</option>{["prepared", "dispatching", "succeeded", "rejected", "indeterminate"].map(state => <option key={state} value={state}>{stateLabels[state]}</option>)}</select></Field><Field label="Охват истории"><select className={field} value={historyScope} onChange={event => filter("historyScope", event.target.value)}><option value="team">Вся команда</option><option value="page">Выбранная страница</option></select></Field></>}</div>
    {data.data && <p className="text-xs text-text-muted" role="status">{tab === "links" ? `Ссылок в сохранённых данных страницы: ${links.length + legacyLinks.length}. Показано: ${visibleLinks.length + visibleLegacy.length}.` : tab === "postbacks" ? `Postbacks команды: ${postbacks.length}. Показано: ${visiblePostbacks.length}.` : tab === "analytics" ? `Снимков отчётов страницы: ${analytics.length}. Показано: ${visibleAnalytics.length}.` : `Действий в ответе: ${intents.length}. Показано: ${visibleIntents.length}. История ограничена последними 50 действиями команды.`}</p>}
    {data.data && !data.isError && (tab === "links" ? links.length + legacyLinks.length > 0 && visibleLinks.length + visibleLegacy.length === 0 : tab === "postbacks" ? postbacks.length > 0 && visiblePostbacks.length === 0 : tab === "analytics" ? analytics.length > 0 && visibleAnalytics.length === 0 : intents.length > 0 && visibleIntents.length === 0) && <StatusPanel title="Совпадений в полученных данных нет" description="Поиск работает внутри сохранённой выборки. Измените запрос или фильтры." action={<button type="button" className={button} onClick={() => { const next = new URLSearchParams(search); ["q", "kind", "historyState", "historyScope"].forEach(key => next.delete(key)); setSearch(next); }}>Сбросить фильтры</button>} />}
    {tab === "links" && <>
      <section className={`${card} space-y-4`}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Smart Links этой страницы</h2><button className={button} disabled={!pageId || actionBlocked} onClick={() => edit("smart_link_create")}>Создать ссылку</button></div>
        {pageId > 0 && data.data && !data.isError && !links.length && <p className="text-sm text-text-muted">Ссылок в сохранённых данных пока нет. Запустите ограниченный сбор ниже или создайте ссылку.</p>}
        {visibleLinks.map(link => <article key={link.id} className="space-y-3 border-t border-border-light pt-4"><div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-semibold text-text-primary">{link.name ?? link.id}</h3><p className="break-all text-xs text-text-muted">{link.id} · {link.linkType} · сохранено {new Date(link.observedAt).toLocaleString()}</p></div><div className="flex flex-wrap gap-2"><button className={button} disabled={actionBlocked} onClick={() => edit("tags_add", link)}>Добавить теги</button><button className={button} disabled={actionBlocked || !link.tags.length} onClick={() => edit("tags_remove", link)}>Снять теги</button><button className={button} disabled={actionBlocked} onClick={() => edit("pixel_create", link)}>Подключить пиксель</button><button className={`${button} text-red-700`} disabled={actionBlocked} onClick={() => edit("smart_link_delete", link)}>Удалить</button></div></div>
          {link.publicUrl && <a className="inline-block max-w-full break-all text-sm text-accent underline" href={link.publicUrl} target="_blank" rel="noreferrer">{link.publicUrl}</a>}
          <p className="text-sm text-text-secondary">Клики {value(link.clicks)} · Подписки {value(link.subscribers)} · Платящие {value(link.spenders)} · Доход {money(link.revenueMills)} ({link.revenueBasis})</p>
          {!!link.tags.length && <div className="flex flex-wrap gap-1.5">{link.tags.map(tag => <span key={tag} className="rounded bg-hover px-2 py-1 text-xs">{tag}</span>)}</div>}
          {link.cost && <p className="text-xs text-text-muted">Расход кампании по настройкам провайдера: {value(link.cost.inputValue)} {value(link.cost.currency)} · {value(link.cost.inputMode)}. Это не фактическое списание из банка.</p>}
          {pixels.filter(pixel => pixel.parentId === link.id && pixel.pageId===link.pageId).map(pixel => <div key={pixel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-hover p-3"><div className="text-sm"><strong>{pixel.name ?? pixel.platform}</strong><p className="text-xs text-text-muted">{pixel.platform} · ID платформы {pixel.platformPixelId} · {value(pixel.status)}</p></div><div className="flex flex-wrap gap-2"><button className={button} disabled={actionBlocked} onClick={() => edit("pixel_update", pixel)}>Изменить</button><button className={button} disabled={actionBlocked || !marketingPixelCanTest(pixel.platform)} title={!marketingPixelCanTest(pixel.platform) ? "CreatorTraffic не поддерживает тестовые события" : undefined} onClick={() => edit("pixel_test", pixel)}>Тест</button>{!marketingPixelCanTest(pixel.platform) && <span className="text-xs text-text-muted">CreatorTraffic не поддерживает тестовые события</span>}<button className={button} disabled={actionBlocked} onClick={() => edit("pixel_disconnect", pixel)}>Отключить от ссылки</button></div></div>)}
        </article>)}
      </section>
      <section className={`${card} space-y-4`}><h2 className="font-semibold">Tracking и trial links</h2><p className="text-sm text-text-secondary">Сохранённые ответы этой страницы. Общие ссылки отмечены отдельно; расходы и доход здесь относятся к настройкам и атрибуции провайдера.</p>{pageId > 0 && data.data && !data.isError && !legacyLinks.length && <p className="text-sm text-text-muted">Прочитайте нужный список через ограниченный сбор ниже.</p>}{visibleLegacy.map(link => <article key={`${link.kind}:${link.shared}:${link.id}`} className="space-y-2 border-t border-border-light pt-4"><h3 className="font-medium">{link.name ?? link.id} <span className="text-xs font-normal text-text-muted">{link.kind}{link.shared ? " · общая ссылка" : ""}</span></h3>{link.publicUrl && <a className="block break-all text-sm text-accent underline" href={link.publicUrl} target="_blank" rel="noreferrer">{link.publicUrl}</a>}<p className="text-sm text-text-secondary">Клики {value(link.clicks)} · Подписки {value(link.subscribers)} · Платящие {value(link.spenders)} · Доход {money(link.revenueMills)} ({link.revenueBasis})</p><p className="text-xs text-text-muted">{link.cost ? `Расход по настройкам провайдера: ${value(link.cost.inputValue)} ${value(link.cost.currency)} · ${value(link.cost.inputMode)} · ${value(link.cost.unit)}` : "Расход по настройкам провайдера неизвестен"}</p>{!!link.tags.length && <p className="text-xs text-text-secondary">Теги: {link.tags.join(", ")}</p>}<p className="text-xs text-text-muted">{link.id} · сохранено {new Date(link.observedAt).toLocaleString()}</p></article>)}</section>
    </>}
    {tab === "postbacks" && <section className={`${card} space-y-4`}><div className="flex flex-wrap justify-between gap-3"><div><h2 className="font-semibold">Postbacks команды</h2><p className="mt-1 text-xs text-text-muted">Глобальные настройки могут охватывать несколько страниц. Секретные шаблоны и значения заголовков скрыты.</p></div><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => { await marketingActions.postbacks({}); setNotice("Список postbacks прочитан у провайдера."); })}>Прочитать у провайдера</button><button className={button} disabled={actionBlocked} onClick={() => edit("postback_create")}>Создать postback</button></div></div>
      {data.data && !data.isError && !postbacks.length && <p className="text-sm text-text-muted">Сохранённого списка пока нет.</p>}{visiblePostbacks.map(row => <article key={row.id} className="space-y-2 border-t border-border-light pt-4"><div className="flex flex-wrap justify-between gap-3"><h3 className="font-medium">{row.httpMethod} {row.destination ?? `Postback ${row.id}`}</h3><div className="flex flex-wrap gap-2"><button className={button} disabled={actionBlocked} onClick={() => edit("postback_update", row)}>Изменить</button><button className={`${button} text-red-700`} disabled={actionBlocked} onClick={() => edit("postback_delete", row)}>Удалить</button></div></div><p className="text-sm text-text-secondary">{row.scope === "global" ? "Все Smart Links команды" : `${row.linkIds.length} выбранных ссылок`} · {row.conversionTypes.map(type => eventLabels[type] ?? type).join(", ")}</p><p className="text-xs text-text-muted">Переменные: {row.templateVariables.join(", ") || "нет"}. Заголовки: {row.headerNames.join(", ") || "нет"}. Сохранено {new Date(row.observedAt).toLocaleString()}.</p></article>)}
    </section>}
    {tab === "analytics" && <section className={`${card} space-y-4`}><h2 className="font-semibold">Сохранённые результаты</h2><p className="text-sm text-text-secondary">Доход относится к атрибуции ссылки. Клики, повторные клики, боты, органика и прошлые подписки сохраняют собственные признаки.</p>{pageId > 0 && data.data && !data.isError && !data.data.analytics.some(row => row.pageId === pageId) && <p className="text-sm text-text-muted">Выберите нужный отчёт и выполните ограниченный сбор ниже.</p>}{visibleAnalytics.map((snapshot, index) => <article key={`${snapshot.operation}:${snapshot.linkId}:${index}`} className="space-y-2 border-t border-border-light pt-4"><h3 className="text-sm font-medium">{snapshot.linkId} · {snapshot.operation.replace(/^ofapi_read_/, "").replaceAll("_", " ")}</h3><p className="text-xs text-text-muted">{stateLabels[snapshot.coverage.state]}{snapshot.coverage.reason ? ` · ${snapshot.coverage.reason}` : ""} · {new Date(snapshot.observedAt).toLocaleString()} · окно {snapshot.window.from ?? "не указано"} — {snapshot.window.to ?? "не указано"}{snapshot.requestedRevenueBasis ? ` · запрошено ${snapshot.requestedRevenueBasis}` : ""}</p><div className="overflow-x-auto" role="region" aria-label="Сохранённые показатели" tabIndex={0}><table className="w-full text-left text-xs"><thead><tr>{["Период / фан", "Клики", "Подписки", "Платящие", "Доход", "Признаки / метрика"].map(label => <th key={label} className="p-2 font-medium text-text-muted">{label}</th>)}</tr></thead><tbody>{snapshot.rows.map((row, i) => {const amount=marketingDisplayMoney(row);return <tr key={i} className="border-t border-border-light"><td className="p-2">{row.timestamp ?? row.occurredAt ?? row.username ?? row.fanId ?? row.period ?? "Итог"}</td><td className="p-2">{value(row.clicks)}</td><td className="p-2">{value(row.subscribers)}</td><td className="p-2">{value(row.spenders)}</td><td className="p-2">{money(amount.mills)} · {amount.basis ?? "—"}</td><td className="p-2">{[row.conversionType, row.country, ...(row.period==="row" ? [marketingFlag("Бот",row.isBot),marketingFlag("Повтор",row.isDuplicate),marketingFlag("Органика",row.organic),marketingFlag("Подписывался ранее",row.previouslySubscribed),marketingFlag("Промо-подписка",row.subscribedUsingPromo),marketingFlag("Подписка по этой ссылке",row.currentSubscriptionFromSmartLink)] : []), row.metricPath ? `${row.metricPath}: ${row.providerValue ?? "—"}` : null].filter(Boolean).join(" · ") || "—"}</td></tr>;})}</tbody></table></div></article>)}</section>}
    {tab === "history" && <section className={`${card} space-y-4`}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">История действий команды</h2><button className={button} disabled={busy} onClick={() => void run(async () => { await marketingActions.rebuild(); setNotice("Локальное восстановление начато. Незавершённые действия показаны в истории; обработка продолжится при обновлении экрана. Запросов к провайдеру не было."); })}>Восстановить из сохранённых ответов</button></div>{data.data && !data.isError && !data.data.intents.length && <p className="text-sm text-text-muted">Действий пока нет.</p>}{visibleIntents.map(intent => <article key={intent.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-3"><div><h3 className="text-sm font-medium">{actionLabels[intent.action as MarketingForm["action"]] ?? intent.action}</h3><p className="text-sm text-text-secondary">{stateLabels[intent.state] ?? intent.state}{intent.errorCode ? ` · ${intent.errorCode}` : ""}</p>{intent.remoteId && <p className="break-all text-xs text-text-secondary">ID у провайдера: {intent.remoteId}</p>}{intent.state === "succeeded" && (intent.accountingState === "pending" || intent.projectionState === "pending") && <p className="text-xs text-amber-700">Действие подтверждено; {intent.accountingState === "pending" ? "учёт расхода" : ""}{intent.accountingState === "pending" && intent.projectionState === "pending" ? " и " : ""}{intent.projectionState === "pending" ? "обновление сохранённых данных" : ""} ещё восстанавливается.</p>}<p className="text-xs text-text-muted">{intent.preview.pageId ? `Страница ${intent.preview.pageLabel ?? intent.preview.pageId} · ${intent.preview.accountId}` : "Настройки команды"} · {new Date(intent.createdAt).toLocaleString()} · {intent.id}</p></div>{intent.state === "prepared" && <button className={button} disabled={actionBlocked} onClick={() => { setError(""); setReview(intent); }}>Проверить и подтвердить</button>}</article>)}</section>}
    <details className={card}><summary className="cursor-pointer font-semibold">Собрать данные по выбранной странице</summary><p className="mt-3 text-sm text-text-secondary">Новые расписания выключены по умолчанию. Этот разовый запуск не меняет расписание: он сохраняет шаги и останавливается на указанных лимитах. Общая пауза фонового сбора действует и здесь.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Что собрать"><select className={field} value={selection} onChange={e => { setSelection(e.target.value); setSelectedLink(""); }}>{readSelections.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      {perLink && <Field label="Ссылка"><select required className={field} value={selectedLink} onChange={e => setSelectedLink(e.target.value)}><option value="">Выберите ссылку</option>{selectableLinks.map(link => <option key={link.id} value={link.id}>{link.name ?? link.id}</option>)}</select></Field>}
      <Field label="С даты (UTC)"><input className={field} type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="По дату включительно (UTC)"><input className={field} type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
      <Field label="Не более запросов"><input className={field} type="number" min={1} max={100} value={calls} onChange={e => setCalls(Number(e.target.value))} /></Field><Field label="Не более кредитов"><input className={field} type="number" min={1} max={100} value={credits} onChange={e => setCredits(Number(e.target.value))} /></Field>
    </div><div className="mt-4 flex flex-wrap items-center gap-3"><button className={button} disabled={busy || !!workspace.custodyError || collectPreview !== null || !pageId || !collection.data || collection.isError || collection.data.backgroundPaused || (perLink && !selectedLink) || !Number.isInteger(calls) || calls < 1 || calls > 100 || !Number.isInteger(credits) || credits < 1 || credits > 100 || !from || !to || from > to} onClick={() => setCollectPreview({ body: { pageId, category: selection.startsWith("smart_") ? "smart_links" : "tracking_links", expectedRevision: collection.data!.revision, maxCalls: calls, maxCredits: credits, maxBytes: 4 * 1024 * 1024, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, selection: [`${selection}${perLink ? `:${selectedLink}` : ""}`] }, pageLabel: selectedPage!.label, unknown: false, jobId: null, record: null })}>Проверить один сбор</button><span className="text-xs text-text-muted">До 4 МиБ ответа; общие ограничения расхода продолжают действовать.</span></div></details>
    {collection.data?.backgroundPaused && <p className="text-sm text-warning">Фоновый сбор приостановлен. Разовый сбор доступен после изменения политики в управлении сбором.</p>}
    {collectPreview && <section className={`${card} space-y-3`} aria-label="Проверка ограниченного сбора"><h2 className="font-semibold">{collectPreview.jobId ? "Задание поставлено в очередь" : collectPreview.unknown ? "Результат постановки задания неизвестен" : "Проверьте один сбор"}</h2><p className="break-all text-sm">Страница: {collectPreview.pageLabel}. Набор: {collectPreview.body.selection?.join(", ")}. До {collectPreview.body.maxCalls} запросов, {collectPreview.body.maxCredits} кредитов, 4 МиБ ответа.</p><p className="text-xs text-text-muted">Период UTC: {collectPreview.body.from} — {collectPreview.body.to}. Версия политики: {collectPreview.body.expectedRevision}.</p>{collectPreview.jobId && <p className="break-all text-sm">Задание: {collectPreview.jobId}. Выполнение отслеживается в управлении сбором.</p>}{collectPreview.unknown && <p className="text-sm text-warning">Задание могло создаться. Автоматического повтора нет. Проверьте очередь для указанной страницы перед отдельным новым заданием.</p>}<div className="flex flex-wrap gap-2"><Link className={button} to={ofapiPageHref("/settings?tab=collection", collectPreview.pageLabel)}>Проверить очередь сбора</Link>{!collectPreview.unknown && !collectPreview.jobId && <button type="button" className={primary} disabled={busy || collection.isError || collectPreview.body.expectedRevision !== collection.data?.revision} onClick={() => void run(async () => { const record: OfapiCaptureCustody = { kind: "marketing", body: collectPreview.body, pageLabel: collectPreview.pageLabel, startedAt: new Date().toISOString(), clientRequestId: crypto.randomUUID() }; const frozen = { ...collectPreview, record }; saveCaptureCustody(ownerId, record); setCollectPreview(frozen); setAllowNewCapture(false); try { const result = await marketingActions.collect(frozen.body); setCollectPreview({ ...frozen, jobId: result.id }); clearCaptureCustody(ownerId, record); } catch (reason) { if (marketingFailureUncertain(reason)) setCollectPreview({ ...frozen, unknown: true }); else clearCaptureCustody(ownerId, record); throw reason; } })}>Подтвердить сбор с этими пределами</button>}{!collectPreview.unknown && <button type="button" className={button} disabled={busy} onClick={() => setCollectPreview(null)}>{collectPreview.jobId ? "Закрыть результат" : "Отмена"}</button>}</div>{!collectPreview.unknown && !collectPreview.jobId && collectPreview.body.expectedRevision !== collection.data?.revision && <p className="text-sm text-warning">Политика изменилась. Отмените эту проверку и подготовьте актуальные условия.</p>}</section>}
    {collectPreview?.unknown && collectPreview.record && <section className={`${card} space-y-3 text-sm`}><Link className="text-accent underline" to="/ofapi-credits">Открыть журнал кредитов OFAPI</Link><label className="flex items-start gap-2"><input type="checkbox" checked={allowNewCapture} onChange={event => setAllowNewCapture(event.target.checked)} />Я проверил очередь и расходы. Разрешаю новое отдельное задание, которое может добавить расход; прежний исход остаётся неизвестным.</label><button type="button" className={button} disabled={busy || !allowNewCapture} onClick={() => {
      const current = readWorkspace(); if (current.busy || !current.collectPreview?.record || !allowNewCapture) return;
      try { const captureHistory = acknowledgeCaptureCustody(ownerId, current.collectPreview.record); setWorkspace(value => ({ ...value, collectPreview: null, captureHistory, error: "" })); setAllowNewCapture(false); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Контекст сбора не сохранён."); }
    }}>Перейти к проверке нового задания</button></section>}
    {!!workspace.captureHistory.length && <details className={card}><summary className="min-h-10 cursor-pointer text-sm">Предыдущие задания с неизвестным исходом: {workspace.captureHistory.length}</summary><ul className="space-y-2 text-xs text-text-muted">{workspace.captureHistory.map(record => <li key={record.clientRequestId} className="break-all">{record.startedAt} · {record.kind === "marketing" ? `${record.pageLabel} · ${record.body.selection?.join(", ")} · до ${record.body.maxCalls} запросов и ${record.body.maxCredits} кредитов` : "Сбор словаря"} · {record.clientRequestId}. После ручной сверки разрешено отдельное новое задание; исход этого запроса не подтверждён.</li>)}</ul></details>}
    {form && editorOpen && <MarketingEditor form={form} setForm={setForm} links={allLinks} busy={busy} frozen={preparing !== null} targetLabel={collection.data?.pages.find(page => page.id === form.pageId)?.label ?? String(form.pageId)} error={error} onClose={() => { if (!readWorkspace().busy) setEditorOpen(false); }} onPrepare={() => void run(prepare)} />}
    {review && !reviewCollapsed && <MarketingIntentReview key={review.id} intent={review} busy={busy} recovering={workspace.dispatchPending !== null} error={error} onClose={() => { if (readWorkspace().busy) return; if (readWorkspace().dispatchPending) setReviewCollapsed(true); else setReview(null); }} onDispatch={(shared, external) => void run(() => dispatchReview(shared, external))} />}
  </div>;
}
