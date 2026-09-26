import {
  domainEventFactTypes,
  type DomainEventProvenance,
} from "@agency_hub_core/contracts";
import {
  dmThreadLabelKey,
  findObservationEnvelopesByIds,
  listDmThreadLabels,
  listRedeliveredWebhookObservationIds,
  type DmThreadLabel,
  type DomainEventRow,
} from "@agency_hub_core/db";

import { millsToDollarsNumber, type Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { appPlatformRegistry } from "../platforms/registry.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";
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

function headNumber(value: unknown): number | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

/** Wave 2: a superseding event carries the COMPLETE merged head in its data
 * — build the sync-message payload from IT, not the source observation (thin
 * frames would leave the desktop's copy unrepaired; whole-row upsert on
 * repeated ids is verified safe client-side). Mills → dollars only through
 * the shared codec. */
function enrichmentFromSupersedingHead(
  row: DomainEventRow,
): Record<string, unknown> | null {
  if (row.schemaVersion < 2 || typeof row.data !== "object" || row.data === null) {
    return null;
  }
  const data = row.data as Record<string, unknown>;
  if (data.supersedesEventId === undefined || data.supersedesEventId === null) {
    return null;
  }
  const head = data.head;
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    return null;
  }
  const fields = head as Record<string, unknown>;
  const createdAt = typeof fields.createdAt === "string" ? fields.createdAt : null;
  if (!row.messageRef || !createdAt) {
    return null;
  }
  const priceMills = headNumber(fields.priceMills);
  const tipMills = headNumber(fields.tipAmountMills);
  return {
    id: row.messageRef,
    text: typeof fields.text === "string" ? fields.text : "",
    createdAt,
    isSentByMe: fields.isSentByMe === true,
    price: priceMills === null ? 0 : millsToDollarsNumber(priceMills),
    ...(typeof fields.isOpened === "boolean" || fields.isOpened === null
      ? { isOpened: fields.isOpened }
      : {}),
    isTip: fields.isTip === true,
    ...(tipMills !== null && tipMills > 0
      ? { tipAmountUsd: millsToDollarsNumber(tipMills) }
      : {}),
    ...(Array.isArray(fields.media) && fields.media.length > 0
      ? { media: fields.media, mediaCount: fields.media.length }
      : {}),
  };
}

/**
 * Batch-build normalized message payloads for a page of v2 frames.
 * Returns event.id → normalized message; events that don't qualify (wrong
 * type, module-emitted observationId 0, non-webhook source, malformed
 * payload) are simply absent — the frame goes out without `payload`.
 * Superseding events enrich from their own head, before any observation
 * lookup.
 */
