import type { ClientCoverageLevel } from "@agency_hub_core/contracts";
import {
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  getOfapiMessageCoverageServingState,
  readConversationHistoryState,
  type OfapiMessageCoverageServingState,
  type ThreadHistoryState,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

// How much of one conversation's history the hub can vouch for, in the words
// every chat-extension surface uses (`CLIENT_COVERAGE_LEVELS`): the AI
// `context_v1` frame and the archive feed. Each platform answers from its own
// per-chat history proof and never reads the other's.

/**
 * OnlyFans: `ofapi_message_coverage`, the per-chat history proof of the
 * capture lane.
 *
 * - `complete`: a standing continuous-history proof under the current proof
 *   policy, and the archive projection has reached the proof's watermark. The
 *   hub holds the chat from its first message to the proof's head; what came
 *   later arrived by webhook.
 * - `partial`: a standing proof that does not vouch for the whole history (the
 *   proof itself records a hole, or the archive has not projected everything
 *   the proof covers yet).
 * - `unknown`: no proof, a revoked one, or one under a policy the hub no longer
 *   accepts.
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

/**
 * Fansly (R20 HF-8д): the Sync Engine's chain, the thread's effective
 * `page_dm_threads.history_state`.
 *
 * - `complete`: the chain is proven from its confirmed head down to the chat's
 *   first message (an accepted empty page below its oldest message). Messages
 *   after the head arrive by the socket and the head reads.
 * - `unknown`: anything else. A `partial` chain proves the newest stretch from
 *   its head and nothing about the history below it; `unverified` and `none`
 *   prove nothing; null is a chat the page holds no thread for. A Fansly chat
 *   never reads `partial`.
 */
export function classifyFanslyChainCoverage(state: ThreadHistoryState | null): ClientCoverageLevel {
  return state === "complete" ? "complete" : "unknown";
}

type ConversationCoverageReader = (
  db: AppContext["db"],
  input: { pageId: number; conversationRef: string },
) => Promise<ClientCoverageLevel>;

/** Each platform's own proof, by the page's platform. */
const COVERAGE_READERS = new Map<string, ConversationCoverageReader>([
  ["onlyfans", async (db, input) => classifyClientCoverage(
    await getOfapiMessageCoverageServingState(db, { pageId: input.pageId, chatId: input.conversationRef }),
  )],
  ["fansly", async (db, input) => classifyFanslyChainCoverage(await readConversationHistoryState(db, input))],
]);

/** One indexed read of the proof of the page's platform; never a platform
 *  request. A platform without a proof answers `unknown` and reads nothing. */
export async function loadClientConversationCoverage(
  app: Pick<AppContext, "db">,
  input: { pageId: number; platform: string; conversationRef: string },
): Promise<ClientCoverageLevel> {
  const read = COVERAGE_READERS.get(input.platform);
  if (read === undefined) {
    return "unknown";
  }
  return read(app.db, { pageId: input.pageId, conversationRef: input.conversationRef });
}
