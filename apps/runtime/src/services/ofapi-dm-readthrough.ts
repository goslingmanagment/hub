// Fast-reply freshness PR4 — the REST readthrough reconcile. Chat-open
// readthroughs through the Stage 9 gateway see the same messages the webhook
// lane sometimes drops; their v2 observations (kind
// ofapi_gateway_chat_messages_v2, envelope carrying chatId/conversationRef/
// cursors — the conversationRef is load-bearing for erasure ref-match) are
// projected into dm_message_archive through the amendment-3 REST merge.
//
// This is a REPLAYABLE PROJECTOR, deliberately NOT a canonicalizer family:
// the pure-sync canonicalizer seam stamps parse_version before/without
// projecting (silent loss), and the empty-draft family shape double-stamps.
// Instead: a dedicated small runner reusing listObservationsForReplay +
// markObservationParsed, PROJECT THEN STAMP, its own try/catch and page
// budget (mirrors runFamily's fault isolation). The API-side immediate
// projection after capture is best-effort; this sweep is the retry.
//
// Error boundary (v7 amendment 2): a pure per-item parse failure is
// skip+count and the observation still stamps after the rest; ANY DB/upsert
// failure aborts the observation with NO stamp; page-budget exhaustion
// mid-observation = no stamp (partial rows replay idempotently); a stamp
// failure after projection leaves the row below the floor (replay is a
// material no-op). Fence-deferred (erasure in progress) = no stamp, retry;
// fence-HIT items are DROPPED and counted, and the observation stamps —
// otherwise the backlog gauge would latch a permanent incident over rows
// that can never project.

