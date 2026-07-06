import {
  deleteExpiredDmMessageArchiveRows,
  findPageByOfapiAccountId,
  getDmMessageArchiveStatus,
  listOfapiWebhookEventsForDmColdArchive,
  markOfapiWebhookEventArchive,
  markOfapiWebhookEventArchivePending,
  tombstoneDmMessageArchive,
  upsertDmMessageArchive,
  type DmMessageArchiveMediaItem,
} from "@agency_hub_core/db";
import { millsFromDollars, normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  asRecord,
  idToString,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";

// Stage 1 retention stand-down: aligned with the env default; effectively-forever.
const DEFAULT_DM_COLD_ARCHIVE_RETENTION_DAYS = 36500;
const OFAPI_DM_COLD_ARCHIVE_MAX_ATTEMPTS = 5;
const OFAPI_DM_COLD_ARCHIVE_SWEEP_LIMIT = 200;
const DM_COLD_ARCHIVE_EVENT_TYPES = [
  "messages.received",
  "messages.sent",
  "messages.deleted",
] as const;
const MEDIA_TYPES = new Set(["photo", "video", "audio", "gif"]);

type DmColdArchiveEventType = (typeof DM_COLD_ARCHIVE_EVENT_TYPES)[number];

export interface OfapiDmColdArchiveProjectableRow {
  id: number;
  idempotencyKey: string;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  fanoutSeq: number | null;
  receivedAt: Date;
  archiveStatus?: string;
  archiveAttempts?: number;
}

interface ParsedArchiveMessage {
  eventType: Extract<DmColdArchiveEventType, "messages.received" | "messages.sent">;
  platformConversationId: string;
  fanPlatformUserId: string;
  platformMessageId: string;
  senderPlatformUserId: string | null;
  senderRole: "fan" | "model" | "system" | "unknown";
  isSentByMe: boolean;
  messageCreatedAt: Date;
  textPlain: string;
  priceMills: bigint | null;
  isOpened: boolean | null;
  isTip: boolean;
  tipAmountMills: bigint;
  inReplyToMessageId: string | null;
  mediaMetadata: DmMessageArchiveMediaItem[];
}

export function isOfapiDmColdArchiveEnabled(
  config?: Pick<AppContext["config"], "ofapiDmColdArchiveEnabled">,
) {
  return config?.ofapiDmColdArchiveEnabled === true;
}

function isDmColdArchiveEventType(eventType: string): eventType is DmColdArchiveEventType {
  return (DM_COLD_ARCHIVE_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function resolveOfapiDmColdArchiveRetentionDays(app: AppContext) {
  return app.config.ofapiDmColdArchiveRetentionDays ?? DEFAULT_DM_COLD_ARCHIVE_RETENTION_DAYS;
}

function archiveRetainUntil(app: AppContext, sourceReceivedAt: Date) {
  const retentionDays = resolveOfapiDmColdArchiveRetentionDays(app);
  return new Date(sourceReceivedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

function parseMessageTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function usdToMills(value: unknown): bigint | null {
  const amount = nonNegativeNumber(value);
  return amount === null ? null : millsFromDollars(amount);
}

function mediaDimension(item: Record<string, unknown>, key: "width" | "height") {
  const files = asRecord(item.files);
  const candidates = [
    asRecord(files?.full),
    asRecord(files?.preview),
    asRecord(files?.thumb),
    asRecord(files?.squarePreview),
  ];

  for (const candidate of candidates) {
    const parsed = nonNegativeInteger(candidate?.[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function normalizeArchiveMediaItem(value: unknown): DmMessageArchiveMediaItem | null {
  const media = asRecord(value);
  const id = idToString(media?.id);
  if (!media || !id) {
    return null;
  }

  const rawType = typeof media.type === "string" ? media.type : "";
  const duration = nonNegativeNumber(media.duration);
  const width = mediaDimension(media, "width");
  const height = mediaDimension(media, "height");

  return {
    id,
    type: MEDIA_TYPES.has(rawType) ? rawType as DmMessageArchiveMediaItem["type"] : "other",
    isReady: media.isReady !== false,
    locked: media.canView === false,
    ...(width === null ? {} : { width }),
    ...(height === null ? {} : { height }),
    ...(duration === null ? {} : { durationSeconds: duration }),
  };
}

function parseArchiveMessage(
  eventType: Extract<DmColdArchiveEventType, "messages.received" | "messages.sent">,
  payload: Record<string, unknown>,
): ParsedArchiveMessage | null {
  const isSentByMe = eventType === "messages.sent";
  const partner = asRecord(isSentByMe ? payload.toUser : payload.fromUser);
  const fanId = idToString(partner?.id);
  const messageId = idToString(payload.id);
  const messageCreatedAt = parseMessageTimestamp(payload.createdAt);
  if (!partner || !fanId || !messageId || !messageCreatedAt) {
    return null;
  }

  const senderPlatformUserId = idToString(asRecord(payload.fromUser)?.id);
  const priceMills = usdToMills(payload.price);
  const isTip = payload.isTip === true;
  const media = Array.isArray(payload.media) ? payload.media : [];
  return {
    eventType,
    platformConversationId: fanId,
    fanPlatformUserId: fanId,
    platformMessageId: messageId,
    senderPlatformUserId,
    senderRole: isSentByMe ? "model" : "fan",
    isSentByMe,
    messageCreatedAt,
    textPlain: normalizeDmMessageText(typeof payload.text === "string" ? payload.text : ""),
    priceMills,
    isOpened: typeof payload.isOpened === "boolean" || payload.isOpened === null
      ? payload.isOpened
      : null,
    isTip,
    tipAmountMills: isTip ? priceMills ?? 0n : 0n,
    inReplyToMessageId: idToString(asRecord(payload.replyToMessage)?.id),
    mediaMetadata: media
      .map((item) => normalizeArchiveMediaItem(item))
      .filter((item): item is DmMessageArchiveMediaItem => item !== null),
  };
}

export async function archiveOfapiDmEvent(
  app: AppContext,
  row: OfapiDmColdArchiveProjectableRow,
) {
  if (!isOfapiDmColdArchiveEnabled(app.config) || !isDmColdArchiveEventType(row.eventType)) {
    return { status: "skipped" as const, reason: "disabled_or_unsupported_event" };
  }

  const envelope = ofapiWebhookEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success) {
    return { status: "skipped" as const, reason: "invalid_envelope" };
  }

  const page = row.ofapiAccountId
    ? await findPageByOfapiAccountId(app.db, row.ofapiAccountId)
    : null;
  if (!page || page.platform !== "onlyfans" || !row.ofapiAccountId) {
    return { status: "skipped" as const, reason: "unmapped_or_non_onlyfans_page" };
  }

  const payload = asRecord(envelope.data.payload) ?? {};
  const retainUntil = archiveRetainUntil(app, row.receivedAt);

  if (row.eventType === "messages.deleted") {
    const messageId = idToString(payload.id);
    if (!messageId) {
      return { status: "skipped" as const, reason: "delete_without_message_id" };
    }
    await tombstoneDmMessageArchive(app.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: row.ofapiAccountId,
      platformMessageId: messageId,
      deletedAt: row.receivedAt,
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: row.idempotencyKey,
      sourceJournalId: row.id,
      sourceFanoutSeq: row.fanoutSeq,
      sourceReceivedAt: row.receivedAt,
      retentionPolicy: "default",
      retainUntil,
    });
    return { status: "archived" as const };
  }

  const message = parseArchiveMessage(row.eventType, payload);
  if (!message) {
    return { status: "skipped" as const, reason: "message_missing_required_fields" };
  }

  await upsertDmMessageArchive(app.db, {
    platform: "onlyfans",
    platformAccountId: page.id,
    ofapiAccountId: row.ofapiAccountId,
    platformConversationId: message.platformConversationId,
    fanPlatformUserId: message.fanPlatformUserId,
    platformMessageId: message.platformMessageId,
    senderPlatformUserId: message.senderPlatformUserId,
    senderRole: message.senderRole,
    isSentByMe: message.isSentByMe,
    messageCreatedAt: message.messageCreatedAt,
    textPlain: message.textPlain,
    priceMills: message.priceMills,
    isOpened: message.isOpened,
    isTip: message.isTip,
    tipAmountMills: message.tipAmountMills,
    inReplyToMessageId: message.inReplyToMessageId,
    source: "webhook",
    sourceEventType: message.eventType,
    sourceIdempotencyKey: row.idempotencyKey,
    sourceJournalId: row.id,
    sourceFanoutSeq: row.fanoutSeq,
    sourceReceivedAt: row.receivedAt,
    rawShapeVersion: "ofapi-message-v1",
    mediaMetadata: message.mediaMetadata,
    retentionPolicy: "default",
    retainUntil,
  });

  return { status: "archived" as const };
}

export async function runOfapiDmColdArchiveForSettledRow(
  app: AppContext,
  row: OfapiDmColdArchiveProjectableRow,
) {
  if (!isOfapiDmColdArchiveEnabled(app.config) || !isDmColdArchiveEventType(row.eventType)) {
    return;
  }
  if (
    row.archiveStatus !== undefined &&
    row.archiveStatus !== "none" &&
    row.archiveStatus !== "pending" &&
    row.archiveStatus !== "failed"
  ) {
    return;
  }
  if (
    row.archiveStatus === "failed" &&
    typeof row.archiveAttempts === "number" &&
    row.archiveAttempts >= OFAPI_DM_COLD_ARCHIVE_MAX_ATTEMPTS
  ) {
    return;
  }

  const claimed = await markOfapiWebhookEventArchivePending(app.db, { id: row.id });
  if (!claimed) {
    return;
  }

  try {
    const outcome = await archiveOfapiDmEvent(app, row);
    if (outcome.status === "archived") {
      await markOfapiWebhookEventArchive(app.db, {
        id: row.id,
        status: "archived",
        archivedAt: new Date(),
      });
      app.logger.info(
        { eventId: row.id, eventType: row.eventType },
        "OFAPI DM cold archive stored webhook event",
      );
    } else {
      await markOfapiWebhookEventArchive(app.db, {
        id: row.id,
        status: "skipped",
        error: outcome.reason,
      });
    }
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      "OFAPI DM cold archive failed; sweep will retry",
    );
    await markOfapiWebhookEventArchive(app.db, {
      id: row.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch((markError) => {
      app.logger.warn(
        { err: markError, eventId: row.id },
        "Failed to record OFAPI DM cold archive failure",
      );
    });
  }
}

export async function sweepOfapiDmColdArchives(app: AppContext) {
  if (!isOfapiDmColdArchiveEnabled(app.config)) {
    return 0;
  }

  const rows = await listOfapiWebhookEventsForDmColdArchive(app.db, {
    eventTypes: DM_COLD_ARCHIVE_EVENT_TYPES,
    maxAttempts: OFAPI_DM_COLD_ARCHIVE_MAX_ATTEMPTS,
    limit: OFAPI_DM_COLD_ARCHIVE_SWEEP_LIMIT,
  });

  for (const row of rows) {
    await runOfapiDmColdArchiveForSettledRow(app, row);
  }

  return rows.length;
}

export async function cleanupExpiredDmMessageArchive(app: AppContext, now = new Date()) {
  return deleteExpiredDmMessageArchiveRows(app.db, now);
}

function maybeIso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export async function getOfapiDmColdArchiveStatus(app: AppContext, now = new Date()) {
  const status = await getDmMessageArchiveStatus(app.db, now);
  return {
    enabled: isOfapiDmColdArchiveEnabled(app.config),
    retentionDays: resolveOfapiDmColdArchiveRetentionDays(app),
    rowCount: status.rowCount,
    tombstoneCount: status.tombstoneCount,
    lastArchivedAt: maybeIso(status.lastArchivedAt),
    lastSourceReceivedAt: maybeIso(status.lastSourceReceivedAt),
    nextPurgeAt: maybeIso(status.nextPurgeAt),
    archiveLagMs: status.archiveLagMs,
    archivePendingCount: status.archivePendingCount,
    archiveFailedCount: status.archiveFailedCount,
    lastArchiveError: status.lastArchiveError,
    maxArchiveAttempts: OFAPI_DM_COLD_ARCHIVE_MAX_ATTEMPTS,
    acl: "owner_admin_endpoint_only" as const,
    audit: "source_journal_metadata_on_each_row" as const,
    purgePolicy: "daily_retention_purge_by_retain_until" as const,
    exportPolicy: "no_raw_transcript_export_endpoint_yet" as const,
    mediaPolicy: "stable_metadata_only_no_signed_urls" as const,
  };
}
