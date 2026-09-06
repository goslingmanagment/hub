import { createHash } from "node:crypto";
import { OfapiKeyPermissionDeniedError } from "./ofapi-vendor-usage.ts";

import {
  claimQueuedOfapiCommand,
  expireStaleQueuedOfapiCommands,
  finalizeOfapiCommand,
  findPageById,
  withOfapiBindingLock,
  markOfapiBindingUnavailable,
  getOfapiCommandById,
  insertObservation,
  listOfapiCommandVerificationCandidates,
  listQueuedOfapiCommandIds,
  markStaleInFlightOfapiCommandsIndeterminate,
  purgeExpiredTypingCommands,
  reduceDmMessageCandidate,
  type OfapiCommandRow,
} from "@agency_hub_core/db";
import { millsFromDollars, normalizeDmMessageText } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { notifyOfapiAuthIncident } from "./notification-incidents.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  isOfapiDmColdArchiveEnabled,
  resolveOfapiDmColdArchiveRetentionDays,
} from "./ofapi-dm-archive.ts";
import { OfapiApiError, OfapiCreditAccountingUnavailableError, OfapiCredentialNotReadyError, ofapiAccountNotFound } from "./ofapi.ts";
import {
  isOfapiAccountHealthEnabled,
  ofapiAuthStatusNeedsAction,
} from "./ofapi-account-health.ts";
import {
  asRecord,
  idToString,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OFAPI_COMMAND_EXECUTE_QUEUE = "ofapi.commands.execute";
export const OFAPI_COMMAND_SWEEP_QUEUE = "ofapi.commands.sweep";

const COMMAND_SWEEP_LIMIT = 100;
const STALE_IN_FLIGHT_MS = 2 * 60 * 1000;
// W3.2 (A4+A23, decision #125): queued-only rows older than this expire to
// `cancelled` at each sweep. 10 min = the desktop's VERIFY_AUTO_STOP_AGE_MS:
// the kernel must never execute a queued row the desktop has already stopped
// watching (15 min would leave a 5-min blind execution window). Overridable
// live via the ofapiQueuedCommandTtlMs registry row (non-staged).
export const QUEUED_COMMAND_TTL_MS = 10 * 60 * 1000;
/** Typing lasts about four seconds at the vendor. Executing an older queued
 * beacon after the chatter stopped typing is actively misleading, so it gets
 * a separate fail-closed claim/expiry horizon. */
export const TYPING_COMMAND_TTL_MS = 10 * 1000;
const WEBHOOK_CORRELATION_WINDOW_MS = 10 * 60 * 1000;
const WEBHOOK_CLOCK_SKEW_MS = 5 * 1000;

export interface OfapiCommandExecutePayload {
  commandId: string;
}

export type OfapiCommandFailure = {
  state: "failed_retryable" | "failed_terminal" | "indeterminate";
  errorCode: string;
  errorClass: "retryable" | "terminal" | "indeterminate";
  httpStatus: number | null;
};

/** The command was claimed, but its local guard refused any vendor dispatch. */
export class OfapiLocalDispatchRefusal extends Error {
  constructor(
    readonly reason: "account_unavailable" | "binding_replaced" | "auth_action_required" | "credential_not_verified" | "credit_accounting_unavailable" | "key_scope_denied",
    readonly detail: string | null = null,
  ) {
    super(`OFAPI command refused before dispatch: ${reason}`);
    this.name = "OfapiLocalDispatchRefusal";
  }
}

export function classifyOfapiCommandFailure(error: unknown): OfapiCommandFailure {
  if (error instanceof OfapiLocalDispatchRefusal) return {
    state: "failed_terminal", errorClass: "terminal", httpStatus: null,
    errorCode: error.reason === "account_unavailable" ? "ofapi_account_not_found" : `ofapi_${error.reason}`,
  };
  if (error instanceof OfapiApiError && ofapiAccountNotFound(error.status, error.body)) return {
    state: "failed_terminal" as const, errorCode: "ofapi_account_not_found", errorClass: "terminal" as const, httpStatus: error.status,
  };
  const status = error instanceof OfapiApiError
    ? error.upstreamStatus ?? error.status
    : null;
  if (status === 429) {
    return {
      state: "failed_retryable",
      errorCode: "ofapi_rate_limited",
      errorClass: "retryable",
      httpStatus: status,
    };
  }
  if (status !== null && [400, 401, 403, 404, 409, 422].includes(status)) {
    return {
      state: "failed_terminal",
      errorCode: `ofapi_http_${status}`,
      errorClass: "terminal",
      httpStatus: status,
    };
  }
  if (status !== null && status >= 200 && status < 300) {
    return {
      state: "indeterminate",
      errorCode: "ofapi_ambiguous_success",
      errorClass: "indeterminate",
      httpStatus: status,
    };
  }
  if (status !== null) {
    return {
      state: "indeterminate",
      errorCode: `ofapi_http_${status}`,
      errorClass: "indeterminate",
      httpStatus: status,
    };
  }
  return {
    state: "indeterminate",
    errorCode: "ofapi_transport_unknown",
    errorClass: "indeterminate",
    httpStatus: null,
  };
}

export function isOfapiCommandExecutionEnabled(
  config?: Pick<AppContext["config"], "ofapiDesktopCommandExecutionEnabled">,
) {
  return config?.ofapiDesktopCommandExecutionEnabled === true;
}

async function resolveQueuedCommandTtlMs(app: Pick<AppContext, "db" | "config">) {
  const effective = await loadEffectiveConfig(app.db, app.config);
  return effective.ofapiQueuedCommandTtlMs ?? QUEUED_COMMAND_TTL_MS;
}

/**
 * Stage 7 producer 5: every durable business-command settle emits a
 * command_result observation. Best-effort AFTER the finalize commit — the
 * outcome already lives permanently in ofapi_commands (Stage 1 stopped its
 * redaction), so a capture hiccup must not unsettle a settled command or risk
 * a re-send; it is logged at error level instead. The
 * `cmd:<id>:<state>` key dedupes the direct-confirm/webhook-confirm race into
 * one fact. Cosmetic typing is intentionally excluded below.
 */
async function recordCommandResultObservation(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    command: Pick<OfapiCommandRow, "id" | "kind" | "pageId" | "conversationId" | "chatterUserId">;
    state: string;
    outcome: Record<string, unknown>;
  },
) {
  // Typing is cosmetic and explicitly lossy. Persisting a canonical result
  // observation would merely move the permanent-history leak out of the
  // command table and into the observations ledger.
  if (input.command.kind === "typing_active_v1") {
    return;
  }
  const payload = {
    commandId: input.command.id,
    commandKind: input.command.kind,
    pageId: input.command.pageId,
    conversationId: input.command.conversationId,
    state: input.state,
    ...input.outcome,
  };
  try {
    await insertObservation(app.db, {
      source: "command_result",
      producer: "ofapi:command-executor",
      platform: "onlyfans",
      accountId: input.command.pageId,
      kind: `command.${input.state}`,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `cmd:${input.command.id}:${input.state}`,
      actorPrincipalId: input.command.chatterUserId,
    });
  } catch (error) {
    app.logger.error(
      { err: error, commandId: input.command.id, state: input.state },
      "command_result observation capture failed — outcome remains in ofapi_commands",
    );
  }
}