export async function buildMessagePayloadEnrichments(
  app: Pick<AppContext, "db" | "logger">,
  rows: readonly DomainEventRow[],
): Promise<Map<number, unknown>> {
  const headEnriched = new Map<number, unknown>();
  const candidates = rows.filter((row) => {
    if (!ENRICHABLE_TYPES.has(row.type) || row.conversationRef === null) {
      return false;
    }
    const fromHead = enrichmentFromSupersedingHead(row);
    if (fromHead !== null) {
      headEnriched.set(row.id, fromHead);
      return false;
    }
    return row.observationId > 0;
  });
  if (candidates.length === 0) {
    return headEnriched;
  }
  const envelopes = await findObservationEnvelopesByIds(
    app.db,
    [...new Set(candidates.map((row) => row.observationId))],
  );
  const enrichments = headEnriched;
  for (const row of candidates) {
    const envelope = envelopes.get(row.observationId);
    if (!envelope || envelope.source !== "webhook" || !ENRICHABLE_OBSERVATION_KINDS.has(envelope.kind)) {
      continue;
    }
    // G5 slice 2: the webhook envelope's body comes through the read seam.
    const resolved = await resolveCapturePayloadRow(
      app,
      "observation",
      row.observationId,
      envelope,
    );
    const payload = envelopePayload(resolved.payload);
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

// --- H3: provenance and thread labels -------------------------------------

const THREAD_LABELLED_TYPES: ReadonlySet<string> = new Set(domainEventFactTypes);

export interface DomainFrameContext {
  /** Absent when the redelivery lookup failed — consumers treat it as not live. */
  provenance?: DomainEventProvenance;
  thread?: DmThreadLabel;
}

/** A superseding correction: schema >= 2 carrying data.supersedesEventId —
 * the H2 PPV ref repair, the Fansly 1970 repair and the DM corrections
 * reconciler all mint this shape (domain-event-supersession.ts). */
export function isSupersedingDomainEvent(row: Pick<DomainEventRow, "schemaVersion" | "data">): boolean {
  if (row.schemaVersion < 2 || typeof row.data !== "object" || row.data === null) {
    return false;
  }
  const supersedes = (row.data as Record<string, unknown>).supersedesEventId;
  return typeof supersedes === "number" && Number.isSafeInteger(supersedes) && supersedes > 0;
}

/** Only a platform with a webhook lane (registry capability) can have a
 * provider redelivery; a page unknown to the caller is looked up, not assumed. */
function mayCarryWebhookRedelivery(pagePlatform: Platform | undefined): boolean {
  return pagePlatform === undefined
    || appPlatformRegistry.maybeGet(pagePlatform)?.capabilities.webhooks !== false;
}

/**
 * Batch-build provenance + thread labels for a page of v2 frames: at most two
 * statements for the whole batch (redelivered receipts, thread labels), never
 * one per frame. Provenance: `repair` for superseding events (no lookup);
 * `redelivery` when the source observation's OFAPI webhook receipt carries
 * the provider's redelivery header; otherwise `live`. Accounts on a platform
 * without webhooks (Fansly) skip the lookup. Thread labels ride money-fact
 * frames only (the frames a client may surface without a local chat row). A
 * failed lookup degrades that field, never the frame.
 */
export async function buildDomainFrameContexts(
  app: Pick<AppContext, "db" | "logger">,
  rows: readonly DomainEventRow[],
  options: { platformOf: (accountId: number) => Platform | undefined },
): Promise<Map<number, DomainFrameContext>> {
  const contexts = new Map<number, DomainFrameContext>();
  if (rows.length === 0) {
    return contexts;
  }
  const needsRedeliveryLookup = (row: DomainEventRow) => (
    !isSupersedingDomainEvent(row)
    && row.observationId > 0
    && mayCarryWebhookRedelivery(options.platformOf(row.accountId))
  );
  const lookupRows = rows.filter(needsRedeliveryLookup);
  const threadKeys = rows.flatMap((row) => (
    THREAD_LABELLED_TYPES.has(row.type) && row.conversationRef !== null
      ? [{ accountId: row.accountId, conversationRef: row.conversationRef }]
      : []
  ));
  const [redelivered, threads] = await Promise.allSettled([
    lookupRows.length === 0
      ? Promise.resolve(new Set<number>())
      : listRedeliveredWebhookObservationIds(app.db, lookupRows.map((row) => row.observationId)),
    threadKeys.length === 0
      ? Promise.resolve(new Map<string, DmThreadLabel>())
      : listDmThreadLabels(app.db, threadKeys),
  ]);
  if (redelivered.status === "rejected") {
    app.logger.warn({ err: redelivered.reason }, "v2 frame provenance lookup failed; omitting provenance");
  }
  if (threads.status === "rejected") {
    app.logger.warn({ err: threads.reason }, "v2 frame thread lookup failed; omitting thread labels");
  }
  for (const row of rows) {
    const context: DomainFrameContext = {};
    if (isSupersedingDomainEvent(row)) {
      context.provenance = "repair";
    } else if (!needsRedeliveryLookup(row)) {
      context.provenance = "live";
    } else if (redelivered.status === "fulfilled") {
      context.provenance = redelivered.value.has(row.observationId) ? "redelivery" : "live";
    }
    if (
      threads.status === "fulfilled"
      && THREAD_LABELLED_TYPES.has(row.type)
      && row.conversationRef !== null
    ) {
      const thread = threads.value.get(dmThreadLabelKey(row.accountId, row.conversationRef));
      if (thread !== undefined) {
        context.thread = thread;
      }
    }
    contexts.set(row.id, context);
  }
  return contexts;
}
