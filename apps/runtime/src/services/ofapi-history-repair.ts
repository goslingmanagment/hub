import {
  createOrGetOfapiCaptureJob,
  findVisiblePageDmConversationByPlatformConversationId,
  getOfapiMessageCoverageServingState,
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export type OfapiHistoryRepairReason = "no_certificate" | "stale_head";

export async function enqueueExplicitOfapiHistoryRepair(
  app: AppContext,
  input: {
    pageId: number;
    ofapiAccountId: string;
    chatId: string;
    principalUserId: number;
    reason: OfapiHistoryRepairReason;
  },
) {
  const conversation = await findVisiblePageDmConversationByPlatformConversationId(app.db, {
    platformAccountId: input.pageId,
    platformConversationId: input.chatId,
  });
  if (!conversation) return null;
  const frozenHeadId = conversation.lastMessageId?.trim() || null;
  if (!frozenHeadId) return null;

  const coverage = await getOfapiMessageCoverageServingState(app.db, {
    pageId: input.pageId,
    chatId: input.chatId,
  });
  const canConnectToAnchor = coverage !== null
    && coverage.revokedAt === null
    && coverage.classification === "continuous_history"
    && coverage.proofPolicyVersion === OFAPI_CAPTURE_PROOF_POLICY_VERSION
    && coverage.frozenHeadId !== frozenHeadId;
  const goal = canConnectToAnchor ? "connect_to_anchor" : "history_to_exhaustion";
  const anchorMessageId = canConnectToAnchor ? coverage.frozenHeadId : null;

  return createOrGetOfapiCaptureJob(app.db, {
    pageId: input.pageId,
    ofapiAccountId: input.ofapiAccountId,
    kind: "chat_paginate",
    goal,
    activeSlotKey: `page:${input.pageId}:chat:${input.chatId}`,
    target: {
      chatId: input.chatId,
      frozenHeadId,
      anchorMessageId,
      limit: 100,
      reason: "interactive_history_miss",
    },
    targetGeneration: conversation.lastSeenGeneration ?? 0,
    manifest: {
      version: "ofapi-interactive-history-repair-v1",
      source: "deep-history-v1",
      fallbackReason: input.reason,
    },
    budgetScope: "interactive",
    originPrincipalId: input.principalUserId,
    createdBy: "interactive_open",
    priority: 1,
    maxCalls: 3,
    maxCredits: 3,
    maxPages: 3,
    maxItems: 300,
  });
}
