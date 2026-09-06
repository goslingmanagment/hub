import { createHash } from "node:crypto";

import {
  acceptOfapiWebhookRaw,
  claimOfapiWebhookRaw,
  getOfapiWebhookEventById,
  insertObservation,
  quarantineMalformedOfapiWebhookRaw,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import { isOfapiDmProjectionEventType } from "./ofapi-dm-projection.ts";
import { ofapiWebhookEnvelopeSchema } from "./ofapi-payloads.ts";
import { isOfapiPresenceProjectionEventType } from "./ofapi-presence-projection.ts";
import { isOfapiSubscriptionProjectionEventType } from "./ofapi-subscription-projection.ts";

export const OFAPI_EPHEMERAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "users.typing", "users.online", "users.offline",
]);

function projectionStatus(eventType: string): "pending" | "none" {
  return isOfapiDmProjectionEventType(eventType) ||
      isOfapiSubscriptionProjectionEventType(eventType) ||
      isOfapiPresenceProjectionEventType(eventType) ||
      eventType.startsWith("accounts.") ||
      eventType.startsWith("media_uploads.") ||
      eventType.startsWith("data_exports.")
    ? "pending"
    : "none";
}

async function assertObservationHash(
  db: AppContext["db"],
  observation: { inserted: boolean; observationId: number; receivedAt: Date },
  payloadHash: Buffer,
) {
  if (observation.inserted) return;
  const existing = await db.execute<{ payload_hash: Buffer }>(sql`
    select payload_hash
    from observations
    where id = ${observation.observationId}
      and received_at = ${observation.receivedAt}
  `);
  if (!existing.rows[0]?.payload_hash?.equals(payloadHash)) {
    throw new Error("OFAPI webhook observation key conflicts with different raw bytes");
  }
}

export interface FinalizedOfapiWebhookRaw {
  eventId: number;
  state: "accepted" | "quarantined_malformed";
}

/** Locally parses already-durable bytes. Safe to call from both the receiver
 * and the existing pending-event sweep after a process crash. */
export async function finalizeOfapiWebhookRaw(
  app: AppContext,
  eventId: number,
): Promise<FinalizedOfapiWebhookRaw> {
  const initial = await getOfapiWebhookEventById(app.db, eventId);
  if (!initial) throw new Error(`OFAPI webhook raw event ${eventId} is missing`);
  if (initial.captureState === "accepted") {
    return { eventId, state: "accepted" };
  }
  if (initial.captureState === "quarantined_malformed") {
    return { eventId, state: "quarantined_malformed" };
  }
  if (initial.captureState !== "raw_captured" || !initial.rawBody || !initial.payloadHash) {
    throw new Error(`OFAPI webhook raw event ${eventId} has an invalid capture envelope`);
  }
  const rawBody = initial.rawBody;
  const payloadHash = initial.payloadHash;

  let parsedBody: unknown;
  let malformedReason: string | null = null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    parsedBody = null;
    malformedReason = "signed_webhook_invalid_json";
  }
  const envelope = malformedReason === null
    ? ofapiWebhookEnvelopeSchema.safeParse(parsedBody)
    : null;
  if (envelope !== null && !envelope.success) {
    malformedReason = "signed_webhook_invalid_envelope";
  }

  if (initial.captureHeaders["identityStatus"] === "invalid" ||
      (initial.captureHeaders["identityStatus"] === "local_receipt" && envelope?.success &&
        !OFAPI_EPHEMERAL_EVENT_TYPES.has(envelope.data.event))) {
    await app.db.transaction(async (tx) => {
      const db = tx as AppContext["db"];
      const won = await quarantineMalformedOfapiWebhookRaw(db, {
        id: initial.id,
        payloadHash,
        reason: "signed_webhook_invalid_identity_header",
      });
      if (!won) return;
      const storedIdentity = initial.captureHeaders["idempotencyKey"];
      const providedIdempotencyKey = storedIdentity === "<missing>"
        ? null
        : storedIdentity ?? null;
      const observation = await insertObservation(db, {
        source: "webhook",
        producer: "ofapi:webhook-raw",
        platform: "onlyfans",
        kind: "ofapi.webhook.invalid_identity",
        payload: {
          reason: "signed_webhook_invalid_identity_header",
          providedIdempotencyKey,
          bodyEncoding: "base64",
          body: rawBody.toString("base64"),
          headers: initial.captureHeaders,
        },
        payloadHash,
        idempotencyKey: `${initial.idempotencyKey}:quarantine`,
      });
      await assertObservationHash(db, observation, payloadHash);
    });
    return { eventId, state: "quarantined_malformed" };
  }

  if (malformedReason !== null) {
    await app.db.transaction(async (tx) => {
      const db = tx as AppContext["db"];
      const won = await quarantineMalformedOfapiWebhookRaw(db, {
        id: initial.id,
        payloadHash,
        reason: malformedReason!,
      });
      if (!won) return;
      const observation = await insertObservation(db, {
        source: "webhook",
        producer: "ofapi:webhook-raw",
        platform: "onlyfans",
        kind: "ofapi.webhook.malformed",
        payload: {
          reason: malformedReason,
          bodyEncoding: "base64",
          body: rawBody.toString("base64"),
          headers: initial.captureHeaders,
        },
        payloadHash,
        idempotencyKey: `${initial.idempotencyKey}:malformed:${payloadHash.toString("hex")}`,
      });
      await assertObservationHash(db, observation, payloadHash);
    });
    return { eventId, state: "quarantined_malformed" };
  }

  if (!envelope?.success) {
    throw new Error(`OFAPI webhook raw event ${eventId} escaped malformed quarantine`);
  }
  const acceptedEnvelope = envelope.data;
  await app.db.transaction(async (tx) => {
    const db = tx as AppContext["db"];
    const won = await acceptOfapiWebhookRaw(db, {
      id: initial.id,
      payloadHash,
      eventType: acceptedEnvelope.event,
      ofapiAccountId: acceptedEnvelope.account_id ?? null,
      payload: parsedBody as Record<string, unknown>,
      projectionStatus: projectionStatus(acceptedEnvelope.event),
    });
    if (!won) return;
    const observation = await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      nativeAccountRef: acceptedEnvelope.account_id ?? null,
      kind: acceptedEnvelope.event,
      payload: parsedBody,
      payloadHash,
      idempotencyKey: initial.idempotencyKey,
    });
    await assertObservationHash(db, observation, payloadHash);
  });
  return { eventId, state: "accepted" };
}

