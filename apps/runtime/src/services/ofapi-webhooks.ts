import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  OfapiWebhookAckResponse,
  OfapiWebhookRegisterResponse,
  OfapiWebhookStatusResponse,
} from "@agency_hub_core/contracts";
import {
  getLatestOfapiEventTimesForPages,
  getOfapiCreditState,
  getOfapiWebhookConfig,
  insertObservation,
  insertOfapiWebhookEvent,
  listOfapiMappedPages,
  listOnlyFansPagesForOfapiMapping,
  setPageOfapiAccountId,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import {
  decryptJsonWithKeyVersion,
  encryptJson,
  randomToken,
} from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import {
  BadRequestError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "./errors.ts";
import { createOfapiCreditSpendSink } from "./ofapi-credits.ts";
import { isOfapiDmProjectionEventType } from "./ofapi-dm-projection.ts";
import { isOfapiPresenceProjectionEventType } from "./ofapi-presence-projection.ts";
import { isOfapiSubscriptionProjectionEventType } from "./ofapi-subscription-projection.ts";
import { ofapiWebhookEnvelopeSchema, sendOfapiEventProcessJob } from "./ofapi-events.ts";
import { OfapiApiError, createOfapiClient, type OfapiClient } from "./ofapi.ts";

// Subscribed event set per ChatGoose PRD F8: everything the desktop's sync engine
// consumes plus journal-only analytics (transactions.new) and account auth states.
export const OFAPI_WEBHOOK_EVENTS = [
  "messages.received",
  "messages.sent",
  "messages.deleted",
  "messages.ppv.unlocked",
  "tips.received",
  "transactions.new",
  "subscriptions.new",
  "subscriptions.renewed",
  "users.typing",
  "users.online",
  "users.offline",
  "accounts.connected",
  "accounts.reconnected",
  "accounts.session_expired",
  "accounts.authentication_failed",
  "accounts.otp_code_required",
  "accounts.face_otp_required",
] as const;

const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function headerString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }
  return null;
}

