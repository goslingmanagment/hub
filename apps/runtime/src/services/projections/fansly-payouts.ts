// WP-F7 — the payouts projector.
//
// ONE projector, ONE watermark, a reducer per table, exactly as the catalog and
// comments projectors are shaped. Two things are specific to this family.
//
// ── 1. `payout.method_list_observed` IS THE ONLY REASON `missing_since` WORKS ─
//
// Row events say what IS. Nothing in them says what ISN'T, so a projector that
// read only row events could never mark a payout method the creator removed —
// least of all in the case that matters most, where the listing comes back
// EMPTY and produces no row events at all.
//
// The roster event carries the complete set of refs one FULL listing served.
// This projector applies it in BOTH directions: mark every method NOT in the
// set (whose `missing_since` is still null) as missing at the roster's instant,
// and CLEAR the mark on every method the set still names. The mark is therefore
// derived from the ledger, in ledger order, which is what makes it survive
// truncate-and-replay identically.
//
// The CLEAR half is not symmetry for its own sake. A method that comes back
// clears its own mark through the ordinary upsert, because method events are
// keyed per LOOK (`payoutmethod:v2`) — but under `payoutmethod:v1` a method
// removed and re-added UNCHANGED emitted no row event at all (its content hash
// was the one it had before), and only the roster could un-mark it. The roster
// keeps doing so, which is also why it is keyed per LOOK rather than per
// ref-set.
//
// ORDER MATTERS, and it is guaranteed by the canonicalizer: the roster is the
// LAST draft of its observation, so every method it names has already been
// upserted by the time the complement is marked.
//
// ── 2. PAYOUT REQUESTS ARE NEVER MARKED MISSING ────────────────────────────
//
// They arrive from an OFFSET-paged walk. A roster built from one page of ten
// would claim the history holds only those ten, and the walk would spend its
// life marking and un-marking the same rows. There is no request roster, and
// `page_payout_requests` has no `missing_since` column — a payout that already
// happened does not un-happen.
//
// ── THE THREE RULES IT SHARES WITH EVERY PROJECTOR IN THIS TREE ────────────
//
// 1. Projectors read EVENTS only — never `observations.payload`, never
//    `sync_raw_payloads`. That is load-bearing here rather than stylistic: the
//    raw payout-method body carries a plaintext email, and the ONLY path from
//    it to a serving table runs through the canonicalizer's mask.
// 2. Rows are dated from `data`, NEVER from `event.occurredAt`. The events are
//    receipt-time by construction (§3.2b); `occurredAt` is when we LOOKED.
// 3. `applied` counts real writes, so an idle tick logs nothing.

import {
  countPagePayouts,
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listDetachedPartitionsHoldingAccount,
  listEventAccounts,
  listEventsSince,
  reconcilePagePayoutMethodPresence,
  setProjectionWatermark,
  upsertPagePayoutMethod,
  upsertPagePayoutRequest,
  type PagePayoutPlatform,
  type PayoutStatusConfidence,
} from "@agency_hub_core/db";
import { millsFromInteger, type Mills } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const FANSLY_PAYOUTS_PROJECTION = "fansly_payouts";

const EVENT_PAGE_SIZE = 500;

const FANSLY_PAYOUTS_EVENT_TYPES = new Set([
  "payout.method_observed",
  "payout.method_list_observed",
  "payout.observed",
]);

/** The tables this projector truncates on rebuild. Both are wholly its own —
 *  no second writer, no scoped delete. */
export const FANSLY_PAYOUTS_PROJECTION_TABLES = [
  "page_payout_requests",
  "page_payout_methods",
] as const;

export interface FanslyPayoutsProjectionResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  applied: number;
  methods: number;
  payouts: number;
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

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
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
 * a non-digit string and on a non-finite number, and a projector must skip a
 * malformed money field rather than crash the sweep. Digits only ⇒ no sign, no
 * fraction, no exponent.
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

function statusConfidence(value: unknown): PayoutStatusConfidence {
  return value === "mapped" ? "mapped" : "unmapped";
}

