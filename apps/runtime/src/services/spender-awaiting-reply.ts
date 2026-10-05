import { createHmac } from "node:crypto";

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
import { decryptJson, encryptJson, millsToNumber } from "@agency_hub_core/shared";
import { z } from "zod";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";
import {
  decodeSignedCursor,
  encodeSignedCursor,
  SIGNED_CURSOR_MAX_LENGTH,
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
 * THE CURSOR is signed and bound to the page and the person (presented for
 * anything else it fails its signature like a forgery), and its state is
 * sealed: the position names the hub's own id of a fan, and a token handed to
 * a client names no internal id (services/signed-cursor.ts).
 *
 * Nothing is kept between requests: unlike the statistics, a queue of people
 * waiting right now is read anew each time.
 */

const STATS_FLAG = "stats";

/** A new state shape is a new domain: an old cursor then fails its signature instead of being misread. */
export const CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN = "agency-hub:client-awaiting-reply-cursor:v1";
/**
 * How long ONE CURSOR is good for, counted from the page that carried it. Every
 * page of a walk hands out a newly issued cursor, so the hour bounds the gap
 * between two pages of a walk and not the walk: a walk that takes a page at
 * least once an hour goes on. That is the bound this queue needs. A walk holds
 * no frozen state that could age (every page is read anew), so there is
 * nothing to end it for; what must not happen is a page appended to rows a
 * client has held untouched for hours. Past the hour the client reads the
 * first page again.
 */
export const CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS = 60 * 60_000;
/**
 * The purpose of the subkey that seals a cursor's state, derived from one key
 * of the encryption ring. Versioned like the domain: a new seal is a new
 * purpose, and an old cursor then does not open.
 */
export const CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE = "agency-hub:client-awaiting-reply-cursor-seal:v1";

const CURSOR_INVALID: ClientCursorRefusalReason = "cursor_invalid";

/** A Postgres bigint as decimal text: JSON numbers cannot carry one exactly. */
const BIGINT_TEXT = /^-?(?:0|[1-9]\d{0,18})$/;

/**
 * What a walk's cursor remembers. Strict at every depth. Never on the wire in
 * the clear: the cursor carries it sealed (`sealedCursorStateSchema`).
 */
const awaitingReplyCursorStateSchema = z.object({
  /**
   * The last row the walk read: the next page holds the rows after it in the
   * queue's order (lifetime gross descending, last fan message ascending, fan
   * id ascending). `fan` is the hub's id of that fan, the order's tie-breaker,
   * and the reason the state is sealed.
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

export type SpenderAwaitingReplyCursorState = z.infer<typeof awaitingReplyCursorStateSchema>;

const base64Text = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);

/**
 * A cursor's state on the wire: the walk's state encrypted with the hub's own
 * envelope (`encryptJson`, AES-256-GCM) under a subkey of the encryption ring.
 * The signature around it binds the cursor to its scope; the seal keeps its
 * holder from reading it, so the token names neither the walk's position nor
 * the hub's id of a fan.
 */
const sealedCursorStateSchema = z.object({
  alg: z.literal("aes-256-gcm"),
  keyVersion: z.number().int().positive(),
  iv: base64Text(24),
  tag: base64Text(32),
  ciphertext: base64Text(SIGNED_CURSOR_MAX_LENGTH),
}).strict();

type SealedCursorState = z.infer<typeof sealedCursorStateSchema>;

const AWAITING_REPLY_CURSOR_SPEC: SignedCursorSpec<SealedCursorState> = {
  domain: CLIENT_SPENDER_AWAITING_REPLY_CURSOR_DOMAIN,
  state: sealedCursorStateSchema,
  ttlMs: CLIENT_SPENDER_AWAITING_REPLY_CURSOR_TTL_MS,
};

/**
 * The key that seals this route's cursors, derived from one key of the
 * encryption ring. The ring's own keys encrypt secrets at rest; they never
 * seal a cursor directly.
 */
function sealKey(rootKey: Buffer): Buffer {
  return createHmac("sha256", rootKey).update(CLIENT_SPENDER_AWAITING_REPLY_CURSOR_SEAL_PURPOSE, "utf8").digest();
}

/** The cursor that continues a walk: its state sealed, then signed for `scope`. */
export function encodeSpenderAwaitingReplyCursor(
  ring: SignedCursorKeyRing,
  input: { scope: SignedCursorScope; state: SpenderAwaitingReplyCursorState; now: Date },
): string {
  const sealed = encryptJson(awaitingReplyCursorStateSchema.parse(input.state), sealKey(ring.key), ring.keyVersion);
  return encodeSignedCursor(AWAITING_REPLY_CURSOR_SPEC, { scope: input.scope, state: sealed, now: input.now }, ring);
}

/**
 * The state of a cursor presented for `expected.scope`, or the one refusal
 * (`SignedCursorInvalidError`): not this hub's cursor for this request (the
 * signature), issued more than an hour ago, or a state that does not open.
 */
export function decodeSpenderAwaitingReplyCursor(
  ring: Pick<SignedCursorKeyRing, "keysByVersion">,
  cursor: string,
  expected: { scope: SignedCursorScope; now: Date },
): SpenderAwaitingReplyCursorState {
  const sealed = decodeSignedCursor(AWAITING_REPLY_CURSOR_SPEC, cursor, expected, ring);
  const rootKey = ring.keysByVersion.get(sealed.keyVersion);
  if (!rootKey) {
    throw new SignedCursorInvalidError("unknown_key_version");
  }
  let opened: unknown;
  try {
    opened = decryptJson<unknown>(sealed, sealKey(rootKey));
  } catch {
    throw new SignedCursorInvalidError("payload");
  }
  const state = awaitingReplyCursorStateSchema.safeParse(opened);
  if (!state.success) {
    throw new SignedCursorInvalidError("payload");
  }
  return state.data;
}

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
): SpenderAwaitingReplyCursorState {
  try {
    return decodeSpenderAwaitingReplyCursor(ring, cursor, { scope, now });
  } catch (error) {
    if (error instanceof SignedCursorInvalidError) {
      refuseCursor();
    }
    throw error;
  }
}

function positionOf(state: SpenderAwaitingReplyCursorState["after"]): SpenderAwaitingReplyPosition {
  return {
    lifetimeGrossMills: BigInt(state.gross),
    lastFanMessageAtMicros: BigInt(state.at),
    fanId: state.fan,
  };
}

function stateOf(position: SpenderAwaitingReplyPosition): SpenderAwaitingReplyCursorState["after"] {
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
      ? encodeSpenderAwaitingReplyCursor(ring, { scope, state: { after: stateOf(last.position), loaded }, now })
      : null,
    asOf: now.toISOString(),
  };
}
