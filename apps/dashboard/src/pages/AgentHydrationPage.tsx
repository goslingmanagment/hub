import { useRef, useState } from "react";
import type { AgentHydrationRequestDecideBody } from "@agency_hub_core/contracts";
import { useAgentHydrationRequests, useDecideAgentHydrationRequest } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

/**
 * The owner approval queue for agent history requests — "Дозагрузка истории"
 * on screen (Agent Read Plane, slice C; hydration in the code).
 *
 * WHAT THIS SCREEN IS FOR: an agent can write down that it wants a thread
 * deepened. It cannot make that happen. Every OnlyFans row here is a request to
 * spend something real — OFAPI credits — and the only thing that turns one into
 * work is a decision taken here (or through `hub agent hydration decide`).
 *
 * A FANSLY ROW TAKES NO APPROVAL. A Fansly page's history is read by the Fansly
 * Sync Engine as a history request (the route wraps the request into one), so
 * there is no lane here to approve and the server refuses an approval; a row
 * still waiting can only be rejected.
 *
 * THREE THINGS THE FORM REFUSES TO LET YOU SKIP, because each is a way the
 * system could otherwise spend on your behalf without you meaning it:
 *   - a CAP (`maxCalls`): an approval without one is an open tab;
 *   - an EXPIRY: an approval that never expires is a licence somebody finds
 *     six months later;
 *   - the #158 MARK-READ CONSENT, on platforms whose history read marks the
 *     fan's chat read. Approving one of those silently would change what the
 *     fan sees. The checkbox states it either way, never by omission — which
 *     is why it stays visible while the caps fold under «Изменить лимиты».
 *
 * The `rowVersion` and `coverageFingerprint` of each card travel back with the
 * decision: if the request moved, or the thread's coverage moved, the server
 * answers 409 instead of applying a decision you formed against a different
 * picture. They are shown under «Технические детали».
 */

const STATE_LABELS: Record<string, { label: string; badge: string }> = {
  requested: { label: "Ждёт решения", badge: "badge badge-accent" },
  approved: { label: "Одобрена", badge: "badge badge-success" },
  dispatching: { label: "Выполняется", badge: "badge badge-info" },
  completed: { label: "Выполнена", badge: "badge badge-success" },
  partially_completed: { label: "Выполнена частично", badge: "badge badge-warning" },
  rejected: { label: "Отклонена", badge: "badge" },
  expired: { label: "Истекла", badge: "badge" },
  failed: { label: "Ошибка", badge: "badge badge-danger" },
};

/** The state filter: the same states the queue has always offered, in words. */
const STATE_FILTERS: ReadonlyArray<{ state: string | undefined; label: string }> = [
  { state: "requested", label: "Ждут решения" },
  { state: "approved", label: "Одобренные" },
  { state: "dispatching", label: "Выполняются" },
  { state: "completed", label: "Выполненные" },
  { state: "failed", label: "С ошибкой" },
  { state: undefined, label: "Все" },
];

const COST_NOTES: Record<string, string> = {
  ofapi_credits: "тратит кредиты OnlyFans API",
};

interface DecisionDraft {
  maxCalls: number;
  maxPages: number;
  maxCredits: number;
  expiresInHours: number;
  allowMarkRead: boolean;
  reason: string;
}

interface ReviewedRequest {
  requestRef: string;
  rowVersion: number;
  coverageFingerprint: string;
}

export interface ReviewedHydrationDraft extends DecisionDraft {
  expectedVersion: number;
  coverageFingerprint: string;
}

export function createHydrationDraft(request: ReviewedRequest): ReviewedHydrationDraft {
  return { ...EMPTY_DRAFT, expectedVersion: request.rowVersion, coverageFingerprint: request.coverageFingerprint };
}

export function hydrationDraftMatches(draft: ReviewedHydrationDraft, request: ReviewedRequest): boolean {
  return draft.expectedVersion === request.rowVersion && draft.coverageFingerprint === request.coverageFingerprint;
}

export function reviewHydrationDraft(draft: ReviewedHydrationDraft, request: ReviewedRequest): ReviewedHydrationDraft {
  return { ...draft, expectedVersion: request.rowVersion, coverageFingerprint: request.coverageFingerprint, allowMarkRead: false };
}

