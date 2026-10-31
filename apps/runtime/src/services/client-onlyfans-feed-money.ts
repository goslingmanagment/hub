import {
  findOnlyfansFeedMoneyClaim,
  findOnlyfansFeedTransactionRow,
  getOnlyfansFeedTransactionId,
  insertOnlyfansFeedMoneyClaim,
  listOnlyfansFeedMoneyCandidates,
  refineOnlyfansFeedWsTransaction,
  type Database,
  type OnlyfansFeedMoneyCandidate,
  type OnlyfansFeedMoneySighting,
} from "@agency_hub_core/db";
import { millsFromDollars, type TransactionType } from "@agency_hub_core/shared";

import { upsertTransactionWithNegationGuards } from "./money-negation-guards.ts";

/**
 * The OnlyFans feed's money (services/client-onlyfans-feed.ts): a purchase or a
 * tip the page's socket announced (`ws`), and a row of the page's sales ledger
 * (`ledger`), as transactions of the page under the writer `chatspace`.
 *
 * ONE PURCHASE, ONE ROW. The same purchase may be seen three ways: by the
 * socket the moment it happens (fan, gross, no time of OnlyFans' own, no id of
 * the transaction), by the ledger later (OnlyMonster's id, OnlyFans' time,
 * gross and net), and — before the cutoff — by OFAPI (OnlyFans' id). None of
 * them names another's id for sure, so a sighting first looks for the row that
 * already counts its purchase and claims it (onlyfans_feed_money_claims);
 * only when there is none it writes a row of its own. A row is claimed at most
 * once by each kind of sighting, and a sighting never claims a row of its own
 * kind: two socket tips of $5 are two tips, and so are two ledger rows. The
 * match is the same fan, the same gross amount, a kind that agrees, within
 * MATCH_WINDOW_MS; of several, the nearest in time.
 *
 * - A ledger row whose id the page already holds (OnlyMonster's id is
 *   OnlyFans' own, as OFAPI wrote it) is that row.
 * - The ledger's figures refine a row the socket wrote (its net replaces the
 *   socket's 80 % estimate); a row of another writer is never changed.
 * - A ledger row with status `undo` is a chargeback: the purchase is counted
 *   and its reversal `<id>:reversal` written beside it, through the negation
 *   guards, as OFAPI's chargebacks are.
 *
 * Every write of a sighting carries its journal entry (`source_observation_id`):
 * the person whose tab saw it is that observation's actor. The caller holds
 * the page's money lock and rebuilds the rollups from the earliest time it
 * wrote.
 */

/** How far apart two sightings of one purchase may be dated. */
export const ONLYFANS_FEED_MATCH_WINDOW_MS = 10 * 60_000;
/** The creator's share OnlyFans pays out of a gross amount: the net of a socket's sighting. */
export const ONLYFANS_CREATOR_SHARE_PERCENT = 80n;

export type FeedMoneyKind = Extract<
  TransactionType,
  "tip" | "message_purchase" | "post_purchase" | "subscription" | "stream_tip" | "other"
>;

export interface FeedMoneySightingInput {
  sighting: OnlyfansFeedMoneySighting;
  /** `ws:tip:<tip>`, `ws:ppv:message:<message>`, `ws:ppv:post:<post>:<fan digest>`, `ledger:<id>`. */
  feedKey: string;
  /** The row's own transaction id when it writes one. */
  transactionId: string;
  fanRef: string | null;
  fanId: number | null;
  kind: FeedMoneyKind;
  /** Positive. */
  grossMills: bigint;
  netMills: bigint;
  occurredAt: Date;
  /** The ledger's `undo`: the purchase was charged back. */
  chargeback: boolean;
  rawType: string;
  rawStatus: string;
  observationId: number;
}

export type FeedMoneyOutcome = (
  | { status: "known" }
  | { status: "claimed"; rowId: number; reversed: boolean }
  | { status: "written"; rowId: number; reversed: boolean }
) & {
  /** A settled positive that brought a suppressed negation back (the negation guards): the rollups start there. */
  reactivatedFrom: Date | null;
};

