import {
  type Database,
  type WorkboardSignalRow,
  type WorkboardStateRecord,
  deleteIneligibleWorkboardStates,
  listWorkboardRecomputePageIds,
  loadWorkboardSignalRows,
  upsertWorkboardStates,
} from "@agency_hub_core/db";
import {
  UTC_TIME_ZONE,
  addUtcDays,
  toBusinessDate,
  transactionTypes,
  type TransactionType,
} from "@agency_hub_core/shared";

import { evaluateFan } from "./engine.ts";
import type {
  ConversationState,
  CoverageStatus,
  DmSenderRole,
  FanFlag,
  FanSignals,
  FreeloaderStatus,
  MassSubstate,
  WorkboardEvaluation,
} from "./types.ts";

const FLAGS = new Set<string>(["whale", "vip", "risky"]);
const ROLES = new Set<string>(["fan", "model", "system", "unknown"]);
const COVERAGE = new Set<string>(["pending_backfill", "partial_window", "complete"]);
const SUBSTATES = new Set<string>(["fresh", "gray", "active", "dead", "archived"]);
const FREELOADER = new Set<string>(["none", "cooling", "freeloader", "ceiling"]);
const CONVERSATION_STATES = new Set<string>(["question", "buy_signal", "smalltalk", "closing", "cold", "complaint"]);
const TXN_TYPES = new Set<string>(transactionTypes);
const UPSERT_CHUNK = 500;
const REFUND_COOLDOWN_MS = 14 * 86_400_000;

type MillsLike = bigint | number | string | null;
function toBig(value: MillsLike): bigint {
  if (value == null) {
    return 0n;
  }
  return typeof value === "bigint" ? value : BigInt(value);
}
function toBigOrNull(value: MillsLike): bigint | null {
  if (value == null) {
    return null;
  }
  return typeof value === "bigint" ? value : BigInt(value);
}
function toDate(value: Date | string | null): Date | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

const NINETY_DAYS_MS = 90 * 86_400_000;

interface FreeloaderUpdate {
  episodes: string[];
  conv90: number;
  lifetime: number;
  converted: boolean;
}

/**
 * Maintain the persisted sliding-window freeloader counter. Counts distinct
 * business-days with a real two-way exchange ("meaningful conversation-days") in
 * the trailing 90d — the design's "~10 conversations on different days". The
 * persisted list survives the 25-message window churn; a conversion resets it.
 */
