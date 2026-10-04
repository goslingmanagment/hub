import { createHash } from "node:crypto";

import {
  CLIENT_FEED_SENDERS,
  type ClientConversationFeedQuery,
  type ClientConversationFeedResponse,
  type ClientCoverageLevel,
  type ClientCursorRefusalReason,
  type ClientFeedHead,
  type ClientFeedItem,
  type ClientFeedSender,
  type ClientFeedSummary,
} from "@agency_hub_core/contracts";
import {
  CONVERSATION_FEED_POSITION_AT_PATTERN,
  CONVERSATION_FEED_POSITION_REF_MAX_LENGTH,
  conversationFeedSummaryWindow,
  findPageSummaryByLabel,
  listConversationFeedPage,
  readConversationFeedSnapshot,
  readConversationFeedThreadLastMessageAt,
  type ConversationFeedPage,
  type ConversationFeedRow,
  type ConversationFeedSnapshot,
  type ConversationFeedSource,
  type Database,
} from "@agency_hub_core/db";
import { z } from "zod";

import type { AppContext } from "../bootstrap.ts";
import { computePingSummary, loadTranscriptContext, normalizeTranscriptMessages } from "../modules/ai/index.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { loadClientConversationCoverage } from "./client-coverage.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";
import {
  canonicalJson,
  decodeSignedCursor,
  encodeSignedCursor,
  signedCursorKeyRing,
  SignedCursorInvalidError,
  type SignedCursorScope,
  type SignedCursorSpec,
} from "./signed-cursor.ts";

/**
 * chat-extension H-9c: the archive feed of one conversation
 * (`clientConversationFeed`).
 *
 * Database only. The route reads the hub's own message stores through the
 * keyset reader (packages/db conversation-feed.ts) and the transcript loader a
 * generation uses; it asks no platform, queues no work and writes nothing, so
 * a chatter can look through a chat without OnlyFans marking it read. A request
 * reads the conversation in one read-only snapshot of the database.
 *
 * THE READER follows the generation's switch, `aiTranscriptFreshUnionMode`:
 * `serve` reads the archive ∪ webhook-store union, anything else the archive.
 * The answer says which (`source`).
 *
 * A WALK is frozen at its first page. What that page learned about the
 * conversation (the bounds of the two stores, the head, the coverage, the
 * newest known time, the snapshot's name and time) travels in the signed
 * cursor and is repeated on every later page: a later page reads its rows and
 * nothing else. The cursor is bound to the page, the fan, the person, the
 * reader and the archive generation; presented for anything else it fails its
 * signature like a forgery.
 *
 * THE HEAD is the newest message of the transcript the summary read, so it is
 * by construction what `context_v1.servedHead` reports for a generation served
 * by the same reader from the same stored state: live, with a time, in the
 * transcript's own order. The summary is the generation's too
 * (`computePingSummary` over `loadTranscriptContext`), never recounted from
 * the page's rows.
 */

const FEED_FLAG = "preview";

/** A new state shape is a new domain: an old cursor then fails its signature instead of being misread. */
export const CLIENT_FEED_CURSOR_DOMAIN = "agency-hub:client-feed-cursor:v1";
/**
 * How long a walk may go on. The stores' bounds freeze inserts only: deletions
 * and repairs keep reaching an old walk (conversation-feed.ts in packages/db
 * says what that costs), so a walk is not kept alive for days. A day is longer
 * than any open preview; after it the client reads the first page again.
 */
export const CLIENT_FEED_CURSOR_TTL_MS = 24 * 60 * 60_000;

const CURSOR_INVALID: ClientCursorRefusalReason = "cursor_invalid";
const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const SNAPSHOT_REVISION_LENGTH = 22;

const nonNegativeInt = z.number().int().nonnegative();

const feedHeadStateSchema = z.object({
  messageRef: z.string().min(1).max(CONVERSATION_FEED_POSITION_REF_MAX_LENGTH),
  at: z.string().max(40).nullable(),
  sender: z.string().min(1).max(64),
}).strict();

