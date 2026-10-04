import type { ClientCoverageLevel } from "@agency_hub_core/contracts";
import {
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  getOfapiMessageCoverageServingState,
  type OfapiMessageCoverageServingState,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * How much of one conversation's history the hub can vouch for, in the words
 * every chat-extension surface uses (`CLIENT_COVERAGE_LEVELS`): the AI
 * `context_v1` frame today, the archive feed next.
 *
 * The answer comes from `ofapi_message_coverage`, the per-chat history proof of
 * the OnlyFans capture lane, and never from `page_dm_threads.history_state`:
 * that column is the Fansly engine's chain.
 *
 * - `complete`: a standing continuous-history proof under the current proof
 *   policy, and the archive projection has reached the proof's watermark. The
 *   hub holds the chat from its first message to the proof's head; what came
 *   later arrived by webhook.
 * - `partial`: a standing proof that does not vouch for the whole history (the
 *   proof itself records a hole, or the archive has not projected everything
 *   the proof covers yet).
 * - `unknown`: no proof, a revoked one, or one under a policy the hub no longer
 *   accepts. A page without the capture lane (Fansly) always reads `unknown`.
 */
export function classifyClientCoverage(
  state: OfapiMessageCoverageServingState | null,
): ClientCoverageLevel {
  if (
    state === null
    || state.revokedAt !== null
    || state.proofPolicyVersion !== OFAPI_CAPTURE_PROOF_POLICY_VERSION
  ) {
    return "unknown";
  }
  if (state.classification !== "continuous_history") {
    return "partial";
  }
  return state.messageArchiveHighWater >= state.requiredServingHighWater ? "complete" : "partial";
}

/** One primary-key read; never a platform request. */
export async function loadClientConversationCoverage(
  app: Pick<AppContext, "db">,
  input: { pageId: number; conversationRef: string },
): Promise<ClientCoverageLevel> {
  return classifyClientCoverage(
    await getOfapiMessageCoverageServingState(app.db, {
      pageId: input.pageId,
      chatId: input.conversationRef,
    }),
  );
}