export async function ensureOfapiCommandQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await Promise.all([
    ensureQueueCreated(boss, OFAPI_COMMAND_EXECUTE_QUEUE, {
      policy: "standard",
      retryLimit: 0,
    }, createdQueues),
    ensureQueueCreated(boss, OFAPI_COMMAND_SWEEP_QUEUE, {
      policy: "exclusive",
    }, createdQueues),
  ]);
}

export async function ensureOfapiCommandSchedules(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(OFAPI_COMMAND_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
}

export function sendOfapiCommandExecuteJob(
  boss: Pick<PgBoss, "send">,
  commandId: string,
) {
  return boss.send(
    OFAPI_COMMAND_EXECUTE_QUEUE,
    { commandId } satisfies OfapiCommandExecutePayload,
    { singletonKey: commandId, retryLimit: 0 },
  );
}

/**
 * Wave 2 sends-as-facts: a CONFIRMED text/media send becomes a message fact
 * through the candidate path (source='command'). Direct-confirm path only —
 * the webhook-confirm path's journal row already feeds the webhook candidate
 * through the cold-archive lane. Fill-grade material (a later webhook
 * upgrades it under W); source_idempotency_key is the command_result
 * observation's key (real lineage — the corrections reconciler resolves the
 * first message.sent event through it, dedupe-proof against a late webhook).
 * Best-effort: a fact-write hiccup must never unsettle a settled command.
 */
async function recordConfirmedSendFact(
  app: AppContext,
  command: OfapiCommandRow,
  platformMessageId: string,
  confirmedAt: Date,
) {
  if (!isOfapiDmColdArchiveEnabled(app.config)) {
    return;
  }
  if (command.kind !== "send_text_message_v1" && command.kind !== "send_media_message_v1") {
    return;
  }
  try {
    const payload = command.payload as { text?: unknown; price?: unknown };
    const text = typeof payload.text === "string" ? normalizeDmMessageText(payload.text) : "";
    const priceMills = command.kind === "send_media_message_v1"
      && typeof payload.price === "number" && payload.price > 0
      ? millsFromDollars(payload.price)
      : null;
    const retentionDays = resolveOfapiDmColdArchiveRetentionDays(app);
    const result = await reduceDmMessageCandidate(app.db, {
      source: "command",
      platform: "onlyfans",
      platformAccountId: command.pageId,
      ofapiAccountId: command.ofapiAccountId,
      platformMessageId,
      platformConversationId: command.conversationId,
      fanPlatformUserId: command.conversationId,
      senderRole: "model",
      isSentByMe: true,
      // The direct response carries no platform timestamp — confirm time is
      // the honest fill; a later webhook replaces it under W.
      messageCreatedAt: confirmedAt,
      textPlain: text,
      priceMills,
      isTip: false,
      tipAmountMills: 0n,
      // Media ids are known but their metadata is NOT — never fabricated;
      // the webhook's media array fills/replaces under W.
      sourceIdempotencyKey: `cmd:${command.id}:confirmed`,
      sourceReceivedAt: confirmedAt,
      retentionPolicy: "default",
      retainUntil: new Date(confirmedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
    });
    if (result.status === "deferred") {
      app.logger.warn(
        { commandId: command.id, platformMessageId },
        "Confirmed-send fact deferred behind an erasure fence; webhook lane remains the fallback",
      );
    }
  } catch (error) {
    app.logger.error(
      { err: error, commandId: command.id, platformMessageId },
      "Confirmed-send fact write failed — command stays settled; webhook lane remains the fallback",
    );
  }
}

function canExecuteCommandKind(
  app: AppContext,
  command: Pick<OfapiCommandRow, "kind">,
): boolean {
  switch (command.kind) {
    case "send_text_message_v1":
      return typeof app.ofapi?.sendTextMessage === "function";
    case "send_media_message_v1":
      return typeof app.ofapi?.sendMediaMessage === "function";
    case "typing_active_v1":
      return typeof app.ofapi?.startTyping === "function";
    case "unsend_message_v1":
      return typeof app.ofapi?.unsendMessage === "function";
    case "mark_chat_read_v1":
      return typeof app.ofapi?.markChatRead === "function";
  }
}

function textPayload(command: OfapiCommandRow): { text: string } {
  const payload = command.payload as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new OfapiApiError("OFAPI text command payload is invalid", 422, null);
  }
  return { text: payload.text };
}

const MEDIA_ID_PATTERN = /^(?:[0-9]{1,30}|ofapi_media_[A-Za-z0-9_-]{1,128})$/;

function mediaPayload(command: OfapiCommandRow): {
  text: string;
  price: number;
  mediaFiles: string[];
  previews: string[];
} {
  const payload = command.payload as {
    text?: unknown;
    price?: unknown;
    mediaFiles?: unknown;
    previews?: unknown;
  };
  const { text, price, mediaFiles, previews } = payload;
  if (typeof text !== "string" || text.length > 10_000) {
    throw new OfapiApiError("OFAPI media command text is invalid", 422, null);
  }
  if (
    typeof price !== "number"
    || !Number.isInteger(price)
    || price < 0
    || price > 200
    || (price !== 0 && price < 3)
  ) {
    throw new OfapiApiError("OFAPI media command price is invalid", 422, null);
  }
  if (
    !Array.isArray(mediaFiles)
    || mediaFiles.length === 0
    || mediaFiles.length > 50
    || mediaFiles.some((id) => typeof id !== "string" || !MEDIA_ID_PATTERN.test(id))
  ) {
    throw new OfapiApiError("OFAPI media command media files are invalid", 422, null);
  }
  if (
    !Array.isArray(previews)
    || previews.length > 50
    || previews.some((id) => typeof id !== "string" || !MEDIA_ID_PATTERN.test(id))
  ) {
    throw new OfapiApiError("OFAPI media command previews are invalid", 422, null);
  }

  const attached = new Set(mediaFiles);
  if (attached.size !== mediaFiles.length) {
    throw new OfapiApiError("OFAPI media command media files are invalid", 422, null);
  }
  const previewSet = new Set(previews);
  if (previewSet.size !== previews.length || previews.some((id) => !attached.has(id))) {
    throw new OfapiApiError("OFAPI media command previews are invalid", 422, null);
  }

  return { text, price, mediaFiles, previews };
}

function unsendPayload(command: OfapiCommandRow): { messageId: string } {
  const payload = command.payload as { messageId?: unknown };
  if (typeof payload.messageId !== "string" || !/^[0-9]{1,30}$/.test(payload.messageId)) {
    throw new OfapiApiError("OFAPI unsend command payload is invalid", 422, null);
  }
  return { messageId: payload.messageId };
}

async function executeCurrentOfapiCommand(
  app: AppContext,
  commandId: string,
  now = new Date(),
  bindingLockDb = app.db,
) {
  if (!isOfapiCommandExecutionEnabled(app.config)) {
    return { status: "execution_disabled" as const };
  }
  const queued = await getOfapiCommandById(app.db, { commandId });
  if (!queued || queued.state !== "queued") {
    return { status: "not_claimed" as const };
  }
  if (!canExecuteCommandKind(app, queued)) {
    app.logger.warn({ commandId }, "OFAPI command execution unavailable; command remains queued");
    return { status: "client_unavailable" as const };
  }

  // W3.2 belt (decision #125): a row older than the queued TTL is
  // unclaimable — even if this execute job races the sweep's expiry, the
  // stale send cannot fire.
  const ttlMs = queued.kind === "typing_active_v1"
    ? TYPING_COMMAND_TTL_MS
    : await resolveQueuedCommandTtlMs(app);
  const command = await claimQueuedOfapiCommand(app.db, {
    commandId,
    now,
    minCreatedAt: new Date(now.getTime() - ttlMs),
  });
  if (!command) {
    return { status: "not_claimed" as const };
  }

  // Stage 26: a page whose vendor session needs operator action cannot send —
  // fail fast with a typed terminal error INSTEAD of spending the one
  // attempt. Never weakens the one-attempt discipline: no HTTP happens here.
  // Gated on the health flag because ofapi_auth_status only advances when
  // the accounts.* projection runs — a stale column must not fail sends.
  if (isOfapiAccountHealthEnabled(app.config)) {
    const stored = await findPageById(app.db, command.pageId);
    if (stored && ofapiAuthStatusNeedsAction(stored.page.ofapiAuthStatus)) {
      const failedAt = new Date();
      const gateFinalized = await finalizeOfapiCommand(app.db, {
        commandId: command.id,
        fromStates: ["in_flight"],
        state: "failed_terminal",
        now: failedAt,
        lastErrorCode: stored.page.ofapiAuthStatus === "account_not_found" ? "ofapi_account_not_found" : "ofapi_auth_action_required",
        lastErrorClass: "terminal",
        verifierResult: {
          source: "auth_gate",
          authStatus: stored.page.ofapiAuthStatus,
          observedAt: failedAt.toISOString(),
        },
      });
      if (!gateFinalized) {
        // Raced (Wave 2 seam discipline): the command settled elsewhere
        // between claim and gate — never journal a failure fact for it.
        return { status: "not_claimed" as const };
      }
      await recordCommandResultObservation(app, {
        command,
        state: "failed_terminal",
        outcome: {
          errorCode: stored.page.ofapiAuthStatus === "account_not_found" ? "ofapi_account_not_found" : "ofapi_auth_action_required",
          errorClass: "terminal",
          authStatus: stored.page.ofapiAuthStatus,
        },
      });
      app.logger.warn(
        { commandId: command.id, pageId: command.pageId, authStatus: stored.page.ofapiAuthStatus },
        "OFAPI command failed fast: account auth needs operator action",
      );
      return { status: "failed_terminal" as const, commandId: command.id };
    }
  }

  try {
    const binding = await findPageById(app.db, command.pageId);
    if (binding?.page.ofapiAuthStatus === "account_not_found") throw new OfapiLocalDispatchRefusal("account_unavailable");
    if (!binding || binding.page.ofapiAccountId !== command.ofapiAccountId ||
        binding.page.ofapiBindingGeneration !== command.bindingGeneration) {
      throw new OfapiLocalDispatchRefusal("binding_replaced");
    }
    if (ofapiAuthStatusNeedsAction(binding.page.ofapiAuthStatus)) throw new OfapiLocalDispatchRefusal("auth_action_required");
    await app.ofapi?.assertCredentialReady?.();
    let platformMessageId: string | null = null;
    const verifierResult: Record<string, unknown> = {
      source: "ofapi_response",
      commandKind: command.kind,
    };
    if (command.kind === "send_text_message_v1") {
      const result = await app.ofapi!.sendTextMessage!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
        textPayload(command),
      );
      platformMessageId = result.messageId;
      if (result.creditAccounting) verifierResult.creditAccounting = result.creditAccounting;
    } else if (command.kind === "send_media_message_v1") {
      const result = await app.ofapi!.sendMediaMessage!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
        mediaPayload(command),
      );
      platformMessageId = result.messageId;
      if (result.creditAccounting) verifierResult.creditAccounting = result.creditAccounting;
    } else if (command.kind === "typing_active_v1") {
      const result = await app.ofapi!.startTyping!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
      );
      if (result.creditAccounting) verifierResult.creditAccounting = result.creditAccounting;
    } else if (command.kind === "unsend_message_v1") {
      const { messageId } = unsendPayload(command);
      const result = await app.ofapi!.unsendMessage!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
        messageId,
      );
      if (result.creditAccounting) verifierResult.creditAccounting = result.creditAccounting;
      platformMessageId = messageId;
    } else {
      const result = await app.ofapi!.markChatRead!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
      );
      if (result.creditAccounting) verifierResult.creditAccounting = result.creditAccounting;
    }
    const confirmedAt = new Date();
    verifierResult.confirmedAt = confirmedAt.toISOString();
    const finalized = await finalizeOfapiCommand(app.db, {
      commandId: command.id,
      fromStates: ["in_flight", "indeterminate"],
      state: "confirmed",
      now: confirmedAt,
      platformMessageId,
      verifierResult,
    });
    if (!finalized) {
      // Raced seam (Wave 2 fix): the webhook verifier finalized first — it
      // owns the fact and the observation; a second emission here would be
      // a duplicate at best and a divergent fact at worst. The command IS
      // confirmed either way.
      app.logger.info(
        { commandId: command.id, platformMessageId },
        "OFAPI command direct-confirm lost the finalize race (webhook verifier won); skipping duplicate emission",
      );
      return { status: "confirmed" as const, commandId: command.id, raced: true };
    }
    await recordCommandResultObservation(app, {
      command,
      state: "confirmed",
      outcome: { platformMessageId: platformMessageId ?? null, verifierResult },
    });
    // Wave 2 sends-as-facts: the finalize WINNER emits the fact.
    if (platformMessageId !== null) {
      await recordConfirmedSendFact(app, command, platformMessageId, confirmedAt);
    }
    app.logger.info(
      { commandId: command.id, pageId: command.pageId, commandKind: command.kind, platformMessageId },
      "OFAPI command confirmed by vendor response",
    );
    return { status: "confirmed" as const, commandId: command.id };
  } catch (error) {
    const localRefusal = error instanceof OfapiLocalDispatchRefusal ? error
      : error instanceof OfapiCredentialNotReadyError
        ? new OfapiLocalDispatchRefusal("credential_not_verified", error.reason ?? error.preflightStatus)
        : error instanceof OfapiCreditAccountingUnavailableError
          ? new OfapiLocalDispatchRefusal("credit_accounting_unavailable")
          : error instanceof OfapiKeyPermissionDeniedError ? new OfapiLocalDispatchRefusal("key_scope_denied") : null;
    if (error instanceof OfapiApiError && ofapiAccountNotFound(error.status, error.body)) {
      const marked = await markOfapiBindingUnavailable(bindingLockDb, command.ofapiAccountId, command.bindingGeneration);
      if (marked) await notifyOfapiAuthIncident({ ...app, db: bindingLockDb }, {
        platformAccountId: marked.page.id, pageLabel: marked.page.label, platform: "onlyfans",
        authStatus: "account_not_found", occurredAt: marked.markedAt,
      });
    }
    const failure = classifyOfapiCommandFailure(localRefusal ?? error);
    const failureEvidence = localRefusal
      ? { source: "local_precondition", reason: localRefusal.reason, detail: localRefusal.detail }
      : { source: "ofapi_response", httpStatus: failure.httpStatus };
    const finishedAt = new Date();
    const finalized = await finalizeOfapiCommand(app.db, {
      commandId: command.id,
      fromStates: ["in_flight"],
      state: failure.state,
      now: finishedAt,
      lastErrorCode: failure.errorCode,
      lastErrorClass: failure.errorClass,
      verifierResult: {
        ...failureEvidence,
        observedAt: finishedAt.toISOString(),
      },
    });
    if (!finalized) {
      // Raced seam: the send actually LANDED and the messages.sent webhook
      // confirmed it while the response erred client-side. Recording a
      // failed_* observation here would journal a FALSE fact about a
      // confirmed command (the pre-fix behavior).
      const current = await getOfapiCommandById(app.db, { commandId: command.id });
      app.logger.warn(
        { commandId: command.id, attemptedState: failure.state, actualState: current?.state },
        "OFAPI command failure finalize lost the race; command already settled elsewhere — no failure fact recorded",
      );
      return {
        status: (current?.state ?? "indeterminate") as "confirmed" | "failed_retryable" | "failed_terminal" | "indeterminate",
        commandId: command.id,
        raced: true,
      };
    }
    await recordCommandResultObservation(app, {
      command,
      state: failure.state,
      outcome: {
        errorCode: failure.errorCode,
        errorClass: failure.errorClass,
        ...failureEvidence,
      },
    });
    app.logger.warn(
      {
        commandId: command.id,
        pageId: command.pageId,
        state: failure.state,
        errorCode: failure.errorCode,
        ...failureEvidence,
      },
      "OFAPI command attempt reached a non-confirmed outcome",
    );
    return { status: failure.state, commandId: command.id };
  }
}