/** What a feed cursor carries. Strict at every depth: the decoder accepts only the bytes that were signed. */
const feedCursorStateSchema = z.object({
  /** The walk's bounds on the two content stores, and where the archive projection stood. */
  snapshot: z.object({
    archiveHighSeq: nonNegativeInt,
    archiveMaxId: nonNegativeInt,
    dmMaxId: nonNegativeInt,
  }).strict(),
  /** The last row served: the next page holds the rows strictly older than it. */
  before: z.object({
    at: z.string().regex(CONVERSATION_FEED_POSITION_AT_PATTERN).nullable(),
    ref: z.string().min(1).max(CONVERSATION_FEED_POSITION_REF_MAX_LENGTH),
  }).strict(),
  /** What the first page answered about the conversation; every page repeats it. */
  walk: z.object({
    revision: z.string().min(1).max(64),
    /** Epoch milliseconds. */
    asOf: nonNegativeInt,
    coverage: z.string().min(1).max(64),
    head: feedHeadStateSchema.nullable(),
    newestKnownAt: z.string().max(40).nullable(),
  }).strict(),
}).strict();

type FeedCursorState = z.infer<typeof feedCursorStateSchema>;
type FeedWalk = FeedCursorState["walk"];

const FEED_CURSOR_SPEC: SignedCursorSpec<FeedCursorState> = {
  domain: CLIENT_FEED_CURSOR_DOMAIN,
  state: feedCursorStateSchema,
  ttlMs: CLIENT_FEED_CURSOR_TTL_MS,
};

/**
 * The reader the owner's `aiTranscriptFreshUnionMode` names: the generation's
 * own rule (modules/ai/features), where only `serve` serves the union and
 * `off`, `shadow` and a value that cannot be read all serve the archive. Pure.
 */
export function conversationFeedSourceOf(unionMode: unknown): ConversationFeedSource {
  return unionMode === "serve" ? "union" : "archive";
}

/** The reader as the process reads the switch right now: one `config_settings` read. */
async function loadConversationFeedSource(app: AppContext): Promise<ConversationFeedSource> {
  try {
    return conversationFeedSourceOf((await loadEffectiveConfig(app.db, app.config)).aiTranscriptFreshUnionMode);
  } catch (error) {
    // As in a generation: a switch that cannot be read is not a failed request, the archive serves.
    app.logger.warn({ err: error }, "conversation feed: union mode lookup failed; the archive serves");
    return "archive";
  }
}

/** An instant as the wire carries it, or null for a value a client's frozen schema would refuse (a year outside 0000–9999). */
function isoInstantOrNull(value: Date | null): string | null {
  if (value === null || Number.isNaN(value.getTime())) {
    return null;
  }
  const text = value.toISOString();
  return text.length === 24 ? text : null;
}

/** Whole mills as a JS number, or null when the stored value is not a positive safe integer. */
function positiveMillsOrNull(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,16}$/.test(value)) {
    return null;
  }
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/**
 * Who sent a row. The direction flag decides for the page's own messages, as
 * it does in a generation; the stored role only tells a fan's message from a
 * system one, and any role the vocabulary does not know reads `unknown`.
 */
function feedSenderOf(row: Pick<ConversationFeedRow, "senderRole" | "isSentByMe">): ClientFeedSender {
  if (row.isSentByMe) {
    return "model";
  }
  return row.senderRole !== "model" && (CLIENT_FEED_SENDERS as readonly string[]).includes(row.senderRole)
    ? row.senderRole as ClientFeedSender
    : "unknown";
}

const ATTACHMENT_LABELS_MAX = 50;
const ATTACHMENT_LABEL_MAX_LENGTH = 80;

/**
 * The captions of a row's media, in the words a generation reads for the same
 * message (`[Photo]`, `[Media Bundle: 2 Photos, 1 Video]`): the transcript's
 * own labeler, given the media alone so the price and the tip stay in their
 * own fields. No media id or URL leaves through it.
 */
