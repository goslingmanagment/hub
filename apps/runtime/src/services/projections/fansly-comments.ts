// WP-F5 — the comment projector.
//
// ONE projector, ONE watermark, ONE table, shaped exactly like the statistics,
// engagement and catalog projectors. Three things are specific to it.
//
// ── 1. THE ROSTER IS THE ONLY REASON `missing_since` WORKS ──────────────────
//
// Row events say what IS. A post whose comments were all deleted serves an
// EMPTY `posts[]` and produces no row events at all, so a projector reading row
// events alone would leave deleted comments reading as live forever.
//
// `post.comment_list_observed` carries the full ref set one walk served, and
// this projector applies it in BOTH directions: mark every comment of that post
// not in the set (whose `missing_since` is still null), and CLEAR the mark on
// every comment the set still names. The mark is therefore derived from the
// ledger, in ledger order, which is what makes it survive truncate-and-replay
// identically.
//
// The CLEAR half is not symmetry for its own sake: a comment that comes back
// clears its own mark through the ordinary upsert (row events are per LOOK
// since `comment:v2`), but under the older hash-only key a comment deleted and
// restored UNCHANGED emitted no row event at all, and those events still
// replay — only the roster un-marks it there.
//
// ORDER MATTERS, and the canonicalizer guarantees it: the roster is the LAST
// draft of its observation, so every comment it names has already been upserted
// by the time the complement is marked.
//
// ── 2. A TRUNCATED ROSTER MAY NOT MARK ANYTHING ─────────────────────────────
//
// `/post/{id}/replies` has no proven pagination, so a suspiciously full page —
// or any page fetched with a cursor — carries `possiblyTruncated: true`, and a
// truncated page's complement is unknowable. Marking from it would delete an
// archive one page at a time. The CLEAR half still runs, because a ref the page
// DID name is present in both worlds.
//
// ── 3. THE WALK QUEUE IS NOT THIS PROJECTOR'S BUSINESS ──────────────────────
//
// `subject_refresh_state` rows for `plane='post_replies'` are written by the
// HANDLER (where the walk happens) and by the creator-posts projector's
// same-transaction seeding hook. This projector never touches them, and the
// registry's `tables` list says so: `post_comments` alone. That boundary is
// what makes `projection:rebuild fansly_comments` safe — it truncates and
// replays the archive without resetting a single walk cursor, so a repair costs
// zero platform calls. A test proves the walk rows survive a rebuild byte for
// byte.
//
// ── THE THREE RULES IT SHARES WITH EVERY PROJECTOR IN THIS TREE ─────────────
//
// 1. Projectors read EVENTS only — never `observations.payload`, never
//    `sync_raw_payloads`.
// 2. Rows are dated from `data`, NEVER from `event.occurredAt`. These events are
//    receipt-time by construction (§3.2b); `occurredAt` is when we LOOKED, and
//    it IS the right freshness key for the head — but never the comment's date.
// 3. `applied` counts real writes, so an idle tick logs nothing.

import {
  countPostComments,
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listDetachedPartitionsHoldingAccount,
  listEventAccounts,
  listEventsSince,
  reconcilePostCommentPresence,
  setProjectionWatermark,
  upsertPostComment,
  type PostCommentPlatform,
} from "@agency_hub_core/db";
import { millsFromInteger, type Mills } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const FANSLY_COMMENTS_PROJECTION = "fansly_comments";

const EVENT_PAGE_SIZE = 500;

const FANSLY_COMMENTS_EVENT_TYPES = new Set([
  "post.comment_observed",
  "post.comment_list_observed",
]);

/**
 * The tables this projector truncates on rebuild.
 *
 * `subject_refresh_state` is ABSENT on purpose — see rule 3 above. It is
 * capture-plane operational state (§3.4) named in `OPERATIONAL_STATE_TABLES`,
 * and the registry test asserts the two lists cannot intersect.
 */
export const FANSLY_COMMENTS_PROJECTION_TABLES = ["post_comments"] as const;

export interface FanslyCommentsProjectionResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  applied: number;
  comments: number;
  markedMissing: number;
  clearedMissing: number;
}

function eventData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/**
 * Event mills travel as decimal STRINGS (JSON cannot carry a bigint, and a
 * float would re-open the 1000x footgun). Constructed through the named
 * already-mills constructor `millsFromInteger` (Stage 27) — never a hand-rolled
 * `BigInt(...)`.
 *
 * The shape guards in FRONT of it are not decoration: the constructor THROWS on
 * a non-digit string, and a projector must skip a malformed money field rather
 * than crash the sweep. Digits only ⇒ no sign, no fraction, no exponent.
 */
function millsOrNull(value: unknown): Mills | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return millsFromInteger(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return millsFromInteger(value);
  }
  return null;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function runFanslyCommentsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyCommentsProjectionResult> {
  const totals: FanslyCommentsProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    applied: 0,
    comments: 0,
    markedMissing: 0,
    clearedMissing: 0,
  };
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  const platformCache = new Map<number, string | null>();

  for (const accountId of accounts) {
    totals.accounts += 1;
    if (!platformCache.has(accountId)) {
      const page = await getPageTransactionsWriterInfo(app.db, accountId);
      platformCache.set(accountId, page?.platform ?? null);
    }
    const platform = platformCache.get(accountId) ?? null;
    if (platform !== "fansly" && platform !== "onlyfans") {
      // No page, no platform: the rows would be unattributable. The events stay
      // in the ledger and project the moment the page mapping lands.
      continue;
    }
    const commentPlatform: PostCommentPlatform = platform;

    let watermark = await getProjectionWatermark(app.db, FANSLY_COMMENTS_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) {
        break;
      }
      totals.eventsSeen += events.length;

      for (const event of events) {
        if (!FANSLY_COMMENTS_EVENT_TYPES.has(event.type)) {
          continue;
        }
        const data = eventData(event.data);
        const contentHash = asText(data.contentHash) ?? "";
        if (contentHash.length !== 64) {
          continue;
        }

        if (event.type === "post.comment_observed") {
          const commentRef = asText(data.commentRef);
          const parentPostRef = asText(data.parentPostRef);
          const authorRef = asText(data.authorRef);
          if (commentRef === null || parentPostRef === null || authorRef === null) {
            continue;
          }
          const result = await upsertPostComment(app.db, {
            pageId: accountId,
            platform: commentPlatform,
            commentRef,
            parentPostRef,
            rootPostRef: asText(data.rootRef),
            authorRef,
            authorUsername: asText(data.authorUsername),
            authorDisplayName: asText(data.authorDisplayName),
            // Empty string is a VALUE here, not a missing field: an
            // empty-content reply is stored, so `asText` (which rejects "")
            // must not be used for this one.
            textPlain: typeof data.textPlain === "string" ? data.textPlain : "",
            likeCount: asCount(data.likeCount),
            mediaLikeCount: asCount(data.mediaLikeCount),
            tipTotalMills: millsOrNull(data.tipTotalMills),
            attachmentTipMills: millsOrNull(data.attachmentTipMills),
            attachmentCount: asCount(data.attachmentCount),
            pinned: typeof data.pinned === "boolean" ? data.pinned : null,
            // The comment's own instant, from `data` — never `event.occurredAt`,
            // which is when we looked. A comment with no usable provider date
            // falls back to the look, which is the only date we can defend.
            occurredAt: isoDate(data.publishedAt) ?? event.occurredAt,
            discoveredVia: "replies_walk",
            possiblyTruncated: data.possiblyTruncated === true,
            observedAt: event.occurredAt,
            contentHash,
            sourceEventId: event.id,
            sourceObservationId: event.observationId,
            sourceAccountSeq: event.accountSeq,
          });
          if (result.applied) {
            totals.comments += 1;
            totals.applied += 1;
          }
          continue;
        }

        // THE ROSTER. Everything this walk named has just been upserted
        // (clearing its `missing_since`); everything it did NOT name, and is not
        // already marked, is missing as of this instant — UNLESS the page could
        // not be proven complete, in which case its complement is unknowable
        // and only the clear half may run.
        const parentPostRef = asText(data.parentPostRef);
        if (parentPostRef === null) {
          continue;
        }
        const reconciled = await reconcilePostCommentPresence(app.db, {
          pageId: accountId,
          parentPostRef,
          presentRefs: stringArray(data.refs),
          missingSince: event.occurredAt,
          markMissing: data.possiblyTruncated !== true,
        });
        if (reconciled.marked > 0 || reconciled.cleared > 0) {
          totals.markedMissing += reconciled.marked;
          totals.clearedMissing += reconciled.cleared;
          totals.applied += reconciled.marked + reconciled.cleared;
        }
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, FANSLY_COMMENTS_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }

  return totals;
}

