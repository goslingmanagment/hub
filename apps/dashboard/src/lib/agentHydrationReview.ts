import {
  agentHydrationRequestDecideBodySchema,
  agentHydrationRequestSchema,
  KernelApiError,
  type AgentHydrationRequest,
  type AgentHydrationRequestDecideBody,
  type AgentHydrationRequestDecideResponse,
  type AgentHydrationState,
} from "@agency_hub_core/contracts";

export const hydrationStateLabels: Record<AgentHydrationState, string> = {
  requested: "Ожидает решения", approved: "Согласовано", dispatching: "Выполняется",
  partially_completed: "Выполнено частично", completed: "Завершено",
  rejected: "Отклонено", expired: "Срок истёк", failed: "Ошибка выполнения",
};

export function hydrationListFilters(search: URLSearchParams) {
  const rawState = search.get("state");
  const validState = rawState === null || rawState === "all" || Object.hasOwn(hydrationStateLabels, rawState);
  const state = validState && rawState !== null ? rawState as AgentHydrationState | "all" : "requested";
  const rawLimit = search.get("limit");
  const parsedLimit = rawLimit === null ? 50 : Number(rawLimit);
  const validLimit = rawLimit === null || (/^\d+$/.test(rawLimit) && Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 200);
  return { state, limit: validLimit ? parsedLimit : 50, invalid: !validState || !validLimit };
}

export interface HydrationDecisionDraft {
  maxCalls: string;
  maxPages: string;
  maxCredits: string;
  expiresInHours: string;
  allowMarkRead: boolean | null;
  reason: string;
}

export interface HydrationDecisionWorkspace {
  snapshot: AgentHydrationRequest;
  draft: HydrationDecisionDraft;
  body: AgentHydrationRequestDecideBody | null;
  phase: "editing" | "review" | "sending" | "uncertain" | "refused" | "confirmed";
  everUncertain: boolean;
  error: string;
  result: Pick<AgentHydrationRequestDecideResponse, "request" | "disposition"> | null;
}

export function beginHydrationReview(request: AgentHydrationRequest): HydrationDecisionWorkspace {
  return {
    // A poll must never transfer the owner's caps/consent to a different version.
    snapshot: structuredClone(request),
    draft: { maxCalls: "5", maxPages: "5", maxCredits: "5", expiresInHours: "24", allowMarkRead: null, reason: "" },
    body: null, phase: "editing", everUncertain: false, error: "", result: null,
  };
}

export function hydrationReviewChanged(snapshot: AgentHydrationRequest, current: AgentHydrationRequest | undefined) {
  return current !== undefined && (
    current.requestRef !== snapshot.requestRef || current.state !== snapshot.state
    || current.rowVersion !== snapshot.rowVersion || current.coverageFingerprint !== snapshot.coverageFingerprint
  );
}

export function hydrationRequestExpired(request: AgentHydrationRequest, now: number) {
  return request.expiresAt !== null && Date.parse(request.expiresAt) <= now;
}

