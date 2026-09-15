import { extractFanslyWsHints, FANSLY_WS_CAPTURE_KIND, FANSLY_WS_HINT_TYPES } from "@agency_hub_core/shared";
import { isRecord, type CanonicalizableObservation, type CanonicalEventDraft } from "./types.ts";

export const FANSLY_WS_SIGNAL_EVENT = "fansly.ws_signal_observed";

export function canParseFanslyWsObservation(observation: CanonicalizableObservation) {
  return observation.source === "fansly_ws" && observation.platform === "fansly"
    && observation.accountId !== null && observation.kind === FANSLY_WS_CAPTURE_KIND
    && isRecord(observation.payload) && observation.payload.codec === FANSLY_WS_CAPTURE_KIND
    && typeof observation.payload.frame === "string";
}

/** Parsing retains addresses and explicit debt only. A candidate type is not
 * permission to dispatch: the operational projector has separate live gates.
 * Old B0 envelopes without a captured generation remain unattributable debt. */
export function canonicalizeFanslyWsObservation(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!canParseFanslyWsObservation(observation) || !isRecord(observation.payload)) return [];
  const generation = typeof observation.payload.generation === "string"
    && /^[0-9a-f]{64}$/.test(observation.payload.generation) ? observation.payload.generation : null;
  return extractFanslyWsHints(observation.payload.frame as string, new Set(FANSLY_WS_HINT_TYPES))
    .map((node) => ({
      type: FANSLY_WS_SIGNAL_EVENT,
      occurredAt: observation.receivedAt,
      conversationRef: node.hint?.groupRef ?? node.mutation?.groupRef ?? null,
      messageRef: node.hint?.messageRef ?? node.mutation?.messageRef ?? null,
      schemaVersion: 1,
      dedupKey: `fansly-ws-signal:v1:${observation.id}:${node.path.join(".")}`,
      data: { ...node, generation, receivedAt: observation.receivedAt.toISOString() },
    }));
}
