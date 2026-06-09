// Cadence map (PRD §11). Pure functions shared by the nightly recompute and
// the read-time board (cadence_overdue needs the interval again). Cadence is a
// reminder, not coercion: only ● and ◆ are mandatory.

const DAY_MS = 86_400_000;

// Defaults per PRD §11; per-page overrides arrive with the Phase 2 settings surface.
export const WB3_DEFAULTS = {
  pageDailyCapacity: 55,
  freshToGrayDay: 14,
  deadAttempts: 5,
  deadSleepDays: 75,
  refillBatch: 20,
  grayBatchSize: 30,
  deadRevivalDailyCap: 5,
  touchConfirmWindowHours: 6,
  purchaseFollowupWindowHours: 48,
  needsReplyL2AgeHours: 24,
  buySignalTtlHours: 72,
  outcomeWindowHours: 72,
  massActiveDemoteDays: 60,
  dossierSourCadenceFactor: 2,
  // Frequencies (days)
  subsRenewOnDays: 7,
  subsRenewOffDays: 3,
  spenderHotDays: 7,
  spenderCoreDays: 14,
  spenderDustDays: 30,
  massWarmDays: 7,
  massCoolingDays: 14,
  freeloaderDays: 30,
  // Spender tiers
  spenderHotPurchaseDays: 30,
  spenderHotLtvMills: 50_000,
  spenderDustLtvMills: 10_000,
  spenderDustPurchaseDays: 180,
  // Fresh warm-up schedule offsets (days since follow) + last call day
  freshScheduleDays: [0, 1, 3],
  freshLastCallFromDay: 12,
  freshLastCallToDay: 14,
  // Overdue threshold (cadence_overdue reason): overdue ≥ 1.5 × cadence
  cadenceOverdueFactor: 1.5,
} as const;

export type Wb3Segment =
  | "subscriber"
  | "spender"
  | "fresh"
  | "gray"
  | "mass_active"
  | "dead"
  | "archived";

export type Wb3SpenderTier = "hot" | "core" | "dust";

export function wb3SpenderTier(input: {
  ltvMills: number;
  lastPurchaseAt: Date | null;
  now: Date;
}): Wb3SpenderTier {
  const { ltvMills, lastPurchaseAt, now } = input;
  const purchaseAgeDays =
    lastPurchaseAt == null ? Infinity : (now.getTime() - lastPurchaseAt.getTime()) / DAY_MS;
  if (purchaseAgeDays <= WB3_DEFAULTS.spenderHotPurchaseDays || ltvMills >= WB3_DEFAULTS.spenderHotLtvMills) {
    return "hot";
  }
  if (ltvMills < WB3_DEFAULTS.spenderDustLtvMills && purchaseAgeDays > WB3_DEFAULTS.spenderDustPurchaseDays) {
    return "dust";
  }
  return "core";
}

export interface Wb3CadenceInput {
  segment: Wb3Segment;
  now: Date;
  /** page_fans.auto_renew for subscribers. */
  autoRenew: boolean | null;
  ltvMills: number;
  lastPurchaseAt: Date | null;
  /** Any fan message (threads metadata) — drives mass_active warm/cooling. */
  lastFanMessageAt: Date | null;
  freeloader: boolean;
  dossierEnding: string | null;
  followerSince: Date | null;
  lastPersonalTouchAt: Date | null;
  lastBroadcastTouchAt: Date | null;
}

/**
 * Interval in days for interval-based segments; null for gray/dead/archived
 * (rotation and revival are reason-driven, no interval promises) and for fresh
 * (fresh uses the 0/+1/+3 schedule, not an interval).
 */
export function wb3CadenceIntervalDays(input: Wb3CadenceInput): number | null {
  const sourFactor =
    input.dossierEnding === "sour" ? WB3_DEFAULTS.dossierSourCadenceFactor : 1;
  switch (input.segment) {
    case "subscriber":
      // Sour endings do not stretch sub retention — renew risk beats dossier mood.
      return input.autoRenew === false
        ? WB3_DEFAULTS.subsRenewOffDays
        : WB3_DEFAULTS.subsRenewOnDays;
    case "spender": {
      const tier = wb3SpenderTier(input);
      const base =
        tier === "hot"
          ? WB3_DEFAULTS.spenderHotDays
          : tier === "dust"
            ? WB3_DEFAULTS.spenderDustDays
            : WB3_DEFAULTS.spenderCoreDays;
      return base * sourFactor;
    }
    case "mass_active": {
      if (input.freeloader) {
        return WB3_DEFAULTS.freeloaderDays;
      }
      const replyAgeDays =
        input.lastFanMessageAt == null
          ? Infinity
          : (input.now.getTime() - input.lastFanMessageAt.getTime()) / DAY_MS;
      const base =
        replyAgeDays <= 14 ? WB3_DEFAULTS.massWarmDays : WB3_DEFAULTS.massCoolingDays;
      return base * sourFactor;
    }
    case "fresh":
    case "gray":
    case "dead":
    case "archived":
      return null;
  }
}

/**
 * Next due timestamp. Interval segments: last qualifying touch + interval (due
 * "now" when never touched). Spender dust counts broadcasts as touches; fresh
 * follows the 0/+1/+3 schedule with the day-0 welcome closable by a broadcast.
 */
export function wb3CadenceDueAt(input: Wb3CadenceInput): Date | null {
  if (input.segment === "fresh") {
    return freshDueAt(input);
  }
  const intervalDays = wb3CadenceIntervalDays(input);
  if (intervalDays == null) {
    return null;
  }

  let base = input.lastPersonalTouchAt;
  if (input.segment === "spender" && wb3SpenderTier(input) === "dust") {
    // Dust is served by broadcasts (PRD §4): they move its cadence.
    if (
      input.lastBroadcastTouchAt != null &&
      (base == null || input.lastBroadcastTouchAt > base)
    ) {
      base = input.lastBroadcastTouchAt;
    }
  }
  if (base == null) {
    return input.now;
  }
  return new Date(base.getTime() + intervalDays * DAY_MS);
}

function freshDueAt(input: Wb3CadenceInput): Date | null {
  const followed = input.followerSince;
  if (followed == null) {
    return null; // no follower data (lora-vip/lora-free) — nothing to schedule
  }
  const points = WB3_DEFAULTS.freshScheduleDays.map(
    (d) => new Date(followed.getTime() + d * DAY_MS),
  );
  const personal =
    input.lastPersonalTouchAt != null && input.lastPersonalTouchAt >= points[0]!
      ? input.lastPersonalTouchAt
      : null;
  const day0ClosedByBroadcast =
    input.lastBroadcastTouchAt != null && input.lastBroadcastTouchAt >= points[0]!;

  if (personal == null && !day0ClosedByBroadcast) {
    return points[0]!; // day-0 welcome still owed (never displaced from the plan)
  }
  // A broadcast closes only day 0; later points need a personal touch.
  const marker = personal ?? points[0]!;
  for (const point of points.slice(1)) {
    if (point > marker) {
      return point;
    }
  }
  return null; // warm-up schedule exhausted; day-13 last call is a reason, not cadence
}
