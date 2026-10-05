import {
  CLIENT_NUMERIC_ID_PATTERN,
  type ClientCursorRefusalReason,
  type ClientSpenderAwaitingReplyItem,
  type ClientSpenderAwaitingReplyQuery,
  type ClientSpenderAwaitingReplyResponse,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  listPageSpenderAwaitingReply,
  type SpenderAwaitingReplyItem,
  type SpenderAwaitingReplyPosition,
} from "@agency_hub_core/db";
import { millsToNumber } from "@agency_hub_core/shared";
import { z } from "zod";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";
import {
  decodeSignedCursor,
  encodeSignedCursor,
  signedCursorKeyRing,
  SignedCursorInvalidError,
  type SignedCursorKeyRing,
  type SignedCursorScope,
  type SignedCursorSpec,
} from "./signed-cursor.ts";

/**
 * chat-extension H-8c: the awaiting-reply queue of one page
 * (`clientSpenderAwaitingReply`). Who waits and in what order is the read in
 * packages/db/src/repositories/spender-stats.ts (`listPageSpenderAwaitingReply`,
 * the same payers and rule as the statistics' `queueSummary`); this file is who
 * may ask, how a walk continues, and what of a row the wire carries.
 *
 * Database only: no platform request, no queued work, nothing written.
 *
 * A WALK IS NOT A SNAPSHOT. Every page is one read-only snapshot of its own
 * instant: its rows, `total` and `unknown` agree with each other and are of
 * `asOf`. Between pages the queue moves, and the cursor carries only a position
 * in the queue's total order plus how many rows the walk has served. So a fan
 * whose place does not change is served exactly once; a fan we answered
 * meanwhile is not served; a fan whose place changed (wrote again, paid more)
 * can be met again or missed until the next walk.
 *
 * Nothing is kept between requests: unlike the statistics, a queue of people
 * waiting right now is read anew each time.
 */

const STATS_FLAG = "stats";

/** A new state shape is a new domain: an old cursor then fails its signature instead of being misread. */
export const CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN = "agency-hub:client-awaiting-reply-cursor:v1";
/**
 * How long a walk may go on. Its pages are not of one instant, so they are
 * kept close in time: an hour is longer than any scroll through the queue, and
 * past it the rows a client already holds are too old to extend. The client
 * then reads the first page again.
 */
export const CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS = 60 * 60_000;

const CURSOR_INVALID: ClientCursorRefusalReason = "cursor_invalid";

/** A Postgres bigint as decimal text: JSON numbers cannot carry one exactly. */
const BIGINT_TEXT = /^-?(?:0|[1-9]\d{0,18})$/;

/** What an awaiting-reply cursor carries. Strict at every depth: the decoder accepts only the bytes that were signed. */
const awaitingReplyCursorStateSchema = z.object({
  /**
   * The last row the walk read: the next page holds the rows after it in the
   * queue's order (lifetime gross descending, last fan message ascending, fan
   * id ascending). `fan` is the hub's id of that fan, the order's tie-breaker:
   * it is of a row this caller was served, and opens nothing by itself.
   */
  after: z.object({
    /** Lifetime gross, mills. */
    gross: z.string().regex(BIGINT_TEXT),
    /** The fan's last message, microseconds since the epoch: a millisecond would repeat rows. */
    at: z.string().regex(BIGINT_TEXT),
    fan: z.number().int().positive(),
  }).strict(),
  /** Rows the walk has served so far. */
  loaded: z.number().int().nonnegative(),
}).strict();

type AwaitingReplyCursorState = z.infer<typeof awaitingReplyCursorStateSchema>;

const AWAITING_REPLY_CURSOR_SPEC: SignedCursorSpec<AwaitingReplyCursorState> = {
  domain: CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN,
  state: awaitingReplyCursorStateSchema,
  ttlMs: CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS,
};

function refuseCursor(): never {
  // One message and one reason for every refusal: saying WHY (another person's
  // cursor versus a cut one) would describe a scope the caller does not hold.
  throw new BadRequestError("cursor is not valid for this request", { reason: CURSOR_INVALID });
}

/** The state of a cursor this hub issued for this page and person, or 400 `bad_request` / `cursor_invalid`. */
function openCursor(
  cursor: string,
  scope: SignedCursorScope,
  now: Date,
  ring: SignedCursorKeyRing,
): AwaitingReplyCursorState {
  try {
    return decodeSignedCursor(AWAITING_REPLY_CURSOR_SPEC, cursor, { scope, now }, ring);
  } catch (error) {
    if (error instanceof SignedCursorInvalidError) {
      refuseCursor();
    }
    throw error;
  }
}

function positionOf(state: AwaitingReplyCursorState["after"]): SpenderAwaitingReplyPosition {
  return {
    lifetimeGrossMills: BigInt(state.gross),
    lastFanMessageAtMicros: BigInt(state.at),
    fanId: state.fan,
  };
}