/** The archive census the lane reports in its progress block. */
export async function measureFanslyComments(
  db: AppContext["db"],
  pageId: number,
): Promise<{ total: number; missing: number; possiblyTruncated: number }> {
  return countPostComments(db, pageId);
}

/**
 * §3.2c(i) READ-SIDE PREFLIGHT — the rebuild refuses when any DETACHED
 * partition holds events for the account.
 *
 * Tiering exports and detaches `domain_events` monthlies older than ~6 months,
 * and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran anyway
 * would truncate the projection, replay a truncated ledger, and call the result
 * authoritative — silently. It is worse than usual in THIS family: the roster
 * events are what write `missing_since`, so a truncated replay would not merely
 * lose comments, it would resurrect ones the platform no longer serves.
 */
export async function assertFanslyCommentsRebuildable(
  app: Pick<AppContext, "db">,
  accountIds: readonly number[],
): Promise<void> {
  for (const accountId of accountIds) {
    const holding = await listDetachedPartitionsHoldingAccount(app.db, accountId);
    if (holding.length > 0) {
      throw new Error(
        `fansly_comments rebuild REFUSED for account ${accountId}: `
          + `${holding.map((row) => `${row.schema}.${row.name} (${row.rows} rows)`).join(", ")} `
          + "is detached and holds this account's events, so a replay would produce a "
          + "TRUNCATED archive and call it authoritative — including resurrecting comments "
          + "a roster event had marked missing. Recovery: re-attach the month (the 0077 "
          + "ritual — DETACH/ATTACH only, never DROP) or replay hot + lake for the range, "
          + "then re-run. See docs/runbooks/domain-event-partitions.md",
      );
    }
  }
}

/**
 * One-command rebuild: preflight, then truncate scope + reset watermark
 * ATOMICALLY, then replay. The deletes run in ONE transaction (the decision
 * #134 rule): a crash between them would leave an empty projection behind a
 * stale high watermark — permanently and silently empty.
 *
 * These deletes are a PROJECTION RESET — rebuildable state only, never
 * scheduled, which is the justification `tests/retention-deleters.test.ts`
 * carries for this file. `subject_refresh_state` is NOT touched: the walk queue
 * is capture-plane operational state, and a rebuild that reset it would re-run
 * a first-pass crawl of the entire post back-catalogue — ~4 300 posts
 * fleet-wide at 100 calls a page a day, for a repair that should cost zero
 * platform calls. The stream CHECKPOINT is untouched for the same reason.
 */
export async function rebuildFanslyCommentsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyCommentsProjectionResult> {
  const accountIds = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  await assertFanslyCommentsRebuildable(app, accountIds);

  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      const pageId = input.accountId;
      await tx.execute(sql`delete from post_comments where page_id = ${pageId}`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${FANSLY_COMMENTS_PROJECTION} and account_id = ${pageId}
      `);
    } else {
      await tx.execute(sql`delete from post_comments`);
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${FANSLY_COMMENTS_PROJECTION}
      `);
    }
  });

  return runFanslyCommentsProjection(app, input);
}
