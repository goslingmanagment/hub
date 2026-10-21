import type { AiStartProofV1, AiStreamCapability } from "@agency_hub_core/contracts";

import { BadRequestError } from "../../../services/errors.ts";
import type { OperationFeature } from "../prompts/index.ts";

// chat-extension R20 HF-5 — the body fields of Hi on Fansly from the new
// client: its proof of the conversation's start (`startProof`), that proof's
// count of personal messages repeated at the top level, and the fan's avatar
// as the page loaded it. They ride only on `hi-greeting`, on a Fansly page,
// without `clientContext`, from a caller that advertised `hi-start-proof-v1`;
// elsewhere each is a 400 — with one exception: on an OnlyFans page the count
// alone rides at the top level (the ChatSpace extension's count of its window,
// audit 2026-10-20, row 6).
//
// Hi has no count limit (owner, 2026-10-21: the 10-message rule is Ping's,
// `PING_MIN_MESSAGES`). So nothing here refuses Hi: the proof and the count
// gate nothing, and an admitted proof only leaves its counts in the
// generation's context manifest. What stays is the shape: a field where it
// can never be read, or a proof of another chat, is a client bug.

/** The body fields of the lane. */
export interface HiStartProofFields {
  conversationRef: string;
  startProof?: AiStartProofV1 | undefined;
  personalMessageCount?: number | undefined;
  fanAvatarUrl?: string | undefined;
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
    // OnlyFans: the client's count of personal messages, alone (the header above).
    if (sent.length === 1 && body.personalMessageCount !== undefined) {
      return;
    }
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

/** What a proof leaves in the generation's context manifest: counts only,
 *  never an id. */
export interface HiStartProofManifest {
  source: AiStartProofV1["source"];
  coveredCount: number;
  personalCount: number;
  automatedCount: number;
}

export function hiStartProofManifestOf(proof: AiStartProofV1): HiStartProofManifest {
  return {
    source: proof.source,
    coveredCount: proof.coveredCount,
    personalCount: proof.personalCount,
    automatedCount: proof.automatedIds.length,
  };
}