export interface CaptureOfapiWebhookRawResult {
  eventId: number;
  duplicate: boolean;
  accepted: boolean;
  conflict: boolean;
}

/** A valid signature proves these bytes came from OFAPI even when the vendor's
 * delivery identity header is missing or unusable. Retain the bytes under a
 * deterministic local identity, quarantine them, and acknowledge the request
 * so a permanently malformed header cannot exhaust the vendor retry window. */
export async function captureInvalidIdentityOfapiWebhookRaw(
  app: AppContext,
  input: {
    rawBody: Buffer;
    signature: string;
    providedIdempotencyKey: string | null;
  },
): Promise<{ eventId: number; duplicate: boolean }> {
  const payloadHash = createHash("sha256").update(input.rawBody).digest();
  const localIdentity = `invalid-identity:${payloadHash.toString("hex")}`;
  const claim = await claimOfapiWebhookRaw(app.db, {
    idempotencyKey: localIdentity,
    rawBody: input.rawBody,
    payloadHash,
    captureHeaders: {
      signature: input.signature,
      idempotencyKey: input.providedIdempotencyKey ?? "<missing>",
      identityStatus: "invalid",
    },
  });
  if (!claim.payloadHash?.equals(payloadHash)) {
    throw new Error("OFAPI invalid-identity capture conflicts with different raw bytes");
  }
  if (claim.captureState === "accepted") {
    throw new Error("OFAPI invalid-identity capture collided with an accepted delivery");
  }
  const finalized = await finalizeOfapiWebhookRaw(app, claim.id);
  if (finalized.state !== "quarantined_malformed") {
    throw new Error("OFAPI invalid-identity delivery escaped quarantine");
  }
  return { eventId: claim.id, duplicate: !claim.created };
}

export async function captureOfapiWebhookRaw(
  app: AppContext,
  input: {
    rawBody: Buffer;
    idempotencyKey: string;
    captureHeaders: Record<string, string>;
  },
): Promise<CaptureOfapiWebhookRawResult> {
  const payloadHash = createHash("sha256").update(input.rawBody).digest();
  const claim = await claimOfapiWebhookRaw(app.db, {
    idempotencyKey: input.idempotencyKey,
    rawBody: input.rawBody,
    payloadHash,
    captureHeaders: input.captureHeaders,
  });
  if (!claim.payloadHash?.equals(payloadHash)) {
    const observation = await insertObservation(app.db, {
      source: "webhook",
      producer: "ofapi:webhook-raw",
      platform: "onlyfans",
      kind: "ofapi.webhook.fact_conflict",
      payload: {
        idempotencyKey: input.idempotencyKey,
        existingPayloadHash: claim.payloadHash?.toString("hex") ?? null,
        conflictingPayloadHash: payloadHash.toString("hex"),
        bodyEncoding: "base64",
        body: input.rawBody.toString("base64"),
        headers: input.captureHeaders,
      },
      payloadHash,
      idempotencyKey: `${input.idempotencyKey}:fact-conflict:${payloadHash.toString("hex")}`,
    });
    await assertObservationHash(app.db, observation, payloadHash);
    app.logger.error(
      { eventId: claim.id, idempotencyKey: input.idempotencyKey },
      "OFAPI reused a webhook idempotency key for different raw bytes",
    );
    return {
      eventId: claim.id,
      duplicate: false,
      accepted: false,
      conflict: true,
    };
  }

  const finalized = await finalizeOfapiWebhookRaw(app, claim.id);
  return {
    eventId: claim.id,
    duplicate: !claim.created,
    accepted: finalized.state === "accepted",
    conflict: false,
  };
}
