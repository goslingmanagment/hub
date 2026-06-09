import {
  type Database,
  type Wb3FanMessageRow,
  type Wb3FanSignalRow,
  type Wb3FanStateRecord,
  type Wb3SegmentValue,
  deleteWb3FanStatesForMissingFans,
  listWb3PageIds,
  loadWb3FanMessageRows,
  loadWb3FanSignalRows,
  stampWb3TouchOutcomes,
  upsertWb3FanStates,
} from "@agency_hub_core/db";

import { isClosingMessage } from "../workboard-v2/closing.ts";
import { type DetectBroadcastsResult, detectBroadcastsForPage } from "./broadcast-detector.ts";
import { WB3_DEFAULTS, wb3CadenceDueAt } from "./cadence.ts";

// Nightly FSM (PRD §2): segments and transitions are recomputed from facts —
// money from transactions, dialog from threads/messages (with the L1 filter and
// Dialog Read verdicts deciding "meaningful"), touches from workboard_v3_touches.
// Sticky bits (has_ever_replied, do_not_touch, dead sleep, archive) carry over
// from the prior state row.

const DAY_MS = 86_400_000;
const UPSERT_CHUNK = 500;

function toDate(value: Date | string | null): Date | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function toNum(value: bigint | number | string | null): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

type MeaningfulStats = {
  anyCount: number;
  meaningfulCount: number;
  dialogDays: number;
  lastMeaningfulAt: Date | null;
};

/**
 * Meaningful = not caught by the L1 closing filter; when a Dialog Read verdict
 * exists for the exact message, its intent wins (a lone "hi" never promotes).
 */
export function aggregateMeaningfulStats(
  rows: Wb3FanMessageRow[],
): Map<number, MeaningfulStats> {
  const byFan = new Map<number, MeaningfulStats & { perDay: Map<string, number> }>();
  for (const row of rows) {
    let entry = byFan.get(row.fanId);
    if (!entry) {
      entry = { anyCount: 0, meaningfulCount: 0, dialogDays: 0, lastMeaningfulAt: null, perDay: new Map() };
      byFan.set(row.fanId, entry);
    }
    entry.anyCount += 1;
    const meaningful =
      row.intent != null ? row.intent !== "closing" : !isClosingMessage(row.content);
    if (!meaningful) {
      continue;
    }
    entry.meaningfulCount += 1;
    if (entry.lastMeaningfulAt == null || row.createdAt > entry.lastMeaningfulAt) {
      entry.lastMeaningfulAt = row.createdAt;
    }
    const day = row.createdAt.toISOString().slice(0, 10);
    entry.perDay.set(day, (entry.perDay.get(day) ?? 0) + 1);
  }

  const result = new Map<number, MeaningfulStats>();
  for (const [fanId, entry] of byFan) {
    let dialogDays = 0;
    for (const count of entry.perDay.values()) {
      if (count >= 2) {
        dialogDays += 1;
      }
    }
    result.set(fanId, {
      anyCount: entry.anyCount,
      meaningfulCount: entry.meaningfulCount,
      dialogDays,
      lastMeaningfulAt: entry.lastMeaningfulAt,
    });
  }
  return result;
}