function stateOf(position: SpenderAwaitingReplyPosition): AwaitingReplyCursorState["after"] {
  return {
    gross: position.lifetimeGrossMills.toString(),
    at: position.lastFanMessageAtMicros.toString(),
    fan: position.fanId,
  };
}

/** An instant as the wire carries it, or null for one a client's frozen schema would refuse (a year outside 0000–9999). */
function isoInstantOrNull(value: Date): string | null {
  if (Number.isNaN(value.getTime())) {
    return null;
  }
  const text = value.toISOString();
  return text.length === 24 ? text : null;
}

/**
 * A queue row as the wire carries it, or null for a row an installed client
 * could not take: its frozen schema reads `fanRef` as a platform numeric id and
 * every instant as a four-digit-year ISO time, and one row it refuses would
 * cost it the whole page. The queue exists on OnlyFans only, where a fan id is
 * such a number, so a null here is a broken stored row, not a kind of fan.
 */
export function toClientSpenderAwaitingReplyItem(row: SpenderAwaitingReplyItem): ClientSpenderAwaitingReplyItem | null {
  const lastFanMessageAt = isoInstantOrNull(row.lastFanMessageAt);
  const lastModelMessageAt = row.lastModelMessageAt === null ? null : isoInstantOrNull(row.lastModelMessageAt);
  if (
    !CLIENT_NUMERIC_ID_PATTERN.test(row.fanRef)
    || lastFanMessageAt === null
    || (row.lastModelMessageAt !== null && lastModelMessageAt === null)
  ) {
    return null;
  }
  return {
    fanRef: row.fanRef,
    username: row.username,
    displayName: row.displayName,
    lifetimeGrossMills: millsToNumber(row.lifetimeGrossMills),
    lastFanMessageAt,
    lastModelMessageAt,
    unreadCount: row.unreadCount,
    readState: row.readState,
  };
}

/**
 * One page of the awaiting-reply queue of the page of the path.
 *
 * In this order:
 * 1. the hub's own check, on every request: an API-key user (a cookie session
 *    → 403), a page granted to the caller, the owner's `stats` switch on for
 *    it, the extension not outdated (409 `client_feature_disabled` with the
 *    reason; a missing page answers `not_granted`, as one that is not the
 *    caller's);
 * 2. the cursor, when there is one: issued by this hub for this page and this
 *    person within the last hour, or 400 `bad_request` with `cursor_invalid`.
 *    Checked after the page and the switch, never in their place: a cursor
 *    adds no right;
 * 3. the read: the rows after the cursor's position and the queue's counts,
 *    from one snapshot, `asOf` the instant the request was taken at.
 */
export async function getClientSpenderAwaitingReply(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; query: ClientSpenderAwaitingReplyQuery },
  now: Date = new Date(),
): Promise<ClientSpenderAwaitingReplyResponse> {
  requireApiKeyUser(principal);
  const stored = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!stored) {
    // A missing page answers like one not granted: the refusal reveals nothing.
    throw new ClientFeatureDisabledError(STATS_FLAG, "not_granted");
  }
  const page = await requireClientFeature(app, request, principal, { id: stored.id }, STATS_FLAG);

  const ring = signedCursorKeyRing(app.config);
  // What a cursor is bound to: one person's walk of one page. Neither travels
  // in the cursor; presented for another page or by another person it fails
  // its signature like a forgery.
  const scope: SignedCursorScope = { pageId: page.id, userId: principal.user.id };
  const { cursor, limit } = input.query;
  const walk = cursor === undefined ? null : openCursor(cursor, scope, now, ring);

  // One row past the page says whether the walk goes on, so its last page
  // carries no cursor instead of pointing at an empty one.
  const read = await listPageSpenderAwaitingReply(app.db, {
    pageId: page.id,
    limit: limit + 1,
    after: walk === null ? null : positionOf(walk.after),
  });
  const rows = read.items.slice(0, limit);
  const last = rows.at(-1);

  const items: ClientSpenderAwaitingReplyItem[] = [];
  for (const row of rows) {
    const item = toClientSpenderAwaitingReplyItem(row);
    if (item === null) {
      // Counted in `total`, never served. Ids only: no name and no message.
      app.logger.warn(
        { pageId: page.id, fanId: row.fanId },
        "awaiting-reply queue: a row the client cannot take was not served",
      );
      continue;
    }
    items.push(item);
  }
  const loaded = (walk?.loaded ?? 0) + items.length;

  return {
    items,
    total: read.total,
    loaded,
    unknown: read.unknown,
    nextCursor: read.items.length > limit && last !== undefined
      ? encodeSignedCursor(AWAITING_REPLY_CURSOR_SPEC, {
        scope,
        state: { after: stateOf(last.position), loaded },
        now,
      }, ring)
      : null,
    asOf: now.toISOString(),
  };
}
