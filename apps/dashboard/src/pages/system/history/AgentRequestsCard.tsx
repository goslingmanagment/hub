import { Fragment, useRef, useState } from "react";
import type { AgentHydrationRequest, AgentHydrationRequestDecideBody } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { hydrationRequestTakesApproval, useAgentHydrationRequests, useDecideAgentHydrationRequest } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { staleDataText } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime } from "@/lib/format";
import { buildPageRoute } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import { HISTORY_REQUEST_STATUS, OFAPI_OFF_REASON } from "@/lib/statusWords";
import { platformName, RowChevron, WhenCell, type OfapiView } from "../shared.js";

/**
 * «Заявки агентов» — the owner approval queue for agent history requests (Agent
 * Read Plane, slice C; hydration in the code).
 *
 * An agent can write down that it wants a thread deepened. It cannot make that
 * happen. Every OnlyFans row here is a request to spend something real — credits
 * of the OnlyFans API — and the only thing that turns one into work is a decision
 * taken here (or through `hub agent hydration decide`). A Fansly row takes no
 * approval: its history is read by the Fansly collection; a row still waiting can
 * only be rejected.
 *
 * The form refuses to let you skip a cap, an expiry and the mark-read consent. The
 * `rowVersion` and `coverageFingerprint` of each row travel back with the decision:
 * if the request moved, the server answers 409. The decision logic below is the old
 * screen's, unchanged; the approval now asks first (design/screens/system.md §5).
 */

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
  if (!Number.isInteger(draft.maxPages) || draft.maxPages < 1 || draft.maxPages > 500) return "Лимит порций — целое число от 1 до 500.";
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

export function hydrationDecisionStatusIsDefiniteRefusal(status: number | null): boolean {
  return status !== null && [400, 401, 403, 404, 409, 422].includes(status);
}

function creditsWord(value: number) {
  return ruPlural(value, "кредит", "кредита", "кредитов");
}

export function frozenHydrationDecisionSummary(body: AgentHydrationRequestDecideBody): string {
  return body.decision === "approve"
    ? `Зафиксировано одобрение · запросов до ${body.maxCalls} · порций до ${body.maxPages} · кредитов до ${body.maxCredits} · действует до ${formatDateTime(body.expiresAt ?? "")} · отметка «прочитано»: ${body.allowMarkReadSideEffect ? "разрешена" : "запрещена"}`
    : `Зафиксирован отказ · причина: ${body.reason}`;
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


/** The state list of the screen, `?state=`. */
export const HYDRATION_STATE_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "requested", label: "Ждут решения" },
  { value: "approved", label: "Одобренные" },
  { value: "dispatching", label: "Выполняются" },
  { value: "completed", label: "Выполненные" },
  { value: "partially_completed", label: "Выполненные частично" },
  { value: "failed", label: "С ошибкой" },
  { value: "rejected", label: "Отклонённые" },
  { value: "expired", label: "Истекшие" },
  { value: "all", label: "Все" },
];

const COST_NOTES: Record<string, string> = {
  ofapi_credits: "тратит кредиты OnlyFans API",
};

/** The Russian phrase of a refusal by its status; the server's text is not shown. */
function decisionErrorText(error: unknown, definite: boolean): string {
  const status = error instanceof KernelApiError ? error.status : null;
  const phrase = status === 409
    ? "Заявка изменилась на сервере. Обновите список и решите заново."
    : status === 404
      ? "Этой заявки больше нет."
      : status === 401 || status === 403
        ? "Нет права на это решение: войдите снова."
        : status === 400 || status === 422
          ? "Hub не принял решение: проверьте лимиты и причину."
          : "Не получилось. Hub вернул ошибку.";
  return definite ? phrase : `${phrase} Итог неизвестен. Сначала обновите список; повтор отправит точно то же решение, и дважды оно не применится.`;
}


/** "Одобрить · до 5 кредитов, 24 ч": the button says what it permits. */
function approveLabel(draft: DecisionDraft): string {
  const hours = Number.isFinite(draft.expiresInHours) ? draft.expiresInHours : 0;
  return `Одобрить · до ${draft.maxCredits} ${creditsWord(draft.maxCredits)}, ${hours} ч`;
}