function updateFreeloaderEpisodes(row: WorkboardSignalRow, now: Date, timeZone: string): FreeloaderUpdate {
  const prior = Array.isArray(row.freeloader_episodes) ? row.freeloader_episodes : [];
  const cutoff = now.getTime() - NINETY_DAYS_MS;
  const pruned = prior
    .filter((iso) => {
      const t = new Date(iso).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const latestMeaningfulAt = toDate(row.latest_meaningful_message_at);
  const meaningfulLatest = row.fan_msgs >= 2
    && row.model_msgs >= 1
    && latestMeaningfulAt != null
    && latestMeaningfulAt.getTime() >= cutoff
    && latestMeaningfulAt.getTime() <= now.getTime();
  const latestKey = latestMeaningfulAt ? toBusinessDate(latestMeaningfulAt, timeZone) : null;
  const lastIso = pruned[pruned.length - 1];
  const lastKey = lastIso ? toBusinessDate(new Date(lastIso), timeZone) : null;

  const episodes = [...pruned];
  let appended = false;
  if (meaningfulLatest && latestKey !== lastKey) {
    episodes.push(latestMeaningfulAt.toISOString());
    appended = true;
  }

  const converted = toBig(row.net90) > 0n;
  const lifetime = converted ? 0 : (row.lifetime_free_episodes ?? 0) + (appended ? 1 : 0);
  return { episodes, conv90: episodes.length, lifetime, converted };
}

function mapRowToSignals(
  row: WorkboardSignalRow,
  now: Date,
  timeZone: string,
  freeloader: FreeloaderUpdate,
): FanSignals {
  const net90 = toBig(row.net90);
  const alaCarte90 = toBig(row.alacarte90);
  const alaCarteShare90 = net90 > 0n ? Number(alaCarte90) / Number(net90) : 0;

  const flags = (row.flags ?? []).filter((flag): flag is FanFlag => FLAGS.has(flag));
  const role = (row.last_message_sender_role && ROLES.has(row.last_message_sender_role)
    ? row.last_message_sender_role
    : "unknown") as DmSenderRole;
  const coverage = (COVERAGE.has(row.message_coverage_status)
    ? row.message_coverage_status
    : "pending_backfill") as CoverageStatus;
  const massSubstate = (row.mass_substate && SUBSTATES.has(row.mass_substate)
    ? row.mass_substate
    : null) as MassSubstate | null;
  const freeloaderStatus = (row.freeloader_status && FREELOADER.has(row.freeloader_status)
    ? row.freeloader_status
    : "none") as FreeloaderStatus;
  const lastPurchaseType = (row.last_purchase_type && TXN_TYPES.has(row.last_purchase_type)
    ? row.last_purchase_type
    : null) as TransactionType | null;

  const refundAt = toDate(row.refund_recent_at);

  return {
    now,
    timeZone,
    ltvMills: toBig(row.ltv_mills),
    lastTransactionAt: toDate(row.last_transaction_at),
    spend30Mills: toBig(row.net30),
    spend90Mills: net90,
    alaCarteShare90,
    isSubscriber: row.is_subscriber,
    subscriptionExpiresAt: toDate(row.subscription_expires_at),
    autoRenew: row.auto_renew,
    subscriptionPriceMills: toBigOrNull(row.sub_price_mills),
    followerSince: toDate(row.follower_since),
    hasEverFanMessaged: row.has_ever_fan_messaged,
    flags,
    lastPurchaseAt: toDate(row.last_purchase_at),
    lastPurchaseNetMills: toBigOrNull(row.last_purchase_net),
    lastPurchaseType,
    lastMessageSenderRole: role,
    lastFanMessageAt: toDate(row.last_fan_message_at),
    lastModelMessageAt: toDate(row.last_model_message_at),
    tailContent: row.last_message_preview,
    storedMessageCount: row.stored_message_count ?? 0,
    messageCoverageStatus: coverage,
    modelMsgCount: row.model_msgs ?? 0,
    fanMsgCount: row.fan_msgs ?? 0,
    unknownMsgCount: row.unknown_msgs ?? 0,
    initiatorRole: (row.initiator_role && ROLES.has(row.initiator_role) ? row.initiator_role : "unknown") as DmSenderRole,
    avgReplyGapHours: row.avg_gap_hours,
    priorQScore: row.prior_q_score == null ? null : Number(row.prior_q_score),
    l2NeedsReply: row.l2_needs_reply,
    l2State: (row.l2_state && CONVERSATION_STATES.has(row.l2_state) ? row.l2_state : null) as ConversationState | null,
    freeloaderConv90: freeloader.conv90,
    lifetimeFreeEpisodes: freeloader.lifetime,
    convertedRecently: freeloader.converted,
    lastProductiveContactAt: toDate(row.last_productive_at),
    externalPresenceAt: toDate(row.external_presence_at),
    externalPresenceObservedAt: toDate(row.external_presence_observed_at),
    presenceFeedTruncated: false,
    snoozedUntil: toDate(row.snoozed_until),
    refundCooldownUntil: refundAt ? new Date(refundAt.getTime() + REFUND_COOLDOWN_MS) : null,
    massSubstate,
    reactivationAttemptedAt: toDate(row.reactivation_attempted_at),
    freeloaderStatus,
  };
}

function toRecord(
  platformAccountId: number,
  fanId: number,
  ev: WorkboardEvaluation,
  freeloader: FreeloaderUpdate,
): WorkboardStateRecord {
  return {
    platformAccountId,
    fanId,
    tab: ev.tab,
    massSubstate: ev.massSubstate,
    valueScore: ev.valueScore,
    urgencyScore: ev.urgencyScore,
    rankScore: ev.rankScore,
    secondaryStatus: ev.secondaryStatus,
    valueTier: ev.valueTier,
    urgencySeverity: ev.urgencySeverity,
    needsReply: ev.needsReply,
    needsHumanTriage: ev.needsHumanTriage,
    isPurchaseFollowup: ev.isPurchaseFollowup,
    whyNowCode: ev.whyNowCode,
    whyNowValue: ev.whyNowValue,
    reasonChips: ev.reasonChips,
    followupDueAt: ev.followupDueAt,
    valueConfidence: ev.valueConfidence,
    qScore: ev.qScore,
    qConfidence: ev.qConfidence,
    freeloaderStatus: ev.freeloaderStatus,
    freeloaderEpisodes: freeloader.episodes,
    lifetimeFreeEpisodes: freeloader.lifetime,
    serviceReason: ev.serviceReason,
  };
}

export interface RecomputeResult {
  platformAccountId: number;
  evaluated: number;
}

/** Recompute and persist workboard_state for every fan on a page. */
export async function recomputeWorkboardPage(
  db: Database,
  input: { platformAccountId: number; now?: Date },
): Promise<RecomputeResult> {
  const now = input.now ?? new Date();
  const timeZone = UTC_TIME_ZONE;
  const fromDate30 = toBusinessDate(addUtcDays(now, -30), timeZone);
  const fromDate90 = toBusinessDate(addUtcDays(now, -90), timeZone);

  const rows = await loadWorkboardSignalRows(db, {
    platformAccountId: input.platformAccountId,
    fromDate30,
    fromDate90,
  });

  const records = rows.map((row) => {
    const freeloader = updateFreeloaderEpisodes(row, now, timeZone);
    const signals = mapRowToSignals(row, now, timeZone, freeloader);
    return toRecord(input.platformAccountId, Number(row.fan_id), evaluateFan(signals), freeloader);
  });

  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    await upsertWorkboardStates(db, records.slice(i, i + UPSERT_CHUNK));
  }
  await deleteIneligibleWorkboardStates(db, { platformAccountId: input.platformAccountId });

  return { platformAccountId: input.platformAccountId, evaluated: records.length };
}

/** Re-evaluate and persist a single fan (instant board update after Готово / snooze / purchase). */
export async function recomputeWorkboardFan(
  db: Database,
  input: { platformAccountId: number; fanId: number; now?: Date },
): Promise<{ evaluated: number }> {
  const now = input.now ?? new Date();
  const timeZone = UTC_TIME_ZONE;
  const fromDate30 = toBusinessDate(addUtcDays(now, -30), timeZone);
  const fromDate90 = toBusinessDate(addUtcDays(now, -90), timeZone);

  const rows = await loadWorkboardSignalRows(db, {
    platformAccountId: input.platformAccountId,
    fromDate30,
    fromDate90,
    fanId: input.fanId,
  });
  const records = rows.map((row) => {
    const freeloader = updateFreeloaderEpisodes(row, now, timeZone);
    return toRecord(input.platformAccountId, Number(row.fan_id), evaluateFan(mapRowToSignals(row, now, timeZone, freeloader)), freeloader);
  });
  await upsertWorkboardStates(db, records);
  await deleteIneligibleWorkboardStates(db, {
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
  });
  return { evaluated: records.length };
}

/** Recompute every eligible page (the scheduled job entry point). */
export async function recomputeAllWorkboardPages(
  db: Database,
  input: { now?: Date } = {},
): Promise<{ pages: number; evaluated: number }> {
  const now = input.now ?? new Date();
  const pageIds = await listWorkboardRecomputePageIds(db);
  let evaluated = 0;
  for (const platformAccountId of pageIds) {
    const result = await recomputeWorkboardPage(db, { platformAccountId, now });
    evaluated += result.evaluated;
  }
  return { pages: pageIds.length, evaluated };
}