function attachmentLabelsOf(media: ConversationFeedRow["mediaMetadata"]): string[] {
  if (media === null || media.length === 0) {
    return [];
  }
  const [labeled] = normalizeTranscriptMessages([{
    id: 0,
    isSentByMe: false,
    createdAt: new Date(0).toISOString(),
    mediaCount: media.length,
    media: media.map((item) => ({ type: typeof item.type === "string" ? item.type : null })),
  }]);
  return (labeled?.labels ?? [])
    .slice(0, ATTACHMENT_LABELS_MAX)
    .map((label) => label.slice(0, ATTACHMENT_LABEL_MAX_LENGTH));
}

/**
 * A stored row as the wire carries it. A tip message stores its amount as its
 * price too (OnlyFans sends one number), so its price is not repeated as a
 * paid message's.
 */
export function toClientFeedItem(row: ConversationFeedRow): ClientFeedItem {
  return {
    messageId: row.messageRef,
    at: isoInstantOrNull(row.occurredAt),
    sender: feedSenderOf(row),
    text: row.textPlain,
    // Neither store records whether an automation sent the message.
    automatic: null,
    deleted: row.deleted,
    tipMills: row.isTip ? positiveMillsOrNull(row.tipAmountMills) : null,
    priceMills: row.isTip ? null : positiveMillsOrNull(row.priceMills),
    attachmentLabels: attachmentLabelsOf(row.mediaMetadata),
  };
}

/**
 * The name of a walk's snapshot: a digest of what the walk is frozen to, so two
 * walks carry the same name only when they stand on the same stored state. A
 * label, not a secret, and not a cursor: nothing is ever looked up by it.
 */
function snapshotRevisionOf(input: {
  pageId: number;
  conversationRef: string;
  source: ConversationFeedSource;
  snapshot: ConversationFeedSnapshot;
  headRef: string | null;
}): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("base64url")
    .slice(0, SNAPSHOT_REVISION_LENGTH);
}

