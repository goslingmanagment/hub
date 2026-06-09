import {
  type Database,
  type Wb3BoardFanRow,
  type Wb3DialogVerdict,
  type Wb3Dossier,
  getWb3DataAsOf,
  getWb3WhaleThresholdMills,
  listWb3FanTouches,
  loadWb3BoardRows,
  loadWb3GrayBatchRows,
  loadWb3ServiceCounts,
  loadWb3ServiceRows,
} from "@agency_hub_core/db";

import { WB3_DEFAULTS, wb3CadenceIntervalDays, wb3SpenderTier, type Wb3Segment } from "./cadence.ts";

// Read-only board (Phase 1, PRD §7/§8). Volatile reasons (◆ from transactions,
// ● from thread tails + Dialog Read verdicts) are computed here at read time;
// everything else comes from the nightly workboard_v3_fan_state. The plan is a
// preview: no shift, no actions — those are Phase 2.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type Wb3ReasonId =
  | "purchase_followup"
  | "needs_reply"
  | "buy_signal"
  | "renew_off_expiring"
  | "renew_off"
  | "expiry_ladder"
  | "cadence_overdue"
  | "fresh_last_call"
  | "dead_revival"
  | "cadence_due"
  | "fresh_touch"
  | "gray_touch";

export type Wb3Section = "purchase" | "needs_reply" | "risk" | "scheduled";
export type Wb3Tab = "subs" | "spenders" | "fresh" | "mass" | "service";
export type Wb3SuppressionCause =
  | "snooze"
  | "do_not_touch"
  | "cross_page"
  | "dead"
  | "archived"
  | "capacity";

// Strict order (PRD §3): the highest reason owns the row. renew_off_expiring is
// the highest ⚠ in the system; buy_signal tops every other tab's ⚠ block.
const REASON_PRIORITY: Record<Wb3ReasonId, number> = {
  purchase_followup: 0,
  needs_reply: 1,
  renew_off_expiring: 2,
  buy_signal: 3,
  renew_off: 4,
  expiry_ladder: 5,
  cadence_overdue: 6,
  fresh_last_call: 7,
  dead_revival: 8,
  cadence_due: 9,
  fresh_touch: 10,
  gray_touch: 11,
};

const REASON_SECTION: Record<Wb3ReasonId, Wb3Section> = {
  purchase_followup: "purchase",
  needs_reply: "needs_reply",
  renew_off_expiring: "risk",
  buy_signal: "risk",
  renew_off: "risk",
  expiry_ladder: "risk",
  cadence_overdue: "risk",
  fresh_last_call: "risk",
  dead_revival: "risk",
  cadence_due: "scheduled",
  fresh_touch: "scheduled",
  gray_touch: "scheduled",
};

export interface Wb3Chip {
  key: string;
  label: string;
  tone: "neutral" | "accent" | "warning" | "danger" | "success";
  /** Dialog-signal chips go dashed when message coverage is incomplete (PRD §6). */
  dashed: boolean;
}

export interface Wb3Reason {
  id: Wb3ReasonId;
  section: Wb3Section;
  phrase: string;
  /** Sort urgency in ms — bigger = more urgent/longer waiting. */
  urgencyMs: number;
  suppressedBy: Wb3SuppressionCause | null;
}

export interface Wb3BoardRow {
  fanId: number;
  name: string;
  alias: string | null;
  segment: string;
  ltvMills: number;
  reason: { id: Wb3ReasonId; section: Wb3Section; phrase: string };
  chips: Wb3Chip[];
  gist: string | null;
  gistSource: "dialog_read" | "dossier" | "preview" | null;
  confidence: "complete" | "partial";
  waitingHours: number | null;
}

