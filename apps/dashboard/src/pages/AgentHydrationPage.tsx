import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { AgentHydrationRequest } from "@agency_hub_core/contracts";
import { useAgentHydrationRequests, useAuthMe, useDecideAgentHydrationRequest } from "@/api/queries";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatRelativeTime } from "@/lib/format";
import {
  beginHydrationReview, hydrationDecisionFailure, hydrationListFilters, hydrationRequestExpired,
  hydrationReviewChanged, hydrationStateLabels, hydrationStorageKey, prepareHydrationDecision,
  restoreHydrationWorkspace, serializeHydrationWorkspace, settleHydrationWorkspace,
  type HydrationDecisionDraft, type HydrationDecisionWorkspace,
} from "@/lib/agentHydrationReview";

const buttonClass = "min-h-10 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = `${buttonClass} border-accent bg-accent text-white hover:bg-accent/90`;
const fieldClass = "mt-1 min-h-10 w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
const stateStyles: Record<AgentHydrationRequest["state"], string> = {
  requested: "bg-accent/10 text-accent", approved: "bg-success/10 text-success", dispatching: "bg-accent/10 text-accent",
  completed: "bg-success/10 text-success", partially_completed: "bg-warning/10 text-warning",
  rejected: "bg-text-muted/10 text-text-muted", expired: "bg-text-muted/10 text-text-muted", failed: "bg-danger/10 text-danger",
};
const costLabels = {
  no_direct_cost: "Без прямых затрат",
  egress_quota_and_ban_risk: "Квота обращений и риск блокировки аккаунта; кредиты не списываются",
  ofapi_credits: "Расход кредитов OFAPI. Нужен предел от 1 кредита и разрешение отмечать диалог прочитанным",
};
const laneLabels = { free_local_replay: "Обработка сохранённых данных", vendor_paid_low: "Запрос истории на платформе", vendor_paid_high: "Запрос истории через OFAPI" };
const progressErrors = {
  none: "Нет", vendor_unavailable: "Платформа недоступна", proxy_missing: "Нет маршрута подключения",
  budget_exhausted: "Достигнут предел затрат", retention_limit: "Достигнута граница доступной истории",
  quarantined: "Выполнение приостановлено защитой", timeout: "Время ожидания истекло",
};

