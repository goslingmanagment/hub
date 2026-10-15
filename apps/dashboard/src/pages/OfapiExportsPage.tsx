import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { OFAPI_TYPED_EXPORT_PROFILES, type OfapiTypedExportProfile } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { ofapiExportActions, ofapiExportJobsQueryOptions, readOfapiExportJobsForRecovery, useOfapiExportPages, useOfapiExportInventory, useOfapiExportRows, useOfapiExports, useOfapiVisitors } from "@/api/ofapiExports";
import { Field } from "@/components/shared/Field";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatBusinessDateShort, formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { isUncertainActionFailure } from "./ofapi-actions/form-values.ts";
const labels: Record<OfapiTypedExportProfile, string> = { profile_visitors: "Посетители профиля", fans: "Фаны", tracking_links: "Tracking-ссылки", trial_links: "Trial-ссылки", smart_links: "Smart Links" };
const fanTypeLabels: Record<string, string> = { all: "Все", active: "Активные", expired: "Бывшие", latest: "Новые" };
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const metric = (value: number | string | null) => value === null ? "—" : String(value);
const credits = (count: number) => `${count} ${ruPlural(count, "кредит", "кредита", "кредитов")}`;
/** "2026-09-01…" → "01.09.2026": the export window is a run of UTC days. */
const day = (iso: string) => { const [year, month, date] = iso.slice(0, 10).split("-"); return `${date}.${month}.${year}`; };
/** A job's state in words; the raw vendor or local value stays in the badge's title. */
const statusLabels: Record<string, string> = {
  indeterminate: "Результат неизвестен · нужна проверка", queued: "В очереди", imported: "Импортирована",
  ready: "В очереди", leased: "Выполняется", awaiting_parse: "Обрабатывается", retry_wait: "Ждёт OnlyFans API",
  blocked: "Ждёт действия", complete: "Готово", cancelled: "Отменена", rejected: "Отклонена",
  pending: "Готовится у OnlyFans API", in_progress: "Готовится у OnlyFans API", completed: "Готова у OnlyFans API",
  failed: "Ошибка у OnlyFans API", expired: "Истекла", calculating_credits: "Расчёт цены",
  calculating_credits_completed: "Цена рассчитана", calculating_credits_failed: "Цену рассчитать не удалось",
};
const statusBadges: Record<string, string> = {
  indeterminate: "badge badge-warning", blocked: "badge badge-warning", imported: "badge badge-success", complete: "badge badge-success",
  completed: "badge badge-success", calculating_credits_completed: "badge badge-accent", failed: "badge badge-danger",
  calculating_credits_failed: "badge badge-danger", rejected: "badge badge-danger", pending: "badge badge-info", in_progress: "badge badge-info",
  calculating_credits: "badge badge-info", retry_wait: "badge badge-info", queued: "badge badge-info", ready: "badge badge-info", leased: "badge badge-info",
};
const reasonLabels: Record<string, string> = {
  owner_approval_required: "Цена получена — запустите выгрузку", export_quote_requires_start: "Цена получена — запустите выгрузку",
  artifact_capture_required: "Выгрузка готова — скачайте и импортируйте её", export_failed: "Выгрузка не удалась у OnlyFans API",
  background_paused: "Фоновый сбор на паузе", job_unavailable: "Задача недоступна", collection_off: "Сбор выключен",
  on_demand_only: "Сбор только по запросу", indeterminate: "Проверьте список, прежде чем повторять",
  vendor_cancelled: "Отменена у OnlyFans API", vendor_cancel_pending: "Отмена ещё не подтверждена OnlyFans API",
  vendor_retry_requested: "Запрошен повтор", artifact_contract_rejected: "Файл выгрузки не прошёл проверку",
  rate_limited: "OnlyFans API ограничил частоту запросов", vendor_5xx: "OnlyFans API временно недоступен",
  export_cancel_status_reconcile: "Сверяем статус отмены",
};
const availabilityLabels: Record<string, string> = { complete: "Полные", partial: "Частичные", missing: "Нет данных", unavailable: "Недоступны", ineligible: "Не применимо" };
export function exportWindowError(from: string, to: string, today = daysAgo(0)): string | null {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to)) return "Выберите обе даты.";
  if (from < "2016-11-01" || from > to || to >= today) return "Выберите прошедший период (по UTC) не раньше 01.11.2016, который заканчивается до сегодняшнего дня.";
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 >= 366) return "Одна выгрузка — не больше 366 дней.";
  return null;
}
type ExportQuoteBody = Parameters<typeof ofapiExportActions.create>[0];
type UnconfirmedExportQuote = { body: ExportQuoteBody; pageLabel: string };
interface ExportJobsReadback { pageId: number; dataUpdatedAt: number }