export function hydrationApprovalError(draft: DecisionDraft): string | null {
  if (!Number.isInteger(draft.maxCalls) || draft.maxCalls < 1 || draft.maxCalls > 500) return "Лимит запросов — целое число от 1 до 500.";
  if (!Number.isInteger(draft.maxPages) || draft.maxPages < 1 || draft.maxPages > 500) return "Лимит страниц — целое число от 1 до 500.";
  if (!Number.isInteger(draft.maxCredits) || draft.maxCredits < 0 || draft.maxCredits > 100_000) return "Лимит кредитов — целое число от 0 до 100 000.";
  if (!Number.isFinite(draft.expiresInHours) || draft.expiresInHours <= 0 || !Number.isFinite(new Date(Date.now() + draft.expiresInHours * 3_600_000).getTime())) return "Укажите срок действия одобрения — положительное число часов.";
  return null;
}

export function prepareHydrationDecision(
  request: ReviewedRequest,
  draft: ReviewedHydrationDraft,
  decision: "approve" | "reject",
): { error: string } | { body: AgentHydrationRequestDecideBody } {
  const error = !hydrationDraftMatches(draft, request)
    ? "Заявка изменилась. Проверьте текущую версию, прежде чем решать."
    : decision === "approve" ? hydrationApprovalError(draft)
      : !draft.reason.trim() ? "Укажите причину, прежде чем отклонить заявку." : null;
  if (error) return { error };
  return { body: {
    decision,
    expectedVersion: draft.expectedVersion,
    coverageFingerprint: draft.coverageFingerprint,
    idempotencyKey: crypto.randomUUID(),
    ...(decision === "approve" ? {
      maxCalls: draft.maxCalls,
      maxPages: draft.maxPages,
      maxCredits: draft.maxCredits,
      expiresAt: new Date(Date.now() + draft.expiresInHours * 3_600_000).toISOString(),
      allowMarkReadSideEffect: draft.allowMarkRead,
    } : { reason: draft.reason.trim() }),
  } };
}

export function hydrationDecisionAttempt(
  previous: AgentHydrationRequestDecideBody | undefined,
  request: ReviewedRequest,
  draft: ReviewedHydrationDraft,
  decision: "approve" | "reject",
): { error: string } | { body: AgentHydrationRequestDecideBody } {
  // A manual recovery repeats the exact idempotent request, including expiry.
  return previous ? { body: previous } : prepareHydrationDecision(request, draft, decision);
}

/** Whether this queue can approve the request: only a platform with a
 *  hydration lane to run it. A Fansly request is the Fansly Sync Engine's
 *  history request and takes no approval. */
export function hydrationRequestTakesApproval(request: { platform: string }): boolean {
  return request.platform !== "fansly";
}

export function hydrationDecisionStatusIsDefiniteRefusal(status: number | null): boolean {
  return status !== null && [400, 401, 403, 404, 409, 422].includes(status);
}

function creditsWord(value: number) {
  return ruPlural(value, "кредит", "кредита", "кредитов");
}

export function frozenHydrationDecisionSummary(body: AgentHydrationRequestDecideBody): string {
  return body.decision === "approve"
    ? `Зафиксировано одобрение · запросов до ${body.maxCalls} · страниц до ${body.maxPages} · кредитов до ${body.maxCredits} · действует до ${formatDateTime(body.expiresAt ?? "")} · отметка «прочитано»: ${body.allowMarkReadSideEffect ? "разрешена" : "запрещена"}`
    : `Зафиксирован отказ · причина: ${body.reason}`;
}

/** "Одобрить · до 5 кредитов, 24 ч": the button says what it permits. */
function approveLabel(draft: DecisionDraft): string {
  const hours = Number.isFinite(draft.expiresInHours) ? draft.expiresInHours : 0;
  return `Одобрить · до ${draft.maxCredits} ${creditsWord(draft.maxCredits)}, ${hours} ч`;
}

/**
 * All THREE ceilings, always. The OnlyFans capture lane refuses a job missing any
 * of them and dies on its first lease; one approval buys one attempt, so a form
 * that sent only `maxCalls` was quietly spending the owner's decision on a job
 * that could never run.
 */
const EMPTY_DRAFT: DecisionDraft = {
  maxCalls: 5,
  maxPages: 5,
  maxCredits: 5,
  expiresInHours: 24,
  allowMarkRead: false,
  reason: "",
};

function CapInput(props: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="field-label">{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="input w-28"
      />
    </label>
  );
}