interface NormalizedFan {
  fanId: number;
  name: string;
  alias: string | null;
  ltvMills: number;
  segment: Wb3Segment;
  tab: Wb3Tab;
  hasEverReplied: boolean;
  freeloader: boolean;
  doNotTouch: boolean;
  doNotTouchReason: string | null;
  deadSleepUntil: Date | null;
  archived: boolean;
  followerSince: Date | null;
  autoRenew: boolean | null;
  subEndsAt: Date | null;
  subTierName: string | null;
  lastPersonalTouchAt: Date | null;
  lastAnyTouchAt: Date | null;
  lastTouchActivityAt: Date | null;
  cadenceDueAt: Date | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  lastSenderRole: string | null;
  lastMessagePreview: string | null;
  worstCoverage: string | null;
  recentPurchaseAt: Date | null;
  recentPurchaseType: string | null;
  recentPurchaseNetMills: number;
  lastPurchaseAt: Date | null;
  verdict: Wb3DialogVerdict | null;
  verdictCreatedAt: Date | null;
  dossier: Wb3Dossier | null;
  snoozedUntil: Date | null;
  snoozeReason: string | null;
  flags: string[];
  crossPageTouched: boolean;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function toNum(value: bigint | number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function tabOf(segment: Wb3Segment): Wb3Tab {
  switch (segment) {
    case "subscriber":
      return "subs";
    case "spender":
      return "spenders";
    case "fresh":
      return "fresh";
    default:
      return "mass";
  }
}

export function normalizeWb3BoardRow(row: Wb3BoardFanRow): NormalizedFan {
  const segment = row.segment as Wb3Segment;
  return {
    fanId: toNum(row.fan_id),
    name: row.display_name || row.username || `fan ${toNum(row.fan_id)}`,
    alias: row.page_alias,
    ltvMills: toNum(row.ltv_mills),
    segment,
    tab: tabOf(segment),
    hasEverReplied: row.has_ever_replied,
    freeloader: row.freeloader,
    doNotTouch: row.do_not_touch,
    doNotTouchReason: row.do_not_touch_reason,
    deadSleepUntil: toDate(row.dead_sleep_until),
    archived: segment === "archived",
    followerSince: toDate(row.follower_since),
    autoRenew: row.sub_auto_renew ?? row.pf_auto_renew,
    subEndsAt: toDate(row.sub_ends_at) ?? toDate(row.subscription_expires_at),
    subTierName: row.sub_tier_name,
    lastPersonalTouchAt: toDate(row.last_personal_touch_at),
    lastAnyTouchAt: toDate(row.last_any_touch_at),
    lastTouchActivityAt: toDate(row.last_touch_activity_at),
    cadenceDueAt: toDate(row.cadence_due_at),
    lastFanMessageAt: toDate(row.last_fan_message_at),
    lastModelMessageAt: toDate(row.last_model_message_at),
    lastSenderRole: row.last_sender_role,
    lastMessagePreview: row.last_message_preview,
    worstCoverage: row.worst_coverage,
    recentPurchaseAt: toDate(row.recent_purchase_at),
    recentPurchaseType: row.recent_purchase_type,
    recentPurchaseNetMills: toNum(row.recent_purchase_net_mills),
    lastPurchaseAt: toDate(row.last_purchase_at) ?? toDate(row.page_last_transaction_at),
    verdict: row.verdict,
    verdictCreatedAt: toDate(row.verdict_created_at),
    dossier: row.dossier,
    snoozedUntil: toDate(row.snoozed_until),
    snoozeReason: row.snooze_reason,
    flags: row.flags ?? [],
    crossPageTouched: row.cross_page_touched,
  };
}

function formatAge(ms: number): string {
  if (ms < HOUR_MS) {
    return "<1ч";
  }
  if (ms < 48 * HOUR_MS) {
    return `${Math.floor(ms / HOUR_MS)}ч`;
  }
  return `${Math.floor(ms / DAY_MS)}д`;
}

function formatUsd(mills: number): string {
  return `$${Math.round(mills / 1000)}`;
}

function purchasePhrase(type: string | null, mills: number, ageMs: number): string {
  const what =
    type === "subscription"
      ? "оформил подписку"
      : type === "tip" || type === "stream_tip"
        ? "оставил чаевые"
        : "купил PPV";
  const when = ageMs < 24 * HOUR_MS ? "сегодня" : "вчера";
  return `${what} ${when} (${formatUsd(mills)})`;
}

function silencePhrase(lastPersonalTouchAt: Date | null, now: Date): string {
  if (lastPersonalTouchAt == null) {
    return "ни одного касания";
  }
  return `${formatAge(now.getTime() - lastPersonalTouchAt.getTime())} тишины`;
}

/** Verdict counts for the CURRENT tail only when it saw the latest fan message. */
function verdictIsFresh(fan: NormalizedFan): boolean {
  return (
    fan.verdict != null &&
    fan.verdictCreatedAt != null &&
    (fan.lastFanMessageAt == null || fan.verdictCreatedAt >= fan.lastFanMessageAt)
  );
}

/**
 * All candidate reasons for one fan (PRD §3), unsuppressed — suppression is
 * annotated separately so diagnostics can show "why is this fan not in the queue".
 */
export function computeWb3FanReasons(fan: NormalizedFan, now: Date): Wb3Reason[] {
  const reasons: Wb3Reason[] = [];
  const push = (id: Wb3ReasonId, phrase: string, urgencyMs: number) => {
    reasons.push({ id, section: REASON_SECTION[id], phrase, urgencyMs, suppressedBy: null });
  };

  // ◆ settled purchase ≤48h with no model message and no touch after it.
  if (fan.recentPurchaseAt != null) {
    const noModelMessageAfter =
      fan.lastModelMessageAt == null || fan.lastModelMessageAt <= fan.recentPurchaseAt;
    const noTouchAfter =
      fan.lastTouchActivityAt == null || fan.lastTouchActivityAt <= fan.recentPurchaseAt;
    if (noModelMessageAfter && noTouchAfter) {
      const age = now.getTime() - fan.recentPurchaseAt.getTime();
      push("purchase_followup", purchasePhrase(fan.recentPurchaseType, fan.recentPurchaseNetMills, age), age);
    }
  }

  // ● fan wrote last; verdict can clear it, absence of a verdict fails open.
  if (fan.lastSenderRole === "fan") {
    const cutByVerdict = verdictIsFresh(fan) && fan.verdict!.needs_reply === false;
    if (!cutByVerdict) {
      const since = fan.lastFanMessageAt ?? fan.lastAnyTouchAt ?? now;
      const age = Math.max(0, now.getTime() - since.getTime());
      push("needs_reply", `ждёт ответа ${formatAge(age)}`, age);
    }
  }

  // ⚠ buy signal from the Dialog Read: TTL 72h, killed by a later purchase/touch.
  if (
    verdictIsFresh(fan) &&
    fan.verdict!.intent === "buy_signal" &&
    fan.verdictCreatedAt != null &&
    now.getTime() - fan.verdictCreatedAt.getTime() <= WB3_DEFAULTS.buySignalTtlHours * HOUR_MS &&
    (fan.lastPurchaseAt == null || fan.lastPurchaseAt <= fan.verdictCreatedAt) &&
    (fan.lastTouchActivityAt == null || fan.lastTouchActivityAt <= fan.verdictCreatedAt)
  ) {
    const age = now.getTime() - fan.verdictCreatedAt.getTime();
    push("buy_signal", `сигнал к покупке · ${formatAge(age)}`, age);
  }

  // Subs risks. With auto_renew=true expiry is not a risk — it renews by itself.
  if (fan.segment === "subscriber" && fan.subEndsAt != null) {
    const daysLeft = (fan.subEndsAt.getTime() - now.getTime()) / DAY_MS;
    const urgency = now.getTime() - fan.subEndsAt.getTime(); // closer expiry = more urgent
    if (fan.autoRenew === false) {
      if (daysLeft <= 7) {
        push(
          "renew_off_expiring",
          `renew OFF · истекает через ${Math.max(0, Math.ceil(daysLeft))}д`,
          urgency,
        );
      } else {
        push("renew_off", "renew OFF", urgency);
      }
    }
    if (fan.autoRenew !== true && daysLeft >= 0 && daysLeft <= 10) {
      push("expiry_ladder", `истекает через ${Math.max(0, Math.ceil(daysLeft))}д`, urgency);
    }
  }

  // Cadence: due (○) and overdue ≥1.5× (⚠) for interval segments.
  if (
    (fan.segment === "subscriber" || fan.segment === "spender" || fan.segment === "mass_active") &&
    fan.cadenceDueAt != null &&
    fan.cadenceDueAt <= now
  ) {
    const intervalDays = wb3CadenceIntervalDays({
      segment: fan.segment,
      now,
      autoRenew: fan.autoRenew,
      ltvMills: fan.ltvMills,
      lastPurchaseAt: fan.lastPurchaseAt,
      lastFanMessageAt: fan.lastFanMessageAt,
      freeloader: fan.freeloader,
      dossierEnding: fan.dossier?.ending ?? null,
      followerSince: fan.followerSince,
      lastPersonalTouchAt: fan.lastPersonalTouchAt,
      lastBroadcastTouchAt: null,
    });
    const overdueMs = now.getTime() - fan.cadenceDueAt.getTime();
    const silence = silencePhrase(fan.lastPersonalTouchAt, now);
    if (
      intervalDays != null &&
      fan.lastPersonalTouchAt != null &&
      overdueMs >= 0.5 * intervalDays * DAY_MS
    ) {
      push("cadence_overdue", `просрочено · ${silence}`, overdueMs);
    } else {
      push("cadence_due", `касание по графику · ${silence}`, overdueMs);
    }
  }

  // Fresh warm-up schedule + day-12–14 last call.
  if (fan.segment === "fresh" && fan.followerSince != null) {
    const followDays = (now.getTime() - fan.followerSince.getTime()) / DAY_MS;
    if (
      followDays >= WB3_DEFAULTS.freshLastCallFromDay &&
      followDays <= WB3_DEFAULTS.freshLastCallToDay &&
      !fan.hasEverReplied
    ) {
      push(
        "fresh_last_call",
        `последний шанс: ${Math.floor(followDays) + 1}-й день без ответа`,
        now.getTime() - fan.followerSince.getTime(),
      );
    } else if (fan.cadenceDueAt != null && fan.cadenceDueAt <= now) {
      const dayOffset = Math.round(
        (fan.cadenceDueAt.getTime() - fan.followerSince.getTime()) / DAY_MS,
      );
      const label = dayOffset <= 0 ? "приветствие: день 0" : `прогрев: день ${dayOffset}`;
      push("fresh_touch", label, now.getTime() - fan.cadenceDueAt.getTime());
    }
  }

  // Dead revival candidate (the per-day cap is applied at assembly).
  if (fan.segment === "dead" && fan.deadSleepUntil != null && fan.deadSleepUntil <= now) {
    push(
      "dead_revival",
      `реанимация после ${WB3_DEFAULTS.deadSleepDays}д сна`,
      now.getTime() - fan.deadSleepUntil.getTime(),
    );
  }

  // Gray rotation reason is attached at assembly (batch membership, not state).

  reasons.sort((a, b) => REASON_PRIORITY[a.id] - REASON_PRIORITY[b.id]);
  return reasons;
}

/** Annotates suppression per PRD §3: snooze/DNT/archive kill all; cross-page spares ◆●. */
export function applyWb3Suppression(fan: NormalizedFan, reasons: Wb3Reason[], now: Date): Wb3Reason[] {
  return reasons.map((reason) => {
    let suppressedBy: Wb3SuppressionCause | null = null;
    if (fan.archived) {
      suppressedBy = "archived";
    } else if (fan.segment === "dead" && reason.id !== "dead_revival") {
      suppressedBy = "dead";
    } else if (fan.doNotTouch) {
      suppressedBy = "do_not_touch";
    } else if (fan.snoozedUntil != null && fan.snoozedUntil > now) {
      suppressedBy = "snooze";
    } else if (
      fan.crossPageTouched &&
      reason.section !== "purchase" &&
      reason.section !== "needs_reply"
    ) {
      suppressedBy = "cross_page";
    }
    return { ...reason, suppressedBy };
  });
}

export function buildWb3Chips(fan: NormalizedFan, whaleThresholdMills: number | null): Wb3Chip[] {
  const chips: Wb3Chip[] = [];
  const dashed = fan.worstCoverage != null && fan.worstCoverage !== "complete";
  if (whaleThresholdMills != null && fan.ltvMills >= whaleThresholdMills && fan.ltvMills > 0) {
    chips.push({ key: "whale", label: "Кит", tone: "accent", dashed: false });
  }
  if (fan.flags.includes("vip")) {
    chips.push({ key: "vip", label: "VIP", tone: "accent", dashed: false });
  }
  if (fan.flags.includes("risky")) {
    chips.push({ key: "risky", label: "Риск", tone: "danger", dashed: false });
  }
  if (fan.freeloader) {
    chips.push({ key: "freeloader", label: "Болтун", tone: "warning", dashed: false });
  }
  const temperature = fan.verdict?.temperature;
  if (temperature === "hot" || temperature === "warm") {
    chips.push({ key: "warm", label: "Тёплый", tone: "success", dashed });
  } else if (temperature === "cool" || temperature === "cold") {
    chips.push({ key: "cold", label: "Холодный", tone: "neutral", dashed });
  } else if (
    fan.segment === "mass_active" &&
    fan.lastFanMessageAt != null &&
    Date.now() - fan.lastFanMessageAt.getTime() < 7 * DAY_MS
  ) {
    // §6 fallback heuristic when no verdict exists: fan reply < 7d = warm.
    chips.push({ key: "warm", label: "Тёплый", tone: "success", dashed: true });
  }
  if (fan.verdict?.readiness === "ready" && verdictIsFresh(fan)) {
    chips.push({ key: "ready", label: "Готов купить", tone: "accent", dashed });
  }
  if (fan.verdict?.intent === "complaint" && verdictIsFresh(fan)) {
    chips.push({ key: "complaint", label: "Жалоба", tone: "danger", dashed });
  }
  if (fan.segment === "fresh") {
    chips.push({ key: "new", label: "Новый", tone: "accent", dashed: false });
  }
  if (fan.segment === "subscriber" && fan.subTierName) {
    chips.push({ key: "tier", label: fan.subTierName, tone: "neutral", dashed: false });
  }
  return chips;
}

function buildGist(fan: NormalizedFan): { gist: string | null; source: Wb3BoardRow["gistSource"] } {
  if (verdictIsFresh(fan) && fan.verdict?.gist) {
    return { gist: fan.verdict.gist, source: "dialog_read" };
  }
  if (fan.dossier?.gist) {
    return { gist: fan.dossier.gist, source: "dossier" };
  }
  if (fan.lastMessagePreview) {
    return { gist: fan.lastMessagePreview, source: "preview" };
  }
  return { gist: null, source: null };
}

function toBoardRow(fan: NormalizedFan, reason: Wb3Reason, whaleThresholdMills: number | null): Wb3BoardRow {
  const { gist, source } = buildGist(fan);
  return {
    fanId: fan.fanId,
    name: fan.name,
    alias: fan.alias,
    segment: fan.segment,
    ltvMills: fan.ltvMills,
    reason: { id: reason.id, section: reason.section, phrase: reason.phrase },
    chips: buildWb3Chips(fan, whaleThresholdMills),
    gist,
    gistSource: source,
    confidence: fan.worstCoverage == null || fan.worstCoverage === "complete" ? "complete" : "partial",
    waitingHours: reason.urgencyMs > 0 ? Math.floor(reason.urgencyMs / HOUR_MS) : null,
  };
}

export interface Wb3BoardSection {
  section: Wb3Section;
  rows: Wb3BoardRow[];
}

export interface Wb3BoardTab {
  key: Exclude<Wb3Tab, "service">;
  title: string;
  planned: number;
  live: number;
  proactive: number;
  debt: number;
  blocks: {
    live: Wb3BoardSection[];
    proactive: Wb3BoardSection[];
  };
}

export interface Wb3ServiceTab {
  counts: { snoozed: number; doNotTouch: number; dead: number; archived: number };
  rows: Array<{
    fanId: number;
    name: string;
    alias: string | null;
    kind: "snoozed" | "do_not_touch";
    until: string | null;
    reason: string | null;
  }>;
}

export interface Wb3BoardResponse {
  pageLabel: string;
  generatedAt: string;
  dataAsOf: string | null;
  capacity: number;
  needsReplyTotal: number;
  tabs: Wb3BoardTab[];
  service: Wb3ServiceTab;
}

const TAB_TITLES: Record<Wb3Tab, string> = {
  subs: "Сабы",
  spenders: "Спендеры",
  fresh: "Свежак",
  mass: "Масса",
  service: "Сервис",
};

type Planned = { fan: NormalizedFan; reason: Wb3Reason };

// Scheduled fill order (PRD §5/§11): fresh day-0 → subs → hot spenders → core →
// fresh warm-up → warm mass → cooling mass → dust → gray rotation.
function scheduledFillRank(item: Planned, now: Date): number {
  const { fan, reason } = item;
  if (reason.id === "fresh_touch") {
    return reason.phrase.includes("день 0") ? 0 : 4;
  }
  if (fan.segment === "subscriber") {
    return 1;
  }
  if (fan.segment === "spender") {
    const tier = wb3SpenderTier({ ltvMills: fan.ltvMills, lastPurchaseAt: fan.lastPurchaseAt, now });
    return tier === "hot" ? 2 : tier === "core" ? 3 : 7;
  }
  if (fan.segment === "mass_active") {
    const replyAgeDays =
      fan.lastFanMessageAt == null
        ? Infinity
        : (now.getTime() - fan.lastFanMessageAt.getTime()) / DAY_MS;
    return replyAgeDays <= 14 ? 5 : 6;
  }
  return 8; // gray rotation
}

function sectionSort(tab: Wb3Tab) {
  return (a: Planned, b: Planned): number => {
    const priority = REASON_PRIORITY[a.reason.id] - REASON_PRIORITY[b.reason.id];
    if (priority !== 0) {
      return priority;
    }
    if (tab !== "mass") {
      if (b.fan.ltvMills !== a.fan.ltvMills) {
        return b.fan.ltvMills - a.fan.ltvMills;
      }
    }
    return b.reason.urgencyMs - a.reason.urgencyMs;
  };
}

export async function getWb3Board(
  db: Database,
  input: { platformAccountId: number; pageLabel: string; now?: Date },
): Promise<Wb3BoardResponse> {
  const now = input.now ?? new Date();
  const { platformAccountId } = input;

  const [rows, grayRows, serviceCounts, serviceRows, whaleThreshold, dataAsOf] = await Promise.all([
    loadWb3BoardRows(db, { platformAccountId, now }),
    loadWb3GrayBatchRows(db, { platformAccountId, now, limit: WB3_DEFAULTS.grayBatchSize + 20 }),
    loadWb3ServiceCounts(db, { platformAccountId, now }),
    loadWb3ServiceRows(db, { platformAccountId, now }),
    getWb3WhaleThresholdMills(db, platformAccountId),
    getWb3DataAsOf(db, platformAccountId),
  ]);

  const fans = rows.map(normalizeWb3BoardRow);
  const seen = new Set(fans.map((f) => f.fanId));

  // Pick each fan's top active reason.
  const planned: Planned[] = [];
  let revivalsUsed = 0;
  const deadRevivalCandidates: Array<{ fan: NormalizedFan; reason: Wb3Reason }> = [];

  for (const fan of fans) {
    const reasons = applyWb3Suppression(fan, computeWb3FanReasons(fan, now), now);
    const active = reasons.filter((r) => r.suppressedBy == null);
    if (active.length === 0) {
      continue;
    }
    const top = active[0]!;
    if (top.id === "dead_revival") {
      deadRevivalCandidates.push({ fan, reason: top });
      continue;
    }
    planned.push({ fan, reason: top });
  }

  // Dead revivals: LRU first, cap 5/day (PRD §3).
  deadRevivalCandidates.sort(
    (a, b) =>
      (a.fan.lastAnyTouchAt?.getTime() ?? 0) - (b.fan.lastAnyTouchAt?.getTime() ?? 0),
  );
  for (const candidate of deadRevivalCandidates) {
    if (revivalsUsed >= WB3_DEFAULTS.deadRevivalDailyCap) {
      break;
    }
    planned.push(candidate);
    revivalsUsed += 1;
  }

  // Gray rotation batch: has_ever_replied first then LRU (query order), cap 30.
  let grayUsed = 0;
  for (const row of grayRows) {
    if (grayUsed >= WB3_DEFAULTS.grayBatchSize) {
      break;
    }
    const fan = normalizeWb3BoardRow(row);
    if (seen.has(fan.fanId)) {
      continue; // already carries a live reason from the main load
    }
    const reasons = applyWb3Suppression(
      fan,
      [
        {
          id: "gray_touch",
          section: "scheduled",
          phrase:
            fan.lastAnyTouchAt == null
              ? "ротация серых · ни одного касания"
              : `ротация серых · ${formatAge(now.getTime() - fan.lastAnyTouchAt.getTime())} без касания`,
          urgencyMs:
            fan.lastAnyTouchAt == null
              ? Number.MAX_SAFE_INTEGER
              : now.getTime() - fan.lastAnyTouchAt.getTime(),
          suppressedBy: null,
        },
      ],
      now,
    );
    if (reasons[0]!.suppressedBy != null) {
      continue;
    }
    planned.push({ fan, reason: reasons[0]! });
    grayUsed += 1;
  }

  // Capacity (PRD §5/§11): ◆●⚠ are mandatory; ○ fills the rest top-down;
  // fresh day-0 is never displaced. Overflow is visible debt, not silence.
  const mandatory = planned.filter((p) => p.reason.section !== "scheduled");
  const scheduled = planned
    .filter((p) => p.reason.section === "scheduled")
    .sort((a, b) => {
      const rank = scheduledFillRank(a, now) - scheduledFillRank(b, now);
      if (rank !== 0) {
        return rank;
      }
      if (b.fan.ltvMills !== a.fan.ltvMills) {
        return b.fan.ltvMills - a.fan.ltvMills;
      }
      return b.reason.urgencyMs - a.reason.urgencyMs;
    });

  let budget = WB3_DEFAULTS.pageDailyCapacity - mandatory.length;
  const included: Planned[] = [...mandatory];
  const debtByTab = new Map<Wb3Tab, number>();
  for (const item of scheduled) {
    const isFreshDay0 = item.reason.id === "fresh_touch" && item.reason.phrase.includes("день 0");
    if (isFreshDay0 || budget > 0) {
      included.push(item);
      budget -= 1;
      continue;
    }
    if (item.fan.segment !== "gray") {
      debtByTab.set(item.fan.tab, (debtByTab.get(item.fan.tab) ?? 0) + 1);
    }
  }

  // Assemble tabs.
  const tabs: Wb3BoardTab[] = (["subs", "spenders", "fresh", "mass"] as const).map((key) => {
    const items = included.filter((p) => p.fan.tab === key);
    const sorter = sectionSort(key);
    const bySection = (section: Wb3Section) =>
      items
        .filter((p) => p.reason.section === section)
        .sort(sorter)
        .map((p) => toBoardRow(p.fan, p.reason, whaleThreshold));
    const live: Wb3BoardSection[] = [
      { section: "purchase", rows: bySection("purchase") },
      { section: "needs_reply", rows: bySection("needs_reply") },
    ];
    const proactive: Wb3BoardSection[] = [
      { section: "risk", rows: bySection("risk") },
      { section: "scheduled", rows: bySection("scheduled") },
    ];
    const liveCount = live.reduce((sum, s) => sum + s.rows.length, 0);
    const proactiveCount = proactive.reduce((sum, s) => sum + s.rows.length, 0);
    return {
      key,
      title: TAB_TITLES[key],
      planned: liveCount + proactiveCount,
      live: liveCount,
      proactive: proactiveCount,
      debt: debtByTab.get(key) ?? 0,
      blocks: { live, proactive },
    };
  });

  const needsReplyTotal = included.filter((p) => p.reason.id === "needs_reply").length;

  return {
    pageLabel: input.pageLabel,
    generatedAt: now.toISOString(),
    dataAsOf: dataAsOf?.toISOString() ?? null,
    capacity: WB3_DEFAULTS.pageDailyCapacity,
    needsReplyTotal,
    tabs,
    service: {
      counts: {
        snoozed: serviceCounts.snoozed,
        doNotTouch: serviceCounts.doNotTouch,
        dead: serviceCounts.dead,
        archived: serviceCounts.archived,
      },
      rows: serviceRows.map((row) => ({
        fanId: row.fanId,
        name: row.displayName || row.username || `fan ${row.fanId}`,
        alias: row.pageAlias,
        kind: row.kind,
        until: row.until?.toISOString() ?? null,
        reason: row.reason,
      })),
    },
  };
}

export interface Wb3FanDiagnosticsResponse {
  fanId: number;
  name: string;
  alias: string | null;
  segment: string;
  tab: Wb3Tab;
  ltvMills: number;
  hasEverReplied: boolean;
  freeloader: boolean;
  doNotTouch: boolean;
  doNotTouchReason: string | null;
  snoozedUntil: string | null;
  snoozeReason: string | null;
  cadenceDueAt: string | null;
  lastPersonalTouchAt: string | null;
  reasons: Array<{
    id: Wb3ReasonId;
    section: Wb3Section;
    phrase: string;
    suppressedBy: Wb3SuppressionCause | null;
  }>;
  chips: Wb3Chip[];
  dossier: Wb3Dossier | null;
  touches: Array<{
    id: number;
    type: string;
    openedAt: string | null;
    confirmedAt: string | null;
    outcomeRepliedAt: string | null;
    outcomePurchaseAt: string | null;
  }>;
}

/** "Why is this fan not in the queue" — the Service-tab diagnostics (PRD §7). */
export async function getWb3FanDiagnostics(
  db: Database,
  input: { platformAccountId: number; fanId: number; now?: Date },
): Promise<Wb3FanDiagnosticsResponse | null> {
  const now = input.now ?? new Date();
  const [rows, whaleThreshold, touches] = await Promise.all([
    loadWb3BoardRows(db, { platformAccountId: input.platformAccountId, now, fanId: input.fanId }),
    getWb3WhaleThresholdMills(db, input.platformAccountId),
    listWb3FanTouches(db, { platformAccountId: input.platformAccountId, fanId: input.fanId }),
  ]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const fan = normalizeWb3BoardRow(row);
  const reasons = applyWb3Suppression(fan, computeWb3FanReasons(fan, now), now);

  return {
    fanId: fan.fanId,
    name: fan.name,
    alias: fan.alias,
    segment: fan.segment,
    tab: tabOf(fan.segment),
    ltvMills: fan.ltvMills,
    hasEverReplied: fan.hasEverReplied,
    freeloader: fan.freeloader,
    doNotTouch: fan.doNotTouch,
    doNotTouchReason: fan.doNotTouchReason,
    snoozedUntil: fan.snoozedUntil?.toISOString() ?? null,
    snoozeReason: fan.snoozeReason,
    cadenceDueAt: fan.cadenceDueAt?.toISOString() ?? null,
    lastPersonalTouchAt: fan.lastPersonalTouchAt?.toISOString() ?? null,
    reasons: reasons.map((r) => ({
      id: r.id,
      section: r.section,
      phrase: r.phrase,
      suppressedBy: r.suppressedBy,
    })),
    chips: buildWb3Chips(fan, whaleThreshold),
    dossier: fan.dossier,
    touches: touches.map((t) => ({
      id: t.id,
      type: t.type,
      openedAt: t.openedAt?.toISOString() ?? null,
      confirmedAt: t.confirmedAt?.toISOString() ?? null,
      outcomeRepliedAt: t.outcomeRepliedAt?.toISOString() ?? null,
      outcomePurchaseAt: t.outcomePurchaseAt?.toISOString() ?? null,
    })),
  };
}