/** What a ledger row is, by OnlyFans' description of it. Pure. */
export function ledgerKindOf(description: string): FeedMoneyKind {
  const text = description.trim().toLowerCase();
  if (/^tip\b|\btip from\b/.test(text)) return text.includes("stream") ? "stream_tip" : "tip";
  if (/stream/.test(text)) return "stream_tip";
  if (/subscription|subscribe/.test(text)) return "subscription";
  if (/payment for message|message/.test(text)) return "message_purchase";
  if (/post/.test(text)) return "post_purchase";
  return "other";
}

/** The socket's purchase as a kind: a message or a post. Pure. */
export function ppvKindOf(contentType: string): FeedMoneyKind {
  return contentType === "post" ? "post_purchase" : contentType === "message" ? "message_purchase" : "other";
}

/** Whether a row of this canonical type may be the purchase a sighting of this kind saw. Pure. */
export function kindsAgree(kind: FeedMoneyKind, canonicalType: string): boolean {
  if (kind === "other" || canonicalType === "other") return true;
  if (kind === "tip" || kind === "stream_tip") return canonicalType === "tip" || canonicalType === "stream_tip";
  return kind === canonicalType;
}

/** The creator's net of a gross amount the socket named. Pure. */
export function socketNetMills(grossMills: bigint): bigint {
  return (grossMills * ONLYFANS_CREATOR_SHARE_PERCENT) / 100n;
}

/** Dollars as the feed carries them, in mills; null when not a finite amount. Pure. */
export function feedDollarsToMills(dollars: number): bigint | null {
  if (!Number.isFinite(dollars)) return null;
  return BigInt(millsFromDollars(Math.round(dollars * 1000) / 1000).toString());
}

/**
 * The row a sighting claims among the candidates, or null (a row of its own is
 * written). Pure: the candidates are the page's active rows of the fan with
 * this gross amount near the sighting's time.
 */
export function pickFeedMoneyClaim(
  sighting: Pick<FeedMoneySightingInput, "sighting" | "kind" | "occurredAt" | "grossMills">,
  candidates: readonly OnlyfansFeedMoneyCandidate[],
): OnlyfansFeedMoneyCandidate | null {
  const own = sighting.sighting === "ws" ? "chatspace:ws" : "chatspace:ledger";
  let best: OnlyfansFeedMoneyCandidate | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const row of candidates) {
    if (row.source === own) continue;
    if (sighting.sighting === "ws" ? row.claimedByWs : row.claimedByLedger) continue;
    if (row.grossAmountMills !== sighting.grossMills) continue;
    if (!kindsAgree(sighting.kind, row.canonicalType)) continue;
    const gap = Math.abs(row.occurredAt.getTime() - sighting.occurredAt.getTime());
    if (gap > ONLYFANS_FEED_MATCH_WINDOW_MS) continue;
    if (gap < bestGap || (gap === bestGap && best !== null && row.id < best.id)) {
      best = row;
      bestGap = gap;
    }
  }
  return best;
}

async function writeReversal(
  db: Database,
  input: { pageId: number; purchaseTransactionId: string; sighting: FeedMoneySightingInput },
): Promise<void> {
  const { sighting } = input;
  await upsertTransactionWithNegationGuards(db, {
    platformAccountId: input.pageId,
    source: "chatspace:ledger",
    sourceObservationId: sighting.observationId,
    fanId: sighting.fanId,
    transactionId: `${input.purchaseTransactionId}:reversal`,
    correlationAccountId: sighting.fanRef,
    rawType: sighting.rawType,
    canonicalType: "chargeback",
    transactionState: "posted",
    rawStatus: sighting.rawStatus,
    grossAmountMills: -sighting.grossMills,
    sourceDestinationAmountMills: -sighting.grossMills,
    creatorNetAmountMills: -sighting.netMills,
    senderId: sighting.fanRef,
    occurredAt: sighting.occurredAt,
    sourceUpdatedAt: sighting.occurredAt,
  });
}

/**
 * Applies one sighting to the page's transactions; the caller holds the page's
 * money lock and the writer is `chatspace`.
 */
