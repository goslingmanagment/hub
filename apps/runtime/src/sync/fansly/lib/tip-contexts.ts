import {
  FANSLY_DM_TIP_SIDECAR_PROVENANCE,
  type Database,
  resolveTransactionTipContextLineage,
  type TransactionTipContextLineageInput,
  upsertTransactionTipContext,
} from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";

type TipItemRejectionReason =
  | "not_object"
  | "invalid_tip_id"
  | "duplicate_tip_id"
  | "missing_conversation_ref"
  | "invalid_sender_id"
  | "invalid_created_at"
  | "invalid_message";

export interface FanslyDmTipItemRejection {
  index: number;
  reason: TipItemRejectionReason;
}

export interface ParsedFanslyDmTipContext {
  platformTipId: string;
  capturedConversationRef: string;
  tipMessageText: string | null;
  tipAmountMills: bigint | null;
  occurredAt: Date;
  senderPlatformUserId: string;
  receiverPlatformUserId: string | null;
}

export interface FanslyDmTipSidecarParseResult {
  envelopeStatus: "absent" | "accepted" | "invalid";
  tipItemsSeen: number;
  contexts: ParsedFanslyDmTipContext[];
  rejectedItems: FanslyDmTipItemRejection[];
  /** Malformed optional values are isolated to their field and become null. */
  droppedOptionalMemberCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNonemptyString(value: unknown) {
  if (value === undefined || value === null) {
    return { value: null, dropped: false } as const;
  }
  return typeof value === "string" && value.length > 0
    ? { value, dropped: false } as const
    : { value: null, dropped: true } as const;
}

function optionalMills(value: unknown) {
  if (value === undefined || value === null) {
    return { value: null, dropped: false } as const;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { value: millsFromInteger(value), dropped: false } as const
    : { value: null, dropped: true } as const;
}

function optionalFanslyTimestamp(value: unknown) {
  if (value === undefined || value === null) {
    return { value: null, dropped: false } as const;
  }
  let parsed: Date | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    parsed = new Date(value >= 1_000_000_000_000 ? value : value * 1000);
  } else if (typeof value === "string" && value.length > 0) {
    parsed = new Date(value);
  }
  return parsed !== null && !Number.isNaN(parsed.getTime())
    ? { value: parsed, dropped: false } as const
    : { value: null, dropped: true } as const;
}

/**
 * Pure, item-isolating parser for the optional `/message` `tips[]` sidecar.
 * Only tip.id and the captured request group are identity facts. A valid
 * sender and event time are mandatory because they are the immutable
 * fan/material-time evidence used by the Stage-28 non-resurrection fence.
 * Optional amount/receiver drift drops only that member. A present malformed
 * note rejects its item rather than fabricating source_did_not_provide.
 */
export function parseFanslyDmTipSidecar(input: {
  requestParams: unknown;
  responsePayload: unknown;
}): FanslyDmTipSidecarParseResult {
  if (!isRecord(input.responsePayload)) {
    return {
      envelopeStatus: "invalid",
      tipItemsSeen: 0,
      contexts: [],
      rejectedItems: [],
      droppedOptionalMemberCount: 0,
    };
  }

  const rawTips = input.responsePayload.tips;
  if (rawTips === undefined || rawTips === null) {
    return {
      envelopeStatus: "absent",
      tipItemsSeen: 0,
      contexts: [],
      rejectedItems: [],
      droppedOptionalMemberCount: 0,
    };
  }
  if (!Array.isArray(rawTips)) {
    return {
      envelopeStatus: "invalid",
      tipItemsSeen: 0,
      contexts: [],
      rejectedItems: [],
      droppedOptionalMemberCount: 0,
    };
  }

  const requestParams = isRecord(input.requestParams) ? input.requestParams : {};
  const capturedConversationRef = nonemptyString(requestParams.groupId);
  const tipIdCounts = new Map<string, number>();
  for (const item of rawTips) {
    if (!isRecord(item)) continue;
    const tipId = nonemptyString(item.id);
    if (tipId !== null) {
      tipIdCounts.set(tipId, (tipIdCounts.get(tipId) ?? 0) + 1);
    }
  }

  const contexts: ParsedFanslyDmTipContext[] = [];
  const rejectedItems: FanslyDmTipItemRejection[] = [];
  let droppedOptionalMemberCount = 0;
  for (const [index, item] of rawTips.entries()) {
    if (!isRecord(item)) {
      rejectedItems.push({ index, reason: "not_object" });
      continue;
    }
    const platformTipId = nonemptyString(item.id);
    if (platformTipId === null) {
      rejectedItems.push({ index, reason: "invalid_tip_id" });
      continue;
    }
    if ((tipIdCounts.get(platformTipId) ?? 0) > 1) {
      rejectedItems.push({ index, reason: "duplicate_tip_id" });
      continue;
    }
    if (capturedConversationRef === null) {
      rejectedItems.push({ index, reason: "missing_conversation_ref" });
      continue;
    }

    const occurredAt = optionalFanslyTimestamp(item.createdAt);
    const senderPlatformUserId = optionalNonemptyString(item.senderId);
    if (senderPlatformUserId.value === null) {
      rejectedItems.push({ index, reason: "invalid_sender_id" });
      continue;
    }
    if (occurredAt.value === null) {
      rejectedItems.push({ index, reason: "invalid_created_at" });
      continue;
    }
    if (
      item.message !== undefined
      && item.message !== null
      && typeof item.message !== "string"
    ) {
      rejectedItems.push({ index, reason: "invalid_message" });
      continue;
    }

    const tipMessageText = item.message === undefined || item.message === null
      ? null
      : item.message;
    const tipAmountMills = optionalMills(item.amount);
    const receiverPlatformUserId = optionalNonemptyString(item.receiverId);
    droppedOptionalMemberCount += [
      tipAmountMills,
      receiverPlatformUserId,
    ].filter((member) => member.dropped).length;

    contexts.push({
      platformTipId,
      capturedConversationRef,
      tipMessageText,
      tipAmountMills: tipAmountMills.value,
      occurredAt: occurredAt.value,
      senderPlatformUserId: senderPlatformUserId.value,
      receiverPlatformUserId: receiverPlatformUserId.value,
    });
  }

  return {
    envelopeStatus: "accepted",
    tipItemsSeen: rawTips.length,
    contexts,
    rejectedItems,
    droppedOptionalMemberCount,
  };
}

export interface MaterializeFanslyDmTipContextsResult extends FanslyDmTipSidecarParseResult {
  upserted: number;
  unchanged: number;
  conversationConflicts: number;
  deferredWrites: number;
  erasureFenced: number;
}

/**
 * One `/message` capture to materialize. Its lineage is the legacy raw row
 * (`sourceRawPayloadId`, what every legacy caller passes) or, for the Fansly
 * Sync Engine, which journals observations only, `lineage: { kind:
 * "observation", sourceObservationId, sourceObservationReceivedAt }` (0230).
 * `capturedAt` is the capture time of that lineage.
 */
export type MaterializeFanslyDmTipContextsInput = {
  accountId: number;
  requestParams: unknown;
  responsePayload: unknown;
  capturedAt: Date;
} & TransactionTipContextLineageInput;

/** Throws on DB failure so the historical backfill can stop loudly. Composes
 * into a caller's transaction (each upsert is then a savepoint). */
export async function materializeFanslyDmTipContexts(
  db: Database,
  input: MaterializeFanslyDmTipContextsInput,
): Promise<MaterializeFanslyDmTipContextsResult> {
  const parsed = parseFanslyDmTipSidecar(input);
  const lineage = resolveTransactionTipContextLineage(input);
  let upserted = 0;
  let unchanged = 0;
  let conversationConflicts = 0;
  let deferredWrites = 0;
  let erasureFenced = 0;
  for (const context of parsed.contexts) {
    const result = await upsertTransactionTipContext(db, {
      accountId: input.accountId,
      platform: "fansly",
      ...context,
      lineage,
      capturedAt: input.capturedAt,
      provenance: FANSLY_DM_TIP_SIDECAR_PROVENANCE,
    });
    if (result.status === "applied") {
      upserted += 1;
    } else if (result.status === "conversation_conflict") {
      conversationConflicts += 1;
    } else if (result.status === "deferred") {
      deferredWrites += 1;
    } else if (result.status === "erasure_fenced") {
      erasureFenced += 1;
    } else {
      unchanged += 1;
    }
  }
  return {
    ...parsed,
    upserted,
    unchanged,
    conversationConflicts,
    deferredWrites,
    erasureFenced,
  };
}
