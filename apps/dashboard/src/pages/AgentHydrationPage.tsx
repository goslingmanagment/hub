import { useState } from "react";
import { useAgentHydrationRequests, useDecideAgentHydrationRequest } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
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
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { data, isLoading, isError } = useAgentHydrationRequests({
    ...(stateFilter === undefined ? {} : { state: stateFilter }),
    limit: 50,
  });
  const decide = useDecideAgentHydrationRequest();

  const draftFor = (requestRef: string) => drafts[requestRef] ?? EMPTY_DRAFT;
  const setDraft = (requestRef: string, patch: Partial<DecisionDraft>) => {
    setDrafts((current) => ({
      ...current,
      [requestRef]: { ...(current[requestRef] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  async function submit(
    request: { requestRef: string; rowVersion: number; coverageFingerprint: string },
    decision: "approve" | "reject",
  ) {
    const draft = draftFor(request.requestRef);
    setErrors((current) => ({ ...current, [request.requestRef]: "" }));
    try {
      await decide.mutateAsync({
        requestRef: request.requestRef,
        body: {
          decision,
          // Both travel back exactly as shown: a decision is bound to the state
          // it was formed against.
          expectedVersion: request.rowVersion,
          coverageFingerprint: request.coverageFingerprint,
          idempotencyKey: crypto.randomUUID(),
          ...(decision === "approve"
            ? {
              maxCalls: draft.maxCalls,
              maxPages: draft.maxPages,
              maxCredits: draft.maxCredits,
              expiresAt: new Date(
                Date.now() + draft.expiresInHours * 60 * 60 * 1000,
              ).toISOString(),
              allowMarkReadSideEffect: draft.allowMarkRead,
            }
            : { reason: draft.reason.trim() || "declined by owner" }),
        },
      });
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [request.requestRef]: error instanceof Error ? error.message : String(error),
      }));
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
          Agents ask for a thread to be deepened. Only a decision here spends anything.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {["requested", "approved", "dispatching", "completed", "failed", undefined].map((state) => (
          <button
            key={state ?? "all"}
            type="button"
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
          const draft = draftFor(request.requestRef);
          const error = errors[request.requestRef];
          const decidable = request.state === "requested";
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
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs text-text-muted">
                      <span className="block font-medium text-text-primary">Max calls</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={draft.maxCalls}
                        onChange={(event) =>
                          setDraft(request.requestRef, {
                            maxCalls: Number(event.target.value) || 1,
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
                          setDraft(request.requestRef, {
                            maxPages: Number(event.target.value) || 1,
                          })}
                        className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                      />
                    </label>
                    <label className="text-xs text-text-muted">
                      <span className="block font-medium text-text-primary">Max credits</span>
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        value={draft.maxCredits}
                        onChange={(event) =>
                          setDraft(request.requestRef, {
                            maxCredits: Number(event.target.value) || 1,
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
                          setDraft(request.requestRef, {
                            expiresInHours: Number(event.target.value) || 1,
                          })}
                        className="mt-1 w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        checked={draft.allowMarkRead}
                        onChange={(event) =>
                          setDraft(request.requestRef, { allowMarkRead: event.target.checked })}
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
                        setDraft(request.requestRef, { reason: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-1 text-sm text-text-primary"
                    />
                  </label>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => void submit(request, "approve")}
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => void submit(request, "reject")}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-text-primary disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>

                  {error && (
                    <p className="mt-2 text-xs text-danger">{error}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
