import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { ofapiPageHref, resolveOfapiPage } from "@/lib/ofapiNavigation";
import { OFAPI_TYPED_EXPORT_PROFILES, type OfapiTypedExportProfile } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { ofapiExportActions, useOfapiExportPages, useOfapiExportInventory, useOfapiExportRows, useOfapiExports, useOfapiVisitors } from "@/api/ofapiExports";
const labels: Record<OfapiTypedExportProfile, string> = { profile_visitors: "Посетители профиля", fans: "Фаны", tracking_links: "Tracking-ссылки", trial_links: "Пробные ссылки", smart_links: "Smart Links" };
const field = "min-w-0 max-w-full rounded border border-border bg-card px-3 py-2 text-sm text-text-primary";
const button = "rounded border border-border px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-40";
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const metric = (value: number | string | null) => value === null ? "Неизвестно" : String(value);
export function OfapiExportsPage() {
  const pages = useOfapiExportPages();
  const [search, setSearch] = useSearchParams();
  const requestedPage = search.get("page");
  const selected = resolveOfapiPage(pages.data?.pages, requestedPage);
  function selectPage(label: string, replace = false) {
    const next = new URLSearchParams(search);
    next.set("page", label);
    setSearch(next, { replace });
  }
  useEffect(() => {
    if (requestedPage === null && selected) selectPage(selected.label, true);
  }, [requestedPage, selected?.label]);
  return <OfapiExportsContent pages={pages} pageId={selected?.id ?? 0} requestedPage={requestedPage} selectPage={selectPage} />;
}
function OfapiExportsContent({ pages, pageId, requestedPage, selectPage }: {
  pages: ReturnType<typeof useOfapiExportPages>;
  pageId: number;
  requestedPage: string | null;
  selectPage: (label: string) => void;
}) {
  const auth = useAuthMe(); const owner = auth.data?.user.role === "owner";
  const [initialDraft] = useState(() => ({
    profile: "profile_visitors" as OfapiTypedExportProfile,
    from: daysAgo(7), to: daysAgo(1), maxCredits: 10, startCredits: 2,
    fanType: "all" as "all" | "active" | "expired" | "latest",
    source: "export" as "export" | "rest",
  }));
  const [drafts, setDrafts] = useState<Record<number, typeof initialDraft>>({});
  const { profile, from, to, maxCredits, startCredits, fanType, source } = drafts[pageId] ?? initialDraft;
  function setDraft<K extends keyof typeof initialDraft>(key: K, value: (typeof initialDraft)[K]) {
    setDrafts(current => ({ ...current, [pageId]: { ...(current[pageId] ?? initialDraft), [key]: value } }));
  }
  const setProfile = (value: OfapiTypedExportProfile) => setDraft("profile", value);
  const setFrom = (value: string) => setDraft("from", value);
  const setTo = (value: string) => setDraft("to", value);
  const setMaxCredits = (value: number) => setDraft("maxCredits", value);
  const setStartCredits = (value: number) => setDraft("startCredits", value);
  const setFanType = (value: typeof fanType) => setDraft("fanType", value);
  const setSource = (value: typeof source) => setDraft("source", value);
  const validStartCredits = Number.isInteger(startCredits) && startCredits >= 1 && startCredits <= 50;
  const [previews, setPreviews] = useState<Record<number, { receipt: Awaited<ReturnType<typeof ofapiExportActions.create>>; body: Parameters<typeof ofapiExportActions.create>[0]; pageLabel: string } | null>>({});
  const preview = previews[pageId] ?? null;
  const setPreview = (value: (typeof previews)[number]) => setPreviews(current => ({ ...current, [pageId]: value }));
  const [approvedPreviews, setApprovedPreviews] = useState<Record<number, { jobId: string; rowVersion: number; credits: number; pageId: number; pageLabel: string; profile: OfapiTypedExportProfile } | null>>({});
  const approvedPreview = approvedPreviews[pageId] ?? null;
  const setApprovedPreview = (value: (typeof approvedPreviews)[number]) => setApprovedPreviews(current => ({ ...current, [pageId]: value }));
  const [controlPreviews, setControlPreviews] = useState<Record<number, { sourceJobId: string; action: "cancel" | "retry"; expectedRowVersion: number; expectedPolicyRevision: number; approvedMaxCredits: number; pageId: number; pageLabel: string; profile: OfapiTypedExportProfile } | null>>({});
  const controlPreview = controlPreviews[pageId] ?? null;
  const setControlPreview = (value: (typeof controlPreviews)[number]) => setControlPreviews(current => ({ ...current, [pageId]: value }));
  const inventory = useOfapiExportInventory(owner);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [selectedJobs, setSelectedJobs] = useState<Record<number, string>>({});
  const selectedJob = selectedJobs[pageId] ?? "";
  const setSelectedJob = (value: string) => setSelectedJobs(current => ({ ...current, [pageId]: value }));
  const inFlight = useRef(false);
  const [operationPage, setOperationPage] = useState("");
  const jobs = useOfapiExports(pageId); const visitors = useOfapiVisitors({ pageId, from, to, source }); const rows = useOfapiExportRows(selectedJob);
  const clearPreview = () => { setPreview(null); setApprovedPreview(null); setControlPreview(null); };
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setOperationPage(pages.data?.pages.find(page => page.id === pageId)?.label ?? "Настройки команды");
    setBusy(true); setError(""); setNotice("");
    try { await action(); await jobs.refetch(); await pages.refetch(); await visitors.refetch(); if (owner) await inventory.refetch(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { inFlight.current = false; setBusy(false); }
  }
  const pageLabel = pages.data?.pages.find(page => page.id === pageId)?.label ?? String(pageId);
  async function create(dryRun: boolean) {
    await run(async () => {
      const body = dryRun ? { pageId, profile, startDate: `${from}T00:00:00.000Z`, endDate: `${to}T23:59:59.000Z`, maxRows: 1000, maxCredits, maxBytes: 4 * 1024 * 1024, fanType, expectedPolicyRevision: pages.data!.revision, dryRun } : preview?.body;
      if (!body) throw new Error("Сначала проверьте параметры экспорта.");
      const result = await ofapiExportActions.create({ ...body, dryRun });
      if (dryRun) setPreview({ receipt: result, body, pageLabel }); else { setPreview(null); setNotice("Запрос цены поставлен в очередь. Для запуска экспорта потребуется отдельное подтверждение в задании ниже."); }
    });
  }
  return <div className="space-y-6 max-w-7xl p-4 md:p-0">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-extrabold text-text-primary">Экспорты и посетители OnlyFans</h1><p className="mt-1 text-sm text-text-muted">Сохранённые данные аккаунта, задания с лимитами и покрытие посетителей по дням.</p></div><Link className="text-sm text-accent" to={ofapiPageHref("/settings?tab=collection", requestedPage)}>Управление сбором</Link></div>
    <div className="flex flex-wrap gap-3 items-end">
      <label className="grid gap-1 text-sm text-text-muted">Страница<select disabled={busy || !pages.data?.pages.length} className={field} value={pageId ? pageLabel : ""} onChange={e => selectPage(e.target.value)}>{!pageId && <option value="">Выберите доступную страницу</option>}{pages.data?.pages.map(page => <option key={page.id} value={page.label}>{page.label}</option>)}</select></label>
      <label className="grid gap-1 text-sm text-text-muted">С даты (UTC)<input disabled={busy} className={field} type="date" value={from} onChange={e => { setFrom(e.target.value); clearPreview(); }} /></label>
      <label className="grid gap-1 text-sm text-text-muted">По дату включительно (UTC)<input disabled={busy} className={field} type="date" max={daysAgo(1)} value={to} onChange={e => { setTo(e.target.value); clearPreview(); }} /></label>
      <button className={button} disabled={busy || !pageId} onClick={() => void Promise.all([jobs.refetch(), pages.refetch(), visitors.refetch()])}>Обновить экран</button>
    </div>
    {from && to && from > to && <p role="alert" className="text-sm text-danger">Дата начала должна быть не позже даты окончания.</p>}
    {to > daysAgo(1) && <p role="alert" className="text-sm text-danger">Экспорт посетителей использует только завершённые дни UTC: выберите вчерашнюю или более раннюю дату.</p>}
    <QueryNotice error={pages.isError} stale={pages.data !== undefined} retry={() => pages.refetch()} />
    {pages.isLoading && !pages.data && <StatusPanel title="Загружаем список страниц…" />}
    {pages.data && !pageId && <StatusPanel title={requestedPage !== null ? "Страница из ссылки недоступна" : "Нет доступных OnlyFans-страниц"} description="Выберите доступный аккаунт в списке выше." />}
    {error && <p role="alert" className="rounded border border-danger/40 p-3 text-sm text-danger">{operationPage && <strong>{operationPage}: </strong>}{error}</p>}
    {notice && <p role="status" className="rounded bg-hover p-3 text-sm text-text-primary">{operationPage && <strong>{operationPage}: </strong>}{notice}{operationPage && operationPage !== requestedPage && pages.data?.pages.some(page => page.label === operationPage) && <Link className="ml-2 text-accent underline" to={ofapiPageHref("/ofapi-exports", operationPage)}>Открыть аккаунт</Link>}</p>}
    {busy && <p role="status" className="text-sm text-text-muted">{operationPage}: обрабатываем подтверждённое действие…</p>}
    {owner && pageId > 0 && <section className="rounded-xl border border-border bg-card p-5 space-y-4"><h2 className="font-semibold text-text-primary">Новый экспорт с лимитами</h2>
      <ol className="grid gap-2 text-sm text-text-secondary sm:grid-cols-3"><li className="rounded-lg bg-hover p-3"><strong>1. Проверить параметры</strong><br />Страница, закрытые дни UTC и лимит.</li><li className="rounded-lg bg-hover p-3"><strong>2. Получить цену</strong><br />Запрос оценки не запускает экспорт.</li><li className="rounded-lg bg-hover p-3"><strong>3. Подтвердить запуск</strong><br />После готовности — проверить и импортировать.</li></ol><p className="text-sm text-text-muted">Предпросмотр проверяет параметры в Hub. Запрос цены обращается к провайдеру с выключенным автозапуском. Лимиты задания: 1 000 строк, 100 запросов и 4 МиБ. Список фанов отражает аудиторию на момент экспорта.</p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="grid gap-1 text-sm text-text-muted">Что экспортировать<select disabled={busy} className={field} value={profile} onChange={e => { setProfile(e.target.value as OfapiTypedExportProfile); clearPreview(); }}>{OFAPI_TYPED_EXPORT_PROFILES.map(value => <option value={value} key={value}>{labels[value]}</option>)}</select></label>
        {profile === "fans" && <label className="grid gap-1 text-sm text-text-muted">Аудитория<select disabled={busy} className={field} value={fanType} onChange={e => { setFanType(e.target.value as typeof fanType); clearPreview(); }}>{["all", "active", "expired", "latest"].map(value => <option key={value}>{value}</option>)}</select></label>}
        <label className="grid gap-1 text-sm text-text-muted">Лимит кредитов задания<input disabled={busy} className={field} type="number" min={2} max={50} value={maxCredits} onChange={e => { setMaxCredits(Number(e.target.value)); clearPreview(); }} /></label>
        <button className={button} disabled={busy || !pageId || !from || !to || from > to || to > daysAgo(1) || !Number.isInteger(maxCredits) || maxCredits < 2 || maxCredits > 50} onClick={() => void create(true)}>Проверить параметры</button>
      </div>
      {preview && <div className="rounded border border-border p-3 text-sm text-text-secondary"><p>Страница: {preview.pageLabel} (#{preview.body.pageId}) · Экспорт: {labels[preview.body.profile]} · {preview.body.startDate} — {preview.body.endDate}{preview.body.profile === "fans" ? ` · Аудитория: ${preview.body.fanType}` : ""}</p><p>До {preview.receipt.maxRows} строк. Оценка стоимости экспорта: {preview.receipt.estimatedCredits === null ? "неизвестна; дождитесь цены провайдера" : `${preview.receipt.estimatedCredits} кр.`}. Общий лимит задания: {preview.receipt.maximumCredits} кр.</p><button className={`${button} mt-3`} disabled={busy} onClick={() => void create(false)}>Запросить цену</button></div>}
    </section>}
    <section className="space-y-3"><h2 className="font-semibold text-text-primary">Задания экспорта</h2>
      {pageId > 0 && <QueryNotice error={jobs.isError} stale={jobs.data !== undefined} retry={() => jobs.refetch()} />}
      {pageId > 0 && jobs.isLoading && !jobs.data && <StatusPanel title="Загружаем задания экспорта…" />}
      {owner && <label className="flex flex-wrap items-center gap-2 text-sm text-text-muted">Лимит кредитов одного запуска<input disabled={busy} className={field} type="number" min={1} max={50} value={startCredits} onChange={e => { setStartCredits(Number(e.target.value)); setApprovedPreview(null); setControlPreview(null); }} /></label>}
      {owner && !validStartCredits && <p role="alert" className="text-sm text-danger">Лимит одного запуска — целое число от 1 до 50 кредитов.</p>}
      {pageId > 0 && jobs.data && !jobs.isError && !jobs.data.jobs.length && <p className="text-sm text-text-muted">Для этой страницы ещё нет заданий экспорта.</p>}
      {jobs.data?.jobs.map(job => <div key={job.jobId} className="rounded-xl border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><strong className="text-text-primary">{job.controlAction ? `${job.controlAction === "cancel" ? "Отмена" : "Повторный запуск"} · ` : ""}{labels[job.profile]} · {job.reason === "indeterminate" ? "Результат неизвестен · нужна проверка" : job.controlAction && job.state === "ready" ? "В очереди" : job.imported ? "Импортирован" : job.vendorStatus ?? job.state}</strong><span className="text-text-muted">{new Date(job.createdAt).toLocaleString()}</span></div>
        <p className="text-text-secondary">Строк: {metric(job.deliveredRows)} / {metric(job.totalRows)} · Расход у провайдера: {metric(job.creditCost)} · Учтённый расход: {job.spentCredits}</p>
        {job.reason && <p className="text-text-muted">{job.reason.replaceAll("_", " ")}</p>}
        {job.sha256 && <p className="break-all text-xs text-text-muted">SHA256 {job.sha256} · {job.artifactBytes} bytes</p>}
        <div className="flex flex-wrap gap-2">
          {owner && job.state === "blocked" && ["background_paused", "job_unavailable", "collection_off", "on_demand_only"].includes(job.reason ?? "") && <button className={button} disabled={busy || !pages.data || pages.data.backgroundPaused} onClick={() => void run(async () => { await ofapiExportActions.resume(job.jobId, { expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, reason: "Owner resumed original bounded export" }); setNotice("Задание продолжено с сохранённой позиции и прежним лимитом. Уже начатый экспорт проверяется без повторного запуска."); })}>Продолжить подтверждённый экспорт</button>}
          {owner && job.state === "blocked" && ["owner_approval_required", "export_quote_requires_start"].includes(job.reason ?? "") && <button className={button} disabled={busy || !validStartCredits} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: job.rowVersion, approvedMaxCredits: startCredits, reason: "Owner reviewed bounded export", dryRun: true }); setApprovedPreview({ jobId: job.jobId, rowVersion: job.rowVersion, credits: startCredits, pageId, pageLabel, profile: job.profile }); })}>Проверить запуск</button>}
          {owner && approvedPreview?.jobId === job.jobId && <div className="rounded border border-border p-3"><p className="mb-2 text-text-secondary">Страница: {approvedPreview.pageLabel} (#{approvedPreview.pageId}) · Экспорт: {labels[approvedPreview.profile]} · Задание: {approvedPreview.jobId}</p><button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: approvedPreview.rowVersion, approvedMaxCredits: approvedPreview.credits, reason: "Owner approved bounded export", dryRun: false }); setApprovedPreview(null); setNotice("Запуск экспорта подтверждён в пределах лимита задания."); })}>Подтвердить запуск · до {approvedPreview.credits} кр.</button></div>}
          {owner && job.reason === "artifact_capture_required" && !job.imported && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.artifact(job.jobId, { expectedRowVersion: job.rowVersion, reason: "Owner captured completed export" }); setNotice("Файл проверен и импортирован. Сохранённые отчёты включают его строки."); })}>Скачать, проверить и импортировать</button>}
          {owner && job.reason === "artifact_capture_required" && !job.imported && <label className={`${button} cursor-pointer`}>Импортировать проверенный CSV<input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
            void run(async () => {
              if (file.size > 4 * 1024 * 1024) throw new Error("CSV превышает лимит этого экрана: 4 МиБ");
              const bytes = new Uint8Array(await file.arrayBuffer());
              const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
              const expectedSha256 = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
              let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
              await ofapiExportActions.artifact(job.jobId, { expectedRowVersion: job.rowVersion, csvBase64: btoa(binary), expectedSha256, reason: "Owner imported reviewed CSV" });
              setNotice("Контрольная сумма CSV проверена, строки импортированы.");
            });
          }} /></label>}
          {owner && job.controlAction !== "cancel" && ((job.state === "retry_wait" && ["pending", "in_progress"].includes(job.vendorStatus ?? "")) || (job.state === "blocked" && job.reason === "export_failed")) && <button className={button} disabled={busy || !pages.data || (job.reason === "export_failed" && !validStartCredits)} onClick={() => void run(async () => {
            const action = job.reason === "export_failed" ? "retry" as const : "cancel" as const;
            const snapshot = { sourceJobId: job.jobId, action, expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, approvedMaxCredits: action === "cancel" ? 1 : startCredits };
            const { sourceJobId: _sourceJobId, ...body } = snapshot;
            await ofapiExportActions.control(job.jobId, { ...body, reason: "Owner reviewed provider export action", dryRun: true });
            setControlPreview({ ...snapshot, pageId, pageLabel, profile: job.profile });
          })}>{job.reason === "export_failed" ? "Проверить новый платный запуск" : "Проверить отмену у провайдера"}</button>}
          {owner && controlPreview?.sourceJobId === job.jobId && <div className="rounded border border-border p-3 text-sm text-text-secondary"><p>Страница: {controlPreview.pageLabel} (#{controlPreview.pageId}) · Экспорт: {labels[controlPreview.profile]} · Задание: {controlPreview.sourceJobId}</p><p>{controlPreview.action === "retry" ? `Создаст и сразу запустит новый экспорт с лимитом ${controlPreview.approvedMaxCredits} кр. Предыдущие списания сохранятся.` : "Отменит выполняющийся экспорт у провайдера. Предыдущие списания сохранятся."}</p><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => {
            const { sourceJobId, pageId: _pageId, pageLabel: _pageLabel, profile: _profile, ...snapshot } = controlPreview;
            await ofapiExportActions.control(sourceJobId, { ...snapshot, reason: "Owner approved provider export action", dryRun: false }); setControlPreview(null); setNotice("Действие поставлено в очередь один раз. Полученный результат появится здесь.");
          })}>{controlPreview.action === "retry" ? "Подтвердить новый платный экспорт" : "Отменить экспорт у провайдера"}</button></div>}
          {job.imported && <button className={button} disabled={busy} onClick={() => setSelectedJob(job.jobId)}>Показать сохранённые строки</button>}
        </div>
      </div>)}
      {selectedJob && <div className="overflow-auto rounded border border-border p-3 text-xs text-text-secondary"><div className="mb-2 flex flex-wrap justify-between gap-2"><p>Первые 100 сохранённых строк. Денежные поля сохраняют единицы и смысл провайдера.</p><button type="button" className={button} onClick={() => setSelectedJob("")}>Закрыть строки</button></div><QueryNotice error={rows.isError} stale={rows.data !== undefined} retry={() => rows.refetch()} />{rows.isLoading && !rows.data ? <p role="status">Загружаем строки…</p> : rows.data ? <pre>{JSON.stringify(rows.data.rows, null, 2)}</pre> : null}</div>}
    </section>
    {owner && <section className="space-y-3 rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-text-primary">Сохранённый список экспортов провайдера</h2><button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: 1, perPage: 25, type: profile }); setNotice("Получена одна бесплатная страница списка экспортов провайдера."); })}>Получить список: {labels[profile]}</button></div><p className="text-sm text-text-muted">Последний сохранённый список · {inventory.data?.observedAt ? new Date(inventory.data.observedAt).toLocaleString() : (inventory.data ? "Ещё не собран" : "Состояние неизвестно")}. Получение списка не запускает и не импортирует экспорты.</p>
      <QueryNotice error={inventory.isError} stale={inventory.data !== undefined} retry={() => inventory.refetch()} />
      {inventory.isLoading && !inventory.data && <StatusPanel title="Загружаем сохранённый список провайдера…" />}
      {inventory.data && !inventory.isError && !inventory.data.rows.length && <StatusPanel title="Сохранённый список провайдера пуст" description="Кнопка получения списка запросит одну страницу у провайдера." />}
      <div className="overflow-auto"><table className="w-full text-sm text-left text-text-secondary"><thead><tr>{["Экспорт", "Тип", "Статус", "Получено / найдено", "Кредиты провайдера"].map(value => <th className="p-2 font-medium" key={value}>{value}</th>)}</tr></thead><tbody>{inventory.data?.rows.map(row => <tr className="border-t border-border" key={row.id}><td className="p-2">{row.id}</td><td className="p-2">{row.type}</td><td className="p-2">{row.status}</td><td className="p-2">{metric(row.deliveredRows)} / {metric(row.totalRows)}</td><td className="p-2">{metric(row.creditCost)}</td></tr>)}</tbody></table></div>
      {inventory.data && inventory.data.currentPage < inventory.data.lastPage && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: inventory.data!.currentPage + 1, perPage: 25, type: profile }); })}>Получить следующую страницу списка</button>}
    </section>}
    <section className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold text-text-primary">Посетители профиля по дням</h2><select disabled={busy} aria-label="Источник статистики посетителей" className={field} value={source} onChange={e => setSource(e.target.value as typeof source)}><option value="export">CSV-экспорт</option><option value="rest">Дневной график REST</option></select></div>
      <p className="text-sm text-text-muted">{visitors.data?.note ?? "Пропущенные дни остаются неизвестными. Покрытие каждого источника показано отдельно."}</p>
      {pageId > 0 && <QueryNotice error={visitors.isError} stale={visitors.data !== undefined} retry={() => visitors.refetch()} />}
      {pageId > 0 && visitors.isLoading && !visitors.data && <StatusPanel title="Загружаем статистику посетителей…" />}
      {visitors.data && !visitors.isError && !visitors.data.days.length && <StatusPanel title="За выбранные даты нет сохранённых данных" description="Это не означает отсутствие посетителей. Выберите другой период или соберите данные." />}
      <div className="overflow-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-card text-text-muted"><tr>{["День", "Всего", "Гости", "Пользователи", "Подписчики", "Длительность (единицы провайдера)", "Покрытие"].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>{visitors.data?.days.map(day => <tr key={day.date} className="border-t border-border text-text-secondary"><td className="p-3">{day.date}</td><td className="p-3">{metric(day.totalVisitors)}</td><td className="p-3">{metric(day.guestVisitors)}</td><td className="p-3">{metric(day.userVisitors)}</td><td className="p-3">{metric(day.subscriberVisitors)}</td><td className="p-3">{metric(source === "export" ? day.avgViewDuration : day.chartDuration)}</td><td className="p-3" title={day.observationId ? `Observation ${day.observationId} · ${day.observedAt}` : undefined}>{day.availability} · {day.source}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
