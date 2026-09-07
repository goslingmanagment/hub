import type { OfapiExtendedCommandKind, OfapiExtendedCommandPayload, OfapiSendV2Payload } from "@agency_hub_core/shared";
import { createHash, randomUUID } from "node:crypto";

import {
  cancelQueuedOfapiCommand,
  checkOfapiProviderOperationReuse,
  createOrGetOfapiCommand,
  getOfapiCommandByIdForUser,
  listOfapiMappedPages,
  releaseOfapiMediaTokenCustody,
  type Database,
  type OfapiCommandRow,
  type OfapiProviderOperationReuseIssue,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "./errors.ts";
import { buildOfapiSendV2Body } from "./ofapi-command-composer.ts";

/**
 * The original provider operation can no longer be replayed honestly (missing,
 * changed scope/body, outside its 24-hour window, or the credential cannot be
 * verified right now). Answered at INTAKE with no command row, so the client
 * keeps its original in the unconfirmed recovery state instead of receiving a
 * retry child that fails terminally and invites a duplicate send.
 */
export class OfapiProviderOperationReuseUnavailableError extends AppError {
  constructor(readonly issue: OfapiProviderOperationReuseIssue | "credential_not_verified") {
    super(`Provider operation cannot be reused: ${issue}`, 409, "provider_operation_reuse_unavailable");
    this.name = "OfapiProviderOperationReuseUnavailableError";
  }
}

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
  // Provider replay eligibility is decided here, before any row exists, so an
  // ineligible recovery never becomes a failed retry child. The vendor-facing
  // preflight (free, cached) runs outside the transaction; the DB predicate runs
  // inside it and rolls the insert back. Exact replays of an already-accepted
  // command still dedupe to 200 — the check only guards a NEW row. Dispatch
  // re-evaluates the same predicate as belt-and-braces.
  const reuse = input.kind === "send_message_v2" && (input.payload as OfapiSendV2Payload).reuseProviderOperation
    ? await resolveProviderOperationReuse(app, input as ExtendedCommandRequest & { payload: OfapiSendV2Payload })
    : null;
  const result = await app.db.transaction(async (tx) => {
    const created = await createOrGetOfapiCommand(tx as unknown as Database, {
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
    if (created.inserted && reuse) {
      if (reuse.issue) throw new OfapiProviderOperationReuseUnavailableError(reuse.issue);
      const eligibility = await checkOfapiProviderOperationReuse(tx as unknown as Database, {
        parentCommandId: retryOfCommandId!, teamSlug: reuse.teamSlug, accountId: input.accountId,
        endpoint: reuse.endpoint, bodyHash: reuse.bodyHash,
      });
      if (!eligibility.eligible) throw new OfapiProviderOperationReuseUnavailableError(eligibility.issue);
    }
    return created;
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

/** Same identity inputs the executor fixes at dispatch (team, endpoint, body hash). */
async function resolveProviderOperationReuse(
  app: AppContext,
  input: { accountId: string; conversationId: string; payload: OfapiSendV2Payload },
): Promise<{ issue: "credential_not_verified" | null; teamSlug: string | null; endpoint: string; bodyHash: string }> {
  const preflight = await app.ofapi?.getCredentialPreflight?.().catch(() => null) ?? null;
  const teamSlug = preflight?.status === "verified" ? preflight.observedTeam : null;
  return {
    issue: teamSlug ? null : "credential_not_verified",
    teamSlug,
    endpoint: `/${input.accountId}/chats/${input.conversationId}/messages`,
    bodyHash: createHash("sha256").update(JSON.stringify(buildOfapiSendV2Body(input.payload))).digest("hex"),
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

  const now = new Date();
  const updated = await cancelQueuedOfapiCommand(app.db, {
    commandId,
    chatterUserId: principal.user.id,
    now,
  });
  if (updated) {
    // queued -> cancelled never dispatched: any one-use custody it holds
    // (reserved only at dispatch today) is definitely unspent. Best-effort;
    // a hiccup keeps the reservation (fail closed).
    if (updated.kind === "send_message_v2" || updated.kind === "send_media_message_v1") {
      await releaseOfapiMediaTokenCustody(app.db, { commandId, reason: "cancelled_before_dispatch", now })
        .catch((error: unknown) => app.logger.error({ err: error, commandId }, "OFAPI media custody release after cancel failed — reservation stays held"));
    }
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