/** Hex HMAC-SHA256 over the raw request bytes — re-serializing JSON breaks the MAC. */
export function verifyOfapiSignature(
  rawBody: Buffer,
  signatureHex: string,
  signingSecret: string,
) {
  if (!SIGNATURE_HEX_PATTERN.test(signatureHex)) {
    return false;
  }

  const expected = createHmac("sha256", signingSecret).update(rawBody).digest();
  const provided = Buffer.from(signatureHex, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function decryptSigningSecret(app: AppContext, encryptedSigningSecret: string) {
  return decryptJsonWithKeyVersion<string>(
    encryptedSigningSecret,
    app.config.encryptionKeysByVersion,
  );
}

function maskSecret(secret: string) {
  return `${secret.slice(0, 4)}…`;
}

/**
 * Receiver path: verify HMAC, dedupe on the idempotency key, journal, enqueue
 * async processing, ack. Stays well under OFAPI's 15s delivery timeout — two
 * indexed statements plus one pg-boss send.
 */
export async function receiveOfapiWebhook(
  app: AppContext,
  boss: Pick<PgBoss, "send"> | null,
  input: {
    rawBody: Buffer;
    signatureHeader: unknown;
    idempotencyKeyHeader: unknown;
  },
): Promise<OfapiWebhookAckResponse> {
  const config = await getOfapiWebhookConfig(app.db);
  if (!config) {
    throw new ServiceUnavailableError("OFAPI webhook is not registered");
  }

  // Accept the previous secret too: registration rotates the secret at OFAPI before
  // persisting it here, so in-flight deliveries may still carry the old signature.
  const signature = headerString(input.signatureHeader);
  const signingSecrets = [
    decryptSigningSecret(app, config.encryptedSigningSecret),
    ...(config.previousEncryptedSigningSecret
      ? [decryptSigningSecret(app, config.previousEncryptedSigningSecret)]
      : []),
  ];
  const signatureValid = signature !== null && signingSecrets.some(
    (secret) => verifyOfapiSignature(input.rawBody, signature, secret),
  );
  if (!signatureValid) {
    // A sustained run of these means the registered secret and the stored one have
    // diverged (e.g. a half-completed rotation) — OFAPI drops deliveries after 5
    // retries, so this must be loud.
    app.logger.warn({
      idempotencyKey: headerString(input.idempotencyKeyHeader),
      hasSignature: signature !== null,
    }, "OFAPI webhook delivery rejected: signature verification failed");
    throw new UnauthorizedError("Invalid webhook signature");
  }

  const idempotencyKey = headerString(input.idempotencyKeyHeader);
  if (!idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestError("Missing or invalid x-ofapi-idempotency-key header");
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(input.rawBody.toString("utf8")) as unknown;
  } catch {
    throw new BadRequestError("Webhook body is not valid JSON");
  }

  const envelope = ofapiWebhookEnvelopeSchema.safeParse(parsedBody);
  if (!envelope.success) {
    throw new BadRequestError("Webhook body is not an OFAPI event envelope");
  }

  // One transaction for the journal row AND its observation (Stage 7,
  // producer 1): a missing observation partition rolls back both -> 5xx ->
  // OFAPI retries — never an acked-but-unobserved delivery. Journaling is
  // unconditional (no capture flags, by construction); mapping is not
  // consulted, so unmapped-account deliveries are captured too.
  const created = await app.db.transaction(async (tx) => {
    const dbTx = tx as typeof app.db;
    const inserted = await insertOfapiWebhookEvent(dbTx, {
      idempotencyKey,
      eventType: envelope.data.event,
      ofapiAccountId: envelope.data.account_id ?? null,
      // Journal the full envelope so processing/replay never depends on parse-time choices.
      payload: parsedBody as Record<string, unknown>,
      // DM, subscription, and presence events are stamped as projection
      // candidates regardless of their flags, so turning the respective flag on
      // later lets the sweep project the journal rows still inside the retention
      // window.
      projectionStatus: isOfapiDmProjectionEventType(envelope.data.event) ||
          isOfapiSubscriptionProjectionEventType(envelope.data.event) ||
          isOfapiPresenceProjectionEventType(envelope.data.event)
        ? "pending"
        : "none",
    });
    if (!inserted) {
      // Same idempotent delivery, same fact — one observation per delivery
      // attempt is NOT kept.
      return null;
    }
    await insertObservation(dbTx, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      nativeAccountRef: envelope.data.account_id ?? null,
      kind: envelope.data.event,
      payload: parsedBody,
      payloadHash: createHash("sha256").update(input.rawBody).digest(),
      idempotencyKey,
    });
    return inserted;
  });

  if (!created) {
    return { received: true, duplicate: true };
  }

  // Best effort: the minutely sweep job re-enqueues any row left pending.
  try {
    if (boss) {
      await sendOfapiEventProcessJob(boss, created.id);
    } else {
      app.logger.warn({ eventId: created.id }, "OFAPI event journaled without job queue; sweep will process it");
    }
  } catch (error) {
    app.logger.warn({ err: error, eventId: created.id }, "Failed to enqueue OFAPI event processing; sweep will retry");
  }

  return { received: true, duplicate: false };
}

function resolveOfapiClient(app: AppContext): OfapiClient {
  if (app.ofapi) {
    return app.ofapi;
  }

  const apiKey = app.config.ofapiApiKey ?? null;
  if (!apiKey) {
    throw new ServiceUnavailableError("OFAPI_API_KEY is not configured");
  }

  return createOfapiClient({
    baseUrl: app.config.ofapiBaseUrl,
    apiKey,
    onCreditSpend: createOfapiCreditSpendSink(app),
  });
}

async function mapOfapiAccountsToPages(app: AppContext, client: OfapiClient) {
  const [accounts, pages] = await Promise.all([
    client.listAccounts(),
    listOnlyFansPagesForOfapiMapping(app.db),
  ]);

  const mapped: Array<{ pageId: number; label: string; ofapiAccountId: string }> = [];
  const unmatchedAccounts: Array<{ id: string; username: string | null }> = [];
  const claimedAccountIds = new Set(
    pages.map((page) => page.ofapiAccountId).filter((id): id is string => id !== null),
  );
  const pagesByUsername = new Map<string, typeof pages>();
  for (const page of pages) {
    if (!page.username) {
      continue;
    }
    const key = page.username.toLowerCase();
    pagesByUsername.set(key, [...(pagesByUsername.get(key) ?? []), page]);
  }

  for (const account of accounts) {
    const candidates = account.username
      ? pagesByUsername.get(account.username.toLowerCase()) ?? []
      : [];
    const existing = pages.find((page) => page.ofapiAccountId === account.id);
    if (existing) {
      // Already mapped (idempotent re-registration).
      mapped.push({ pageId: existing.id, label: existing.label, ofapiAccountId: account.id });
      continue;
    }

    // Map only on an unambiguous username match to a page that has no mapping yet;
    // anything else is reported back for manual resolution instead of guessed.
    const target = candidates.length === 1 && candidates[0] && !candidates[0].ofapiAccountId
      ? candidates[0]
      : null;
    if (!target || claimedAccountIds.has(account.id)) {
      unmatchedAccounts.push({ id: account.id, username: account.username });
      continue;
    }

    await setPageOfapiAccountId(app.db, { pageId: target.id, ofapiAccountId: account.id });
    target.ofapiAccountId = account.id;
    claimedAccountIds.add(account.id);
    mapped.push({ pageId: target.id, label: target.label, ofapiAccountId: account.id });
  }

  const unmappedPages = pages
    .filter((page) => !page.ofapiAccountId)
    .map((page) => page.label);

  return { mapped, unmatchedAccounts, unmappedPages };
}

export async function registerOfapiWebhook(
  app: AppContext,
  input: { endpointUrl: string },
): Promise<OfapiWebhookRegisterResponse> {
  const client = resolveOfapiClient(app);
  const existing = await getOfapiWebhookConfig(app.db);
  const signingSecret = randomToken(32);
  const registration = {
    endpointUrl: input.endpointUrl,
    signingSecret,
    events: [...OFAPI_WEBHOOK_EVENTS],
    accountScope: "global" as const,
  };

  let externalWebhookId: string | null;
  try {
    if (existing?.externalWebhookId) {
      const updated = await client.updateWebhook(existing.externalWebhookId, registration);
      externalWebhookId = updated.id ?? existing.externalWebhookId;
    } else {
      externalWebhookId = (await client.createWebhook(registration)).id;
    }
  } catch (error) {
    if (error instanceof OfapiApiError) {
      throw new ServiceUnavailableError(`OFAPI webhook registration failed: ${error.message}`);
    }
    throw error;
  }

  await upsertOfapiWebhookConfig(app.db, {
    externalWebhookId,
    endpointUrl: input.endpointUrl,
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(
      signingSecret,
      app.config.encryptionKey,
      app.config.encryptionKeyVersion,
    )),
    // Grace window: deliveries already signed with the outgoing secret keep verifying.
    previousEncryptedSigningSecret: existing?.encryptedSigningSecret ?? null,
  });

  let mapping: Awaited<ReturnType<typeof mapOfapiAccountsToPages>>;
  try {
    mapping = await mapOfapiAccountsToPages(app, client);
  } catch (error) {
    if (error instanceof OfapiApiError) {
      // Registration itself is stored; surface the partial failure to the admin.
      throw new ServiceUnavailableError(
        `OFAPI webhook registered, but account mapping failed: ${error.message}. Re-run registration to retry.`,
      );
    }
    throw error;
  }

  return {
    externalWebhookId,
    endpointUrl: input.endpointUrl,
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    signingSecretMask: maskSecret(signingSecret),
    mapping,
  };
}

