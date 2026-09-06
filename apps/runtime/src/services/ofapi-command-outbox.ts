import type { OfapiExtendedCommandKind, OfapiExtendedCommandPayload, OfapiSendV2Payload } from "@agency_hub_core/shared";
import { createHash, randomUUID } from "node:crypto";

import {
  cancelQueuedOfapiCommand,
  createOrGetOfapiCommand,
  getOfapiCommandByIdForUser,
  listOfapiMappedPages,
  type OfapiCommandRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "./errors.ts";

type OfapiCommandKind = OfapiExtendedCommandKind
  | "send_text_message_v1"
  | "send_media_message_v1"
  | "typing_active_v1"
  | "unsend_message_v1"
  | "mark_chat_read_v1";
type TextCommandRequest = {
  clientCommandId: string;
  kind: "send_text_message_v1";
  accountId: string;
  conversationId: string;
  payload: { text: string };
  retryOfCommandId?: string | null;
};
type MediaCommandRequest = {
  clientCommandId: string;
  kind: "send_media_message_v1";
  accountId: string;
  conversationId: string;
  payload: {
    text: string;
    price: number;
    mediaFiles: string[];
    previews: string[];
  };
  retryOfCommandId?: string | null;
};
type TypingCommandRequest = {
  clientCommandId: string;
  kind: "typing_active_v1";
  accountId: string;
  conversationId: string;
  payload: Record<string, never>;
  retryOfCommandId?: null;
};
type UnsendCommandRequest = {
  clientCommandId: string;
  kind: "unsend_message_v1";
  accountId: string;
  conversationId: string;
  payload: { messageId: string };
  retryOfCommandId?: null;
};
type MarkReadCommandRequest = {
  clientCommandId: string;
  kind: "mark_chat_read_v1";
  accountId: string;
  conversationId: string;
  payload: Record<string, never>;
  retryOfCommandId?: null;
};

const RETRYABLE_SOURCE_STATES = new Set([
  "failed_retryable",
  "failed_terminal",
  "indeterminate",
  "cancelled",
]);

type ExtendedCommandRequest = { clientCommandId: string; accountId: string; conversationId: string; kind: OfapiExtendedCommandKind; payload: OfapiExtendedCommandPayload; retryOfCommandId?: string | null };

export type CreateOfapiCommandRequest = ExtendedCommandRequest
  | TextCommandRequest
  | MediaCommandRequest
  | TypingCommandRequest
  | UnsendCommandRequest
  | MarkReadCommandRequest;

export interface OfapiCommandView {
  commandId: string;
  clientCommandId: string;
  kind: OfapiCommandKind;
  accountId: string;
  conversationId: string;
  state:
    | "queued"
    | "in_flight"
    | "confirmed"
    | "failed_retryable"
    | "failed_terminal"
    | "indeterminate"
    | "cancelled";
  payloadHash: string;
  retryOfCommandId: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  verifierResult: Record<string, unknown> | null;
  platformMessageId: string | null;
  attemptStartedAt: string | null;
  attemptFinishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deduplicated: boolean;
}

function requireEnabled(app: AppContext) {
  if (app.config.ofapiDesktopCommandOutboxEnabled !== true) {
    throw new ServiceUnavailableError("OFAPI desktop command outbox is disabled");
  }
}

async function resolveAssignedPage(
  app: AppContext,
  principal: HumanAuthPrincipal,
  accountId: string,
) {
  const pages = await listOfapiMappedPages(app.db);
  const page = pages.find((candidate) => (
    candidate.ofapiAccountId === accountId
    && principal.assignedPageIds.includes(candidate.id)
  ));
  if (!page) {
    throw new NotFoundError("OFAPI account is not assigned to this chatter");
  }
  return page;
}

function canonicalHash(input: {
  kind: OfapiCommandKind;
  accountId: string;
  conversationId: string;
  payload:
    | OfapiExtendedCommandPayload
    | { text: string }
    | {
      text: string;
      price: number;
      mediaFiles: string[];
      previews: string[];
    }
    | { messageId: string }
    | Record<string, never>;
  retryOfCommandId: string | null;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: input.kind,
      accountId: input.accountId,
      conversationId: input.conversationId,
      payload: input.payload,
      retryOfCommandId: input.retryOfCommandId,
    }))
    .digest("hex");
}

function toView(row: OfapiCommandRow, deduplicated: boolean): OfapiCommandView {
  return {
    commandId: row.id,
    clientCommandId: row.clientCommandId,
    kind: row.kind,
    accountId: row.ofapiAccountId,
    conversationId: row.conversationId,
    state: row.state,
    payloadHash: row.payloadHash,
    retryOfCommandId: row.retryOfCommandId,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lastErrorClass: row.lastErrorClass,
    verifierResult: row.verifierResult,
    platformMessageId: row.platformMessageId,
    attemptStartedAt: row.attemptStartedAt?.toISOString() ?? null,
    attemptFinishedAt: row.attemptFinishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deduplicated,
  };
}