export async function applyFeedMoneySighting(
  db: Database,
  pageId: number,
  sighting: FeedMoneySightingInput,
): Promise<FeedMoneyOutcome> {
  if (sighting.grossMills <= 0n) return { status: "known", reactivatedFrom: null };
  const reverse = async (purchaseTransactionId: string | null): Promise<boolean> => {
    if (!sighting.chargeback || purchaseTransactionId === null) return false;
    await writeReversal(db, { pageId, purchaseTransactionId, sighting });
    return true;
  };

  // Seen before: its purchase is counted. A ledger row may since have been charged back.
  const claimed = await findOnlyfansFeedMoneyClaim(db, { pageId, feedKey: sighting.feedKey });
  if (claimed !== null) {
    const reversed = await reverse(await getOnlyfansFeedTransactionId(db, claimed.transactionRowId));
    return reversed ? { status: "claimed", rowId: claimed.transactionRowId, reversed, reactivatedFrom: null } : { status: "known", reactivatedFrom: null };
  }
  // The page holds this very id: OnlyMonster's id of a ledger row is OnlyFans' own, as OFAPI wrote it.
  const same = await findOnlyfansFeedTransactionRow(db, { pageId, transactionId: sighting.transactionId });
  if (same !== null) {
    await insertOnlyfansFeedMoneyClaim(db, {
      pageId, feedKey: sighting.feedKey, sighting: sighting.sighting, transactionRowId: same.id, observationId: sighting.observationId,
    });
    const reversed = await reverse(same.transactionId);
    return { status: "claimed", rowId: same.id, reversed, reactivatedFrom: null };
  }

  const candidates = sighting.fanRef === null
    ? []
    : await listOnlyfansFeedMoneyCandidates(db, {
      pageId,
      fanId: sighting.fanId,
      fanRef: sighting.fanRef,
      grossAmountMills: sighting.grossMills,
      from: new Date(sighting.occurredAt.getTime() - ONLYFANS_FEED_MATCH_WINDOW_MS),
      to: new Date(sighting.occurredAt.getTime() + ONLYFANS_FEED_MATCH_WINDOW_MS),
    });
  const match = pickFeedMoneyClaim(sighting, candidates);
  if (match !== null && await insertOnlyfansFeedMoneyClaim(db, {
    pageId, feedKey: sighting.feedKey, sighting: sighting.sighting, transactionRowId: match.id, observationId: sighting.observationId,
  })) {
    if (sighting.sighting === "ledger" && match.source === "chatspace:ws") {
      // The ledger's figures replace the socket's estimate on the row the socket wrote.
      await refineOnlyfansFeedWsTransaction(db, {
        rowId: match.id,
        creatorNetAmountMills: sighting.netMills,
        rawStatus: sighting.rawStatus,
        sourceObservationId: sighting.observationId,
      });
    }
    const reversed = await reverse(match.transactionId);
    return { status: "claimed", rowId: match.id, reversed, reactivatedFrom: null };
  }

  const guarded = await upsertTransactionWithNegationGuards(db, {
    platformAccountId: pageId,
    source: sighting.sighting === "ws" ? "chatspace:ws" : "chatspace:ledger",
    sourceObservationId: sighting.observationId,
    fanId: sighting.fanId,
    transactionId: sighting.transactionId,
    correlationAccountId: sighting.fanRef,
    rawType: sighting.rawType,
    canonicalType: sighting.kind,
    transactionState: "posted",
    rawStatus: sighting.rawStatus,
    grossAmountMills: sighting.grossMills,
    sourceDestinationAmountMills: sighting.grossMills,
    creatorNetAmountMills: sighting.netMills,
    senderId: sighting.fanRef,
    occurredAt: sighting.occurredAt,
    sourceUpdatedAt: sighting.occurredAt,
  });
  const written = await findOnlyfansFeedTransactionRow(db, { pageId, transactionId: sighting.transactionId });
  if (written === null) return { status: "known", reactivatedFrom: null };
  await insertOnlyfansFeedMoneyClaim(db, {
    pageId, feedKey: sighting.feedKey, sighting: sighting.sighting, transactionRowId: written.id, observationId: sighting.observationId,
  });
  const reversed = await reverse(sighting.transactionId);
  return { status: "written", rowId: written.id, reversed, reactivatedFrom: guarded.reactivatedFrom };
}