export async function sweepOfapiCommands(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  now = new Date(),
) {
  // W3.2 (A4, decision #125): expire parked queued rows FIRST — before the
  // execution-disabled early return below, because rows parked while
  // execution is off are the exact bug window (they used to fire hours late
  // on re-enable). Each expiry is journaled with the same idempotency key a
  // client cancel would use, so the two paths dedupe into one fact.
  const ttlMs = await resolveQueuedCommandTtlMs(app);
  const expiredTyping = await expireStaleQueuedOfapiCommands(app.db, {
    createdBefore: new Date(now.getTime() - TYPING_COMMAND_TTL_MS),
    now,
    kind: "typing_active_v1",
  });
  const expiredGeneral = await expireStaleQueuedOfapiCommands(app.db, {
    createdBefore: new Date(now.getTime() - ttlMs),
    now,
  });
  const expired = [...expiredTyping, ...expiredGeneral];
  for (const command of expired) {
    await recordCommandResultObservation(app, {
      command,
      state: "cancelled",
      outcome: { errorCode: "expired_queued_ttl", queuedTtlMs: ttlMs },
    });
  }
  if (expired.length > 0) {
    app.logger.warn(
      { count: expired.length, queuedTtlMs: ttlMs, commandIds: expired.map((row) => row.id) },
      "Expired stale queued OFAPI commands to cancelled (queued TTL)",
    );
  }

  const stale = await markStaleInFlightOfapiCommandsIndeterminate(app.db, {
    startedBefore: new Date(now.getTime() - STALE_IN_FLIGHT_MS),
    now,
  });
  if (stale.length > 0) {
    app.logger.warn(
      { count: stale.length, commandIds: stale.map((row) => row.id) },
      "Stale OFAPI command attempts marked indeterminate",
    );
  }

  const purged = await purgeExpiredTypingCommands(app.db, { now });

  // Stage 28: the Stage 1 redaction kill-switch RETIRED — terminal business
  // command payloads are kept permanently. Typing is not a business fact and
  // is the explicit short-retention exception above.
  if (!isOfapiCommandExecutionEnabled(app.config) || !app.ofapi) {
    return { expired: expired.length, stale: stale.length, purged: purged.length, enqueued: 0 };
  }

  const queued = await listQueuedOfapiCommandIds(app.db, { limit: COMMAND_SWEEP_LIMIT });
  for (const command of queued) {
    await sendOfapiCommandExecuteJob(boss, command.id);
  }
  return { expired: expired.length, stale: stale.length, purged: purged.length, enqueued: queued.length };
}