function dateTime(value: string) {
  return new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function Heading() {
  return <header className="mb-5"><h1 className="text-xl font-extrabold text-text-primary">Запросы дозагрузки</h1><p className="mt-1 max-w-3xl text-sm text-text-muted">Агенты запрашивают более раннюю историю диалога. Проверьте цель и пределы затрат перед решением. Одно согласование разрешает одну попытку дозагрузки.</p></header>;
}

export function HydrationRequestDetails({ request }: { request: AgentHydrationRequest }) {
  return <>
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      <span className={`rounded-full px-2 py-1 text-xs font-medium ${stateStyles[request.state]}`}>{hydrationStateLabels[request.state]}</span>
      <h3 className="min-w-0 break-all text-sm font-semibold text-text-primary">{request.pageLabel} · {request.platform}</h3>
      <time className="text-xs text-text-muted sm:ml-auto" dateTime={request.createdAt} title={dateTime(request.createdAt)}>Создан {formatRelativeTime(request.createdAt)}</time>
    </div>
    <dl className="mt-3 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
      <div className="min-w-0"><dt className="text-xs text-text-muted">Диалог</dt><dd className="break-all text-text-primary">{request.conversationRef}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-text-muted">Дозагрузить историю раньше</dt><dd className="break-all text-text-primary">{request.target.beforeAt ? dateTime(request.target.beforeAt) : `сообщения ${request.target.beforeMessageRef ?? "—"}`}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-text-muted">Способ и затраты</dt><dd className="text-text-primary">{request.admissibility.selected ? laneLabels[request.admissibility.selected] : "Способ не выбран"}</dd><dd className="mt-1 text-xs text-text-muted">{request.admissibility.costNote ? costLabels[request.admissibility.costNote] : "Оценка затрат недоступна"}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-text-muted">{request.decision?.approved ? "Согласование действует до" : "Срок запроса"}</dt><dd className="text-text-primary">{request.expiresAt ? dateTime(request.expiresAt) : "Не указан"}</dd><dd className="mt-1 break-all text-xs text-text-muted">Запросил агент {request.requestedBy.keyPrefix}</dd></div>
    </dl>
    {!request.admissibility.admissible && <p className="mt-3 text-sm text-warning">Дозагрузка сейчас недоступна{request.admissibility.reason ? `: ${request.admissibility.reason}` : "."}</p>}
    {request.decision && <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-text-muted">
      <p className="font-medium text-text-primary">{request.decision.approved ? "Согласовано" : "Отклонено"} {request.decision.decisionSource === "auto_policy" ? `автоматической политикой v${request.decision.policyVersion ?? "—"}` : "владельцем"} · {dateTime(request.decision.decidedAt)}</p>
      {request.decision.approved && <><p>Пределы: {request.decision.maxCalls ?? "—"} вызовов · {request.decision.maxPages ?? "—"} страниц ответа · {request.decision.maxCredits ?? "—"} кредитов{request.decision.maxItems !== null ? ` · ${request.decision.maxItems} записей` : ""}.</p><p>Отмечать диалог прочитанным: {request.decision.allowMarkReadSideEffect === null ? "не указано" : request.decision.allowMarkReadSideEffect ? "разрешено" : "запрещено"}.</p></>}
    </div>}
    {(request.progress.dispatchCount > 0 || request.progress.executionRef !== null || request.progress.lastError !== "none") && <div className="mt-3 space-y-1 text-xs text-text-muted"><p>Попыток: {request.progress.dispatchCount}. Сохранено {request.progress.acceptedItems} записей на {request.progress.acceptedPages} страницах ответа. Потрачено {request.progress.spentCredits} кредитов.</p>{request.progress.lastError !== "none" && <p className="text-warning">Причина остановки: {progressErrors[request.progress.lastError]}.</p>}</div>}
    {request.state === "approved" && <p className="mt-3 text-xs text-text-muted">Решение сохранено. Ожидается запуск; история ещё не дозагружена.</p>}
    {request.state === "partially_completed" && <p className="mt-3 text-xs text-text-muted">Получена часть истории. Повторная попытка требует нового запроса и отдельного решения.</p>}
    {request.state === "failed" && <p className="mt-3 text-xs text-text-muted">Эта попытка завершилась ошибкой. Повторная попытка требует нового запроса и отдельного решения.</p>}
    <details className="mt-3 text-xs text-text-muted"><summary className="min-h-8 cursor-pointer py-1 focus-visible:outline-2">Технические сведения · версия {request.rowVersion}</summary><dl className="mt-2 space-y-2 break-all"><div><dt>Номер запроса</dt><dd className="font-mono">{request.requestRef}</dd></div><div><dt>Отпечаток покрытия</dt><dd className="font-mono">{request.coverageFingerprint}</dd></div><div><dt>Причина агента хранится как отпечаток ({request.reasonLength} символов)</dt><dd className="font-mono">{request.reasonSha256}</dd></div>{request.progress.executionRef && <div><dt>Выполнение</dt><dd className="font-mono">{request.progress.executionRef}</dd></div>}</dl></details>
  </>;
}

function loadWorkspace(ownerId: number) {
  if (typeof window === "undefined") return { workspace: null, failed: false, message: "" };
  try { return { workspace: restoreHydrationWorkspace(window.sessionStorage.getItem(hydrationStorageKey(ownerId)), ownerId), failed: false, message: "" }; }
  catch { return { workspace: null, failed: true, message: "Не удалось прочитать сохранённое решение этой вкладки. Новое решение недоступно, пока сохранённый результат не восстановлен. Чтение очереди работает." }; }
}

export function AgentHydrationPage() {
  const auth = useAuthMe();
  if (!auth.data) return <div className="p-4 md:p-0"><Heading /><QueryNotice error={auth.isError} stale={false} retry={auth.refetch} /><StatusPanel title={auth.isError ? "Не удалось проверить сессию владельца" : "Проверяем сессию владельца"} description="Сохранённое решение привязано к учётной записи в этой вкладке." /></div>;
  return <HydrationQueue key={auth.data.user.id} ownerId={auth.data.user.id} />;
}

function HydrationQueue({ ownerId }: { ownerId: number }) {
  const [search, setSearch] = useSearchParams();
  const filters = hydrationListFilters(search);
  const query = useAgentHydrationRequests({ ...(filters.state === "all" ? {} : { state: filters.state }), limit: filters.limit });
  const decide = useDecideAgentHydrationRequest();
  const [restored] = useState(() => loadWorkspace(ownerId));
  const [workspace, setWorkspace] = useState<HydrationDecisionWorkspace | null>(restored.workspace);
  const workspaceRef = useRef(workspace);
  const [restoreFailed, setRestoreFailed] = useState(restored.failed);
  const [storageError, setStorageError] = useState(restored.message);
  const inFlight = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (workspace) reviewHeading.current?.focus(); }, [workspace?.snapshot.requestRef, workspace?.phase]);

  // Persist before admission: route changes and reloads retain the exact body/key.
  // A late promise can still settle its original owner's storage entry.
  function updateWorkspace(next: HydrationDecisionWorkspace | null, requireStorage = false, settle = false) {
    try {
      if (settle && next) {
        const saved = restoreHydrationWorkspace(window.sessionStorage.getItem(hydrationStorageKey(ownerId)), ownerId, false);
        next = settleHydrationWorkspace(saved, next);
      }
      if (next) window.sessionStorage.setItem(hydrationStorageKey(ownerId), serializeHydrationWorkspace(ownerId, next));
      else window.sessionStorage.removeItem(hydrationStorageKey(ownerId));
      setStorageError("");
    } catch {
      setStorageError("Не удалось сохранить решение в этой вкладке. Отправка недоступна: разрешите хранилище браузера и повторите подтверждение. Очередь и черновик остаются доступны.");
      if (requireStorage) return false;
    }
    workspaceRef.current = next;
    setWorkspace(next);
    return true;
  }

  function changeFilters(patch: { state?: string; limit?: number }) {
    const next = new URLSearchParams(search);
    next.set("state", patch.state ?? filters.state);
    next.set("limit", String(patch.limit ?? filters.limit));
    if (next.toString() !== search.toString()) setSearch(next);
  }

  const items = query.data?.items ?? [];
  const current = workspace ? items.find(request => request.requestRef === workspace.snapshot.requestRef) : undefined;
  const changed = workspace ? hydrationReviewChanged(workspace.snapshot, current) : false;
  const expired = workspace ? hydrationRequestExpired(workspace.snapshot, now) : false;
  const busy = workspace?.phase === "sending";
  const unresolved = busy || workspace?.phase === "uncertain";
  const reviewUnavailable = changed || expired || query.isError || !query.data;

  function changeDraft(patch: Partial<HydrationDecisionDraft>) {
    const active = workspaceRef.current;
    if (!active || active.phase !== "editing") return;
    updateWorkspace({ ...active, draft: { ...active.draft, ...patch }, error: "" });
  }

  function prepare(decision: "approve" | "reject") {
    const active = workspaceRef.current;
    if (!active || active.phase !== "editing" || reviewUnavailable || inFlight.current) return;
    try {
      const body = prepareHydrationDecision(active.snapshot, active.draft, decision, Date.now(), crypto.randomUUID());
      updateWorkspace({ ...active, body, phase: "review", error: "" });
    } catch (error) { updateWorkspace({ ...active, error: error instanceof Error ? error.message : String(error) }); }
  }

  async function submit() {
    const active = workspaceRef.current;
    if (inFlight.current || !active?.body || !["review", "uncertain"].includes(active.phase)) return;
    if (active.phase === "review" && (reviewUnavailable || hydrationRequestExpired(active.snapshot, Date.now()))) return;
    if (active.phase === "review" && active.body.expiresAt && Date.parse(active.body.expiresAt) <= Date.now()) {
      updateWorkspace({ ...active, phase: "editing", body: null, error: "Срок подготовленного согласования истёк. Проверьте срок и подготовьте решение заново." });
      return;
    }
    const sending: HydrationDecisionWorkspace = { ...active, phase: "sending", error: "" };
    if (!updateWorkspace(sending, true)) return;
    inFlight.current = true;
    try {
      const result = await decide.mutateAsync({ requestRef: active.snapshot.requestRef, body: active.body });
      updateWorkspace({ ...sending, phase: "confirmed", result: { request: result.request, disposition: result.disposition }, error: "" }, false, true);
    } catch (error) {
      const failure = hydrationDecisionFailure(error, active.everUncertain);
      updateWorkspace({ ...sending, phase: failure.uncertain ? "uncertain" : "refused", everUncertain: failure.uncertain, error: `${failure.message}\n${failure.diagnostic}` }, false, true);
      void query.refetch();
    } finally { inFlight.current = false; }
  }

  const hasData = query.data !== undefined;
  const capped = query.data?.delivery.cappedBy !== null && query.data?.delivery.cappedBy !== undefined;
  const limitOptions = [...new Set([25, 50, 100, 200, filters.limit])].sort((a, b) => a - b);

  return <div className="min-w-0 space-y-5 p-4 md:p-0">
    <Heading />
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
      <label className="min-w-0 basis-full text-xs text-text-muted sm:basis-auto sm:flex-1"><span>Состояние запросов</span><select className={fieldClass} value={filters.state} onChange={event => changeFilters({ state: event.target.value })}>{Object.entries(hydrationStateLabels).map(([state, label]) => <option key={state} value={state}>{label}</option>)}<option value="all">Все состояния</option></select></label>
      <label className="min-w-0 flex-1 text-xs text-text-muted sm:w-44 sm:flex-none"><span>Последних запросов</span><select className={fieldClass} value={filters.limit} onChange={event => changeFilters({ limit: Number(event.target.value) })}>{limitOptions.map(limit => <option key={limit} value={limit}>{limit}</option>)}</select></label>
      <button type="button" className={buttonClass} disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "Обновляем…" : "Обновить очередь"}</button>
    </div>
    {filters.invalid && <p className="text-sm text-warning" role="status">В ссылке есть неподдерживаемые фильтры. Показаны допустимые значения. <button type="button" className="underline" onClick={() => changeFilters({})}>Исправить ссылку</button></p>}
    {storageError && <div role="alert" className="rounded-xl border border-warning p-3 text-sm text-warning"><p>{storageError}</p>{restoreFailed && <button type="button" className={`${buttonClass} mt-2`} onClick={() => { const retry = loadWorkspace(ownerId); setRestoreFailed(retry.failed); setStorageError(retry.message); if (!retry.failed) { workspaceRef.current = retry.workspace; setWorkspace(retry.workspace); } }}>Восстановить сохранённое решение</button>}</div>}

    {workspace && <section aria-labelledby="hydration-review-title" className="min-w-0 space-y-4 rounded-xl border-2 border-accent/40 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="hydration-review-title" ref={reviewHeading} tabIndex={-1} className="text-base font-bold text-text-primary focus-visible:outline-2">{workspace.phase === "confirmed" ? "Результат решения" : workspace.phase === "editing" ? "1. Проверьте запрос и задайте условия" : "2. Проверьте решение перед отправкой"}</h2><p className="mt-1 text-xs text-text-muted">{workspace.phase === "confirmed" ? "Сохранённый ответ сервера" : `Решение относится к показанной версии ${workspace.snapshot.rowVersion}. Фильтры очереди не меняют этот запрос.`}</p></div>{!unresolved && <button type="button" className={buttonClass} onClick={() => updateWorkspace(null)}>{workspace.phase === "confirmed" ? "Закрыть результат" : "Закрыть проверку"}</button>}</div>
      <HydrationRequestDetails request={workspace.result?.request ?? workspace.snapshot} />
      {workspace.phase !== "confirmed" && changed && <p role="alert" className="rounded-lg border border-warning p-3 text-sm text-warning">В очереди уже другая версия этого запроса. Снимок и условия проверки сохранены. {current && <span>Текущее состояние: {hydrationStateLabels[current.state]}, версия {current.rowVersion}.</span>}</p>}
      {workspace.phase !== "confirmed" && expired && <p role="status" className="text-sm text-warning">Срок исходного запроса истёк. Новое решение по нему недоступно.</p>}
      {workspace.error && <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-warning p-3 text-sm text-warning">{workspace.error}</p>}
      {workspace.phase === "editing" && <form className="space-y-4 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); prepare("approve"); }} noValidate>
        <fieldset disabled={reviewUnavailable} className="space-y-4 disabled:opacity-60"><legend className="mb-3 text-sm font-semibold text-text-primary">Пределы одной попытки</legend>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{([
            ["maxCalls", "Вызовы", 1, 500, "1", "От 1 до 500"],
            ["maxPages", "Страницы ответа", 1, 500, "1", "От 1 до 500"],
            ["maxCredits", "Кредиты", 0, 100_000, "1", "От 0 до 100 000; минимум OFAPI — 1"],
            ["expiresInHours", "Срок действия, часов", 0, undefined, "any", "Точное время будет показано перед отправкой"],
          ] as const).map(([field, label, min, max, step, help]) => <label key={field} className="min-w-0 text-xs text-text-muted"><span className="font-medium text-text-primary">{label}</span><input className={fieldClass} type="number" min={min} max={max} step={step} value={workspace.draft[field]} onChange={event => changeDraft({ [field]: event.target.value })} aria-describedby={`hydration-${field}-help`} required /><span id={`hydration-${field}-help`} className="mt-1 block">{help}</span></label>)}</div>
          <fieldset className="space-y-2 rounded-lg border border-border p-3"><legend className="px-1 text-sm font-medium text-text-primary">Можно отметить диалог прочитанным на платформе?</legend><p className="text-xs text-text-muted">Чтение истории через OFAPI меняет статус диалога. Для такой дозагрузки нужно явное разрешение. Сервер проверит, выполнимо ли решение.</p>{([{ value: false, label: "Нет, сохранить статус прочтения" }, { value: true, label: "Да, разрешаю отметить диалог прочитанным" }] as const).map(option => <label key={String(option.value)} className="flex min-h-10 items-start gap-2 py-1 text-sm text-text-primary"><input className="mt-1" type="radio" name="hydration-mark-read" checked={workspace.draft.allowMarkRead === option.value} onChange={() => changeDraft({ allowMarkRead: option.value })} />{option.label}</label>)}</fieldset>
          <label className="block text-xs text-text-muted"><span className="font-medium text-text-primary">Причина отказа</span><textarea className={fieldClass} rows={2} value={workspace.draft.reason} maxLength={1000} onChange={event => changeDraft({ reason: event.target.value })} /><span className="mt-1 block">Обязательна только для отказа; до 1000 символов.</span></label>
          <div className="flex flex-wrap gap-2"><button type="submit" className={primaryClass} disabled={!workspace.snapshot.admissibility.admissible}>Проверить согласование</button><button type="button" className={buttonClass} onClick={() => prepare("reject")}>Проверить отказ</button></div>
        </fieldset>
      </form>}
      {workspace.body && workspace.phase !== "confirmed" && <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-text-primary">{workspace.body.decision === "approve" ? "Будет разрешена одна попытка дозагрузки" : "Запрос будет отклонён"}</h3>
        {workspace.body.decision === "approve" ? <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-text-muted">Максимальный расход</dt><dd>{workspace.body.maxCalls} вызовов · {workspace.body.maxPages} страниц ответа · {workspace.body.maxCredits} кредитов</dd></div><div><dt className="text-text-muted">Согласование действует до</dt><dd>{workspace.body.expiresAt ? dateTime(workspace.body.expiresAt) : "—"}</dd></div><div className="sm:col-span-2"><dt className="text-text-muted">Отметить диалог прочитанным</dt><dd className="font-medium">{workspace.body.allowMarkReadSideEffect ? "Разрешено" : "Запрещено"}</dd></div></dl> : <p className="whitespace-pre-wrap break-words text-sm">Причина: {workspace.body.reason}</p>}
        <p className="break-all text-xs text-text-muted">Ключ решения: <span className="font-mono">{workspace.body.idempotencyKey}</span></p>
        {workspace.phase === "review" && <div className="flex flex-wrap gap-2"><button type="button" className={primaryClass} disabled={reviewUnavailable} onClick={() => void submit()}>{workspace.body.decision === "approve" ? "Подтвердить согласование" : "Подтвердить отказ"}</button><button type="button" className={buttonClass} onClick={() => updateWorkspace({ ...workspace, body: null, phase: "editing", error: "" })}>Изменить условия</button></div>}
        {busy && <p role="status" className="text-sm text-text-primary">3. Сохраняем решение… Оно останется в этой вкладке при смене фильтра или возврате на страницу.</p>}
        {workspace.phase === "uncertain" && <div className="space-y-3"><p className="text-sm text-text-muted">Исходное решение и ключ сохранены. Явный повтор вернёт уже принятое решение, а если оно ещё не применено — отправит те же условия. Новый срок, пределы или другое решение здесь не создаются.</p><button type="button" className={buttonClass} onClick={() => void submit()}>Повторить то же решение</button></div>}
        {workspace.phase === "refused" && !reviewUnavailable && <button type="button" className={buttonClass} onClick={() => updateWorkspace({ ...workspace, body: null, phase: "editing", error: "" })}>Изменить условия после отказа сервера</button>}
      </div>}
      {workspace.phase === "confirmed" && <p role="status" className="rounded-lg bg-success/10 p-3 text-sm text-success">{workspace.result?.disposition === "already_decided" ? "Сервер подтвердил ранее сохранённое решение." : "Решение сохранено на сервере."} {workspace.result?.request.decision?.approved ? "Согласование само по себе не означает, что дозагрузка завершилась." : "Расход по этому решению не разрешён."}</p>}
      {!unresolved && workspace.phase !== "confirmed" && changed && current?.state === "requested" && !query.isError && <button type="button" className={buttonClass} onClick={() => updateWorkspace(beginHydrationReview(current))}>Начать проверку актуальной версии</button>}
    </section>}

    <section aria-label="Очередь запросов дозагрузки" className="min-w-0 space-y-3">
      <QueryNotice error={query.isError} stale={hasData} retry={query.refetch} />
      {!hasData && !query.isError && <StatusPanel title="Загружаем запросы дозагрузки" description="Получаем состояние очереди и условия запросов." />}
      {!hasData && query.isError && <StatusPanel title="Очередь недоступна" description="Не удалось получить запросы. Проверьте соединение и доступ, затем повторите загрузку." tone="error" />}
      {hasData && <p className="text-xs text-text-muted" role="status">Запросов в ответе: {items.length}{capped || !query.data?.delivery.matchedInScope.exact ? "; всего может быть больше" : ""}. Сначала новые. {query.isFetching ? "Обновляем состояние…" : "Состояние обновляется каждые 15 секунд."}</p>}
      {hasData && capped && <div className="rounded-lg border border-warning/40 p-3 text-sm text-text-muted"><p>Достигнут предел ответа. Более старые запросы могут не попасть в список.{filters.limit === 200 ? " Максимум — 200; выберите отдельное состояние, чтобы сузить очередь." : " Увеличьте лимит или выберите отдельное состояние."}</p>{filters.limit < 200 && <button type="button" className={`${buttonClass} mt-2`} onClick={() => changeFilters({ limit: 200 })}>Показать до 200 запросов</button>}</div>}
      {hasData && !query.isError && items.length === 0 && <StatusPanel title={filters.state === "requested" ? "Нет запросов, ожидающих решения" : "Нет запросов с выбранным состоянием"} description={filters.state === "all" ? "Очередь дозагрузки пока пуста." : "Измените фильтр, чтобы посмотреть другие состояния."} action={filters.state !== "all" ? <button type="button" className={buttonClass} onClick={() => changeFilters({ state: "all" })}>Все состояния</button> : undefined} />}
      <div className="space-y-3">{items.map(request => <article key={request.requestRef} className="min-w-0 rounded-xl border border-border bg-card p-4">
        <HydrationRequestDetails request={request} />
        {request.state === "requested" && <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3"><button type="button" className={buttonClass} disabled={workspace !== null || restoreFailed || query.isError || hydrationRequestExpired(request, now)} onClick={() => updateWorkspace(beginHydrationReview(request))}>{workspace?.snapshot.requestRef === request.requestRef ? "Открыт для проверки выше" : "Рассмотреть запрос"}</button>{hydrationRequestExpired(request, now) ? <p className="text-xs text-warning">Срок запроса истёк; ожидается обновление состояния.</p> : workspace !== null && workspace.snapshot.requestRef !== request.requestRef ? <p className="text-xs text-text-muted">Завершите или закройте текущую проверку.</p> : null}</div>}
      </article>)}</div>
    </section>
  </div>;
}
