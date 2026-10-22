import { sql } from "drizzle-orm";

import {
  ARCHIVE_AI_TRANSCRIPT_MAX_ROWS,
  aiTranscriptRowCap,
  listAiTranscriptUnionMessages,
  listArchiveConversationMessagesForAi,
  listDmLiveMessageMarkers,
  readDmLiveUnion,
  type AiTranscriptUnionRow,
  type ArchiveMessageRow,
  type DmLiveReaderMessage,
  type DmLiveUnionItem,
  type FanslyMessageMarkers,
} from "@agency_hub_core/db";
import { millsToDollarsNumber, normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../../../bootstrap.ts";
import { UNCONFIRMED_SOCKET_MESSAGE_LABEL } from "./chat-access.ts";
import {
  AUTOMATED_MESSAGE_LABEL,
  fanslyAutomationReason,
  type FanslyAutomationEvidence,
  type FanslyAutomationInput,
  type FanslyAutomationManifest,
  type FanslyAutomationReason,
} from "./fansly-automation.ts";
import {
  formatFanSpendingData,
  formatFanSubscriptionData,
  formatTranscript,
  isTranscriptMessageRef,
  normalizeTranscriptMessages,
  type FanSpendingData,
  type FanSubscriptionInput,
  type FanTransactionRow,
  type OfapiChatMessage,
  type SpendingSums,
  type TranscriptMessage,
} from "../prompts/index.ts";
import {
  servedWindowOf,
  type AiContextSource,
  type TranscriptServedSnapshot,
} from "./context-frame.ts";
import { readsMaterialHeadMedia } from "./fansly-media.ts";
import type { FanslyServedMedia, FanslyServedMessageMedia } from "./fansly-media-notes.ts";
import {
  loadFanslyTranscriptMediaLabels,
  type FanslyClientPurchases,
  type FanslyTranscriptMediaLabels,
} from "./fansly-ppv.ts";
import type { OnlyFansMessageMedia } from "./media-notes.ts";

export * from "./chat-access.ts";
export * from "./context-frame.ts";
export * from "./fansly-automation.ts";
export * from "./fansly-coverage.ts";
export * from "./fansly-fan-identity.ts";
export * from "./fansly-media.ts";
export * from "./fansly-media-notes.ts";
export * from "./fansly-ppv.ts";
export * from "./hi-start-proof.ts";
export * from "./live-text.ts";
export * from "./live-images.ts";
export * from "./live-ppv.ts";
export * from "./media-notes.ts";
export * from "./media-notes-context.ts";
export * from "./ping-summary.ts";

// Context loaders. Pure over kernel data; their outputs
// are the exact strings the desktop's assembly produces today, built by the
// SAME migrated formatters. Where the kernel lacks a vendor field the gap
// is NAMED here (assumption 1: escalate, never approximate silently):
//  - PPV purchased-state: message_archive keeps price/tip but not
//    isOpened/isFree → an OnlyFans archive read renders PPV labels in the
//    'unknown' state (the union read supplies isOpened). A Fansly row's
//    paid attachments are marked one by one from the media plane, its
//    orders and its order-history walks (fansly-ppv.ts, R20 HF-7в).
//  - Spending `sums`: the desktop passes the vendor's own summary object;
//    the kernel derives the same sums from its transactions ledger.

type Db = Pick<AppContext, "db">;

/** Rebuild the OFAPI chat-message shape the migrated normalizer consumes —
 * archive rows were projected from those same vendor payloads. The id is the
 * row's ref as the store keeps it, never a number (HF-8a, message-ref.ts); a
 * ref that is not a decimal id, or a row without an event time, is not served. */
function archiveRowToOfapiShape(row: {
  messageRef: string;
  textPlain: string;
  isSentByMe: boolean;
  occurredAt: Date | null;
  priceMills: bigint | number | string | null;
  isTip: boolean;
  tipAmountMills: bigint | number | string;
  /** OFAPI's media list: only the OnlyFans union read passes it. An archive
   * row comes without it (`archiveRowWithoutMedia`): its OnlyFans bytes are
   * those of a read without media, and a Fansly row's media are labelled from
   * the hub's own stores (fansly-media.ts, R20 HF-7a). */
  mediaMetadata?: Array<Record<string, unknown>> | null;
  /** PPV purchase state — the union read supplies it (dm arm + hot-table
   * purchased_at upgrade); the archive read leaves it null → 'unknown'. */
  isOpened?: boolean | null;
}): ShapedArchiveMessage | null {
  if (!isTranscriptMessageRef(row.messageRef) || row.occurredAt === null) {
    return null;
  }
  const priceDollars = row.priceMills === null ? null : millsToDollarsNumber(row.priceMills);
  const tipDollars = millsToDollarsNumber(row.tipAmountMills);
  const media = row.mediaMetadata ?? [];
  return {
    id: row.messageRef,
    text: row.textPlain,
    isSentByMe: row.isSentByMe,
    createdAt: row.occurredAt.toISOString(),
    price: priceDollars,
    isOpened: row.isOpened ?? null,
    isTip: row.isTip,
    tipAmount: row.isTip && tipDollars > 0 ? tipDollars : null,
    mediaCount: media.length,
    media: media.map((media) => ({
      id: (media.id as string | number | null) ?? null,
      type: (media.type as string | null) ?? null,
      canView: (media.canView as boolean | null) ?? null,
    })),
  } as ShapedArchiveMessage;
}

/** A served row in the normalizer's input shape, keyed by its exact ref. */
type ShapedArchiveMessage = OfapiChatMessage & { id: string };

/** An archive row for the shaper, without its stored media list: the archive
 * read never gave the shaper media, so an OnlyFans transcript read from the
 * archive keeps its bytes; a Fansly row's media are labelled by
 * fansly-media.ts from the same list (R20 HF-7a). */
function archiveRowWithoutMedia(row: ArchiveMessageRow) {
  const { mediaMetadata: _stored, ...rest } = row;
  return rest;
}

/** A Fansly live overlay row in the archive row shape the shaper reads: the
 * socket fields only. No price or tip: money is REST-only (owner decision №7).
 * Its attachments are labelled like a stored row's media (fansly-media.ts,
 * R20 HF-7a) from the files the hub knows by their ids, so a message whose
 * files the hub knows reads the same before and after its REST copy replaces
 * it; one it does not know reads `[Media]` until then. */
function liveMessageToArchiveShape(message: DmLiveReaderMessage) {
  return {
    messageRef: message.platformMessageId,
    textPlain: normalizeDmMessageText(message.content),
    isSentByMe: message.senderRole === "model",
    occurredAt: message.createdAt,
    priceMills: null,
    isTip: false,
    tipAmountMills: 0,
  };
}

/** R20 HF-7д: one served message as the automation classifier reads it. */
type ServedAutomationEvidence = FanslyAutomationEvidence & { messageRef: string; source: "rest" | "live" };

/** R20 HF-7д: an archive row as the automation classifier reads it. */
function archiveAutomationEvidence(row: ArchiveMessageRow): ServedAutomationEvidence {
  return {
    messageRef: row.messageRef,
    source: "rest",
    fromModel: row.isSentByMe,
    markers: row.markers,
    inReplyTo: row.inReplyToRef,
    text: row.textPlain,
  };
}

/** R20 HF-7д: a socket overlay message as the automation classifier reads it
 *  (the same sender and text the transcript line shows). */
function liveAutomationEvidence(message: DmLiveReaderMessage): ServedAutomationEvidence {
  return {
    messageRef: message.platformMessageId,
    source: "live",
    fromModel: message.senderRole === "model",
    markers: message.markers,
    inReplyTo: message.inReplyToMessageId,
    text: normalizeDmMessageText(message.content),
  };
}

const markersUnobserved = (markers: FanslyMessageMarkers) => !markers.typeObserved && !markers.correlationIdObserved;

interface FanslyAutomationClassification {
  /** Why each automatic message is automatic, by its exact ref. */
  reasons: Map<string, FanslyAutomationReason>;
  /** The model's messages whose `type` and `correlationId` were never observed. */
  markersUnknown: Set<string>;
  /** The model's archive rows that took the socket overlay's markers. */
  overlayMarked: Set<string>;
  overlayError: boolean;
}

/**
 * R20 HF-7д: classify the served messages. A model's archive row neither of
 * whose markers the hub observed (archived before HF-7д0) takes the markers
 * the socket overlay holds for the same message, when it holds any; the
 * archive keeps its own reply and text. A failed overlay read leaves those
 * rows unknown: never a failed transcript.
 */
async function classifyFanslyAutomation(
  app: Db,
  input: { pageId: number; served: readonly ServedAutomationEvidence[]; welcome: ReadonlySet<string> },
): Promise<FanslyAutomationClassification> {
  const unknownRest = input.served.filter((message) => (
    message.source === "rest" && message.fromModel && markersUnobserved(message.markers)
  ));
  let overlay = new Map<string, FanslyMessageMarkers>();
  let overlayError = false;
  try {
    overlay = await listDmLiveMessageMarkers(app.db, {
      pageId: input.pageId,
      messageIds: unknownRest.map((message) => message.messageRef),
    });
  } catch {
    overlayError = true;
  }
  const reasons = new Map<string, FanslyAutomationReason>();
  const markersUnknown = new Set<string>();
  const overlayMarked = new Set<string>();
  for (const served of input.served) {
    const fromOverlay = served.source === "rest" && served.fromModel && markersUnobserved(served.markers)
      ? overlay.get(served.messageRef)
      : undefined;
    const message = fromOverlay === undefined ? served : { ...served, markers: fromOverlay };
    if (fromOverlay !== undefined) {
      overlayMarked.add(served.messageRef);
    }
    const reason = fanslyAutomationReason(message, input.welcome);
    if (reason !== null) {
      reasons.set(message.messageRef, reason);
    }
    if (message.fromModel && markersUnobserved(message.markers)) {
      markersUnknown.add(message.messageRef);
    }
  }
  return { reasons, markersUnknown, overlayMarked, overlayError };
}

/** The marks of the served window (after its cap), counted for the manifest. */
function fanslyAutomationManifest(
  messages: readonly TranscriptMessage[],
  automation: FanslyAutomationClassification,
  welcomeTexts: number | null,
): FanslyAutomationManifest {
  const manifest: FanslyAutomationManifest = {
    marked: 0,
    typeTwo: 0,
    nonReplyCorrelation: 0,
    welcomeText: 0,
    modelMarkersUnknown: 0,
    overlayMarkers: 0,
    welcomeTexts,
    ...(automation.overlayError ? { overlayMarkersError: true as const } : {}),
  };
  for (const message of messages) {
    if (automation.markersUnknown.has(message.id)) {
      manifest.modelMarkersUnknown += 1;
    }
    if (automation.overlayMarked.has(message.id)) {
      manifest.overlayMarkers += 1;
    }
    const reason = automation.reasons.get(message.id);
    if (reason === undefined) {
      continue;
    }
    manifest.marked += 1;
    if (reason === "type-2") manifest.typeTwo += 1;
    else if (reason === "non-reply-correlation") manifest.nonReplyCorrelation += 1;
    else manifest.welcomeText += 1;
  }
  return manifest;
}

/** PR3: the transcript reader of one load. "serve" = the archive ∪
 * webhook-store union (OnlyFans), with the archive as its fallback; "off" =
 * the archive alone. */
export type AiTranscriptUnionMode = "off" | "serve";

/** Fansly live overlay (plan §7.11): "serve" on a Fansly page, so the
 * transcript is the archive ∪ the socket messages the archive does not hold
 * yet; "off" everywhere else. */
export type AiTranscriptLiveOverlay = "off" | "serve";

export const TRANSCRIPT_LOADER_VERSION = "transcript-union-v1";

export interface TranscriptContext {
  transcript: string;
  messages: TranscriptMessage[];
  /** Per-message media ids of the served rows (image notes numbering), keyed
   *  by the transcript's message id (the exact ref). */
  mediaByMessage: Map<string, OnlyFansMessageMedia>;
  /** Fansly: each served message's attachments and where their labels start
   *  (image notes numbering, fansly-media-notes.ts). Absent on OnlyFans, when
   *  no served message has an attachment, or when the media read failed. */
  fanslyMedia?: FanslyServedMedia;
  /** PR3: per-generation context manifest — counts/heads/timings only, no
   * message text. Lands as the ADDITIVE params.contextManifest key on the
   * restricted generation record. */
  contextManifest: Record<string, unknown>;
  /** chat-extension H-4b: the served snapshot the `context_v1` frame reports.
   * Beside the manifest, never inside it: the manifest is recorded with the
   * generation and echoed to debug clients, and neither may change. */
  served: TranscriptServedSnapshot;
  /** Arena "vanished chat" (plan §5): the served socket messages labelled
   *  `UNCONFIRMED_SOCKET_MESSAGE_LABEL` (0 unless `chatUnavailable`). */
  unconfirmedSocketMessages: number;
  /** Fansly: the PPV marks the client's word changed or added
   *  (`fanslyClientPurchases`); absent when the load was given none. */
  fanslyClientPurchasesChanged?: number;
}

export async function loadTranscriptContext(
  app: Db,
  input: {
    pageId: number;
    conversationRef: string;
    limit?: number;
    unionMode?: AiTranscriptUnionMode;
    /** Fansly pages only; the OnlyFans union mode never runs beside it. */
    liveOverlay?: AiTranscriptLiveOverlay;
    /** chat-extension H-6, R20 HF-6: raises the row cap of this load's reads
     * (the deep features' deeper read, ai-transcript-depth.ts): the archive
     * and union reads, and the Fansly live overlay union with its REST arm. */
    maxRows?: number;
    /** Arena "vanished chat" (plan §5): the chat has an established
     * unavailability episode (`readAiChatAccess`, read by the caller): its
     * served socket messages are labelled `UNCONFIRMED_SOCKET_MESSAGE_LABEL`. */
    chatUnavailable?: boolean;
    /** chat-extension R20 HF-7д, Fansly Hi only (the caller decides): the
     * model's welcome and mass messages of the served window are labelled
     * `AUTOMATED_MESSAGE_LABEL` (fansly-automation.ts), and the manifest
     * counts them. Absent, nothing is classified and nothing changes. */
    fanslyAutomation?: FanslyAutomationInput;
    /** chat-extension `live-ppv-fansly-v1`, Fansly only (the caller decides,
     *  under the page's `freshText` flag): the client's word on the open
     *  chat's paid attachments, over the hub's purchase marks
     *  (fansly-ppv.ts). Absent, the marks are the hub's alone. */
    fanslyClientPurchases?: FanslyClientPurchases;
  },
): Promise<TranscriptContext> {
  const limit = input.limit ?? 100;
  const mode = input.unionMode ?? "off";
  const liveOverlay = input.liveOverlay ?? "off";

  // The AI reader filters tombstones + content-pending stubs in the repo
  // layer and accepts the deeper 1500 cap (fastreply-freshness PR2). It is
  // read in every mode: it serves off, it is the union's fallback, and it
  // anchors the manifest comparison. With the live overlay
  // it is the union's REST arm (socket deletions hide its rows too); a failed
  // union read is never a hard failure: the plain archive serves.
  let liveUnion: DmLiveUnionItem<ArchiveMessageRow>[] | null = null;
  let liveError = false;
  let archiveRows: ArchiveMessageRow[] = [];
  if (liveOverlay === "serve") {
    try {
      liveUnion = await readDmLiveUnion(app.db, {
        pageId: input.pageId,
        platformConversationId: input.conversationRef,
        store: "message_archive",
        limit: Math.min(limit, aiTranscriptRowCap(input.maxRows, ARCHIVE_AI_TRANSCRIPT_MAX_ROWS)),
        readStore: async (notTombstoned) => {
          archiveRows = await listArchiveConversationMessagesForAi(app.db, {
            accountId: input.pageId,
            conversationRef: input.conversationRef,
            limit,
            notTombstoned,
            maxRows: input.maxRows,
          });
          return archiveRows;
        },
        storeKey: (row) => ({ messageId: row.messageRef, at: row.occurredAt }),
      });
    } catch {
      liveError = true;
    }
  }
  if (liveUnion === null) {
    archiveRows = await listArchiveConversationMessagesForAi(app.db, {
      accountId: input.pageId,
      conversationRef: input.conversationRef,
      limit,
      maxRows: input.maxRows,
    });
  }

  let unionRows: AiTranscriptUnionRow[] | null = null;
  let unionError = false;
  let queryDurationMs: number | null = null;
  if (mode === "serve") {
    const startedAt = performance.now();
    try {
      unionRows = await listAiTranscriptUnionMessages(app.db, {
        pageId: input.pageId,
        conversationRef: input.conversationRef,
        limit,
        maxRows: input.maxRows,
      });
    } catch {
      // Union failure is NEVER a hard failure: archive serves, and the
      // manifest carries the stale-context bit.
      unionError = true;
    }
    queryDurationMs = Math.round(performance.now() - startedAt);
  }

  const serveUnion = mode === "serve" && unionRows !== null;
  const servedRows = liveUnion !== null
    ? liveUnion.map((item) => item.source === "rest"
      ? archiveRowWithoutMedia(item.row)
      : liveMessageToArchiveShape(item.message))
    : serveUnion ? unionRows! : archiveRows.map(archiveRowWithoutMedia);
  const shaped = servedRows
    .map((row) => archiveRowToOfapiShape(row as never))
    .filter((row): row is ShapedArchiveMessage => row !== null);

  // chat-extension R20 HF-7a: a Fansly row's media labels, from the hub's own
  // stores (fansly-media.ts): the archive's media list and the socket's
  // attachments. Fansly rows only: an OnlyFans archive row is shaped without
  // media as before, and the union (OnlyFans) reads OFAPI's media list. A
  // failed read is not a failed generation: the messages serve without their
  // media labels, and the manifest says so. R20 HF-7в: a paid attachment of a
  // stored row carries its own purchase mark (fansly-ppv.ts); a failed
  // purchase read leaves the marks `unknown`, and the manifest says so.
  let fanslyMedia: FanslyTranscriptMediaLabels | null = null;
  let fanslyMediaError = false;
  try {
    fanslyMedia = await loadFanslyTranscriptMediaLabels(app, {
      pageId: input.pageId,
      conversationRef: input.conversationRef,
      stored: liveUnion !== null
        ? liveUnion.flatMap((item) => item.source === "rest" && readsMaterialHeadMedia(item.row.platform) ? [item.row] : [])
        : serveUnion ? [] : archiveRows.filter((row) => readsMaterialHeadMedia(row.platform)),
      live: liveUnion === null ? [] : liveUnion.flatMap((item) => item.source === "live"
        ? [{ messageRef: item.message.platformMessageId, attachments: item.message.attachments }]
        : []),
      ...(input.fanslyClientPurchases !== undefined ? { client: input.fanslyClientPurchases } : {}),
    });
  } catch {
    fanslyMediaError = true;
  }

  // Arena "vanished chat" (plan §5): a chat Fansly no longer serves to the
  // page keeps its socket messages in the transcript, labelled: no REST read
  // will confirm them while the episode lasts. The transcript keys a message
  // by its exact ref, so the labels do too.
  const unconfirmedIds = new Set(input.chatUnavailable === true && liveUnion !== null
    ? liveUnion.flatMap((item) => item.source === "live" ? [item.message.platformMessageId] : [])
    : []);
  // R20 HF-7д: why each served Fansly message is automatic, from the store
  // that served it (the union serves a message in both stores from REST).
  // Only when the caller asks: every other load classifies nothing.
  const automation = input.fanslyAutomation === undefined
    ? null
    : await classifyFanslyAutomation(app, {
      pageId: input.pageId,
      served: liveUnion !== null
        ? liveUnion.map((item) => item.source === "rest"
          ? archiveAutomationEvidence(item.row)
          : liveAutomationEvidence(item.message))
        : serveUnion ? [] : archiveRows.map(archiveAutomationEvidence),
      welcome: input.fanslyAutomation.welcome ?? new Set<string>(),
    });
  const messages = normalizeTranscriptMessages(
    shaped,
    fanslyMedia !== null && fanslyMedia.bodies.size > 0
      ? {
        mediaLabelBodiesByMessageId: fanslyMedia.bodies,
        ...(fanslyMedia.ppvMarked.size > 0 ? { mediaLabelBodiesCarryPpv: fanslyMedia.ppvMarked } : {}),
      }
      : {},
  ).slice(-limit).map((message) => {
    // The released extension puts the mark first, before the media labels.
    const automatic = automation?.reasons.has(message.id) === true;
    const unconfirmed = unconfirmedIds.has(message.id);
    return automatic || unconfirmed
      ? {
        ...message,
        labels: [
          ...(automatic ? [AUTOMATED_MESSAGE_LABEL] : []),
          ...message.labels,
          ...(unconfirmed ? [UNCONFIRMED_SOCKET_MESSAGE_LABEL] : []),
        ],
      }
      : message;
  });
  const unconfirmedSocketMessages = messages.filter((message) => unconfirmedIds.has(message.id)).length;

  // Image notes (fansly-media-notes.ts): the attachments behind each served
  // message's media labels, which follow the automation mark when it has one.
  let fanslyServed: FanslyServedMedia | undefined;
  if (fanslyMedia !== null) {
    const served = new Map<string, FanslyServedMessageMedia>();
    for (const message of messages) {
      const attachments = fanslyMedia.media.attachments.get(message.id);
      if (attachments !== undefined && attachments.length > 0) {
        served.set(message.id, {
          labelOffset: automation?.reasons.has(message.id) === true ? 1 : 0,
          attachments,
          offers: fanslyMedia.media.offers.get(message.id) ?? null,
        });
      }
    }
    fanslyServed = served.size > 0 ? { messages: served, kinds: fanslyMedia.media.kinds } : undefined;
  }

  // Both readers return newest-first, so index 0 is the head.
  const archiveHead = archiveRows[0] ?? null;
  const unionHead = unionRows?.[0] ?? null;
  const archiveRefs = new Set(archiveRows.map((row) => row.messageRef));
  const unionRefs = unionRows === null ? null : new Set(unionRows.map((row) => row.messageRef));
  const source: AiContextSource = liveUnion !== null ? "live_union" : serveUnion ? "union" : "archive";
  const contextManifest: Record<string, unknown> = {
    loaderVersion: TRANSCRIPT_LOADER_VERSION,
    mode,
    source,
    archiveCount: archiveRows.length,
    unionCount: unionRows === null ? null : unionRows.length,
    archiveHeadRef: archiveHead?.messageRef ?? null,
    archiveHeadAt: archiveHead?.occurredAt?.toISOString() ?? null,
    unionHeadRef: unionHead?.messageRef ?? null,
    unionHeadAt: unionHead?.occurredAt?.toISOString() ?? null,
    headsEqual: unionRows === null
      ? null
      : (archiveHead?.messageRef ?? null) === (unionHead?.messageRef ?? null),
    additions: unionRows === null
      ? null
      : unionRows.filter((row) => !archiveRefs.has(row.messageRef)).length,
    tombstones: unionRefs === null
      ? null
      : archiveRows.filter((row) => !unionRefs.has(row.messageRef)).length,
    // Signed: positive = the union head is newer than the archive head.
    gapMs: archiveHead?.occurredAt != null && unionHead?.occurredAt != null
      ? unionHead.occurredAt.getTime() - archiveHead.occurredAt.getTime()
      : null,
    queryDurationMs,
    unionError,
    staleContext: mode === "serve" && unionError,
    // Fansly live overlay: socket messages served beside the archive (they
    // carry no money), and whether the union read failed (archive served).
    liveOverlay,
    liveCount: liveUnion === null ? null : liveUnion.filter((item) => item.source === "live").length,
    liveError,
    // Only on a failed media read, so every other generation records what it
    // recorded before.
    ...(fanslyMediaError ? { fanslyMediaError: true } : {}),
    // R20 HF-7в, only when a served Fansly attachment is paid: how many, and
    // how many of them the hub could call bought or not bought (counts only).
    ...(fanslyMedia?.ppv ? { fanslyPpv: fanslyMedia.ppv } : {}),
    ...(fanslyMedia?.ppvError ? { fanslyPpvError: true } : {}),
    // The client's word on the paid attachments (`live-ppv-fansly-v1`), in the
    // shape the OnlyFans lane records (live-ppv.ts): counts only.
    ...(input.fanslyClientPurchases !== undefined
      ? {
        livePpv: {
          source: "client-supplied",
          mode: "serve",
          sent: input.fanslyClientPurchases.sent,
          changed: fanslyMedia?.client?.changed ?? 0,
          matched: fanslyMedia?.client?.matched ?? 0,
          ignored: fanslyMedia?.client?.ignored ?? input.fanslyClientPurchases.sent,
        },
      }
      : {}),
    // R20 HF-7д, only where the caller asked for the marks (Fansly Hi).
    ...(automation !== null && input.fanslyAutomation !== undefined
      ? {
        fanslyAutomation: fanslyAutomationManifest(
          messages,
          automation,
          input.fanslyAutomation.welcome === null ? null : input.fanslyAutomation.welcome.size,
        ),
      }
      : {}),
  };

  const mediaByMessage = new Map<string, OnlyFansMessageMedia>();
  for (const message of shaped) {
    const media = (message.media ?? []).flatMap((item) => (
      item.id === null || item.id === undefined ? [] : [{ id: String(item.id), type: item.type ?? null }]
    ));
    if (media.length > 0) {
      mediaByMessage.set(message.id, {
        messageId: message.id,
        sender: message.isSentByMe ? "model" : "fan",
        paid: (message.price ?? 0) > 0,
        media,
      });
    }
  }

  const served: TranscriptServedSnapshot = {
    source,
    window: servedWindowOf(messages),
    archiveHead: archiveHead === null
      ? null
      : {
        messageRef: archiveHead.messageRef,
        occurredAt: archiveHead.occurredAt,
        isFromFan: !archiveHead.isSentByMe,
      },
  };

  return {
    transcript: formatTranscript(messages),
    messages,
    mediaByMessage,
    ...(fanslyServed !== undefined ? { fanslyMedia: fanslyServed } : {}),
    contextManifest,
    served,
    unconfirmedSocketMessages,
    ...(input.fanslyClientPurchases !== undefined
      ? { fanslyClientPurchasesChanged: fanslyMedia?.client?.changed ?? 0 }
      : {}),
  };
}

const SPENDING_TYPE_BY_CANONICAL: Record<string, string> = {
  subscription: "subscribe",
  tip: "tip",
  message_purchase: "message",
  post_purchase: "post",
  stream: "stream",
};

export async function loadSpendingContext(
  app: Db,
  input: { pageId: number; fanRef: string },
): Promise<{ block: string; data: FanSpendingData }> {
  const result = await app.db.execute<{
    canonical_type: string;
    gross: string;
    occurred_at: Date;
  }>(sql`
    select t.canonical_type, t.gross_amount_mills::text as gross, t.occurred_at
    from transactions t
    join fans f on f.id = t.fan_id
    where t.platform_account_id = ${input.pageId}
      and f.platform_user_id = ${input.fanRef}
      and t.is_active = true
    order by t.occurred_at desc
    limit 500
  `);
  const rows: FanTransactionRow[] = result.rows.map((row) => ({
    type: SPENDING_TYPE_BY_CANONICAL[row.canonical_type] ?? row.canonical_type,
    amount: millsToDollarsNumber(row.gross),
    date: new Date(row.occurred_at).toISOString(),
  }));

  const sums: SpendingSums = { totalSumm: 0, subscribesSumm: 0, tipsSumm: 0, messagesSumm: 0, postsSumm: 0, streamsSumm: 0 };
  for (const row of rows) {
    sums.totalSumm = (sums.totalSumm ?? 0) + row.amount;
    if (row.type === "subscribe") sums.subscribesSumm = (sums.subscribesSumm ?? 0) + row.amount;
    else if (row.type === "tip") sums.tipsSumm = (sums.tipsSumm ?? 0) + row.amount;
    else if (row.type === "message") sums.messagesSumm = (sums.messagesSumm ?? 0) + row.amount;
    else if (row.type === "post") sums.postsSumm = (sums.postsSumm ?? 0) + row.amount;
    else if (row.type === "stream") sums.streamsSumm = (sums.streamsSumm ?? 0) + row.amount;
  }

  const data: FanSpendingData = {
    fanId: input.fanRef,
    sums: rows.length > 0 ? sums : null,
  };
  return { block: formatFanSpendingData(data), data };
}

export async function loadSubscriptionContext(
  app: Db,
  input: { pageId: number; fanRef: string },
): Promise<{ block: string; data: FanSubscriptionInput }> {
  const result = await app.db.execute<{
    is_subscriber: boolean;
    subscriber_since: Date | null;
    subscription_expires_at: Date | null;
    auto_renew: boolean | null;
    auto_renew_off_detected_at: Date | null;
  }>(sql`
    select pf.is_subscriber, pf.subscriber_since, pf.subscription_expires_at,
           pf.auto_renew, pf.auto_renew_off_detected_at
    from page_fans pf
    join fans f on f.id = pf.fan_id
    where pf.platform_account_id = ${input.pageId}
      and f.platform_user_id = ${input.fanRef}
  `);
  const row = result.rows[0];
  const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);
  const data: FanSubscriptionInput = row
    ? {
      subscribedOn: row.is_subscriber,
      subscribedOnExpiredNow: !row.is_subscriber && row.subscription_expires_at !== null,
      subscribedOnData: {
        subscribeAt: iso(row.subscriber_since),
        expiredAt: iso(row.subscription_expires_at),
        subscribes: [{
          isCurrent: row.is_subscriber,
          startDate: iso(row.subscriber_since),
          expireDate: iso(row.subscription_expires_at),
          cancelDate: row.auto_renew === false ? iso(row.auto_renew_off_detected_at) : null,
        }],
      },
    }
    : { subscribedOn: null, subscribedOnData: null };
  return { block: formatFanSubscriptionData(data), data };
}