import {
  findDmMessageArchiveByPlatformMessageId,
  listObservationsForReplay,
  markObservationParsed,
  upsertDmMessageArchiveFromReadthrough,
  type Database,
  type DmMessageArchiveMediaItem,
} from "@agency_hub_core/db";
import { millsFromDollars, normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import {
  normalizeArchiveMediaItem,
  resolveOfapiDmColdArchiveRetentionDays,
} from "./ofapi-dm-archive.ts";
import {
  OFAPI_READTHROUGH_HEALTH_FLOOR,
  OFAPI_READTHROUGH_OBSERVATION_KIND,
} from "./health-floors.ts";

const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 10;
/** Page budget in message ITEMS per run — exhaustion mid-observation aborts
 * that observation without a stamp (idempotent replay next run). */
const SWEEP_ITEM_BUDGET = 5000;

export function isOfapiDmReadthroughReconcileEnabled(
  config?: Pick<AppContext["config"], "ofapiDmReadthroughReconcileEnabled">,
) {
  return config?.ofapiDmReadthroughReconcileEnabled === true;
}

/** Envelope journaled by the read-gateway capture tee for chat-messages
 * readthroughs. body is the proxied OFAPI response verbatim. */
export interface ReadthroughChatMessagesEnvelope {
  ofapiAccountId: string;
  chatId: string;
  conversationRef: string;
  cursors: Record<string, string>;
  body: unknown;
}

/** The non-sentinel conflict classes Wave 1 deliberately keeps (amendment 3:
 * "conflicts barely exist" must become a measured number). */
export type ReadthroughConflictField =
  | "text"
  | "price"
  | "direction"
  | "timestamp"
  | "reply"
  | "media";

export interface ReadthroughReconcileRunResult {
  scanned: number;
  stamped: number;
  upserts: number;
  noops: number;
  /** Items dropped permanently (erasure-fenced). */
  drops: number;
  parseSkips: number;
  /** Observations deferred behind the erasure fence lock (retry next run). */
  deferred: number;
  errored: number;
  conflicts: Record<ReadthroughConflictField, number>;
}

function emptyRunResult(): ReadthroughReconcileRunResult {
  return {
    scanned: 0,
    stamped: 0,
    upserts: 0,
    noops: 0,
    drops: 0,
    parseSkips: 0,
    deferred: 0,
    errored: 0,
    conflicts: { text: 0, price: 0, direction: 0, timestamp: 0, reply: 0, media: 0 },
  };
}

interface ParsedReadthroughMessage {
  platformMessageId: string;
  senderPlatformUserId: string | null;
  senderRole: "fan" | "model";
  isSentByMe: boolean;
  messageCreatedAt: Date;
  textPlain: string;
  priceMills: bigint | null;
  isOpened: boolean | null;
  isTip: boolean;
  tipAmountMills: bigint;
  inReplyToMessageId: string | null;
  mediaMetadata: DmMessageArchiveMediaItem[];
  /** The platform's own edit time (changedAt) — Wave-2 ordering input. */
  platformChangedAt: Date | null;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function usdToMills(value: unknown): bigint | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? millsFromDollars(value)
    : null;
}

/** One REST list item → the archive shape. Returns null on a pure per-item
 * parse failure (missing id/direction/timestamp) — skip and count. */
export function parseReadthroughChatMessage(value: unknown): ParsedReadthroughMessage | null {
  const item = asRecord(value);
  if (!item) {
    return null;
  }
  const platformMessageId = idToString(item.id);
  const messageCreatedAt = parseTimestamp(item.createdAt);
  if (!platformMessageId || typeof item.isSentByMe !== "boolean" || !messageCreatedAt) {
    return null;
  }
  const isSentByMe = item.isSentByMe;
  const priceMills = usdToMills(item.price);
  const isTip = item.isTip === true;
  const tipMills = usdToMills(item.tipAmount);
  const media = Array.isArray(item.media) ? item.media : [];
  return {
    platformMessageId,
    senderPlatformUserId: idToString(asRecord(item.fromUser)?.id),
    senderRole: isSentByMe ? "model" : "fan",
    isSentByMe,
    messageCreatedAt,
    textPlain: normalizeDmMessageText(typeof item.text === "string" ? item.text : ""),
    priceMills,
    isOpened: typeof item.isOpened === "boolean" ? item.isOpened : null,
    isTip,
    tipAmountMills: isTip ? tipMills ?? priceMills ?? 0n : 0n,
    inReplyToMessageId: idToString(asRecord(item.replyToMessage)?.id),
    mediaMetadata: media
      .map((entry) => normalizeArchiveMediaItem(entry))
      .filter((entry): entry is DmMessageArchiveMediaItem => entry !== null),
    platformChangedAt: parseTimestamp(item.changedAt),
  };
}

function sortMediaById(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...items].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

/** Measure the non-sentinel conflicts the Wave-1 merge deliberately keeps in
 * favor of the existing row (Wave 2's reducer arbitrates them for real). */
function countConflicts(
  existing: {
    textPlain: string;
    priceMills: bigint | null;
    isSentByMe: boolean;
    messageCreatedAt: Date | null;
    inReplyToMessageId: string | null;
    mediaMetadata: Array<Record<string, unknown>>;
  },
  incoming: ParsedReadthroughMessage,
  into: Record<ReadthroughConflictField, number>,
) {
  if (existing.textPlain !== "" && incoming.textPlain !== "" && existing.textPlain !== incoming.textPlain) {
    into.text += 1;
  }
  if (existing.priceMills !== null && incoming.priceMills !== null && existing.priceMills !== incoming.priceMills) {
    into.price += 1;
  }
  if (existing.messageCreatedAt !== null && existing.isSentByMe !== incoming.isSentByMe) {
    into.direction += 1;
  }
  if (
    existing.messageCreatedAt !== null
    && existing.messageCreatedAt.getTime() !== incoming.messageCreatedAt.getTime()
  ) {
    into.timestamp += 1;
  }
  if (
    existing.inReplyToMessageId !== null && incoming.inReplyToMessageId !== null
    && existing.inReplyToMessageId !== incoming.inReplyToMessageId
  ) {
    into.reply += 1;
  }
  const existingMedia = existing.mediaMetadata ?? [];
  const incomingMedia = incoming.mediaMetadata as unknown as Array<Record<string, unknown>>;
  if (existingMedia.length > 0 && incomingMedia.length > 0) {
    const left = JSON.stringify(sortMediaById(existingMedia));
    const right = JSON.stringify(sortMediaById(incomingMedia));
    if (left !== right) {
      into.media += 1;
    }
  }
}

export interface ReadthroughObservationRow {
  id: number;
  receivedAt: Date;
  accountId: number | null;
  payload: unknown;
}

export type ReadthroughProjectionOutcome =
  | { status: "projected" }
  /** The erasure fence lock is held — no stamp; the sweep retries. */
  | { status: "deferred" }
  /** Item budget ran out mid-observation — no stamp; idempotent replay. */
  | { status: "budget_exhausted" };

/**
 * Projects ONE v2 readthrough observation: per-item parse-skip, per-item
 * REST merge upsert, then PROJECT-THEN-STAMP with the observation's exact
 * (id, received_at) pair. Throws on DB/upsert failure (caller counts it and
 * leaves the observation below the floor).
 */
export async function projectReadthroughObservation(
  app: Pick<AppContext, "db" | "config" | "logger">,
  observation: ReadthroughObservationRow,
  totals: ReadthroughReconcileRunResult,
  budget?: { itemsLeft: number },
): Promise<ReadthroughProjectionOutcome> {
  const envelope = asRecord(observation.payload);
  const body = asRecord(envelope?.body);
  const items = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(envelope?.body)
      ? (envelope.body as unknown[])
      : [];
  const ofapiAccountId = typeof envelope?.ofapiAccountId === "string" ? envelope.ofapiAccountId : null;
  const chatId = typeof envelope?.chatId === "string" ? envelope.chatId : null;
  const pageId = observation.accountId;

  const stamp = async () => {
    try {
      await markObservationParsed(app.db, {
        observationId: observation.id,
        receivedAt: observation.receivedAt,
        parseVersion: OFAPI_READTHROUGH_HEALTH_FLOOR.version,
      });
      totals.stamped += 1;
    } catch (error) {
      // Below-floor is safe: the sweep replays it as a material no-op.
      app.logger.warn(
        { err: error, observationId: observation.id },
        "Readthrough reconcile projected but failed to stamp; sweep will replay",
      );
    }
  };

  if (!ofapiAccountId || !chatId || pageId === null || items.length === 0) {
    // Structurally unusable (or empty page of messages) — everything here is
    // a parse-class outcome; stamp so it never wedges the floor.
    totals.parseSkips += items.length === 0 ? 0 : items.length;
    await stamp();
    return { status: "projected" };
  }

  const retentionDays = resolveOfapiDmColdArchiveRetentionDays(app as AppContext);
  const retainUntil = new Date(
    observation.receivedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000,
  );

  for (const raw of items) {
    if (budget) {
      if (budget.itemsLeft <= 0) {
        return { status: "budget_exhausted" };
      }
      budget.itemsLeft -= 1;
    }
    const message = parseReadthroughChatMessage(raw);
    if (!message) {
      totals.parseSkips += 1;
      continue;
    }

    // Conflict measurement against the current row (telemetry only — the
    // merge itself never overwrites non-sentinel material in Wave 1).
    const existing = await findDmMessageArchiveByPlatformMessageId(app.db, {
      platform: "onlyfans",
      ofapiAccountId,
      platformMessageId: message.platformMessageId,
    });
    if (existing && existing.deletedAt === null && existing.messageCreatedAt !== null) {
      countConflicts(existing, message, totals.conflicts);
    }

    const result = await upsertDmMessageArchiveFromReadthrough(app.db, {
      platform: "onlyfans",
      platformAccountId: pageId,
      ofapiAccountId,
      platformConversationId: chatId,
      fanPlatformUserId: chatId,
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
      mediaMetadata: message.mediaMetadata,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      platformChangedAt: message.platformChangedAt,
      retentionPolicy: "default",
      retainUntil,
    });
    if (result.status === "deferred") {
      return { status: "deferred" };
    }
    if (result.status === "fenced") {
      totals.drops += 1;
    } else if (result.status === "written") {
      totals.upserts += 1;
    } else {
      totals.noops += 1;
    }
  }

  await stamp();
  return { status: "projected" };
}

/**
 * The sweep runner: walks v2 readthrough observations below the shared
 * health-floor version, projects then stamps, with runFamily-style fault
 * isolation (one poison observation costs exactly its own stamp) and an
 * item budget. Invoked from the canonicalize.sweep handler after
 * runCanonicalization; the run-result counters are the reconcile telemetry
 * (logged by the sweep — no new surface).
 */
export async function runOfapiDmReadthroughReconcile(
  app: Pick<AppContext, "db" | "config" | "logger">,
): Promise<ReadthroughReconcileRunResult> {
  const totals = emptyRunResult();
  if (!isOfapiDmReadthroughReconcileEnabled(app.config)) {
    return totals;
  }
  const budget = { itemsLeft: SWEEP_ITEM_BUDGET };

  let afterId: number | null = null;
  for (let pageIndex = 0; pageIndex < SWEEP_MAX_PAGES; pageIndex += 1) {
    const rows = await listObservationsForReplay(app.db as Database, {
      belowParseVersion: OFAPI_READTHROUGH_HEALTH_FLOOR.version,
      source: OFAPI_READTHROUGH_HEALTH_FLOOR.source,
      kinds: [OFAPI_READTHROUGH_OBSERVATION_KIND],
      afterId,
      limit: SWEEP_PAGE_SIZE,
    });
    if (rows.length === 0) {
      break;
    }
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      totals.scanned += 1;
      try {
        // G5 slice 2: the captured body comes through the read seam.
        const observation = await resolveCapturePayloadRow(app, "observation", row.id, row);
        const outcome = await projectReadthroughObservation(app, {
          id: row.id,
          receivedAt: row.receivedAt,
          accountId: row.accountId,
          payload: observation.payload,
        }, totals, budget);
        if (outcome.status === "deferred") {
          totals.deferred += 1;
        } else if (outcome.status === "budget_exhausted") {
          return totals;
        }
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, observationId: row.id },
          "Readthrough reconcile failed for observation; left below the floor for the next sweep",
        );
      }
    }

    if (rows.length < SWEEP_PAGE_SIZE) {
      break;
    }
  }
  return totals;
}