function targetText(request: AgentHydrationRequest): string {
  return request.target.beforeAt
    ? `Догрузить историю до ${formatDateTime(request.target.beforeAt, { yearUnlessCurrent: true })}`
    : request.target.beforeMessageRef
      ? `Догрузить историю до сообщения ${request.target.beforeMessageRef}`
      : "Догрузить историю";
}

/** What was already decided and done, under «Что просит». */
function historyLine(request: AgentHydrationRequest): string | null {
  const approvable = hydrationRequestTakesApproval(request);
  const parts: string[] = [];
  const decision = request.decision;
  if (decision === null) {
    if (approvable) parts.push(request.admissibility.costNote ? COST_NOTES[request.admissibility.costNote] ?? "тратит кредиты" : "тратит кредиты OnlyFans API");
    else parts.push("историю загружает сбор данных Fansly");
  } else if (decision.approved) {
    const who = decision.decisionSource === "auto_policy" ? "Одобрено автоматически" : "Одобрено вами";
    parts.push(`${who} ${formatDateTime(decision.decidedAt, { yearUnlessCurrent: true })}`);
    parts.push(`лимиты: запросов ${decision.maxCalls ?? "—"}, порций ${decision.maxPages ?? "—"}, кредитов ${decision.maxCredits ?? "—"}`);
    parts.push(`отметка «прочитано» ${decision.allowMarkReadSideEffect ? "разрешена" : "запрещена"}`);
  } else {
    parts.push(`Отклонено ${formatDateTime(decision.decidedAt, { yearUnlessCurrent: true })}`);
  }
  if (request.progress.executionRef) {
    parts.push(`загружено записей: ${request.progress.acceptedItems} · потрачено ${request.progress.spentCredits} ${creditsWord(request.progress.spentCredits)}`);
  }
  return parts.join(" · ");
}