type SentWebhookRow = {
  id: number;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  receivedAt: Date;
};

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function webhookMediaCount(payload: Record<string, unknown>): number | null {
  for (const field of ["media", "medias", "mediaFiles"]) {
    const value = payload[field];
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  for (const field of ["mediaCount", "media_count", "mediasCount"]) {
    const value = numberValue(payload[field]);
    if (value !== null && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

export async function verifyOfapiCommandFromSentWebhook(
  app: AppContext,
  row: SentWebhookRow,
) {
  if (row.eventType !== "messages.sent" || !row.ofapiAccountId) {
    return { status: "not_applicable" as const };
  }
  const envelope = ofapiWebhookEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success || envelope.data.event !== "messages.sent") {
    return { status: "invalid_envelope" as const };
  }
  const payload = asRecord(envelope.data.payload);
  const conversationId = idToString(asRecord(payload?.toUser)?.id);
  const platformMessageId = idToString(payload?.id);
  const text = normalizeDmMessageText(typeof payload?.text === "string" ? payload.text : "");
  const mediaCount = webhookMediaCount(payload ?? {});
  const price = numberValue(payload?.price) ?? 0;
  if (!conversationId || !platformMessageId || (text.length === 0 && (mediaCount ?? 0) === 0)) {
    return { status: "insufficient_payload" as const };
  }

  const candidates = await listOfapiCommandVerificationCandidates(app.db, {
    ofapiAccountId: row.ofapiAccountId,
    conversationId,
    attemptStartedFrom: new Date(row.receivedAt.getTime() - WEBHOOK_CORRELATION_WINDOW_MS),
    attemptStartedTo: new Date(row.receivedAt.getTime() + WEBHOOK_CLOCK_SKEW_MS),
  });
  const matches = candidates.filter((candidate) => {
    if (candidate.kind === "send_text_message_v1") {
      const candidatePayload = candidate.payload as { text?: unknown };
      return normalizeDmMessageText(
        typeof candidatePayload.text === "string" ? candidatePayload.text : "",
      ) === text;
    }
    if (candidate.kind === "send_media_message_v1") {
      if (mediaCount === null) {
        return false;
      }
      const candidatePayload = candidate.payload as {
        text?: unknown;
        price?: unknown;
        mediaFiles?: unknown;
      };
      const mediaFiles = Array.isArray(candidatePayload.mediaFiles)
        ? candidatePayload.mediaFiles
        : [];
      return normalizeDmMessageText(
        typeof candidatePayload.text === "string" ? candidatePayload.text : "",
      ) === text
        && candidatePayload.price === price
        && mediaFiles.length === mediaCount;
    }
    return false;
  });
  if (matches.length !== 1) {
    if (matches.length > 1) {
      app.logger.warn(
        { eventId: row.id, candidateCount: matches.length },
        "OFAPI sent webhook command verification was ambiguous",
      );
    }
    return { status: matches.length === 0 ? "no_match" as const : "ambiguous" as const };
  }

  const matched = matches[0]!;
  const confirmed = await finalizeOfapiCommand(app.db, {
    commandId: matched.id,
    fromStates: ["in_flight", "indeterminate"],
    state: "confirmed",
    now: row.receivedAt,
    platformMessageId,
    verifierResult: {
      source: "messages.sent",
      eventId: row.id,
      receivedAt: row.receivedAt.toISOString(),
    },
  });
  if (!confirmed) {
    return { status: "raced" as const };
  }
  await recordCommandResultObservation(app, {
    command: matched,
    state: "confirmed",
    outcome: {
      platformMessageId,
      verifierResult: { source: "messages.sent", eventId: row.id },
    },
  });
  app.logger.info(
    { commandId: matched.id, eventId: row.id, platformMessageId },
    "OFAPI command confirmed by messages.sent webhook",
  );
  return { status: "confirmed" as const, commandId: matched.id };
}

type OfapiCommandWorkerBoss = Pick<PgBoss, "send" | "work">;

export async function startOfapiCommandWorker(
  app: AppContext,
  boss: OfapiCommandWorkerBoss,
) {
  await boss.work<OfapiCommandExecutePayload>(
    OFAPI_COMMAND_EXECUTE_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await executeOfapiCommand(app, job.data.commandId);
      }
    },
  );

  await boss.work(OFAPI_COMMAND_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const result = await sweepOfapiCommands(app, boss);
    if (result.enqueued > 0) {
      app.logger.info(
        { enqueued: result.enqueued },
        "OFAPI command sweep enqueued queued commands",
      );
    }
  });
}

export async function executeOfapiCommand(app: AppContext, commandId: string, now = new Date()) {
  if (!isOfapiCommandExecutionEnabled(app.config)) return { status: "execution_disabled" as const };
  const command = await getOfapiCommandById(app.db, { commandId });
  if (!command) return { status: "not_claimed" as const };
  return withOfapiBindingLock(app.db, command.pageId, db => executeCurrentOfapiCommand(app, commandId, now, db));
}