export async function loadFanDisplayName(
  app: Db,
  input: { pageId: number; fanRef: string; platform: "fansly" | "onlyfans" },
): Promise<string> {
  // fans are unique on (platform, platform_user_id) — the native id alone can
  // collide across platforms, and a LIMIT 1 without the platform filter could
  // serve the other platform's fan into the prompt (review R3-2). The LEFT
  // join is deliberate: a fan not yet linked to the page keeps their name.
  const result = await app.db.execute<{ name: string | null }>(sql`
    select coalesce(pf.page_alias, f.display_name, f.username) as name
    from fans f
    left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}
    where f.platform_user_id = ${input.fanRef} and f.platform = ${input.platform}
    limit 1
  `);
  return result.rows[0]?.name ?? input.fanRef;
}

/** hi-greeting only. The desktop reads the fan's profile "about"; the
 * kernel's nearest source is the audience-synced fans.metadata — a NAMED
 * parity checkpoint (Task 5) if the field proves absent in practice. */
export async function loadFanBio(
  app: Db,
  input: { fanRef: string; platform: "fansly" | "onlyfans" },
): Promise<string | undefined> {
  const result = await app.db.execute<{ metadata: Record<string, unknown> | null }>(sql`
    select metadata from fans
    where platform_user_id = ${input.fanRef} and platform = ${input.platform}
    limit 1
  `);
  const metadata = result.rows[0]?.metadata;
  const bio = metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>).about ?? (metadata as Record<string, unknown>).bio
    : undefined;
  return typeof bio === "string" && bio.trim().length > 0 ? bio : undefined;
}

// Fan-dossier context — compiler + loader live in their own
// file; re-exported here so consumers ride the module barrel.
export * from "./fan-profile.ts";

// Spend and subscription of a Fansly fan in the released extension's shape
// (chat-extension R20 HF-7г); the two loaders above stay OnlyFans' own.
export * from "./fansly-money.ts";