export function evaluateWb3Fan(
  row: Wb3FanSignalRow,
  stats: MeaningfulStats | undefined,
  input: { platformAccountId: number; now: Date },
): Wb3FanStateRecord {
  const { platformAccountId, now } = input;
  const fanId = toNum(row.fan_id);
  const ltvMills = toNum(row.ltv_mills);
  const paidMills = toNum(row.paid_mills);
  const everPaid = paidMills > 0 || ltvMills > 0;
  const anyFanMessage = row.any_fan_message;
  const lastFanMessageAt = toDate(row.last_fan_message_at);
  const followerSince = toDate(row.follower_since);
  const lastPersonalTouchAt = toDate(row.last_personal_touch_at);
  const lastBroadcastTouchAt = toDate(row.last_broadcast_touch_at);
  const lastAnyTouchAt = toDate(row.last_any_touch_at);
  const lastPurchaseAt =
    toDate(row.last_purchase_at) ?? toDate(row.page_last_transaction_at);
  const fifthPersonalTouchAt = toDate(row.fifth_personal_touch_at);
  const revivalTouchAt = toDate(row.revival_touch_at);

  // Sticky "ever replied meaningfully": prior flag, a meaningful message in the
  // 90d content scan, or fan messages that predate the scan entirely (approximated
  // as meaningful — those fans are >60d silent and stay in gray regardless).
  const messagedWithin90d = (stats?.anyCount ?? 0) > 0;
  const hasEverReplied =
    (row.prior_has_ever_replied ?? false) ||
    (stats?.meaningfulCount ?? 0) > 0 ||
    (anyFanMessage && !messagedWithin90d);

  // dead_attempts only accrue while the fan has zero messages in the page's
  // entire history; any message (or purchase) resurrects and zeroes the path.
  const deadAttempts = anyFanMessage ? 0 : toNum(row.personal_touch_count);
  let deadSleepUntil = toDate(row.prior_dead_sleep_until);
  let archivedAt = toDate(row.prior_archived_at);

  let segment: Wb3SegmentValue;
  if (row.is_subscriber) {
    segment = "subscriber";
    deadSleepUntil = null;
    archivedAt = null;
  } else if (everPaid) {
    // Expiry and any purchase land here: paid once — spender forever.
    segment = "spender";
    deadSleepUntil = null;
    archivedAt = null;
  } else if (anyFanMessage) {
    // Resurrection: any fan message returns dead/archived to the living flow.
    deadSleepUntil = null;
    archivedAt = null;
    const silenceDays =
      lastFanMessageAt == null
        ? Infinity
        : (now.getTime() - lastFanMessageAt.getTime()) / DAY_MS;
    const followAgeDays =
      followerSince == null
        ? Infinity
        : (now.getTime() - followerSince.getTime()) / DAY_MS;
    if (hasEverReplied && silenceDays <= WB3_DEFAULTS.massActiveDemoteDays) {
      segment = "mass_active";
    } else if (followAgeDays <= WB3_DEFAULTS.freshToGrayDay && !hasEverReplied) {
      segment = "fresh";
    } else {
      segment = "gray";
    }
  } else if (deadAttempts >= WB3_DEFAULTS.deadAttempts) {
    if (deadSleepUntil == null) {
      deadSleepUntil = new Date(
        (fifthPersonalTouchAt ?? now).getTime() + WB3_DEFAULTS.deadSleepDays * DAY_MS,
      );
    }
    if (archivedAt != null) {
      segment = "archived";
    } else if (
      now >= deadSleepUntil &&
      revivalTouchAt != null &&
      now.getTime() >= revivalTouchAt.getTime() + 7 * DAY_MS
    ) {
      // Revival attempted after the sleep, no reply within 7d → archive.
      segment = "archived";
      archivedAt = new Date(revivalTouchAt.getTime() + 7 * DAY_MS);
    } else {
      segment = "dead";
    }
  } else {
    const followAgeDays =
      followerSince == null
        ? Infinity
        : (now.getTime() - followerSince.getTime()) / DAY_MS;
    segment = followAgeDays <= WB3_DEFAULTS.freshToGrayDay ? "fresh" : "gray";
  }

  const freeloader =
    segment === "mass_active" && (stats?.dialogDays ?? 0) >= 10;

  const cadenceDueAt = wb3CadenceDueAt({
    segment,
    now,
    autoRenew: row.auto_renew,
    ltvMills,
    lastPurchaseAt,
    lastFanMessageAt,
    freeloader,
    dossierEnding: row.dossier_ending,
    followerSince,
    lastPersonalTouchAt,
    lastBroadcastTouchAt,
  });

  const outcomeTotal = toNum(row.outcome_total_90);
  const outcomeReplied = toNum(row.outcome_replied_90);
  const responseRate90d =
    outcomeTotal > 0 ? Math.round((outcomeReplied / outcomeTotal) * 1000) / 1000 : null;

  return {
    platformAccountId,
    fanId,
    segment,
    hasEverReplied,
    freeloader,
    doNotTouch: row.prior_do_not_touch ?? false,
    doNotTouchReason: row.prior_do_not_touch_reason ?? null,
    deadAttempts,
    deadSleepUntil,
    archivedAt,
    lastPersonalTouchAt,
    lastAnyTouchAt,
    cadenceDueAt,
    responseRate90d,
    computedAt: now,
  };
}

export interface RecomputeWb3PageResult {
  platformAccountId: number;
  evaluated: number;
  pruned: number;
  outcomesStamped: number;
  broadcast: DetectBroadcastsResult;
}

export async function recomputeWb3Page(
  db: Database,
  input: { platformAccountId: number; now?: Date },
): Promise<RecomputeWb3PageResult> {
  const { platformAccountId } = input;
  const now = input.now ?? new Date();

  // Order matters: broadcasts first (touch credit must exist before cadence),
  // then outcomes (older than the window), then the FSM over fresh signals.
  const broadcast = await detectBroadcastsForPage(db, { platformAccountId, now });
  const outcomesStamped = await stampWb3TouchOutcomes(db, {
    platformAccountId,
    now,
    outcomeWindowHours: WB3_DEFAULTS.outcomeWindowHours,
  });

  const signals = await loadWb3FanSignalRows(db, { platformAccountId, now });
  const messageRows = await loadWb3FanMessageRows(db, { platformAccountId, now, sinceDays: 90 });
  const stats = aggregateMeaningfulStats(messageRows);

  const records = signals.map((row) =>
    evaluateWb3Fan(row, stats.get(toNum(row.fan_id)), { platformAccountId, now }),
  );
  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    await upsertWb3FanStates(db, records.slice(i, i + UPSERT_CHUNK));
  }
  const pruned = await deleteWb3FanStatesForMissingFans(db, platformAccountId);

  return { platformAccountId, evaluated: records.length, pruned, outcomesStamped, broadcast };
}

export async function recomputeWb3AllPages(
  db: Database,
  input?: { now?: Date },
): Promise<{ pages: number; evaluated: number }> {
  const now = input?.now ?? new Date();
  const pageIds = await listWb3PageIds(db);
  let evaluated = 0;
  for (const platformAccountId of pageIds) {
    const result = await recomputeWb3Page(db, { platformAccountId, now });
    evaluated += result.evaluated;
  }
  return { pages: pageIds.length, evaluated };
}
