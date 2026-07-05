import {
  findObservationEnvelopesByIds,
  type DomainEventRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { normalizeOfapiSyncMessage } from "./ofapi-payloads.ts";

// Kernel Stage 24: serve-time enrichment for the v2 event stream. The ledger
// keeps message.* data canonical and thin (Stage 8); projection-grade
// consumers (the desktop) need the same normalized message payload the v1
// fanout carries, or every live message costs a read-gateway round trip.
// The frame's `payload` field is built here from the SOURCE OBSERVATION —
// the ledger rows stay byte-identical, and only OFAPI webhook message
// observations qualify (Fansly DM events have a different upstream shape and
// no OFAPI-keyed consumer).

const ENRICHABLE_TYPES = new Set(["message.received", "message.sent"]);
const ENRICHABLE_OBSERVATION_KINDS = new Set(["messages.received", "messages.sent"]);

function envelopePayload(observationPayload: unknown): Record<string, unknown> | null {
  if (typeof observationPayload !== "object" || observationPayload === null) {
    return null;
  }
  const inner = (observationPayload as Record<string, unknown>).payload;
  return typeof inner === "object" && inner !== null ? inner as Record<string, unknown> : null;
}

/**
 * Batch-build normalized message payloads for a page of v2 frames.
 * Returns event.id → normalized message; events that don't qualify (wrong
 * type, module-emitted observationId 0, non-webhook source, malformed
 * payload) are simply absent — the frame goes out without `payload`.
 */
export async function buildMessagePayloadEnrichments(
  app: Pick<AppContext, "db">,
  rows: readonly DomainEventRow[],
): Promise<Map<number, unknown>> {
  const candidates = rows.filter((row) =>
    ENRICHABLE_TYPES.has(row.type)
    && row.observationId > 0
    && row.conversationRef !== null,
  );
  if (candidates.length === 0) {
    return new Map();
  }
  const envelopes = await findObservationEnvelopesByIds(
    app.db,
    [...new Set(candidates.map((row) => row.observationId))],
  );
  const enrichments = new Map<number, unknown>();
  for (const row of candidates) {
    const envelope = envelopes.get(row.observationId);
    if (!envelope || envelope.source !== "webhook" || !ENRICHABLE_OBSERVATION_KINDS.has(envelope.kind)) {
      continue;
    }
    const payload = envelopePayload(envelope.payload);
    if (!payload) {
      continue;
    }
    const message = normalizeOfapiSyncMessage({
      payload,
      chatId: row.conversationRef!,
      isSentByMe: row.type === "message.sent",
    });
    if (message !== null) {
      enrichments.set(row.id, message);
    }
  }
  return enrichments;
}
