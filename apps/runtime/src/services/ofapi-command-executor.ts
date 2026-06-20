import {
  claimQueuedOfapiCommand,
  finalizeOfapiCommand,
  getOfapiCommandById,
  listOfapiCommandVerificationCandidates,
  listQueuedOfapiCommandIds,
  markStaleInFlightOfapiCommandsIndeterminate,
  type OfapiCommandRow,
  redactTerminalOfapiCommandPayloads,
} from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { OfapiApiError } from "./ofapi.ts";
import {
  asRecord,
  idToString,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OFAPI_COMMAND_EXECUTE_QUEUE = "ofapi.commands.execute";
export const OFAPI_COMMAND_SWEEP_QUEUE = "ofapi.commands.sweep";

const COMMAND_SWEEP_LIMIT = 100;
const COMMAND_PAYLOAD_REDACTION_LIMIT = 500;
const COMMAND_PAYLOAD_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_IN_FLIGHT_MS = 2 * 60 * 1000;
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

export function classifyOfapiCommandFailure(error: unknown): OfapiCommandFailure {
  const status = error instanceof OfapiApiError ? error.status : null;
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

function canExecuteCommandKind(
  app: AppContext,
  command: Pick<OfapiCommandRow, "kind">,
): boolean {
  switch (command.kind) {
    case "send_text_message_v1":
      return typeof app.ofapi?.sendTextMessage === "function";
    case "typing_active_v1":
      return typeof app.ofapi?.startTyping === "function";
    case "unsend_message_v1":
      return typeof app.ofapi?.unsendMessage === "function";
  }
}

function textPayload(command: OfapiCommandRow): { text: string } {
  const payload = command.payload as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new OfapiApiError("OFAPI text command payload is invalid", 422, null);
  }
  return { text: payload.text };
}

function unsendPayload(command: OfapiCommandRow): { messageId: string } {
  const payload = command.payload as { messageId?: unknown };
  if (typeof payload.messageId !== "string" || !/^[0-9]{1,30}$/.test(payload.messageId)) {
    throw new OfapiApiError("OFAPI unsend command payload is invalid", 422, null);
  }
  return { messageId: payload.messageId };
}

export async function executeOfapiCommand(
  app: AppContext,
  commandId: string,
  now = new Date(),
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

  const command = await claimQueuedOfapiCommand(app.db, { commandId, now });
  if (!command) {
    return { status: "not_claimed" as const };
  }

  try {
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
    } else if (command.kind === "typing_active_v1") {
      await app.ofapi!.startTyping!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
      );
    } else {
      const { messageId } = unsendPayload(command);
      await app.ofapi!.unsendMessage!(
        { pageId: command.pageId },
        command.ofapiAccountId,
        command.conversationId,
        messageId,
      );
      platformMessageId = messageId;
    }
    const confirmedAt = new Date();
    verifierResult.confirmedAt = confirmedAt.toISOString();
    await finalizeOfapiCommand(app.db, {
      commandId: command.id,
      fromStates: ["in_flight", "indeterminate"],
      state: "confirmed",
      now: confirmedAt,
      platformMessageId,
      verifierResult,
    });
    app.logger.info(
      { commandId: command.id, pageId: command.pageId, commandKind: command.kind, platformMessageId },
      "OFAPI command confirmed by vendor response",
    );
    return { status: "confirmed" as const, commandId: command.id };
  } catch (error) {
    const failure = classifyOfapiCommandFailure(error);
    const finishedAt = new Date();
    await finalizeOfapiCommand(app.db, {
      commandId: command.id,
      fromStates: ["in_flight"],
      state: failure.state,
      now: finishedAt,
      lastErrorCode: failure.errorCode,
      lastErrorClass: failure.errorClass,
      verifierResult: {
        source: "ofapi_response",
        httpStatus: failure.httpStatus,
        observedAt: finishedAt.toISOString(),
      },
    });
    app.logger.warn(
      {
        commandId: command.id,
        pageId: command.pageId,
        state: failure.state,
        errorCode: failure.errorCode,
        httpStatus: failure.httpStatus,
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

  const redacted = await redactTerminalOfapiCommandPayloads(app.db, {
    terminalUpdatedBefore: new Date(now.getTime() - COMMAND_PAYLOAD_RECOVERY_WINDOW_MS),
    redactedAt: now,
    limit: COMMAND_PAYLOAD_REDACTION_LIMIT,
  });
  if (redacted.length > 0) {
    app.logger.info(
      { count: redacted.length, recoveryWindowDays: 7 },
      "OFAPI command terminal payloads redacted",
    );
  }

  if (!isOfapiCommandExecutionEnabled(app.config) || !app.ofapi) {
    return { stale: stale.length, purged: redacted.length, enqueued: 0 };
  }

  const queued = await listQueuedOfapiCommandIds(app.db, { limit: COMMAND_SWEEP_LIMIT });
  for (const command of queued) {
    await sendOfapiCommandExecuteJob(boss, command.id);
  }
  return { stale: stale.length, purged: redacted.length, enqueued: queued.length };
}

type SentWebhookRow = {
  id: number;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  receivedAt: Date;
};

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
  if (!conversationId || !platformMessageId || text.length === 0) {
    return { status: "insufficient_payload" as const };
  }

  const candidates = await listOfapiCommandVerificationCandidates(app.db, {
    ofapiAccountId: row.ofapiAccountId,
    conversationId,
    attemptStartedFrom: new Date(row.receivedAt.getTime() - WEBHOOK_CORRELATION_WINDOW_MS),
    attemptStartedTo: new Date(row.receivedAt.getTime() + WEBHOOK_CLOCK_SKEW_MS),
  });
  const matches = candidates.filter((candidate) => {
    if (candidate.kind !== "send_text_message_v1") {
      return false;
    }
    const payload = candidate.payload as { text?: unknown };
    return normalizeDmMessageText(typeof payload.text === "string" ? payload.text : "") === text;
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