export async function getOfapiWebhookStatus(
  app: AppContext,
): Promise<OfapiWebhookStatusResponse> {
  const now = new Date();
  const [config, pages, mappedPages, credit] = await Promise.all([
    getOfapiWebhookConfig(app.db),
    listOnlyFansPagesForOfapiMapping(app.db),
    listOfapiMappedPages(app.db),
    getOfapiCreditState(app.db, now),
  ]);
  const lastEventTimes = await getLatestOfapiEventTimesForPages(
    app.db,
    mappedPages.map((page) => page.id),
  );
  const mappedById = new Map(mappedPages.map((page) => [page.id, page] as const));

  return {
    configured: config !== null,
    endpointUrl: config?.endpointUrl ?? null,
    externalWebhookId: config?.externalWebhookId ?? null,
    accountScope: config?.accountScope ?? null,
    events: config?.events ?? [],
    signingSecretMask: config
      ? maskSecret(decryptSigningSecret(app, config.encryptedSigningSecret))
      : null,
    updatedAt: config ? new Date(config.updatedAt).toISOString() : null,
    pages: pages.map((page) => {
      const mapped = mappedById.get(page.id) ?? null;
      const lastEventAt = lastEventTimes.get(page.id) ?? null;
      return {
        pageId: page.id,
        label: page.label,
        username: page.username,
        ofapiAccountId: page.ofapiAccountId,
        ofapiAuthStatus: mapped?.ofapiAuthStatus ?? null,
        ofapiAuthChangedAt: mapped?.ofapiAuthChangedAt
          ? mapped.ofapiAuthChangedAt.toISOString()
          : null,
        lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
        lastEventAgeSeconds: lastEventAt
          ? Math.max(0, Math.round((now.getTime() - lastEventAt.getTime()) / 1000))
          : null,
      };
    }),
    credit: {
      lastBalance: credit.lastBalance,
      lastBalanceAt: credit.lastBalanceAt ? credit.lastBalanceAt.toISOString() : null,
      spentToday: credit.spentToday,
    },
  };
}
