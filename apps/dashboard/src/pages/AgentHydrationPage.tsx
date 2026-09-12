import { useRef, useState } from "react";
import type { AgentHydrationRequestDecideBody } from "@agency_hub_core/contracts";
import { useAgentHydrationRequests, useDecideAgentHydrationRequest } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatRelativeTime } from "@/lib/format";

/**
 * The owner approval queue for agent hydration requests (Agent Read Plane,
 * slice C).
 *
 * WHAT THIS SCREEN IS FOR: an agent can write down that it wants a thread
 * deepened. It cannot make that happen. Every row here is a request to spend
 * something real — OFAPI credits, or Fansly egress quota on an account that can
 * be banned for looking too eager — and the only thing that turns one into work
 * is a decision taken here (or through `hub agent hydration decide`).
 *
 * THREE THINGS THE FORM REFUSES TO LET YOU SKIP, because each is a way the
 * system could otherwise spend on your behalf without you meaning it:
 *   - a CAP (`maxCalls`): an approval without one is an open tab;
 *   - an EXPIRY: an approval that never expires is a licence somebody finds
 *     six months later;
 *   - the #158 MARK-READ CONSENT, on platforms whose history read marks the
 *     fan's chat read. Approving one of those silently would change what the
 *     fan sees. The checkbox states it either way, never by omission.
 *
 * The `rowVersion` and `coverageFingerprint` shown on each card travel back with
 * the decision: if the request moved, or the thread's coverage moved, the server
 * answers 409 instead of applying a decision you formed against a different
 * picture.
 */

const STATE_STYLES: Record<string, string> = {
  requested: "bg-accent/10 text-accent",
  approved: "bg-success/10 text-success",
  dispatching: "bg-accent/10 text-accent",
  completed: "bg-success/10 text-success",
  partially_completed: "bg-warning/10 text-warning",
  rejected: "bg-text-muted/10 text-text-muted",
  expired: "bg-text-muted/10 text-text-muted",
  failed: "bg-danger/10 text-danger",
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
  if (!Number.isInteger(draft.maxCalls) || draft.maxCalls < 1 || draft.maxCalls > 500) return "Max calls must be a whole number from 1 to 500.";
  if (!Number.isInteger(draft.maxPages) || draft.maxPages < 1 || draft.maxPages > 500) return "Max pages must be a whole number from 1 to 500.";
  if (!Number.isInteger(draft.maxCredits) || draft.maxCredits < 0 || draft.maxCredits > 100_000) return "Max credits must be a whole number from 0 to 100,000.";
  if (!Number.isFinite(draft.expiresInHours) || draft.expiresInHours <= 0 || !Number.isFinite(new Date(Date.now() + draft.expiresInHours * 3_600_000).getTime())) return "Enter a valid positive approval lifetime.";
  return null;
}