function assertCurrentAccess(principal: HumanAuthPrincipal, row: OfapiCommandRow) {
  if (!principal.assignedPageIds.includes(row.pageId)) {
    throw new NotFoundError("OFAPI command not found");
  }
}

export async function createOfapiCommand(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: CreateOfapiCommandRequest,
): Promise<{ status: 200 | 202; command: OfapiCommandView }> {
  requireEnabled(app);
  const page = await resolveAssignedPage(app, principal, input.accountId);
  const retryOfCommandId = input.retryOfCommandId ?? null;
  if (input.kind === "send_message_v2" && (input.payload as OfapiSendV2Payload).reuseProviderOperation && !retryOfCommandId) throw new ConflictError("Provider replay requires an explicit retry source");

  if (
    input.kind !== "send_message_v2"
    && input.kind !== "send_text_message_v1"
    && input.kind !== "send_media_message_v1"
    && retryOfCommandId !== null
  ) {
    throw new ConflictError(`${input.kind} commands cannot retry another command`);
  }

  if (retryOfCommandId !== null) {
    const original = await getOfapiCommandByIdForUser(app.db, {
      commandId: retryOfCommandId,
      chatterUserId: principal.user.id,
    });
    if (
      !original
      || original.pageId !== page.id
      || original.conversationId !== input.conversationId
    ) {
      throw new ConflictError("Retry source must be an owned command in the same conversation");
    }
    if (original.kind !== input.kind) {
      throw new ConflictError("Retry source must use the same command kind");
    }
    if (!RETRYABLE_SOURCE_STATES.has(original.state)) {
      throw new ConflictError(`Command in state '${original.state}' cannot be retried`);
    }
  }

  const payloadHash = canonicalHash({
    kind: input.kind,
    accountId: input.accountId,
    conversationId: input.conversationId,
    payload: input.payload,
    retryOfCommandId,
  });
  const result = await createOrGetOfapiCommand(app.db, {
    id: randomUUID(),
    clientCommandId: input.clientCommandId,
    pageId: page.id,
    chatterUserId: principal.user.id,
    ofapiAccountId: input.accountId,
    conversationId: input.conversationId,
    kind: input.kind,
    payload: input.payload,
    payloadHash,
    retryOfCommandId,
  });

  if (
    !result.inserted
    && (
      result.row.ofapiAccountId !== input.accountId
      || result.row.conversationId !== input.conversationId
      || result.row.kind !== input.kind
      || result.row.payloadHash !== payloadHash
      || result.row.retryOfCommandId !== retryOfCommandId
    )
  ) {
    throw new ConflictError("clientCommandId was already used for a different command");
  }

  return {
    status: result.inserted ? 202 : 200,
    command: toView(result.row, !result.inserted),
  };
}

export async function getOfapiCommand(
  app: AppContext,
  principal: HumanAuthPrincipal,
  commandId: string,
) {
  requireEnabled(app);
  const row = await getOfapiCommandByIdForUser(app.db, {
    commandId,
    chatterUserId: principal.user.id,
  });
  if (!row) {
    throw new NotFoundError("OFAPI command not found");
  }
  assertCurrentAccess(principal, row);
  return toView(row, false);
}

export async function cancelOfapiCommand(
  app: AppContext,
  principal: HumanAuthPrincipal,
  commandId: string,
) {
  requireEnabled(app);
  const existing = await getOfapiCommandByIdForUser(app.db, {
    commandId,
    chatterUserId: principal.user.id,
  });
  if (!existing) {
    throw new NotFoundError("OFAPI command not found");
  }
  assertCurrentAccess(principal, existing);
  if (existing.state === "cancelled") {
    return toView(existing, false);
  }
  if (existing.state !== "queued") {
    throw new ConflictError(`Command in state '${existing.state}' cannot be cancelled`);
  }

  const updated = await cancelQueuedOfapiCommand(app.db, {
    commandId,
    chatterUserId: principal.user.id,
    now: new Date(),
  });
  if (updated) {
    return toView(updated, false);
  }

  const raced = await getOfapiCommandByIdForUser(app.db, {
    commandId,
    chatterUserId: principal.user.id,
  });
  if (raced?.state === "cancelled") {
    return toView(raced, false);
  }
  throw new ConflictError(`Command in state '${raced?.state ?? "unknown"}' cannot be cancelled`);
}