function laterInstant(left: string | null, right: string | null): string | null {
  if (left === null || right === null) {
    return left ?? right;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function refuseCursor(): never {
  // One message and one reason for every refusal: saying WHY (another person's
  // cursor versus a cut one) would describe a scope the caller does not hold.
  throw new BadRequestError("cursor is not valid for this request", { reason: CURSOR_INVALID });
}

interface FeedRead {
  walk: FeedWalk;
  snapshot: FeedCursorState["snapshot"];
  page: ConversationFeedPage;
  summary: ClientFeedSummary | null;
}

/** The first page of a walk: the snapshot, the rows, and what the conversation looks like at this instant. */
async function readFirstPage(
  db: Database,
  input: {
    pageId: number;
    conversationRef: string;
    source: ConversationFeedSource;
    snapshot: ConversationFeedSnapshot;
    limit: number;
    summaryWindow: number;
    now: Date;
  },
): Promise<FeedRead> {
  const target = { pageId: input.pageId, conversationRef: input.conversationRef };
  const page = await listConversationFeedPage(db, {
    ...target,
    source: input.source,
    snapshot: input.snapshot,
    limit: input.limit,
  });
  const coverage: ClientCoverageLevel = await loadClientConversationCoverage({ db }, target);
  const threadLastMessageAt = await readConversationFeedThreadLastMessageAt(db, target);
  // Last on purpose: the loader swallows a failed union read (a generation then
  // falls back to the archive), and a failed statement ends this snapshot.
  const transcript = await loadTranscriptContext({ db }, {
    ...target,
    limit: input.summaryWindow,
    unionMode: input.source === "union" ? "serve" : "off",
    liveOverlay: "off",
  });
  if (transcript.served.source !== input.source) {
    // The union read failed under the summary after it served the page. The
    // feed never answers one reader's rows under another reader's head.
    throw new Error(`conversation feed: the ${input.source} reader served the page but not its summary`);
  }

  const newest = transcript.served.window.at(-1) ?? null;
  const head: ClientFeedHead | null = newest === null
    ? null
    : {
      messageRef: newest.messageRef,
      at: isoInstantOrNull(newest.occurredAt),
      sender: newest.isFromFan ? "fan" : "model",
    };
  const asOf = input.now.toISOString();
  // One clock for the segment and the silence, as in a generation.
  const ping = computePingSummary(transcript.messages, input.now.getTime());
  return {
    walk: {
      revision: snapshotRevisionOf({ ...target, source: input.source, snapshot: input.snapshot, headRef: head?.messageRef ?? null }),
      asOf: input.now.getTime(),
      coverage,
      head,
      newestKnownAt: laterInstant(head?.at ?? null, isoInstantOrNull(threadLastMessageAt)),
    },
    snapshot: {
      archiveHighSeq: input.snapshot.archiveHighSeq,
      archiveMaxId: input.snapshot.archiveMaxId,
      dmMaxId: input.snapshot.dmMaxId,
    },
    page,
    summary: {
      pingSegment: ping.segment,
      fanSilenceDays: ping.fanSilenceDays,
      window: { requested: input.summaryWindow, served: transcript.messages.length },
      coverage,
      asOf,
    },
  };
}

export async function getClientConversationFeed(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; query: ClientConversationFeedQuery },
  now: Date = new Date(),
): Promise<ClientConversationFeedResponse> {
  // A cookie session → 403: the route is a client's, not the dashboard's.
  requireApiKeyUser(principal);
  const stored = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!stored) {
    // A missing page answers like one not granted: the refusal reveals nothing.
    throw new ClientFeatureDisabledError(FEED_FLAG, "not_granted");
  }
  // The hub's own check, before anything is read: the page is granted to the
  // caller, the feature exists on its platform, the owner's `preview` switch is
  // on for it, and the extension is not outdated (409 `client_feature_disabled`).
  const page = await requireClientFeature(app, request, principal, { id: stored.id }, FEED_FLAG);
  const source = await loadConversationFeedSource(app);
  const ring = signedCursorKeyRing(app.config);
  // The feature exists only where the chat id IS the fan id (OnlyFans), so the
  // fan names the conversation.
  const conversationRef = input.fanRef;
  const { cursor, limit } = input.query;

  const read = await app.db.transaction(async (tx): Promise<{ scope: SignedCursorScope; read: FeedRead }> => {
    const snapshot = await readConversationFeedSnapshot(tx, { pageId: page.id });
    // What a cursor is bound to. The archive generation is the live one: a
    // rebuild renumbers the archive's rows, and a cursor from before it must
    // not bound a walk by ids that now name other rows.
    const scope: SignedCursorScope = {
      pageId: page.id,
      fanRef: conversationRef,
      userId: principal.user.id,
      source,
      archiveGeneration: snapshot.archiveGeneration,
    };
    if (cursor === undefined) {
      return {
        scope,
        read: await readFirstPage(tx, {
          pageId: page.id,
          conversationRef,
          source,
          snapshot,
          limit,
          summaryWindow: conversationFeedSummaryWindow(input.query.summaryWindow),
          now,
        }),
      };
    }
    let state: FeedCursorState;
    try {
      state = decodeSignedCursor(FEED_CURSOR_SPEC, cursor, { scope, now }, ring);
    } catch (error) {
      if (error instanceof SignedCursorInvalidError) {
        refuseCursor();
      }
      throw error;
    }
    return {
      scope,
      read: {
        walk: state.walk,
        snapshot: state.snapshot,
        page: await listConversationFeedPage(tx, {
          pageId: page.id,
          conversationRef,
          source,
          snapshot: state.snapshot,
          before: state.before,
          limit,
        }),
        summary: null,
      },
    };
  }, READ_SNAPSHOT);

  const { walk, snapshot, page: rows, summary } = read.read;
  return {
    target: { pageLabel: page.label, fanRef: input.fanRef },
    source,
    snapshotRevision: walk.revision,
    asOf: new Date(walk.asOf).toISOString(),
    coverage: walk.coverage,
    head: walk.head,
    newestKnownAt: walk.newestKnownAt,
    nextOlderCursor: rows.nextBefore === null
      ? null
      : encodeSignedCursor(FEED_CURSOR_SPEC, {
        scope: read.scope,
        state: { snapshot, before: rows.nextBefore, walk },
        now,
      }, ring),
    items: rows.rows.map(toClientFeedItem),
    summary,
  };
}