export function exportQuoteReviewSnapshot(
  readback: ExportJobsReadback | null,
  current: ExportJobsReadback & { hasData: boolean; isError: boolean; isFetching: boolean },
  selectedPageId: number,
): string | null {
  if (
    !readback || current.pageId !== readback.pageId || selectedPageId !== readback.pageId
    || !current.hasData || current.isError || current.isFetching
    || current.dataUpdatedAt < readback.dataUpdatedAt
  ) return null;
  return `${current.pageId}:${current.dataUpdatedAt}`;
}

export function UnconfirmedExportQuoteNotice({ quote, onReadJobs, onStartNew, reviewSnapshot, busy = false }: {
  quote: UnconfirmedExportQuote;
  onReadJobs: () => void;
  onStartNew: () => void;
  reviewSnapshot: string | null;
  busy?: boolean;
}) {
  const [acknowledgedSnapshot, setAcknowledgedSnapshot] = useState<string | null>(null);
  useEffect(() => { setAcknowledgedSnapshot(null); }, [quote, reviewSnapshot]);
  const reviewed = reviewSnapshot !== null && acknowledgedSnapshot === reviewSnapshot;
  return <section role="alert" className="notice notice-warning flex-col items-stretch gap-3">
    <h2 className="font-semibold">Неизвестно, создан ли запрос цены</h2>
    <p>{quote.pageLabel} · {labels[quote.body.profile]} · {day(quote.body.startDate)} — {day(quote.body.endDate)} · лимит {credits(quote.body.maxCredits ?? 10)}.</p>
    <p>Сервер мог уже создать этот запрос цены, а повтор создаст отдельную задачу. Прочитайте выгрузки этой страницы и проверьте список, прежде чем готовить новый запрос.</p>
    <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => {
      setAcknowledgedSnapshot(null);
      onReadJobs();
    }}>Прочитать выгрузки этой страницы</button></div>
    {reviewSnapshot === null && <p className="text-xs">
      Сначала успешно прочитайте выгрузки исходной страницы, затем проверьте список ниже.
      Прежний список или незавершённое обновление не подтверждают проверку.
    </p>}
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-1"
        disabled={busy || reviewSnapshot === null}
        checked={reviewed}
        onChange={event => setAcknowledgedSnapshot(event.target.checked ? reviewSnapshot : null)}
      />
      Я проверил(а) выгрузки и понимаю, что прежний запрос цены может существовать. Хочу подготовить отдельный новый запрос.
    </label>
    <div><button type="button" className="btn btn-sm" disabled={busy || !reviewed} onClick={() => {
      if (!busy && reviewed) onStartNew();
    }}>Подготовить новый запрос цены</button></div>
    <p className="text-xs">Кнопка вернёт к форме оценки. Запрос цены не запускает выгрузку.</p>
  </section>;
}
export function OfapiExportsPage() {
  const queryClient = useQueryClient();
  const auth = useAuthMe(); const owner = auth.data?.user.role === "owner";
  const pages = useOfapiExportPages(); const [selectedPage, setSelectedPage] = useState(0);
  const pageId = selectedPage || pages.data?.pages[0]?.id || 0;
  const [profile, setProfile] = useState<OfapiTypedExportProfile>("profile_visitors");
  const [from, setFrom] = useState(daysAgo(7)); const [to, setTo] = useState(daysAgo(1));
  const [maxCredits, setMaxCredits] = useState(10); const [startCredits, setStartCredits] = useState(2);
  const [fanType, setFanType] = useState<"all" | "active" | "expired" | "latest">("all");
  const [source, setSource] = useState<"export" | "rest">("export");
  const [preview, setPreview] = useState<{ receipt: Awaited<ReturnType<typeof ofapiExportActions.create>>; body: Parameters<typeof ofapiExportActions.create>[0]; pageLabel: string } | null>(null);
  const [approvedPreview, setApprovedPreview] = useState<{ jobId: string; rowVersion: number; credits: number; pageId: number; pageLabel: string; profile: OfapiTypedExportProfile } | null>(null);
  const [controlPreview, setControlPreview] = useState<{ sourceJobId: string; action: "cancel" | "retry"; expectedRowVersion: number; expectedPolicyRevision: number; approvedMaxCredits: number; pageId: number; pageLabel: string; profile: OfapiTypedExportProfile } | null>(null);
  const inventory = useOfapiExportInventory(owner);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [unconfirmedQuote, setUnconfirmedQuote] = useState<UnconfirmedExportQuote | null>(null);
  const [quoteReadback, setQuoteReadback] = useState<ExportJobsReadback | null>(null);
  // A disabled observer keeps recovery pinned to the original page without adding
  // another polling timer. Its explicit refetch shares the ordinary jobs cache.
  const recoveryPageId = unconfirmedQuote?.body.pageId ?? 0;
  const recoveryJobs = useQuery({ ...ofapiExportJobsQueryOptions(recoveryPageId), enabled: false });
  const reviewSnapshot = exportQuoteReviewSnapshot(quoteReadback, {
    pageId: recoveryPageId,
    dataUpdatedAt: recoveryJobs.dataUpdatedAt,
    hasData: recoveryJobs.data !== undefined,
    isError: recoveryJobs.isError,
    isFetching: recoveryJobs.isFetching,
  }, pageId);
  const windowError = exportWindowError(from, to);
  const validMaxCredits = Number.isInteger(maxCredits) && maxCredits >= 2 && maxCredits <= 50;
  const validStartCredits = Number.isInteger(startCredits) && startCredits >= 1 && startCredits <= 50;
  const jobs = useOfapiExports(pageId); const visitors = useOfapiVisitors({ pageId: windowError ? 0 : pageId, from, to, source }); const rows = useOfapiExportRows(selectedJob);
  const clearPreview = () => { setPreview(null); setApprovedPreview(null); setControlPreview(null); };
  const inFlight = useRef(false);
  async function readQuoteJobs() {
    if (inFlight.current || !unconfirmedQuote) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setQuoteReadback(null);
    setSelectedPage(unconfirmedQuote.body.pageId);
    setSelectedJob("");
    clearPreview();
    try {
      const readback = await readOfapiExportJobsForRecovery(queryClient, unconfirmedQuote.body.pageId);
      setQuoteReadback(readback);
    } catch {
      setError("Выгрузки исходной страницы прочитать не удалось. Результат запроса цены по-прежнему неизвестен — прочитайте их ещё раз, прежде чем готовить новый запрос.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function run(action: () => Promise<void>, refreshedNotice?: string, onActionError?: (error: unknown) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    let actionCompleted = false;
    try {
      await action();
      actionCompleted = true;
      const results = await Promise.all([jobs.refetch(), pages.refetch(), ...(!windowError ? [visitors.refetch()] : []), ...(owner ? [inventory.refetch()] : [])]);
      if (results.some(result => result.isError)) setError("Не удалось обновить сохранённые данные. Результат действия сохранён; нажмите «Обновить», чтобы проверить.");
      else if (refreshedNotice) setNotice(refreshedNotice);
    } catch (err) { if (!actionCompleted) onActionError?.(err); setError(err instanceof Error ? err.message : String(err)); } finally { inFlight.current = false; setBusy(false); }
  }
  const pageInfo = pages.data?.pages.find(page => page.id === pageId);
  const pageLabel = pageInfo?.label ?? String(pageId);
  const unbound = pageInfo !== undefined && pageInfo.accountId === null;
  async function create(dryRun: boolean) {
    if (unconfirmedQuote) return;
    const quote = !dryRun && preview ? { body: preview.body, pageLabel: preview.pageLabel } : null;
    await run(async () => {
      if (dryRun && (windowError || !validMaxCredits || !pages.data || pages.isError)) throw new Error(windowError ?? "Проверьте лимит кредитов и обновите данные страниц.");
      const body = dryRun ? { pageId, profile, startDate: `${from}T00:00:00.000Z`, endDate: `${to}T23:59:59.000Z`, maxRows: 1000, maxCredits, maxBytes: 4 * 1024 * 1024, fanType, expectedPolicyRevision: pages.data!.revision, dryRun } : preview?.body;
      if (!body) throw new Error("Сначала покажите оценку выгрузки.");
      const result = await ofapiExportActions.create({ ...body, dryRun });
      if (dryRun) setPreview({ receipt: result, body, pageLabel }); else { setPreview(null); setNotice("Запрос цены отправлен. Выгрузка начнётся только после отдельного запуска ниже."); }
    }, undefined, error => {
      if (quote && isUncertainActionFailure(error)) {
        setUnconfirmedQuote(quote);
        setQuoteReadback(null);
        setPreview(null);
      }
    });
  }
  const loadError = error || (pages.error ?? jobs.error ?? visitors.error)?.message;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <label className="w-full sm:w-64"><span className="field-label">Страница</span><select disabled={busy || !pages.data} className="select" value={pageId} onChange={e => { setSelectedPage(Number(e.target.value)); setSelectedJob(""); clearPreview(); }}>{pages.data?.pages.map(page => <option key={page.id} value={page.id}>{page.label}</option>)}</select></label>
      <label className="w-[calc(50%-6px)] sm:w-40"><span className="field-label">С</span><input disabled={busy} className="input" type="date" value={from} onChange={e => { setFrom(e.target.value); clearPreview(); }} /></label>
      <label className="w-[calc(50%-6px)] sm:w-40"><span className="field-label">По</span><input disabled={busy} className="input" type="date" max={daysAgo(1)} value={to} onChange={e => { setTo(e.target.value); clearPreview(); }} /></label>
      <button type="button" className="btn" disabled={busy || !pageId} onClick={() => void run(async () => {}, "Данные обновлены.")}>Обновить</button>
      {owner && <Link className="link ml-auto pb-2 text-sm" to="/settings?tab=collection">Настройки сбора</Link>}
    </div>
    {loadError && <p role="alert" className="notice notice-danger">{loadError}</p>}
    {pages.isError && !pages.data && <button type="button" className="btn" disabled={pages.isFetching} onClick={() => void pages.refetch()}>Повторить загрузку страниц</button>}
    {((jobs.isError && jobs.data) || (visitors.isError && visitors.data)) && <p className="notice notice-warning">Показаны прежние данные. Нажмите «Обновить», чтобы проверить текущее состояние.</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {pages.isPending && <p role="status" className="text-sm text-text-muted">Загружаем страницы…</p>}
    {pages.data && !pages.isError && pages.data.pages.length === 0 && <StatusPanel title="Нет страниц OnlyFans" description={owner ? "Добавьте или привяжите страницу в настройках сбора." : "Страницы OnlyFans пока не добавлены."} />}
    {windowError && <p role="alert" className="notice notice-danger">{windowError}</p>}
    {unbound && <p className="notice notice-warning">Страница не привязана к OnlyFans API: новые выгрузки для неё недоступны.</p>}
    {unconfirmedQuote && <UnconfirmedExportQuoteNotice
      quote={unconfirmedQuote}
      busy={busy}
      onReadJobs={() => void readQuoteJobs()}
      reviewSnapshot={reviewSnapshot}
      onStartNew={() => {
        if (inFlight.current || reviewSnapshot === null) return;
        setSelectedPage(unconfirmedQuote.body.pageId);
        setProfile(unconfirmedQuote.body.profile);
        setFrom(unconfirmedQuote.body.startDate.slice(0, 10));
        setTo(unconfirmedQuote.body.endDate.slice(0, 10));
        setMaxCredits(unconfirmedQuote.body.maxCredits ?? 10);
        setFanType(unconfirmedQuote.body.fanType ?? "all");
        clearPreview();
        setUnconfirmedQuote(null);
        setQuoteReadback(null);
        setError("");
      }}
    />}
    {owner && !unbound && <section className="card" aria-labelledby="export-new-title">
      <div className="card-header"><div className="min-w-0"><h2 id="export-new-title" className="card-title">Новая выгрузка</h2><p className="card-description">Сначала Hub покажет оценку, затем OnlyFans API рассчитает цену. Выгрузка начнётся только после отдельного запуска.</p></div></div>
      <div className="card-body space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-56"><Field label="Что выгрузить"><select disabled={busy} className="select" value={profile} onChange={e => { setProfile(e.target.value as OfapiTypedExportProfile); clearPreview(); }}>{OFAPI_TYPED_EXPORT_PROFILES.map(value => <option value={value} key={value}>{labels[value]}</option>)}</select></Field></div>
          {profile === "fans" && <div className="w-full sm:w-44"><Field label="Аудитория"><select disabled={busy} className="select" value={fanType} onChange={e => { setFanType(e.target.value as typeof fanType); clearPreview(); }}>{(["all", "active", "expired", "latest"] as const).map(value => <option key={value} value={value}>{fanTypeLabels[value]}</option>)}</select></Field></div>}
          <div className="w-full sm:w-48"><Field label="Лимит на задачу, кредитов"><input disabled={busy} className="input" type="number" min={2} max={50} value={maxCredits} onChange={e => { setMaxCredits(Number(e.target.value)); clearPreview(); }} /></Field></div>
          <button type="button" className="btn" disabled={busy || Boolean(unconfirmedQuote) || !pageId || Boolean(windowError) || !validMaxCredits || !pages.data || pages.isError} onClick={() => void create(true)}>Показать оценку</button>
        </div>
        <p className="field-hint">Период — прошедшие дни по UTC, не больше 366. Одна задача — не больше 1 000 строк, 100 запросов и 4 МБ. Фаны выгружаются такими, какие они на момент выгрузки.</p>
        {!validMaxCredits && <p role="alert" className="notice notice-danger">Лимит на задачу — целое число от 2 до 50.</p>}
        {preview && <div className="space-y-3 rounded-lg border border-border bg-hover-alt p-4 text-sm">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-xs text-text-muted">Страница</dt><dd>{preview.pageLabel}</dd></div>
            <div><dt className="text-xs text-text-muted">Что выгрузить</dt><dd>{labels[preview.body.profile]}{preview.body.profile === "fans" ? ` · ${fanTypeLabels[preview.body.fanType ?? "all"] ?? preview.body.fanType}` : ""}</dd></div>
            <div><dt className="text-xs text-text-muted">Период</dt><dd>{day(preview.body.startDate)} — {day(preview.body.endDate)}</dd></div>
            <div><dt className="text-xs text-text-muted">Строк</dt><dd>не больше {preview.receipt.maxRows.toLocaleString("ru-RU")}</dd></div>
            <div><dt className="text-xs text-text-muted">Оценка выгрузки</dt><dd>{preview.receipt.estimatedCredits === null ? "неизвестна — дождитесь цены от OnlyFans API" : credits(preview.receipt.estimatedCredits)}</dd></div>
            <div><dt className="text-xs text-text-muted">Лимит задачи</dt><dd>{credits(preview.receipt.maximumCredits)}</dd></div>
          </dl>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create(false)}>Запросить цену</button>
        </div>}
      </div>
    </section>}
    <section className="card" aria-labelledby="export-jobs-title">
      <div className="card-header">
        <h2 id="export-jobs-title" className="card-title">Выгрузки</h2>
        {owner && Boolean(jobs.data?.jobs.length) && <label className="flex flex-wrap items-center gap-2 text-sm text-text-secondary"><span>Запуск или повтор — не больше</span><input disabled={busy} className="input min-h-[32px] w-20 py-1" type="number" min={1} max={50} value={startCredits} onChange={e => { setStartCredits(Number(e.target.value)); setApprovedPreview(null); setControlPreview(null); }} /><span>кредитов</span></label>}
      </div>
      {!validStartCredits && <div className="px-5 pt-4"><p role="alert" className="notice notice-danger">Лимит на запуск — целое число от 1 до 50.</p></div>}
      {pageId > 0 && jobs.isPending && <p role="status" className="px-5 py-4 text-sm text-text-muted">Загружаем выгрузки…</p>}
      {jobs.data && !jobs.isError && !jobs.data.jobs.length && <div className="empty"><p className="empty-title">Выгрузок для этой страницы пока нет</p></div>}
      {jobs.data && jobs.data.jobs.length > 0 && <ul className="divide-y divide-border-light">
        {jobs.data.jobs.map(job => {
          const status = job.reason === "indeterminate" ? "indeterminate" : job.controlAction && job.state === "ready" ? "queued" : job.imported ? "imported" : job.vendorStatus ?? job.state;
          const rawStatus = [job.state, job.vendorStatus, job.imported ? "imported" : null].filter(Boolean).join(" · ");
          const canResume = owner && job.state === "blocked" && ["background_paused", "job_unavailable", "collection_off", "on_demand_only"].includes(job.reason ?? "");
          const canPreviewStart = owner && job.state === "blocked" && ["owner_approval_required", "export_quote_requires_start"].includes(job.reason ?? "");
          const canImport = owner && job.reason === "artifact_capture_required" && !job.imported;
          const canControl = owner && job.controlAction !== "cancel" && ((job.state === "retry_wait" && ["pending", "in_progress"].includes(job.vendorStatus ?? "")) || (job.state === "blocked" && job.reason === "export_failed"));
          const isRetry = job.reason === "export_failed";
          const startShown = owner && approvedPreview?.jobId === job.jobId ? approvedPreview : null;
          const controlShown = owner && controlPreview?.sourceJobId === job.jobId ? controlPreview : null;
          return <li key={job.jobId} className="space-y-3 px-5 py-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary">{job.controlAction ? `${job.controlAction === "cancel" ? "Отмена" : "Повтор"} · ` : ""}{labels[job.profile]}</span>
                <span className={statusBadges[status] ?? "badge"} title={rawStatus}>{statusLabels[status] ?? status}</span>
              </div>
              <span className="text-xs text-text-muted">{formatDateTime(job.createdAt)}</span>
            </div>
            <p className="text-text-secondary">Строк: {job.deliveredRows === null && job.totalRows === null ? "неизвестно" : `${metric(job.deliveredRows)} из ${metric(job.totalRows)}`} · Цена у OnlyFans API: {job.creditCost === null ? "—" : credits(job.creditCost)} · Учтено: {credits(job.spentCredits)}</p>
            {job.reason && job.reason !== "indeterminate" && <p className="text-xs text-text-muted" title={job.reason}>{reasonLabels[job.reason] ?? job.reason.replaceAll("_", " ")}</p>}
            {job.reason === "indeterminate" && <p className="text-xs text-warning-dark">{reasonLabels.indeterminate}</p>}
            {(canResume || canPreviewStart || canImport || canControl) && <div className="flex flex-wrap gap-2">
              {canResume && <button type="button" className="btn btn-sm btn-primary" disabled={busy || !pages.data || pages.data.backgroundPaused} onClick={() => void run(async () => { await ofapiExportActions.resume(job.jobId, { expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, reason: "Owner resumed original bounded export" }); setNotice("Выгрузка продолжена с прежним лимитом. Уже запущенная выгрузка проверяется без повторного запуска."); })}>Продолжить выгрузку</button>}
              {canPreviewStart && <button type="button" className={startShown ? "btn btn-sm" : "btn btn-sm btn-primary"} disabled={busy || !validStartCredits} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: job.rowVersion, approvedMaxCredits: startCredits, reason: "Owner reviewed bounded export", dryRun: true }); setApprovedPreview({ jobId: job.jobId, rowVersion: job.rowVersion, credits: startCredits, pageId, pageLabel, profile: job.profile }); })}>Проверить запуск</button>}
              {canImport && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.artifact(job.jobId, { expectedRowVersion: job.rowVersion, reason: "Owner captured completed export" }); setNotice("Файл выгрузки проверен и импортирован. Сохранённые отчёты уже включают его строки."); })}>Скачать и импортировать</button>}
              {canImport && <label className={`btn btn-sm ${busy ? "pointer-events-none opacity-45" : "cursor-pointer"}`}>Импортировать CSV вручную<input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy} onChange={event => {
                const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
                void run(async () => {
                  if (file.size > 4 * 1024 * 1024) throw new Error("CSV больше 4 МБ — это предел этого экрана.");
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
                  const expectedSha256 = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
                  let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
                  await ofapiExportActions.artifact(job.jobId, { expectedRowVersion: job.rowVersion, csvBase64: btoa(binary), expectedSha256, reason: "Owner imported reviewed CSV" });
                  setNotice("Контрольная сумма CSV совпала, строки импортированы.");
                });
              }} /></label>}
              {canControl && <button type="button" className={isRetry && !controlShown ? "btn btn-sm btn-primary" : "btn btn-sm"} disabled={busy || !pages.data || pages.isError || (job.reason === "export_failed" && !validStartCredits)} onClick={() => void run(async () => {
                const action = job.reason === "export_failed" ? "retry" as const : "cancel" as const;
                const snapshot = { sourceJobId: job.jobId, action, expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, approvedMaxCredits: action === "cancel" ? 1 : startCredits };
                const { sourceJobId: _sourceJobId, ...body } = snapshot;
                await ofapiExportActions.control(job.jobId, { ...body, reason: "Owner reviewed provider export action", dryRun: true });
                setControlPreview({ ...snapshot, pageId, pageLabel, profile: job.profile });
              })}>{isRetry ? "Проверить платный повтор" : "Проверить отмену"}</button>}
            </div>}
            {startShown && <div className="space-y-2 rounded-lg border border-border bg-hover-alt p-3 text-text-secondary" title={`Задача ${startShown.jobId}`}><p>{startShown.pageLabel} · {labels[startShown.profile]}. Запуск спишет не больше {credits(startShown.credits)}.</p><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: startShown.rowVersion, approvedMaxCredits: startShown.credits, reason: "Owner approved bounded export", dryRun: false }); setApprovedPreview(null); setNotice("Запуск выгрузки подтверждён в пределах лимита задачи."); })}>Запустить · до {credits(startShown.credits)}</button></div>}
            {controlShown && <div className="space-y-2 rounded-lg border border-border bg-hover-alt p-3 text-text-secondary" title={`Задача ${controlShown.sourceJobId}`}><p>{controlShown.pageLabel} · {labels[controlShown.profile]}. {controlShown.action === "retry" ? `Создаст новую выгрузку и сразу запустит её, не больше ${credits(controlShown.approvedMaxCredits)}. Прежние списания остаются учтёнными.` : "Отменит выгрузку, которая сейчас идёт у OnlyFans API. Прежние списания остаются учтёнными."}</p><button type="button" className={controlShown.action === "retry" ? "btn btn-sm btn-primary" : "btn btn-sm btn-danger"} disabled={busy} onClick={() => void run(async () => {
              const { sourceJobId, pageId: _pageId, pageLabel: _pageLabel, profile: _profile, ...snapshot } = controlShown;
              await ofapiExportActions.control(sourceJobId, { ...snapshot, reason: "Owner approved provider export action", dryRun: false }); setControlPreview(null); setNotice("Действие отправлено в OnlyFans API один раз. Его результат появится здесь.");
            })}>{controlShown.action === "retry" ? "Запустить новую платную выгрузку" : "Отменить выгрузку"}</button></div>}
            <details className="help"><summary>Технические детали</summary><div className="help-body break-all text-xs">
              <p>Задача {job.jobId}{job.vendorExportId ? ` · выгрузка у провайдера ${job.vendorExportId}` : ""}</p>
              <p>Состояние: {rawStatus}{job.reason ? ` · причина: ${job.reason}` : ""}</p>
              {job.sha256 && <p>SHA256 {job.sha256}{job.artifactBytes === null ? "" : ` · ${job.artifactBytes} байт`}</p>}
              {job.imported && <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setSelectedJob(job.jobId)}>Показать сохранённые строки</button></div>}
            </div></details>
          </li>;
        })}
      </ul>}
    </section>
    {selectedJob && <section className="card" aria-labelledby="export-rows-title">
      <div className="card-header"><div className="min-w-0"><h2 id="export-rows-title" className="card-title">Сохранённые строки</h2><p className="card-description">Первые 100 строк. Денежные значения — в единицах и смысле OnlyFans API.</p></div><button type="button" className="btn btn-sm" onClick={() => setSelectedJob("")}>Скрыть строки</button></div>
      <div className="card-body overflow-auto text-xs text-text-secondary">{rows.isPending ? <p role="status">Загружаем строки…</p> : rows.error ? <p role="alert" className="notice notice-danger">{rows.error.message}</p> : <pre>{JSON.stringify(rows.data?.rows ?? [], null, 2)}</pre>}</div>
    </section>}
    {owner && <details className="card group">
      <summary className="card-header flex-nowrap cursor-pointer list-none border-b-0 group-open:border-b [&::-webkit-details-marker]:hidden">
        <div className="min-w-0"><h2 className="card-title">Выгрузки у провайдера</h2><p className="card-description">Список выгрузок в OnlyFans API · {inventory.data?.observedAt ? formatDateTime(inventory.data.observedAt) : inventory.isPending ? "загружаем…" : inventory.isError ? "недоступен" : "ещё не получен"}</p></div>
        <ChevronDown size={18} className="shrink-0 text-text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="card-body space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-text-secondary">Этот список не запускает и не импортирует выгрузки.</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: 1, perPage: 25, type: profile }); setNotice("Получена одна бесплатная страница списка выгрузок."); })}>Обновить список · {labels[profile]}</button></div>
        {inventory.error && <p role="alert" className="notice notice-danger">{inventory.error.message}</p>}
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Выгрузка</th><th>Тип</th><th>Статус</th><th className="num">Строк</th><th className="num">Цена, кредитов</th></tr></thead><tbody>
          {inventory.data && !inventory.data.rows.length && <tr><td colSpan={5} className="muted">Список пуст.</td></tr>}
          {inventory.data?.rows.map(row => <tr key={row.id}><td className="muted">{row.id}</td><td>{labels[row.type as OfapiTypedExportProfile] ?? row.type}</td><td title={row.status}>{statusLabels[row.status] ?? row.status}</td><td className="num">{metric(row.deliveredRows)} из {metric(row.totalRows)}</td><td className="num">{metric(row.creditCost)}</td></tr>)}
        </tbody></table></div>
        {inventory.data && inventory.data.currentPage < inventory.data.lastPage && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: inventory.data!.currentPage + 1, perPage: 25, type: profile }); })}>Загрузить следующую страницу списка</button>}
      </div>
    </details>}
    <section className="card" aria-labelledby="export-visitors-title">
      <div className="card-header">
        <div className="min-w-0"><h2 id="export-visitors-title" className="card-title">Посетители профиля по дням</h2><p className="card-description">Пропущенные дни остаются неизвестными; категории посетителей могут пересекаться.</p></div>
        <label className="flex items-center gap-2 text-sm text-text-secondary"><span>Источник</span><select disabled={busy} className="select w-auto min-h-[32px] py-1" value={source} onChange={e => setSource(e.target.value as typeof source)}><option value="export">Выгрузка CSV</option><option value="rest">Дневной график</option></select></label>
      </div>
      {!windowError && pageId > 0 && visitors.isPending && <p role="status" className="px-5 py-4 text-sm text-text-muted">Загружаем посетителей…</p>}
      <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>День</th><th className="num">Всего</th><th className="num">Гости</th><th className="num">Пользователи</th><th className="num">Подписчики</th><th className="num" title="Единицы задаёт OnlyFans API">Длительность</th><th>Полнота</th></tr></thead><tbody>
        {visitors.data?.days.map(row => <tr key={row.date}><td>{formatBusinessDateShort(row.date)}</td><td className="num">{metric(row.totalVisitors)}</td><td className="num">{metric(row.guestVisitors)}</td><td className="num">{metric(row.userVisitors)}</td><td className="num">{metric(row.subscriberVisitors)}</td><td className="num">{metric(source === "export" ? row.avgViewDuration : row.chartDuration)}</td><td className={row.availability === "complete" ? "" : "muted"} title={`${row.availability} · ${row.source}${row.observationId ? ` · наблюдение ${row.observationId} · ${row.observedAt}` : ""}`}>{availabilityLabels[row.availability] ?? row.availability}</td></tr>)}
      </tbody></table></div>
      {visitors.data?.note && <div className="border-t border-border-light px-5 py-3"><details className="help"><summary>Технические детали</summary><div className="help-body text-xs"><p>{visitors.data.note}</p></div></details></div>}
    </section>
  </div>;
}
