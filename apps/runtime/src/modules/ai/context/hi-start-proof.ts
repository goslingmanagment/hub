import {
  compareClientNumericIds,
  type AI_HI_GREETING_REFUSAL_REASONS,
  type AiCoverageCheck,
  type AiStartProofV1,
  type AiStreamCapability,
} from "@agency_hub_core/contracts";
import { findAiConversationOldestMessageRef } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import { BadRequestError, ProductGateError } from "../../../services/errors.ts";
import { HI_GREETING_MAX_TRANSCRIPT, type OperationFeature } from "../prompts/index.ts";
import type { TranscriptServedSnapshot } from "./context-frame.ts";

// chat-extension R20 HF-5 — Hi on Fansly by the client's proof of the
// conversation's start (owner decision X37).
//
// Hi is for a conversation with at most 10 personal messages, counted over a
// history read to its first message. The hub's own Fansly history is
// pull-cadenced and almost never reaches a new chat's first message, so the
// hub cannot count them. The released Fansly extension counts them itself and
// sends the count inside `clientContext`. The new client sends no
// `clientContext`: it proves the start from what its page already loaded
// (`startProof`), and the hub checks what it can check: the proof's ids
// against the history it holds, and the count against the limit.
//
// The lane: `hi-greeting`, a Fansly page, a transcript the hub loads itself,
// a caller that advertised `hi-start-proof-v1`. On it the proof decides and
// nothing else does: no proof is a refusal, never a count of zero, and the
// number of messages in the hub's transcript (the gate of every other lane)
// is not read. Off it nothing changes: the three body fields are refused
// (400), and Hi keeps the gate it had.

export type HiGreetingRefusalReason = (typeof AI_HI_GREETING_REFUSAL_REASONS)[number];

/** The body fields of the lane. */
export interface HiStartProofFields {
  conversationRef: string;
  startProof?: AiStartProofV1 | undefined;
  personalMessageCount?: number | undefined;
  fanAvatarUrl?: string | undefined;
}

/** Whether the start proof decides this request's Hi (the lane above). */
export function hiStartProofDecides(input: {
  feature: OperationFeature;
  isFanslyRequest: boolean;
  hasClientContext: boolean;
  capabilities: ReadonlySet<AiStreamCapability> | undefined;
}): boolean {
  return input.feature === "hi-greeting"
    && input.isFanslyRequest
    && !input.hasClientContext
    && input.capabilities?.has("hi-start-proof-v1") === true;
}

/**
 * Refuses the lane's body fields where they can never be read, and a proof
 * that is not of the chat the request names. Pure; a refusal here is a client
 * bug, so it is a 400 with a machine reason, as fresh text's is
 * (assertLiveTextRequestShape). A request that sends none of the fields passes
 * untouched, whatever its lane.
 */
export function assertHiStartProofRequestShape(input: {
  feature: OperationFeature;
  isFanslyRequest: boolean;
  hasClientContext: boolean;
  capabilities: ReadonlySet<AiStreamCapability> | undefined;
  body: HiStartProofFields;
}): void {
  const { body } = input;
  const sent = [
    body.startProof !== undefined ? "startProof" : null,
    body.personalMessageCount !== undefined ? "personalMessageCount" : null,
    body.fanAvatarUrl !== undefined ? "fanAvatarUrl" : null,
  ].filter((name): name is string => name !== null);
  if (sent.length === 0) {
    return;
  }
  const fields = sent.join(", ");
  if (input.feature !== "hi-greeting") {
    throw new BadRequestError(`${input.feature} does not accept ${fields}`, {
      reason: "start_proof_not_allowed",
    });
  }
  if (input.hasClientContext) {
    // The client-context lane carries its own count and avatar inside it.
    throw new BadRequestError(`${fields} cannot be combined with clientContext`, {
      reason: "start_proof_not_allowed",
    });
  }
  if (!input.isFanslyRequest) {
    throw new BadRequestError(`${fields} are only accepted for fansly pages`, {
      reason: "start_proof_not_allowed",
    });
  }
  if (!input.capabilities?.has("hi-start-proof-v1")) {
    throw new BadRequestError(`${fields} require the hi-start-proof-v1 capability`, {
      reason: "capability_required",
    });
  }
  if (body.startProof !== undefined && body.startProof.groupId !== body.conversationRef) {
    throw new BadRequestError("startProof.groupId must be the request's conversationRef", {
      reason: "start_proof_mismatch",
    });
  }
  if (
    body.startProof !== undefined
    && body.personalMessageCount !== undefined
    && body.personalMessageCount !== body.startProof.personalCount
  ) {
    throw new BadRequestError("personalMessageCount must equal startProof.personalCount", {
      reason: "start_proof_mismatch",
    });
  }
}