export function prepareHydrationDecision(
  request: ReviewedRequest,
  draft: ReviewedHydrationDraft,
  decision: "approve" | "reject",
): { error: string } | { body: AgentHydrationRequestDecideBody } {
  const error = !hydrationDraftMatches(draft, request)
    ? "This request changed. Review the current version before deciding."
    : decision === "approve" ? hydrationApprovalError(draft)
      : !draft.reason.trim() ? "Enter a reason before rejecting this request." : null;
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

export function frozenHydrationDecisionSummary(body: AgentHydrationRequestDecideBody): string {
  return body.decision === "approve"
    ? `Frozen approval · v${body.expectedVersion} · calls ${body.maxCalls} · pages ${body.maxPages} · credits ${body.maxCredits} · expires ${body.expiresAt} · mark-read ${body.allowMarkReadSideEffect ? "allowed" : "refused"}`
    : `Frozen rejection · v${body.expectedVersion} · reason: ${body.reason}`;
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
        [request.requestRef]: `${error instanceof Error ? error.message : String(error)}${definiteRefusal ? "" : " The outcome is unknown. Refresh first; any manual retry will reuse the same decision and request key."}`,
      }));
    } finally {
      submitting.current = false;
    }
  }

  if (isLoading || !data) {
    return isLoading ? (
      <StatusPanel title="Loading hydration requests" description="Fetching the approval queue." />
    ) : (
      <StatusPanel
        title="Hydration queue unavailable"
        description={
          isError
            ? "The queue could not be fetched. It answers 503 while agentHydrationMode is off."
            : "The queue did not return data."
        }
        tone="error"
      />
    );
  }

  const items = data.items ?? [];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">Hydration requests</h1>
        <p className="mt-1 text-sm text-text-muted">
          Agents ask for a thread to be deepened. Approval permits work within the caps below; rejected requests do not run.
        </p>
      </div>

      {isError && <StaleDataNotice title="Queue refresh failed; decisions are paused" error={queryError} className="mb-4" />}
      <button type="button" disabled={isFetching} onClick={() => void refetch()} className="mb-4 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary disabled:opacity-50">
        {isFetching ? "Refreshing…" : "Refresh requests"}
      </button>

      <div className="mb-5 flex flex-wrap gap-2">
        {["requested", "approved", "dispatching", "completed", "failed", undefined].map((state) => (
          <button
            key={state ?? "all"}
            type="button"
            aria-pressed={stateFilter === state}
            onClick={() => setStateFilter(state)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              stateFilter === state
                ? "border-accent bg-accent/5 text-text-primary"
                : "border-border bg-card text-text-muted hover:bg-hover"
            }`}
          >
            {state ?? "all"}
          </button>
        ))}
      </div>

      {items.length === 0 && (
        <StatusPanel
          title="Nothing waiting"
          description="No hydration request matches this filter."
        />
      )}

      <div className="space-y-4">
        {items.map((request) => {
          const draft = draftFor(request);
          const error = errors[request.requestRef];
          const decidable = request.state === "requested";
          const changed = !hydrationDraftMatches(draft, request);
          const approvalError = hydrationApprovalError(draft);
          const attempt = attempts[request.requestRef];
          return (
            <div key={request.requestRef} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    STATE_STYLES[request.state] ?? "bg-text-muted/10 text-text-muted"
                  }`}
                >
                  {request.state}
                </span>
                <span className="text-sm font-semibold text-text-primary">
                  {request.pageLabel} · {request.platform}
                </span>
                <span className="text-sm text-text-muted">thread {request.conversationRef}</span>
                <span className="ml-auto text-xs text-text-muted">
                  {formatRelativeTime(request.createdAt)}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted sm:grid-cols-4">
                <div>
                  <dt className="font-medium text-text-primary">Target</dt>
                  <dd>
                    before {request.target.beforeAt ?? request.target.beforeMessageRef ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-text-primary">Lane</dt>
                  <dd>{request.admissibility.selected ?? "none"} · {request.admissibility.costNote ?? "—"}</dd>
                </div>
                <div>
                  <dt className="font-medium text-text-primary">Key</dt>
                  <dd>{request.requestedBy.keyPrefix}</dd>
                </div>
                <div>
                  <dt className="font-medium text-text-primary">Version</dt>
                  <dd className="tabular-nums">v{request.rowVersion}</dd>
                </div>
              </dl>

              <p className="mt-2 break-all font-mono text-[11px] text-text-muted">
                coverage {request.coverageFingerprint.slice(0, 16)}… · reason sha
                {" "}
                {request.reasonSha256.slice(0, 12)}… ({request.reasonLength} chars)
              </p>

              {request.decision && (
                <p className="mt-2 text-xs text-text-muted">
                  {request.decision.approved ? "Approved" : "Rejected"}
                  {" "}
                  {formatRelativeTime(request.decision.decidedAt)}
                  {request.decision.approved && (
                    <>
                      {" "}· caps {request.decision.maxCalls ?? "—"}/
                      {request.decision.maxPages ?? "—"}/
                      {request.decision.maxCredits ?? "—"} · mark-read
                      {" "}
                      {request.decision.allowMarkReadSideEffect ? "allowed" : "refused"}
                    </>
                  )}
                </p>
              )}

              {request.progress.executionRef && (
                <p className="mt-1 text-xs text-text-muted">
                  execution {request.progress.executionRef} · items
                  {" "}
                  {request.progress.acceptedItems} · lastError {request.progress.lastError}
                </p>
              )}

              {decidable && (
                <div className="mt-4 border-t border-border pt-3">
                  {changed && (
                    <div role="alert" className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text-primary">
                      Request or coverage changed since your draft (v{draft.expectedVersion} → v{request.rowVersion}). Your limits are preserved; review the current coverage and limits before deciding.
                      <button type="button" disabled={decide.isPending || isError || Boolean(attempt)} className="mt-2 block rounded-lg border border-border px-3 py-1.5 disabled:opacity-50" onClick={() => {
                        setDrafts((current) => ({ ...current, [request.requestRef]: reviewHydrationDraft(draft, request) }));
                        setErrors((current) => ({ ...current, [request.requestRef]: "" }));
                      }}>I reviewed v{request.rowVersion}; keep limits and reconsider mark-read</button>
                    </div>
                  )}
                  <fieldset disabled={decide.isPending || Boolean(attempt)} className="min-w-0">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs text-text-muted">
                      <span className="block font-medium text-text-primary">Max calls</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={draft.maxCalls}
                        onChange={(event) =>
                          setDraft(request, {
                            maxCalls: Number(event.target.value),
                          })}
                        className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      <span className="block font-medium text-text-primary">Max pages</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={draft.maxPages}
                        onChange={(event) =>
                          setDraft(request, {
                            maxPages: Number(event.target.value),
                          })}
                        className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      <span className="block font-medium text-text-primary">Max credits</span>
                      <input
                        type="number"
                        min={0}
                        max={100000}
                        value={draft.maxCredits}
                        onChange={(event) =>
                          setDraft(request, {
                            maxCredits: Number(event.target.value),
                          })}
                        className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      <span className="block font-medium text-text-primary">Expires in (h)</span>
                      <input
                        type="number"
                        min={1}
                        value={draft.expiresInHours}
                        onChange={(event) =>
                          setDraft(request, {
                            expiresInHours: Number(event.target.value),
                          })}
                        className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        checked={draft.allowMarkRead}
                        onChange={(event) =>
                          setDraft(request, { allowMarkRead: event.target.checked })}
                      />
                      <span>
                        Allow the vendor read to mark this chat READ on the platform (#158)
                      </span>
                    </label>
                  </div>

                  <label className="mt-3 block text-xs text-text-muted">
                    <span className="block font-medium text-text-primary">
                      Reason (required to reject)
                    </span>
                    <input
                      type="text"
                      value={draft.reason}
                      maxLength={1000}
                      onChange={(event) =>
                        setDraft(request, { reason: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                    />
                  </label>
                  </fieldset>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={decide.isPending || isError || changed || approvalError !== null || Boolean(attempt)}
                      onClick={() => void submit(request, "approve")}
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={decide.isPending || isError || changed || !draft.reason.trim() || Boolean(attempt)}
                      onClick={() => void submit(request, "reject")}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-text-primary disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>

                  {approvalError && <p className="mt-2 text-xs text-danger">{approvalError}</p>}

                  {error && (
                    <p role="alert" className="mt-2 text-xs text-danger">{error}</p>
                  )}
                  {attempt && <div className="mt-2 text-xs text-text-secondary" role="status">
                    {attempt.confirmed ? "Decision accepted by the server. Refresh to see its current state." : `Recorded ${attempt.body.decision} request; its limits and expiry are frozen until the outcome is known.`}
                    <p className="mt-1 break-words">{frozenHydrationDecisionSummary(attempt.body)}</p>
                    {!attempt.confirmed && error && <button type="button" disabled={decide.isPending || isError} className="mt-2 block rounded-lg border border-border px-3 py-1.5 disabled:opacity-50" onClick={() => void submit(request, attempt.body.decision)}>Retry the same {attempt.body.decision === "approve" ? "approval" : "rejection"}</button>}
                  </div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {items.length === 50 && <p className="mt-4 text-xs text-text-muted">Showing the first 50 matching requests. Narrow the status filter to inspect this queue; this view has no older-page control.</p>}
    </div>
  );
}