function CapInput(props: { label: string; value: number; min: number; max?: number; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="field-label">{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="input sys-cap-input"
      />
    </label>
  );
}

function RequestDetails({ request }: { request: AgentHydrationRequest }) {
  const approvable = hydrationRequestTakesApproval(request);
  return (
    <Disclosure label="Подробнее">
      <KeyValue
        rows={[
          { label: "Способ", value: approvable ? `${request.admissibility.selected ?? "нет"} · ${request.admissibility.costNote ?? "—"}` : "Сбор данных Fansly · запрос истории" },
          { label: "Агент", value: <span className="sys-code">{request.requestedBy.keyPrefix}</span> },
          { label: "Версия заявки", value: String(request.rowVersion) },
          {
            label: "Причина агента",
            value: <>{request.reasonLength} {ruPlural(request.reasonLength, "знак", "знака", "знаков")}, отпечаток <span className="sys-code">{request.reasonSha256.slice(0, 12)}…</span></>,
          },
          { label: "Покрытие", value: <span className="sys-code">{request.coverageFingerprint.slice(0, 16)}…</span> },
          ...(request.progress.executionRef
            ? [{ label: "Выполнение", value: <><span className="sys-code">{request.progress.executionRef}</span> · последняя ошибка: {request.progress.lastError ?? "нет"}</> }]
            : []),
          ...(request.decision?.decisionSource === "auto_policy" ? [{ label: "Решение", value: `политика версии ${request.decision.policyVersion ?? "—"}` }] : []),
        ]}
      />
    </Disclosure>
  );
}

/**
 * «Заявки агентов»: the table, the decision form in an opened row. The target of
 * every decision is the row's own `requestRef`, `rowVersion`, `coverageFingerprint`;
 * the page filter only narrows the rows.
 */
export function AgentRequestsCard({ state, pageLabel, ofapi, onShowAllPages }: {
  state: string;
  pageLabel: string | null;
  ofapi: OfapiView;
  onShowAllPages: () => void;
}) {
  const limit = pageLabel ? 200 : 50;
  const query = useAgentHydrationRequests({ ...(state === "all" ? {} : { state }), limit });
  const { data, isLoading, isError } = query;
  const decide = useDecideAgentHydrationRequest();
  const [drafts, setDrafts] = useState<Record<string, ReviewedHydrationDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempts, setAttempts] = useState<Record<string, { body: AgentHydrationRequestDecideBody; confirmed: boolean }>>({});
  const [opened, setOpened] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AgentHydrationRequest | null>(null);
  const submitting = useRef(false);

  const draftFor = (request: ReviewedRequest) => drafts[request.requestRef] ?? createHydrationDraft(request);
  const setDraft = (request: ReviewedRequest, patch: Partial<DecisionDraft>) => {
    setDrafts((current) => ({
      ...current,
      [request.requestRef]: { ...(current[request.requestRef] ?? createHydrationDraft(request)), ...patch },
    }));
  };

  async function submit(request: ReviewedRequest, decision: "approve" | "reject") {
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
      await decide.mutateAsync({ requestRef: request.requestRef, body: prepared.body });
      setAttempts((current) => ({ ...current, [request.requestRef]: { body: prepared.body, confirmed: true } }));
    } catch (error) {
      const definiteRefusal = error instanceof KernelApiError && hydrationDecisionStatusIsDefiniteRefusal(error.status);
      if (definiteRefusal) setAttempts((current) => {
        const next = { ...current };
        delete next[request.requestRef];
        return next;
      });
      setErrors((current) => ({ ...current, [request.requestRef]: decisionErrorText(error, definiteRefusal) }));
    } finally {
      submitting.current = false;
    }
  }

  const all = data?.items ?? [];
  const items = pageLabel ? all.filter((request) => request.pageLabel === pageLabel) : all;
  const waiting = items.filter((request) => request.state === "requested");
  // A single request waiting for a decision opens by itself.
  const openRef = opened ?? (waiting.length === 1 && state === "requested" ? waiting[0]!.requestRef : null);
  const stateLabel = HYDRATION_STATE_FILTERS.find((entry) => entry.value === state)?.label ?? "";

  return (
    <section className="card" aria-labelledby="agent-requests-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="agent-requests-title" className="card-title">Заявки агентов</h2>
          <p className="card-description sys-measure">
            На OnlyFans чтение истории тратит кредиты, поэтому заявка выполняется только после одобрения и только в пределах лимитов.
            На Fansly одобрять нечего: историю читает сбор данных.
          </p>
        </div>
      </div>
      {isError && data && (
        <div className="card-body sys-card-notice">
          <Notice tone="warning" role="alert" action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}>
            {staleDataText(query.dataUpdatedAt)} Решения на паузе, пока список не обновится.
          </Notice>
        </div>
      )}
      {isLoading && !data ? (
        <TableSkeleton rows={4} columns={4} />
      ) : !data ? (
        <NoAnswerPanel retry={query.refetch} />
      ) : items.length === 0 ? (
        pageLabel ? (
          <StatusPanel
            title={`На ${pageLabel} заявок в этом состоянии нет.`}
            action={<button type="button" className="btn btn-sm" onClick={onShowAllPages}>Показать все страницы</button>}
          />
        ) : state === "requested" ? (
          <StatusPanel title="Заявок, ждущих решения, нет" description="Заявки Fansly идут сами, заявки OnlyFans появятся, когда агент их подаст." />
        ) : (
          <StatusPanel title="Заявок в этом состоянии нет" />
        )
      ) : (
        <div className="table-wrap">
          <table className="data-table sys-hydration">
            <thead>
              <tr>
                <th>Состояние</th>
                <th>Страница и чат</th>
                <th>Что просит</th>
                <th className="sys-col-opened">Подана</th>
                <th><span className="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((request) => {
                const isOpen = openRef === request.requestRef;
                const decidable = request.state === "requested";
                const word = HISTORY_REQUEST_STATUS[request.state];
                const toggle = () => setOpened(isOpen ? "" : request.requestRef);
                return (
                  <Fragment key={request.requestRef}>
                    <tr className="sys-click-row" data-hydration-request={request.requestRef} onClick={toggle}>
                      <td className="status-col whitespace-nowrap">
                        <RowChevron open={isOpen} label={isOpen ? "Свернуть заявку" : "Раскрыть заявку"} onToggle={toggle} />
                        {word ? <StatusBadge status={word} /> : request.state}
                      </td>
                      <td>
                        <Link to={buildPageRoute(request.pageLabel)} className="sys-row-link">{request.pageLabel}</Link>
                        <span className="text-text-secondary"> {platformName(request.platform)}</span>
                        <span className="cell-second">чат {request.conversationRef}</span>
                      </td>
                      <td>
                        {targetText(request)}
                        <span className="cell-second sys-clamp">{historyLine(request)}</span>
                      </td>
                      <td className="sys-col-opened"><WhenCell at={request.createdAt} /></td>
                      <td className="sys-actions" onClick={(event) => event.stopPropagation()}>
                        {decidable && !isOpen && (
                          <button type="button" className="btn btn-sm" onClick={() => setOpened(request.requestRef)}>Решить</button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="sys-detail-row">
                        <td colSpan={5}>
                          <div className="sys-detail">
                            {decidable && (
                              <DecisionForm
                                request={request}
                                draft={draftFor(request)}
                                error={errors[request.requestRef]}
                                attempt={attempts[request.requestRef]}
                                pending={decide.isPending}
                                listFailed={isError}
                                ofapiBlock={ofapi.block}
                                setDraft={(patch) => setDraft(request, patch)}
                                onReviewed={() => {
                                  setDrafts((current) => ({ ...current, [request.requestRef]: reviewHydrationDraft(draftFor(request), request) }));
                                  setErrors((current) => ({ ...current, [request.requestRef]: "" }));
                                }}
                                onApprove={() => {
                                  // A repeat sends the very same body: the owner already confirmed it.
                                  if (attempts[request.requestRef]) void submit(request, "approve");
                                  else setConfirming(request);
                                }}
                                onReject={() => void submit(request, "reject")}
                                onRepeat={(decision) => void submit(request, decision)}
                              />
                            )}
                            <RequestDetails request={request} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && pageLabel && all.length >= limit && (
        <p className="card-footer">Показаны первые {limit} заявок состояния «{stateLabel}»: на {pageLabel} могут быть ещё.</p>
      )}
      {data && !pageLabel && all.length >= limit && (
        <p className="card-footer">Показаны первые {limit} заявок. Чтобы увидеть остальные, выберите другое состояние.</p>
      )}

      {confirming && (() => {
        const draft = draftFor(confirming);
        return (
          <ConfirmModal
            title={`Одобрить заявку на ${confirming.pageLabel}?`}
            message="Hub прочитает старую переписку через OnlyFans API."
            facts={[
              { label: "Куда", value: `${confirming.pageLabel}, ${platformName(confirming.platform)}, чат ${confirming.conversationRef}` },
              { label: "Что именно", value: targetText(confirming).replace("Догрузить", "догрузить") },
              { label: "Сколько стоит", value: `до ${draft.maxCredits} ${creditsWord(draft.maxCredits)}, ${draft.maxCalls} ${ruPlural(draft.maxCalls, "запрос", "запроса", "запросов")}, ${draft.maxPages} ${ruPlural(draft.maxPages, "порция", "порции", "порций")}` },
              { label: "Когда", value: `одобрение действует ${draft.expiresInHours} ч` },
              { label: "Кто увидит", value: draft.allowMarkRead ? "фан увидит, что чат прочитан" : "отметка «прочитано» запрещена" },
              { label: "Отменить", value: "нельзя, когда чтение началось" },
            ]}
            confirmLabel={approveLabel(draft)}
            pendingLabel="Одобряем…"
            tone="primary"
            isPending={decide.isPending}
            onConfirm={() => {
              const request = confirming;
              void submit(request, "approve").finally(() => setConfirming(null));
            }}
            onClose={() => setConfirming(null)}
          />
        );
      })()}
    </section>
  );
}

function DecisionForm({ request, draft, error, attempt, pending, listFailed, ofapiBlock, setDraft, onReviewed, onApprove, onReject, onRepeat }: {
  request: AgentHydrationRequest;
  draft: ReviewedHydrationDraft;
  error: string | undefined;
  attempt: { body: AgentHydrationRequestDecideBody; confirmed: boolean } | undefined;
  pending: boolean;
  listFailed: boolean;
  ofapiBlock: string | null;
  setDraft: (patch: Partial<DecisionDraft>) => void;
  onReviewed: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRepeat: (decision: "approve" | "reject") => void;
}) {
  const approvable = hydrationRequestTakesApproval(request);
  const changed = !hydrationDraftMatches(draft, request);
  const approvalError = hydrationApprovalError(draft);
  // The OnlyFans API reads the history: while it is off, approving waits; rejecting works.
  const vendorBlock = approvable && request.platform === "onlyfans" ? ofapiBlock : null;
  return (
    <div className="sys-decision">
      {changed && (
        <Notice
          tone="warning"
          role="alert"
          action={<button type="button" disabled={pending || listFailed || Boolean(attempt)} className="btn btn-sm" onClick={onReviewed}>Проверено, оставить лимиты</button>}
        >
          Заявка изменилась после того, как вы начали решение. Лимиты сохранены; проверьте заявку и заново решите про отметку «прочитано».
        </Notice>
      )}
      {!approvable && (
        <p className="text-text-secondary">Историю этой страницы загружает сбор данных Fansly, одобрять здесь нечего. Ждущую заявку можно отклонить.</p>
      )}
      <fieldset disabled={pending || Boolean(attempt)} className="sys-decision-fields">
        {approvable && (
          <>
            <Disclosure label="Изменить лимиты">
              <div className="sys-caps">
                <CapInput label="Лимит запросов" value={draft.maxCalls} min={1} max={500} onChange={(value) => setDraft({ maxCalls: value })} />
                <CapInput label="Лимит порций" value={draft.maxPages} min={1} max={500} onChange={(value) => setDraft({ maxPages: value })} />
                <CapInput label="Лимит кредитов" value={draft.maxCredits} min={0} max={100000} onChange={(value) => setDraft({ maxCredits: value })} />
                <CapInput label="Действует, ч" value={draft.expiresInHours} min={1} onChange={(value) => setDraft({ expiresInHours: value })} />
              </div>
              <p>
                Сейчас: до {draft.maxCalls} {ruPlural(draft.maxCalls, "запроса", "запросов", "запросов")}, {draft.maxPages} {ruPlural(draft.maxPages, "порции", "порций", "порций")} и {draft.maxCredits} {creditsWord(draft.maxCredits)}; одобрение действует {draft.expiresInHours} ч.
              </p>
            </Disclosure>
            <label className="sys-check">
              <input type="checkbox" checked={draft.allowMarkRead} onChange={(event) => setDraft({ allowMarkRead: event.target.checked })} />
              <span>Разрешить отметить этот чат прочитанным на площадке: чтение истории может это сделать, и фан это увидит</span>
            </label>
          </>
        )}
        <label className="block sys-measure">
          <span className="field-label">Причина (обязательна для отказа)</span>
          <input type="text" value={draft.reason} maxLength={1000} onChange={(event) => setDraft({ reason: event.target.value })} className="input" />
        </label>
      </fieldset>
      <div className="sys-decision-buttons">
        {approvable && (
          <button
            type="button"
            disabled={pending || listFailed || changed || approvalError !== null || Boolean(attempt) || vendorBlock !== null}
            title={vendorBlock ?? undefined}
            onClick={onApprove}
            className="btn btn-primary"
          >
            {approveLabel(draft)}
          </button>
        )}
        <button
          type="button"
          disabled={pending || listFailed || changed || !draft.reason.trim() || Boolean(attempt)}
          onClick={onReject}
          className="btn"
        >
          Отклонить
        </button>
        {vendorBlock !== null && <span className="text-text-secondary">{vendorBlock === OFAPI_OFF_REASON ? OFAPI_OFF_REASON : vendorBlock}</span>}
      </div>
      {approvable && approvalError && <p className="sys-error">{approvalError}</p>}
      {error && <p role="alert" className="sys-error">{error}</p>}
      {attempt && (
        <div className="text-text-secondary" role="status">
          {attempt.confirmed
            ? "Сервер принял решение. Обновите список, чтобы увидеть состояние заявки."
            : `Решение отправлено (${attempt.body.decision === "approve" ? "одобрение" : "отказ"}); его лимиты и срок зафиксированы, пока не известен итог.`}
          <p className="break-words">{frozenHydrationDecisionSummary(attempt.body)}</p>
          {!attempt.confirmed && error && (
            <button type="button" disabled={pending || listFailed} className="btn btn-sm mt-2" onClick={() => onRepeat(attempt.body.decision)}>
              Повторить {attempt.body.decision === "approve" ? "то же одобрение" : "тот же отказ"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