export async function runFanslyPayoutsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyPayoutsProjectionResult> {
  const totals: FanslyPayoutsProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    applied: 0,
    methods: 0,
    payouts: 0,
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
    const payoutPlatform: PagePayoutPlatform = platform;

    let watermark = await getProjectionWatermark(app.db, FANSLY_PAYOUTS_PROJECTION, accountId);
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
        if (!FANSLY_PAYOUTS_EVENT_TYPES.has(event.type)) {
          continue;
        }
        const data = eventData(event.data);
        const lineage = {
          sourceEventId: event.id,
          sourceObservationId: event.observationId,
          sourceAccountSeq: event.accountSeq,
          // Receipt-time events: occurredAt IS the observation instant, which
          // is exactly the freshness ordering these heads need.
          observedAt: event.occurredAt,
          contentHash: asText(data.contentHash) ?? "",
        };
        if (lineage.contentHash.length !== 64) {
          continue;
        }

        switch (event.type) {
          case "payout.method_observed": {
            const methodRef = asText(data.methodRef);
            const providerLabel = asText(data.providerLabel);
            if (methodRef === null || providerLabel === null) continue;
            const result = await upsertPagePayoutMethod(app.db, {
              pageId: accountId,
              platform: payoutPlatform,
              methodRef,
              providerId: asInt(data.providerId),
              providerLabel,
              type: asInt(data.type),
              flags: asInt(data.flags),
              status: asInt(data.status),
              // THE MASK, and nothing else `metadata` produced. The database
              // CHECKs its shape, so a canonicalizer regression that let a full
              // address through fails at the INSERT.
              maskedLabel: asText(data.maskedLabel),
              metadataParseOk: data.metadataParseOk !== false,
              ...lineage,
            });
            if (result.applied) {
              totals.methods += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "payout.observed": {
            const payoutRef = asText(data.payoutRef);
            if (payoutRef === null) continue;
            const result = await upsertPagePayoutRequest(app.db, {
              pageId: accountId,
              platform: payoutPlatform,
              payoutRef,
              // MILLS. The wire unit IS mills; nothing scales here.
              amountMills: millsOrNull(data.amountMills),
              methodRef: asText(data.payoutMethodRef),
              // The integer and the label TOGETHER — 8 is never treated as
              // "the success code" in a conditional anywhere downstream.
              statusCode: asInt(data.statusCode),
              statusLabel: asText(data.statusLabel),
              statusConfidence: statusConfidence(data.statusConfidence),
              requestedAt: isoDate(data.createdAtPlatform),
              updatedAtPlatform: isoDate(data.updatedAtPlatform),
              version: asInt(data.version),
              ...lineage,
            });
            if (result.applied) {
              totals.payouts += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "payout.method_list_observed": {
            // THE ROSTER. Everything this listing named has just been upserted
            // (clearing its `missing_since`); everything it did NOT name, and
            // is not already marked, is missing as of this instant.
            const reconciled = await reconcilePagePayoutMethodPresence(app.db, {
              pageId: accountId,
              presentRefs: stringArray(data.refs),
              missingSince: event.occurredAt,
            });
            if (reconciled.marked > 0 || reconciled.cleared > 0) {
              totals.markedMissing += reconciled.marked;
              totals.clearedMissing += reconciled.cleared;
              totals.applied += reconciled.marked + reconciled.cleared;
            }
            continue;
          }

          default:
            continue;
        }
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, FANSLY_PAYOUTS_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }

  return totals;
}

/** The lane's public census: how much of the money-out surface this page has
 *  stored, and how far back the walk has reached. */
export async function measureFanslyPayouts(db: AppContext["db"], pageId: number) {
  return await countPagePayouts(db, pageId);
}

/**
 * §3.2c(i) READ-SIDE PREFLIGHT — the rebuild refuses when any DETACHED
 * partition holds events for the account.
 *
 * Tiering exports and detaches `domain_events` monthlies older than ~6 months,
 * and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran
 * anyway would truncate the projection, replay a truncated ledger, and call the
 * result authoritative — silently. The walked payout history reaches back to
 * 2025-06-23, so on this lane a truncated replay is not an edge case: it is
 * what a rebuild run today would do to the oldest half of the money-out record.
 */
export async function assertFanslyPayoutsRebuildable(
  app: Pick<AppContext, "db">,
  accountIds: readonly number[],
): Promise<void> {
  for (const accountId of accountIds) {
    const holding = await listDetachedPartitionsHoldingAccount(app.db, accountId);
    if (holding.length > 0) {
      throw new Error(
        `fansly_payouts rebuild REFUSED for account ${accountId}: `
          + `${holding.map((row) => `${row.schema}.${row.name} (${row.rows} rows)`).join(", ")} `
          + "is detached and holds this account's events, so a replay would produce a "
          + "TRUNCATED money-out history and call it authoritative — including resurrecting "
          + "payout methods a roster event had marked missing. Recovery: re-attach the month "
          + "(the 0077 ritual — DETACH/ATTACH only, never DROP) or replay hot + lake for "
          + "the range, then re-run. See docs/runbooks/domain-event-partitions.md",
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
 * carries for this file. The stream CHECKPOINT is not touched: the walk's
 * offset cursor and its floor live there, they are capture-plane operational
 * state, and a rebuild that reset them would re-walk the whole payout history
 * for a repair that should cost zero platform calls.
 */
export async function rebuildFanslyPayoutsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyPayoutsProjectionResult> {
  const accountIds = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  await assertFanslyPayoutsRebuildable(app, accountIds);

  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      const pageId = input.accountId;
      for (const table of FANSLY_PAYOUTS_PROJECTION_TABLES) {
        await tx.execute(sql`delete from ${sql.identifier(table)} where page_id = ${pageId}`);
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${FANSLY_PAYOUTS_PROJECTION} and account_id = ${pageId}
      `);
    } else {
      for (const table of FANSLY_PAYOUTS_PROJECTION_TABLES) {
        await tx.execute(sql`delete from ${sql.identifier(table)}`);
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${FANSLY_PAYOUTS_PROJECTION}
      `);
    }
  });
  return runFanslyPayoutsProjection(app, input);
}