/**
 * The verdict on a proof: null admits Hi.
 *
 * `history_unproven`:
 * - no proof (a count without one proves nothing);
 * - the request's own window (`coverageCheck.window`, what the client's tab
 *   holds of the chat) names a message older than the proof's first one, or
 *   any message at all beside a proof of an empty history;
 * - the hub holds, live, a message of the conversation older than the proof's
 *   first one, or any message at all beside a proof of an empty history.
 *
 * `knownLiveIds` are only messages the hub holds as not deleted: a message
 * the hub knows as deleted never contradicts a proof, whatever its place (the
 * page no longer shows it, so the client could not have named it). The
 * witness itself is not looked up: the hub's history seldom reaches it, and a
 * witness deleted since is still where the history the client saw began.
 *
 * `too_many_personal`: the proof stands and counts more personal messages
 * than Hi allows. A tab counts over the whole history it proved, a pass among
 * its last 30 (the schema's rule), as the released Fansly extension does.
 */
export function judgeHiStartProof(input: {
  proof: AiStartProofV1 | undefined;
  /** The ids of the request's `coverageCheck.window`; empty when it sent none. */
  windowIds: readonly string[];
  /** Messages of the conversation the hub holds live. */
  knownLiveIds: readonly string[];
}): HiGreetingRefusalReason | null {
  const { proof } = input;
  if (proof === undefined) {
    return "history_unproven";
  }
  const witness = proof.startWitnessId;
  const beforeStart = (id: string) => witness === null || compareClientNumericIds(id, witness) < 0;
  if (input.windowIds.some(beforeStart) || input.knownLiveIds.some(beforeStart)) {
    return "history_unproven";
  }
  return proof.personalCount > HI_GREETING_MAX_TRANSCRIPT ? "too_many_personal" : null;
}

const REFUSAL_MESSAGES: Readonly<Record<HiGreetingRefusalReason, string>> = Object.freeze({
  history_unproven: "hi-greeting is only available for conversations whose start is proven",
  // The released clients' wording of the same refusal (assertHiGreetingFreshness).
  too_many_personal:
    `hi-greeting is only available for conversations with at most ${HI_GREETING_MAX_TRANSCRIPT} personal messages`,
});

/** What an admitted proof leaves in the generation's context manifest: counts
 *  only, never an id. */
export interface HiStartProofManifest {
  source: AiStartProofV1["source"];
  coveredCount: number;
  personalCount: number;
  automatedCount: number;
}

/** The lane's refusal: `gate_hi_greeting_limit` with its machine `reason`. */
export function hiStartProofRefusal(reason: HiGreetingRefusalReason): ProductGateError {
  return new ProductGateError(REFUSAL_MESSAGES[reason], "gate_hi_greeting_limit", { reason });
}

/**
 * The lane's first answer, before any context loads: without a proof Hi is
 * refused whatever the hub holds, so nothing is read for it.
 */
export function assertHiStartProofSent(proof: AiStartProofV1 | undefined): asserts proof is AiStartProofV1 {
  if (proof === undefined) {
    throw hiStartProofRefusal("history_unproven");
  }
}

/**
 * The Hi gate of the lane (`gate_hi_greeting_limit`, with its `reason`). Runs
 * after the transcript loaded: what the hub holds live for the conversation is
 * the transcript it just served (the socket overlay's messages included, where
 * the live union served) and the oldest message of its archive, one read. A
 * failed read is not swallowed: the request fails as any failed context load
 * does, it is never admitted on a guess.
 */
export async function assertHiStartProof(
  app: Pick<AppContext, "db">,
  input: {
    pageId: number;
    conversationRef: string;
    proof: AiStartProofV1 | undefined;
    coverageCheck: AiCoverageCheck | undefined;
    served: TranscriptServedSnapshot;
  },
): Promise<HiStartProofManifest> {
  assertHiStartProofSent(input.proof);
  const oldestArchived = await findAiConversationOldestMessageRef(app.db, {
    pageId: input.pageId,
    conversationRef: input.conversationRef,
    liveOverlay: input.served.source === "live_union",
  });
  const verdict = judgeHiStartProof({
    proof: input.proof,
    windowIds: input.coverageCheck?.window.map((item) => item.id) ?? [],
    knownLiveIds: [
      ...input.served.window.map((message) => message.messageRef),
      ...(oldestArchived !== null ? [oldestArchived] : []),
    ],
  });
  if (verdict !== null) {
    throw hiStartProofRefusal(verdict);
  }
  return {
    source: input.proof.source,
    coveredCount: input.proof.coveredCount,
    personalCount: input.proof.personalCount,
    automatedCount: input.proof.automatedIds.length,
  };
}
