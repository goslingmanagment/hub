import { createHash, randomUUID } from "node:crypto";

import type { AppConfig } from "@agency_hub_core/shared";
import {
  decideAgentHydrationRequest,
  findAgentHydrationThread,
  hydrationCoverageFingerprint,
  listAutoApprovableAgentHydrationRequests,
  sumAutoApprovedCallsSince,
  type AgentHydrationRequestRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * Decision #202 — the hydration auto-approve policy.
 *
 * The owner delegated ONE narrow act to this module: authorizing a single
 * bounded Fansly `thread_backfill_before` attempt, within a daily call budget.
 * An approval reserves its cap until its run settles, then counts the calls
 * the run actually made (`sumAutoApprovedCallsSince`), so a day's unused
 * reservations are approvable again the same day. Everything else about a
 * decision — mark-read consent, other platforms, other targets, anything over
 * the per-request cap — stays the owner's, and a request the policy may not
 * decide is LEFT `requested` for a human, never rejected on the policy's behalf.
 *
 * Runs strictly inside the exclusive hydration cycle, so its sum-then-decide
 * budget arithmetic is single-writer by construction: there is no concurrent
 * approver to race the reservation against.
 */

export const AGENT_HYDRATION_AUTO_POLICY_VERSION = 1;

/** One approval buys at most one full targeted run (40 requests × 25 messages). */
export const AUTO_APPROVE_MAX_CALLS_PER_REQUEST = 40;

/** How long an auto-approval stays dispatchable. The dispatcher normally picks
 *  it up in the SAME cycle; six hours covers a wedged queue without leaving a
 *  stale authorization armed for days. */
const AUTO_APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;

const CANDIDATE_BATCH_LIMIT = 10;

export interface AgentHydrationAutoApproveResult {
  mode: "off" | "shadow" | "enforce";
  considered: number;
  /** enforce: decisions written. shadow: decisions that WOULD have been written. */
  approved: number;
  skippedBudget: number;
  skippedConflict: number;
  /** Calls reserved by this pass (enforce) or that would have been (shadow). */
  reservedCalls: number;
  budgetRemaining: number;
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function policyDecisionFingerprint(request: AgentHydrationRequestRecord, maxCalls: number): string {
  // The rule snapshot this decision was made under, hashed exactly like an
  // owner's decision fingerprint: enough to prove WHICH policy said yes.
  return createHash("sha256")
    .update(JSON.stringify({
      policy: "agent_hydration_auto_approve",
      version: AGENT_HYDRATION_AUTO_POLICY_VERSION,
      requestRef: request.requestRef,
      maxCalls,
      maxPages: maxCalls,
      maxCredits: 0,
      allowMarkReadSideEffect: false,
    }))
    .digest("hex");
}

export async function runAgentHydrationAutoApprove(
  app: AppContext,
  config: AppConfig,
  now: Date = new Date(),
): Promise<AgentHydrationAutoApproveResult> {
  const mode = config.agentHydrationAutoApproveMode ?? "off";
  const budget = config.agentHydrationAutoDailyCallBudget ?? 0;
  const result: AgentHydrationAutoApproveResult = {
    mode,
    considered: 0,
    approved: 0,
    skippedBudget: 0,
    skippedConflict: 0,
    reservedCalls: 0,
    budgetRemaining: 0,
  };
  if (mode === "off") {
    return result;
  }

  const dayStart = utcDayStart(now);
  // Runs settled since the last pass have returned what they did not use; the
  // cycle runs every two minutes, so returned calls are approvable within one.
  const alreadyCounted = await sumAutoApprovedCallsSince(app.db, dayStart);
  let remaining = Math.max(0, budget - alreadyCounted);
  result.budgetRemaining = remaining;
  if (remaining <= 0) {
    return result;
  }

  const candidates = await listAutoApprovableAgentHydrationRequests(app.db, {
    limit: CANDIDATE_BATCH_LIMIT,
    utcDayStart: dayStart,
    now,
  });

  // ONE live approval per page. The candidate query checked that against the
  // table as it stood BEFORE this pass, so the approvals this pass makes are
  // the caller's to count: the page's targeted run is one job at a time, and a
  // second same-page approval would only sit behind it (2026-09-27..29: ten
  // same-page approvals per pass, nine of them failed without a Fansly call).
  const approvedPages = new Set<number>();

  for (const request of candidates) {
    if (approvedPages.has(request.pageId)) {
      continue;
    }
    result.considered += 1;
    const requested = request.requestedMaxCalls ?? AUTO_APPROVE_MAX_CALLS_PER_REQUEST;
    const maxCalls = Math.min(requested, AUTO_APPROVE_MAX_CALLS_PER_REQUEST);
    if (maxCalls > remaining) {
      // Over budget is NOT a rejection: the request stays for the owner, and
      // tomorrow's budget may cover it.
      result.skippedBudget += 1;
      continue;
    }

    if (mode === "shadow") {
      result.approved += 1;
      result.reservedCalls += maxCalls;
      remaining -= maxCalls;
      approvedPages.add(request.pageId);
      app.logger.info(
        {
          requestRef: request.requestRef,
          pageLabel: request.pageLabel,
          conversationRef: request.conversationRef,
          maxCalls,
          policyVersion: AGENT_HYDRATION_AUTO_POLICY_VERSION,
        },
        "Hydration autopilot (shadow): would approve",
      );
      continue;
    }

    // The decider quotes the coverage it SAW, and the decide transaction
    // recomputes and compares — the same staleness protocol the owner follows.
    const { thread } = await findAgentHydrationThread(app.db, {
      pageId: request.pageId,
      conversationRef: request.conversationRef,
    });
    if (thread === null) {
      result.skippedConflict += 1;
      continue;
    }
    const coverage = hydrationCoverageFingerprint({
      pageId: request.pageId,
      conversationRef: request.conversationRef,
      storedMessageCount: thread.storedMessageCount,
      oldestStoredMessageId: thread.oldestStoredMessageId,
      messageCoverageStatus: thread.messageCoverageStatus,
    });

    const { outcome } = await decideAgentHydrationRequest(app.db, {
      id: request.id,
      expectedVersion: request.rowVersion,
      approved: true,
      decidedBy: {
        source: "auto_policy",
        policyVersion: AGENT_HYDRATION_AUTO_POLICY_VERSION,
      },
      allowMarkReadSideEffect: false,
      maxCalls,
      maxPages: maxCalls,
      maxCredits: 0,
      maxItems: null,
      expiresAt: new Date(now.getTime() + AUTO_APPROVAL_TTL_MS),
      reasonSha256: null,
      reasonLength: null,
      idempotencyKey: randomUUID(),
      decisionFingerprint: policyDecisionFingerprint(request, maxCalls),
      coverageFingerprint: coverage,
      audit: {
        // The spend is attributed to the KEY whose request the policy granted:
        // the audit table demands exactly one principal, and inventing an owner
        // session here would claim a human authored the read.
        agentKeyId: request.agentKeyId,
        operation: "agentHydrationAutoDecide",
        pageIds: [request.pageId],
        verbatimText: false,
        requestSummary: {
          decisionSource: "auto_policy",
          policyVersion: AGENT_HYDRATION_AUTO_POLICY_VERSION,
          maxCalls,
          budgetDate: dayStart.toISOString(),
          returned: 1,
        },
      },
      now,
    });

    if (outcome === "applied") {
      result.approved += 1;
      result.reservedCalls += maxCalls;
      remaining -= maxCalls;
      approvedPages.add(request.pageId);
    } else {
      // conflict / coverage_stale: the world moved between the list and the
      // decision. The CAS already refused; the request keeps its state and a
      // later cycle (or the owner) re-evaluates against fresh facts.
      result.skippedConflict += 1;
    }
  }

  result.budgetRemaining = remaining;
  return result;
}