function integer(value: string, min: number, max: number, label: string) {
  const parsed = Number(value);
  if (!value.trim() || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}: укажите целое число от ${min} до ${max}.`);
  }
  return parsed;
}

export function prepareHydrationDecision(
  snapshot: AgentHydrationRequest,
  draft: HydrationDecisionDraft,
  decision: "approve" | "reject",
  now: number,
  idempotencyKey: string,
): AgentHydrationRequestDecideBody {
  if (snapshot.state !== "requested" || hydrationRequestExpired(snapshot, now)) {
    throw new Error("Этот запрос больше нельзя согласовать: обновите его состояние.");
  }
  const base = { decision, expectedVersion: snapshot.rowVersion, coverageFingerprint: snapshot.coverageFingerprint, idempotencyKey };
  if (decision === "reject") {
    const reason = draft.reason.trim();
    if (!reason || reason.length > 1000) throw new Error("Укажите причину отказа: от 1 до 1000 символов.");
    return { ...base, reason };
  }
  if (!snapshot.admissibility.admissible) throw new Error("Для этого запроса нет доступного способа дозагрузки.");
  if (draft.allowMarkRead === null) throw new Error("Укажите, разрешаете ли вы отмечать диалог прочитанным.");
  const hours = Number(draft.expiresInHours);
  const expiry = now + hours * 3_600_000;
  if (!draft.expiresInHours.trim() || !Number.isFinite(hours) || hours <= 0 || !Number.isFinite(new Date(expiry).getTime())) {
    throw new Error("Укажите положительный срок действия в часах.");
  }
  return {
    ...base,
    maxCalls: integer(draft.maxCalls, 1, 500, "Вызовы"),
    maxPages: integer(draft.maxPages, 1, 500, "Страницы ответа"),
    maxCredits: integer(draft.maxCredits, 0, 100_000, "Кредиты"),
    expiresAt: new Date(expiry).toISOString(),
    allowMarkReadSideEffect: draft.allowMarkRead,
  };
}

export function hydrationDecisionFailure(error: unknown, everUncertain = false) {
  const definite = error instanceof KernelApiError && error.category !== "contract"
    && error.status !== null && error.status >= 400 && error.status < 500;
  const messages: Record<string, string> = {
    hydration_proposal_stale: "Архив диалога изменился после создания запроса. Для согласования нужен актуальный запрос агента.",
    conflict: "Запрос уже изменился, был рассмотрен или истёк. Обновите очередь и проверьте его состояние.",
    hydration_not_admissible: "Сервер не допустил дозагрузку. Проверьте предел кредитов и разрешение отмечать диалог прочитанным.",
    idempotency_mismatch: "Сервер обнаружил другое содержимое у этого ключа решения. Не создавайте повторное решение; проверьте сохранённое состояние запроса.",
  };
  const detail = error instanceof KernelApiError ? messages[error.code ?? ""] : undefined;
  return {
    // A later refusal cannot prove what happened to an earlier lost reply.
    uncertain: everUncertain || !definite,
    message: detail ?? (definite ? "Сервер отказал в применении решения. Проверьте ответ и обновите очередь." : "Ответ не получен или не подтверждён. Решение могло сохраниться на сервере."),
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

export function hydrationStorageKey(ownerId: number) {
  return `hub:hydration-decision:v1:owner:${ownerId}`;
}

export function serializeHydrationWorkspace(ownerId: number, workspace: HydrationDecisionWorkspace) {
  return JSON.stringify({ version: 1, ownerId, workspace });
}

/** A response from an unmounted page cannot replace a newer review or downgrade
 *  a confirmed outcome from another explicit recovery of the same decision. */
export function settleHydrationWorkspace(current: HydrationDecisionWorkspace | null, outcome: HydrationDecisionWorkspace) {
  if (!current?.body || current.body.idempotencyKey !== outcome.body?.idempotencyKey || current.phase === "confirmed") return current;
  if (current.everUncertain && outcome.phase === "refused") return { ...outcome, phase: "uncertain" as const, everUncertain: true };
  return outcome;
}

/** Persist only this tab's owner-bound review. Recovery never dispatches anything. */
export function restoreHydrationWorkspace(raw: string | null, ownerId: number, recoverInterrupted = true): HydrationDecisionWorkspace | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1
    || !("ownerId" in parsed) || parsed.ownerId !== ownerId || !("workspace" in parsed)) throw new Error("Invalid saved review");
  const workspace = parsed.workspace as Partial<HydrationDecisionWorkspace> | null;
  if (!workspace || !["editing", "review", "sending", "uncertain", "refused", "confirmed"].includes(workspace.phase ?? "")
    || typeof workspace.everUncertain !== "boolean" || typeof workspace.error !== "string") throw new Error("Invalid saved review");
  const snapshot = agentHydrationRequestSchema.parse(workspace.snapshot);
  const draft = workspace.draft;
  if (!draft || ![draft.maxCalls, draft.maxPages, draft.maxCredits, draft.expiresInHours, draft.reason].every(value => typeof value === "string")
    || ![true, false, null].includes(draft.allowMarkRead)) throw new Error("Invalid saved draft");
  const body = workspace.body === null ? null : agentHydrationRequestDecideBodySchema.parse(workspace.body);
  if (workspace.phase !== "editing" && body === null) throw new Error("Missing saved decision");
  if (body && (body.expectedVersion !== snapshot.rowVersion || body.coverageFingerprint !== snapshot.coverageFingerprint)) throw new Error("Saved decision does not match request");
  let result: HydrationDecisionWorkspace["result"] = null;
  if (workspace.result !== null && workspace.result !== undefined) {
    if (!["approved", "rejected", "already_decided"].includes(workspace.result.disposition)) throw new Error("Invalid saved outcome");
    const request = agentHydrationRequestSchema.parse(workspace.result.request);
    if (request.requestRef !== snapshot.requestRef) throw new Error("Saved outcome does not match request");
    result = { request, disposition: workspace.result.disposition };
  }
  if (workspace.phase === "confirmed" && result === null) throw new Error("Missing saved outcome");
  const interrupted = recoverInterrupted && workspace.phase === "sending";
  return {
    snapshot, draft, body, phase: interrupted ? "uncertain" : workspace.phase as HydrationDecisionWorkspace["phase"],
    everUncertain: interrupted || workspace.everUncertain,
    error: interrupted ? "Вкладка была закрыта во время отправки. Результат решения ещё не подтверждён." : workspace.error,
    result,
  };
}
