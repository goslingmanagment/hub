import { compareClientNumericIds, type ClientCoverageLevel } from "@agency_hub_core/contracts";
import { findAiConversationOldestMessageRef } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import { loadClientConversationCoverage } from "../../../services/client-coverage.ts";
import type { OperationFeature, TranscriptMessage } from "../prompts/index.ts";

// chat-extension R20 HF-7д (parity row AI-148): `transcriptCoverage` of a
// Fansly transcript the hub loads itself, from the hub's own proof instead of
// the client's word. The released Fansly extension sends it for Coach, the
// short Recap and the notes fill, and says `full-history` only when its read
// reached the conversation's first message and nothing was cut after
// (fansly-chat src/background/operations.ts `computedTranscriptCoverage`).
// The hub says what it can prove:
//
// - `full-history`: the Sync Engine's chain of the thread is proven down to
//   the chat's first message (HF-8д, `complete`), and the served window
//   reaches the oldest message the hub holds of it;
// - `window`: the hub holds a message of the chat older than the served
//   window (or the Coach budget cut the transcript, the caller's check): the
//   history is longer than what the model reads;
// - unknown (no value, no note): the window holds everything the hub has, but
//   nothing proves the chat began there.

/** The features whose prompt reads the coverage note, and whose released
 *  Fansly client sends it (fan-summary stores it with the recap). */
export function readsTranscriptCoverage(feature: OperationFeature): boolean {
  return feature === "coach-chat" || feature === "fan-summary" || feature === "fan-notes-fill";
}

export type HubTranscriptCoverage = "full-history" | "window";

/** What the coverage leaves in the context manifest: no id, no text. */
export interface FanslyTranscriptCoverageManifest {
  /** What the prompt and the stored recap say; null = unknown (no note). */
  value: HubTranscriptCoverage | null;
  /** The chain's level (HF-8д); absent when a read failed. */
  chain?: ClientCoverageLevel;
  /** The served window holds the oldest message the hub holds of the chat;
   *  absent when a read failed. */
  reachesOldest?: boolean;
  /** A read failed: no value from the chain. */
  error?: true;
  /** The Coach budget cut the transcript (set by the feature service). */
  promptBudgetCut?: true;
}

/** The coverage from the chain and the served window (pure). */
export function judgeFanslyTranscriptCoverage(input: {
  chain: ClientCoverageLevel;
  /** The oldest message of the chat the hub holds live; null when none. */
  oldestRef: string | null;
  /** The served window's message ids. */
  servedIds: readonly string[];
}): { value: HubTranscriptCoverage | null; reachesOldest: boolean } {
  const oldest = input.oldestRef;
  const reachesOldest = oldest === null || input.servedIds.some((id) => compareClientNumericIds(id, oldest) <= 0);
  if (!reachesOldest) {
    return { value: "window", reachesOldest };
  }
  return { value: input.chain === "complete" ? "full-history" : null, reachesOldest };
}

/**
 * Two indexed reads: the thread's chain and the chat's oldest message the
 * archive holds live (the AI reader's own filters). A failed read never fails
 * the generation: no value (the note stays empty, as before this change), and
 * the manifest says so.
 */
export async function resolveFanslyTranscriptCoverage(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    pageId: number;
    conversationRef: string;
    messages: readonly TranscriptMessage[];
    /** The live union served the transcript: a socket deletion hides an
     *  archived message here too. */
    liveOverlay: boolean;
  },
): Promise<{ value: HubTranscriptCoverage | undefined; manifest: FanslyTranscriptCoverageManifest }> {
  try {
    const chain = await loadClientConversationCoverage(app, {
      pageId: input.pageId,
      platform: "fansly",
      conversationRef: input.conversationRef,
    });
    const oldestRef = await findAiConversationOldestMessageRef(app.db, {
      pageId: input.pageId,
      conversationRef: input.conversationRef,
      liveOverlay: input.liveOverlay,
    });
    const judged = judgeFanslyTranscriptCoverage({
      chain,
      oldestRef,
      servedIds: input.messages.map((message) => message.id),
    });
    return {
      value: judged.value ?? undefined,
      manifest: { value: judged.value, chain, reachesOldest: judged.reachesOldest },
    };
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error }, "ai fansly transcript coverage read failed");
    return { value: undefined, manifest: { value: null, error: true } };
  }
}
