import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  OfapiWebhookAckResponse,
  OfapiWebhookReconcileBody,
  OfapiWebhookRegisterResponse,
  OfapiWebhookStatusResponse,
} from "@agency_hub_core/contracts";
import {
  completeOfapiWebhookRegistration,
  getLatestOfapiEventTimesForPages,
  getOfapiCreditState,
  getOfapiWebhookConfig,
  listOfapiMappedPages,
  listOnlyFansPagesForOfapiMapping,
  markOfapiWebhookRegistrationDispatching,
  markOfapiWebhookRegistrationIndeterminate,
  prepareOfapiWebhookRegistration,
  reconcileOfapiWebhookRegistrationAdopt,
  reconcileOfapiWebhookRegistrationNotCreated,
  rejectOfapiWebhookRegistration,
} from "@agency_hub_core/db";
import {
  decryptJsonWithKeyVersion,
  encryptJson,
  randomToken,
} from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import {
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "./errors.ts";
import { ofapiCredentialPolicy } from "./ofapi-credential-policy.ts";
import { createOfapiCreditSpendSink } from "./ofapi-credits.ts";
import { sendOfapiEventProcessJob } from "./ofapi-events.ts";
import { OfapiApiError, createOfapiClient, type OfapiClient } from "./ofapi.ts";
import {
  captureInvalidIdentityOfapiWebhookRaw,
  captureOfapiWebhookRaw,
} from "./ofapi-webhook-capture.ts";

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
  "chat_queue.updated",
  "chat_queue.finished",
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
    ...(config.pendingEncryptedSigningSecret
      ? [decryptSigningSecret(app, config.pendingEncryptedSigningSecret)]
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
    const quarantined = await captureInvalidIdentityOfapiWebhookRaw(app, {
      rawBody: input.rawBody,
      signature: signature!,
      providedIdempotencyKey: idempotencyKey,
    });
    return { received: true, duplicate: quarantined.duplicate };
  }

  // Capture-before-parse: once the signature is trusted, exact bytes commit
  // before JSON or envelope interpretation. Signed malformed
  // deliveries are quarantined locally and acknowledged, never discarded.
  const captured = await captureOfapiWebhookRaw(app, {
    rawBody: input.rawBody,
    idempotencyKey,
    captureHeaders: {
      signature,
      idempotencyKey,
    },
  });
  if (!captured.accepted) {
    return { received: true, duplicate: captured.duplicate };
  }

  // Best effort: the minutely sweep job re-enqueues any row left pending.
  try {
    if (boss) {
      await sendOfapiEventProcessJob(boss, captured.eventId);
    } else {
      app.logger.warn(
        { eventId: captured.eventId },
        "OFAPI event journaled without job queue; sweep will process it",
      );
    }
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: captured.eventId },
      "Failed to enqueue OFAPI event processing; sweep will retry",
    );
  }

  return { received: true, duplicate: captured.duplicate };
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
    ...ofapiCredentialPolicy(app.db, app.config, app.logger),
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
  // Registration inventories current associations; replacements require the
  // explicit versioned binding preview/apply workflow, never a username guess.
  for (const account of accounts) {
    const existing = pages.find(page => page.ofapiAccountId === account.id);
    const stable = existing?.creatorId ?? existing?.metadata.onlyfansUserId;
    if (existing && account.identityStatus !== "conflict" &&
        (!stable || stable === account.onlyfansUserId)) {
      mapped.push({ pageId: existing.id, label: existing.label, ofapiAccountId: account.id });
    } else unmatchedAccounts.push({ id: account.id, username: account.username });
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
  const credential = await client.getCredentialPreflight?.();
  if (credential?.status !== "verified") throw new ServiceUnavailableError(`OFAPI credential preflight ${credential?.status ?? "unknown"}`);
  const existing = await getOfapiWebhookConfig(app.db);
  let remoteProof: Parameters<typeof prepareOfapiWebhookRegistration>[1]["remoteProof"];
  if (existing?.registrationState === "stable" && existing.externalWebhookId) {
    if (!client.getWebhook) throw new ServiceUnavailableError("OFAPI remote webhook inspection unavailable");
    let remote: Record<string, unknown> | null;
    try {
      remote = await client.getWebhook(existing.externalWebhookId);
    } catch (error) {
      // A 404 alone may hide a scope-restricted resource. Require configured
      // full visibility plus a successful inventory, and refuse endpoint overlaps.
      if (!(error instanceof OfapiApiError) || error.status !== 404 ||
          app.config.ofapiWebhookManagementScope !== "team" || !client.listWebhooks) throw new ServiceUnavailableError("OFAPI webhook access unavailable; absence is unproven");
      const inventory = await client.listWebhooks();
      if (inventory.some(row => row.id === existing.externalWebhookId || row.url === input.endpointUrl || row.endpoint_url === input.endpointUrl)) {
        throw new ServiceUnavailableError("OFAPI remote webhook requires reconciliation");
      }
      remote = null;
    }
    if (remote && (remote.account_scope ?? remote.accountScope) !== "global") {
      throw new ServiceUnavailableError("OFAPI remote webhook scope is unknown or differs; reconcile before updating");
    }
    const matches = remote && (remote.url ?? remote.endpoint_url) === input.endpointUrl &&
      remote.enabled === true && Array.isArray(remote.events) &&
      JSON.stringify([...remote.events].sort()) === JSON.stringify([...OFAPI_WEBHOOK_EVENTS].sort());
    remoteProof = { id: existing.externalWebhookId, updatedAt: existing.updatedAt.toISOString(),
      credentialFingerprint: credential.credentialFingerprint, state: !remote ? "missing" : matches ? "match" : "drift" };
  } else if (!existing || (existing.registrationState === "stable" && !existing.externalWebhookId)) {
    if (app.config.ofapiWebhookManagementScope !== "team" || !client.listWebhooks) throw new ServiceUnavailableError("OFAPI webhook visibility must be confirmed before creation");
    const inventory = await client.listWebhooks();
    if (inventory.some(row => row.url === input.endpointUrl || row.endpoint_url === input.endpointUrl)) throw new ServiceUnavailableError("An existing OFAPI webhook for this endpoint requires reconciliation");
  }

  const candidateSecret = randomToken(32);
  const candidateEncryptedSecret = JSON.stringify(encryptJson(
    candidateSecret,
    app.config.encryptionKey,
    app.config.encryptionKeyVersion,
  ));
  const prepared = await prepareOfapiWebhookRegistration(app.db, {
    operationId: randomUUID(),
    endpointUrl: input.endpointUrl,
    events: [...OFAPI_WEBHOOK_EVENTS],
    candidateEncryptedSigningSecret: candidateEncryptedSecret,
    ...(remoteProof ? { remoteProof } : {}),
  });
  if (prepared.kind === "blocked") {
    const message = prepared.reason === "create_indeterminate"
      ? "Initial OFAPI webhook creation is indeterminate; reconcile the remote webhook before retrying"
      : `OFAPI webhook registration is blocked: ${prepared.reason}`;
    throw new ServiceUnavailableError(message);
  }
  const signingSecret = decryptSigningSecret(app, prepared.encryptedSigningSecret);
  const registration = {
    endpointUrl: prepared.kind === "ready" ? prepared.endpointUrl : input.endpointUrl,
    signingSecret,
    events: prepared.kind === "ready" ? prepared.events : [...OFAPI_WEBHOOK_EVENTS],
    accountScope: "global" as const,
  };

  let externalWebhookId: string | null;
  if (prepared.kind === "ready") {
    const dispatching = await markOfapiWebhookRegistrationDispatching(app.db, {
      operation: prepared.operation,
      operationId: prepared.operationId,
    });
    if (!dispatching) {
      throw new ServiceUnavailableError("OFAPI webhook registration dispatch fence was lost");
    }
    try {
      if (prepared.operation === "update") {
        if (!prepared.externalWebhookId) {
          throw new Error("Prepared OFAPI webhook update has no external id");
        }
        const updated = await client.updateWebhook(prepared.externalWebhookId, registration);
        externalWebhookId = updated.id ?? prepared.externalWebhookId;
      } else {
        externalWebhookId = (await client.createWebhook(registration)).id;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const definitelyRejected = error instanceof OfapiApiError &&
        error.status !== null &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408;
      if (definitelyRejected) {
        await rejectOfapiWebhookRegistration(app.db, {
          operation: prepared.operation,
          operationId: prepared.operationId,
          error: message,
        });
      } else {
        await markOfapiWebhookRegistrationIndeterminate(app.db, {
          operation: prepared.operation,
          operationId: prepared.operationId,
          error: message,
        });
      }
      throw new ServiceUnavailableError(`OFAPI webhook registration failed: ${message}`);
    }
    const completed = await completeOfapiWebhookRegistration(app.db, {
      operation: prepared.operation,
      operationId: prepared.operationId,
      returnedExternalWebhookId: externalWebhookId,
    });
    if (!completed) {
      await markOfapiWebhookRegistrationIndeterminate(app.db, {
        operation: prepared.operation,
        operationId: prepared.operationId,
        error: "OFAPI returned no usable webhook id",
      });
      throw new ServiceUnavailableError(
        "OFAPI webhook registration returned no usable id; reconciliation is required",
      );
    }
  } else {
    externalWebhookId = (await getOfapiWebhookConfig(app.db))?.externalWebhookId ?? null;
  }

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
    endpointUrl: registration.endpointUrl,
    accountScope: "global",
    events: registration.events,
    signingSecretMask: maskSecret(signingSecret),
    mapping,
  };
}

export async function reconcileOfapiWebhookRegistration(
  app: AppContext,
  input: OfapiWebhookReconcileBody,
): Promise<OfapiWebhookStatusResponse> {
  const reconciled = input.action === "adopt"
    ? await reconcileOfapiWebhookRegistrationAdopt(app.db, {
      operationId: input.operationId,
      externalWebhookId: input.externalWebhookId,
    })
    : await reconcileOfapiWebhookRegistrationNotCreated(app.db, {
      operationId: input.operationId,
      reason: input.reason,
    });
  if (!reconciled) {
    throw new ConflictError(
      "OFAPI webhook registration state or operation id changed; refresh status before reconciling",
    );
  }
  return getOfapiWebhookStatus(app);
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
    configured: Boolean(config?.externalWebhookId),
    registrationState: config
      ? config.registrationState as OfapiWebhookStatusResponse["registrationState"]
      : null,
    registrationError: config?.registrationError ?? null,
    pendingRegistration: config?.pendingRegistration ?? null,
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
        bindingGeneration: page.bindingGeneration,
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
