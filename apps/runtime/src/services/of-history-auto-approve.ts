import { createHash, randomUUID } from "node:crypto";

import { MASS_SEND_MIN_CHATS } from "@agency_hub_core/contracts";
import {
  countAutoApprovedHydrationSince,
  decideAgentHydrationRequest,
  findAgentHydrationThread,
  hydrationCoverageFingerprint,
  listAutoApprovableOnlyfansHydrationRequests,
  type AgentHydrationRequestRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

/**
 * The OnlyFans history auto-approve policy (owner, 2026-10-25: «одобрять надо
 * давно … можно автоматом»). An agent's request to read an OnlyFans chat's
 * older history waited for the owner's click only because the OnlyFansAPI read
 * marks the chat read (#158). This policy approves the request itself when the
 * chat has nothing a chatter has not seen — no unread on the thread, and the
 * fan's newest message answered by a personal reply (a mass message answers
 * nothing) — so the read changes nothing a chatter would miss.
 *
 * Bounded: one approval buys one capture job of at most MAX_CALLS calls and
 * MAX_CREDITS credits (the executor's own day budget still applies), and the
 * policy approves at most DAILY_APPROVALS requests per UTC day. A request it
 * may not decide stays `requested` for the owner or a later pass — never
 * rejected on the policy's behalf. The decision is the policy's (decision
 * source `auto_policy`, 0119), never written as the owner's.
 *
 * Runs inside the exclusive hydration cycle, before its dispatch.
 */

// 3: a mass message after the fan's message no longer counts as an answer.
export const OF_HISTORY_AUTO_POLICY_VERSION = 3;
const MAX_CALLS = 10;
const MAX_CREDITS = 20;
const DAILY_APPROVALS = 50;
const BATCH_LIMIT = 10;
/** The executor normally claims an approval within its next cycle (two minutes). */
const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;

export interface OnlyfansHistoryAutoApproveResult {
  skipped: "off" | "daily_cap" | null;
  approved: number;
  conflicts: number;
}

function policyDecisionFingerprint(request: AgentHydrationRequestRecord): string {
  // The rule this decision was made under, hashed like an owner's decision
  // fingerprint: enough to prove which policy said yes and to what.
  return createHash("sha256")
    .update(JSON.stringify({
      policy: "onlyfans_history_auto_approve",
      version: OF_HISTORY_AUTO_POLICY_VERSION,
      requestRef: request.requestRef,
      maxCalls: MAX_CALLS,
      maxPages: MAX_CALLS,
      maxCredits: MAX_CREDITS,
      allowMarkReadSideEffect: true,
    }))
    .digest("hex");
}

export async function runOnlyfansHistoryAutoApprove(
  app: AppContext,
  now: Date = new Date(),
): Promise<OnlyfansHistoryAutoApproveResult> {
  const result: OnlyfansHistoryAutoApproveResult = { skipped: null, approved: 0, conflicts: 0 };
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.ofHistoryAutoApproveEnabled !== true) return { ...result, skipped: "off" };

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let remaining = DAILY_APPROVALS - await countAutoApprovedHydrationSince(app.db, dayStart);
  if (remaining <= 0) return { ...result, skipped: "daily_cap" };

  const candidates = await listAutoApprovableOnlyfansHydrationRequests(app.db, {
    limit: Math.min(BATCH_LIMIT, remaining), burstMinChats: MASS_SEND_MIN_CHATS, now,
  });
  for (const request of candidates) {
    // The decider quotes the coverage it sees now; the decide transaction
    // recomputes and compares, the same staleness protocol the owner follows.
    const { thread } = await findAgentHydrationThread(app.db, { pageId: request.pageId, conversationRef: request.conversationRef });
    if (thread === null) {
      result.conflicts += 1;
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
      decidedBy: { source: "auto_policy", policyVersion: OF_HISTORY_AUTO_POLICY_VERSION },
      allowMarkReadSideEffect: true,
      maxCalls: MAX_CALLS,
      maxPages: MAX_CALLS,
      maxCredits: MAX_CREDITS,
      maxItems: null,
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      reasonSha256: null,
      reasonLength: null,
      idempotencyKey: randomUUID(),
      decisionFingerprint: policyDecisionFingerprint(request),
      coverageFingerprint: coverage,
      audit: {
        // The audit row demands exactly one principal: the key whose request
        // the policy granted, never an invented owner session.
        agentKeyId: request.agentKeyId,
        operation: "agentHydrationAutoDecide",
        pageIds: [request.pageId],
        verbatimText: false,
        requestSummary: {
          decisionSource: "auto_policy",
          policyVersion: OF_HISTORY_AUTO_POLICY_VERSION,
          maxCalls: MAX_CALLS,
          budgetDate: dayStart.toISOString(),
          platform: "onlyfans",
          returned: 1,
        },
      },
      now,
    });
    if (outcome === "applied") {
      result.approved += 1;
      remaining -= 1;
      if (remaining <= 0) break;
    } else {
      // The world moved between the list and the decision; the CAS refused and
      // a later pass re-evaluates against fresh facts.
      result.conflicts += 1;
    }
  }
  return result;
}