export function AgentHydrationPage() {
  const [stateFilter, setStateFilter] = useState<string | undefined>("requested");
  const [drafts, setDrafts] = useState<Record<string, ReviewedHydrationDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempts, setAttempts] = useState<Record<string, { body: AgentHydrationRequestDecideBody; confirmed: boolean }>>({});
  const submitting = useRef(false);
  const { data, isLoading, isError, error: queryError, isFetching, refetch } = useAgentHydrationRequests({
    ...(stateFilter === undefined ? {} : { state: stateFilter }),
    limit: 50,
  });
  const decide = useDecideAgentHydrationRequest();

  const draftFor = (request: ReviewedRequest) => drafts[request.requestRef] ?? createHydrationDraft(request);
  const setDraft = (request: ReviewedRequest, patch: Partial<DecisionDraft>) => {
    setDrafts((current) => ({
      ...current,
      [request.requestRef]: { ...(current[request.requestRef] ?? createHydrationDraft(request)), ...patch },
    }));
  };

  async function submit(
    request: ReviewedRequest,
    decision: "approve" | "reject",
  ) {
    if (submitting.current || decide.isPending || isError) return;
    const draft = draftFor(request);
    if (attempts[request.requestRef]?.confirmed) return;
    const prepared = hydrationDecisionAttempt(attempts[request.requestRef]?.body, request, draft, decision);
    if ("error" in prepared) {
      setErrors((current) => ({ ...current, [request.requestRef]: prepared.error }));
      return;
    }
    // Keep the reviewed version even when the owner submitted untouched defaults.
    setDrafts((current) => ({ ...current, [request.requestRef]: draft }));
    submitting.current = true;
    setAttempts((current) => ({ ...current, [request.requestRef]: { body: prepared.body, confirmed: false } }));
    setErrors((current) => ({ ...current, [request.requestRef]: "" }));
    try {
      await decide.mutateAsync({
        requestRef: request.requestRef,
        body: prepared.body,
      });
      setAttempts((current) => ({ ...current, [request.requestRef]: { body: prepared.body, confirmed: true } }));
    } catch (error) {
      const definiteRefusal = error instanceof KernelApiError && hydrationDecisionStatusIsDefiniteRefusal(error.status);
      if (definiteRefusal) setAttempts((current) => {
        const next = { ...current };
        delete next[request.requestRef];
        return next;
      });
      setErrors((current) => ({
        ...current,
        [request.requestRef]: `${error instanceof Error ? error.message : String(error)}${definiteRefusal ? "" : " Итог неизвестен. Сначала обновите список; повтор отправит точно то же решение, и дважды оно не применится."}`,
      }));
    } finally {
      submitting.current = false;
    }
  }

  const refreshButton = (
    <button type="button" disabled={isFetching} onClick={() => void refetch()} className="btn btn-sm">
      {isFetching ? "Обновляем…" : "Обновить"}
    </button>
  );

  const intro = (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-3xl">
        <p className="text-sm text-text-secondary">
          AI-агенты просят догрузить старую историю переписки. На OnlyFans это тратит кредиты, поэтому заявка
          выполняется только после вашего одобрения и только в пределах лимитов.
        </p>
      </div>
      {refreshButton}
    </div>
  );

  if (isLoading || !data) {
    return (
      <div>
        {intro}
        {isLoading ? (
          <StatusPanel title="Загружаем заявки…" />
        ) : (
          <StatusPanel
            title="Заявки не загрузились"
            description={
              isError
                ? "Сервер не ответил. Если дозагрузка истории выключена в Система → Возможности, очередь недоступна."
                : "Сервер не вернул данных."
            }
            tone="error"
          />
        )}
      </div>
    );
  }

  const items = data.items ?? [];

  return (
    <div>
      {intro}

      {isError && <StaleDataNotice title="Не удалось обновить список — решения на паузе" error={queryError} className="mb-4" />}

      <div className="segmented mb-5 max-w-full flex-wrap" role="group" aria-label="Состояние заявки">
        {STATE_FILTERS.map(({ state, label }) => (
          <button
            key={state ?? "all"}
            type="button"
            aria-pressed={stateFilter === state}
            onClick={() => setStateFilter(state)}
            className="segment"
          >
            {label}
          </button>
        ))}
      </div>

      {items.length === 0 && (
        <StatusPanel
          title="Заявок нет"
          description="Под этот фильтр не подходит ни одна заявка."
        />
      )}

      <div className="space-y-4">
        {items.map((request) => {
          const draft = draftFor(request);
          const error = errors[request.requestRef];
          const decidable = request.state === "requested";
          const approvable = hydrationRequestTakesApproval(request);
          const changed = !hydrationDraftMatches(draft, request);
          const approvalError = hydrationApprovalError(draft);
          const attempt = attempts[request.requestRef];
          const state = STATE_LABELS[request.state] ?? { label: request.state, badge: "badge" };
          const costNote = request.admissibility.costNote ? COST_NOTES[request.admissibility.costNote] : undefined;
          return (
            <article key={request.requestRef} className="card">
              <div className="card-body space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={state.badge}>{state.label}</span>
                  <span className="text-sm font-semibold text-text-primary">{request.pageLabel}</span>
                  {request.platform === "onlyfans" || request.platform === "fansly"
                    ? <PlatformBadge platform={request.platform} />
                    : <span className="text-sm text-text-secondary">{request.platform}</span>}
                  <span className="text-sm text-text-secondary">чат {request.conversationRef}</span>
                  <span className="ml-auto text-[13px] text-text-secondary">
                    {formatRelativeTime(request.createdAt)}
                  </span>
                </div>

                <p className="text-sm text-text-primary">
                  {request.target.beforeAt
                    ? `Догрузить историю до ${formatDateTime(request.target.beforeAt, { yearUnlessCurrent: true })}`
                    : request.target.beforeMessageRef
                      ? `Догрузить историю до сообщения ${request.target.beforeMessageRef}`
                      : "Догрузить историю"}
                  {approvable
                    ? costNote ? <span className="text-text-secondary"> · {costNote}</span> : null
                    : !decidable ? <span className="text-text-secondary"> · историю загружает сбор данных Fansly</span> : null}
                </p>

                {request.decision && (
                  <p className="text-[13px] text-text-secondary">
                    {request.decision.approved ? "Одобрено" : "Отклонено"}
                    {" "}
                    {formatRelativeTime(request.decision.decidedAt)}
                    {request.decision.approved && (
                      <>
                        {" "}· лимиты: запросов {request.decision.maxCalls ?? "—"}, страниц {request.decision.maxPages ?? "—"},
                        {" "}кредитов {request.decision.maxCredits ?? "—"} · отметка «прочитано»
                        {" "}
                        {request.decision.allowMarkReadSideEffect ? "разрешена" : "запрещена"}
                      </>
                    )}
                  </p>
                )}

                {request.progress.executionRef && (
                  <p className="text-[13px] text-text-secondary">
                    Выполнение: загружено записей — {request.progress.acceptedItems}
                  </p>
                )}

                <details className="help">
                  <summary>Технические детали</summary>
                  <dl className="help-body grid max-w-none grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium text-text-primary">Способ: </dt>
                      <dd className="inline">
                        {approvable
                          ? `${request.admissibility.selected ?? "нет"} · ${request.admissibility.costNote ?? "—"}`
                          : "Сбор данных Fansly · запрос истории"}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-text-primary">Агент: </dt>
                      <dd className="inline font-mono text-xs">{request.requestedBy.keyPrefix}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-text-primary">Версия заявки: </dt>
                      <dd className="inline tabular-nums">{request.rowVersion}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-text-primary">Причина агента: </dt>
                      <dd className="inline">
                        {request.reasonLength} {ruPlural(request.reasonLength, "знак", "знака", "знаков")}, отпечаток{" "}
                        <span className="font-mono text-xs">{request.reasonSha256.slice(0, 12)}…</span>
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="inline font-medium text-text-primary">Покрытие: </dt>
                      <dd className="inline break-all font-mono text-xs">{request.coverageFingerprint.slice(0, 16)}…</dd>
                    </div>
                    {request.progress.executionRef && (
                      <div className="sm:col-span-2">
                        <dt className="inline font-medium text-text-primary">Выполнение: </dt>
                        <dd className="inline break-all">
                          <span className="font-mono text-xs">{request.progress.executionRef}</span> · последняя ошибка: {request.progress.lastError}
                        </dd>
                      </div>
                    )}
                  </dl>
                </details>
              </div>

              {decidable && (
                <div className="card-footer block space-y-3 text-sm">
                  {changed && (
                    <div role="alert" className="notice notice-warning">
                      <div>
                        <p>
                          Заявка изменилась после того, как вы начали решение. Лимиты сохранены; проверьте заявку и
                          заново решите про отметку «прочитано».
                        </p>
                        <button type="button" disabled={decide.isPending || isError || Boolean(attempt)} className="btn btn-sm mt-2" onClick={() => {
                          setDrafts((current) => ({ ...current, [request.requestRef]: reviewHydrationDraft(draft, request) }));
                          setErrors((current) => ({ ...current, [request.requestRef]: "" }));
                        }}>Проверено — оставить лимиты</button>
                      </div>
                    </div>
                  )}
                  {!approvable && (
                    <p className="text-[13px] text-text-secondary">
                      Историю этой страницы загружает сбор данных Fansly, одобрять здесь нечего. Ждущую заявку можно отклонить.
                    </p>
                  )}
                  <fieldset disabled={decide.isPending || Boolean(attempt)} className="min-w-0 space-y-3">
                    {approvable && (
                      <>
                        <details className="help">
                          <summary>Изменить лимиты</summary>
                          <div className="help-body max-w-none">
                            <div className="flex flex-wrap items-end gap-3">
                              <CapInput label="Лимит запросов" value={draft.maxCalls} min={1} max={500} onChange={(value) => setDraft(request, { maxCalls: value })} />
                              <CapInput label="Лимит страниц" value={draft.maxPages} min={1} max={500} onChange={(value) => setDraft(request, { maxPages: value })} />
                              <CapInput label="Лимит кредитов" value={draft.maxCredits} min={0} max={100000} onChange={(value) => setDraft(request, { maxCredits: value })} />
                              <CapInput label="Действует, ч" value={draft.expiresInHours} min={1} onChange={(value) => setDraft(request, { expiresInHours: value })} />
                            </div>
                            <p className="text-xs">
                              Сейчас: до {draft.maxCalls} запросов, {draft.maxPages} страниц и {draft.maxCredits} {creditsWord(draft.maxCredits)}; одобрение действует {draft.expiresInHours} ч.
                            </p>
                          </div>
                        </details>
                        <label className="flex items-start gap-2 text-[13px] text-text-primary">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={draft.allowMarkRead}
                            onChange={(event) =>
                              setDraft(request, { allowMarkRead: event.target.checked })}
                          />
                          <span>
                            Разрешить отметить этот чат прочитанным на площадке — чтение истории может это сделать,
                            и фан это увидит
                          </span>
                        </label>
                      </>
                    )}

                    <label className="block max-w-xl">
                      <span className="field-label">Причина (обязательна для отказа)</span>
                      <input
                        type="text"
                        value={draft.reason}
                        maxLength={1000}
                        onChange={(event) =>
                          setDraft(request, { reason: event.target.value })}
                        className="input"
                      />
                    </label>
                  </fieldset>

                  <div className="flex flex-wrap gap-2">
                    {approvable && (
                      <button
                        type="button"
                        disabled={decide.isPending || isError || changed || approvalError !== null || Boolean(attempt)}
                        onClick={() => void submit(request, "approve")}
                        className="btn btn-primary"
                      >
                        {approveLabel(draft)}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={decide.isPending || isError || changed || !draft.reason.trim() || Boolean(attempt)}
                      onClick={() => void submit(request, "reject")}
                      className="btn"
                    >
                      Отклонить
                    </button>
                  </div>

                  {approvable && approvalError && <p className="text-[13px] text-danger">{approvalError}</p>}

                  {error && (
                    <p role="alert" className="text-[13px] text-danger">{error}</p>
                  )}
                  {attempt && <div className="text-[13px] text-text-secondary" role="status">
                    {attempt.confirmed ? "Сервер принял решение. Обновите список, чтобы увидеть состояние заявки." : `Решение отправлено (${attempt.body.decision === "approve" ? "одобрение" : "отказ"}); его лимиты и срок зафиксированы, пока не известен итог.`}
                    <p className="mt-1 break-words">{frozenHydrationDecisionSummary(attempt.body)}</p>
                    {!attempt.confirmed && error && <button type="button" disabled={decide.isPending || isError} className="btn btn-sm mt-2" onClick={() => void submit(request, attempt.body.decision)}>Повторить {attempt.body.decision === "approve" ? "то же одобрение" : "тот же отказ"}</button>}
                  </div>}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {items.length === 50 && <p className="mt-4 text-[13px] text-text-secondary">Показаны первые 50 заявок. Чтобы увидеть остальные, выберите другое состояние.</p>}
    </div>
  );
}
