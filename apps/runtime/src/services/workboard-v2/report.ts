import type {
  WorkboardV2ContactBody,
  WorkboardV2Item,
  WorkboardV2Query,
  WorkboardV2Response,
} from "@agency_hub_core/contracts";
import {
  type WorkboardV2Row,
  appendWorkboardContact,
  countClosingCache,
  countOldMassContactsToday,
  deleteLastWorkboardContact,
  getClosingSettings,
  getLlmUsageDaily,
  getWorkboardV2Counts,
  listWorkboardV2,
  snoozeWorkboardFanV2,
  unsnoozeWorkboardFan,
} from "@agency_hub_core/db";
import { UTC_TIME_ZONE, millsToNumber, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AuthPrincipal } from "../auth.ts";
import { resolveAccessibleFanslyPage } from "../fansly-page.ts";
import { resolveClosingSettings } from "./ai-settings.ts";
import { isClosingMessage } from "./closing.ts";
import { recomputeWorkboardFan, recomputeWorkboardPage } from "./recompute.ts";

const PRESENCE_ONLINE_MINUTES = 6;

type ClosingLayer = "l1" | "l2" | "fresh" | "unverified" | "model_last" | "unknown";
type ClosingVerdict =
  | { layer: ClosingLayer; needsReply: boolean; state: string | null; reason: string | null }
  | null;

/** The closing-detector verdict on the tail message, for the transparency panel. */
function closingVerdict(row: WorkboardV2Row): ClosingVerdict {
  const role = row.last_message_sender_role;
  if (!role) {
    return null; // no conversation yet → nothing to show
  }
  if (role === "model") {
    return { layer: "model_last", needsReply: false, state: null, reason: null }; // we replied last — fan's turn
  }
  if (role !== "fan") {
    return { layer: "unknown", needsReply: false, state: null, reason: null }; // system / unresolved role
  }
  if (isClosingMessage(row.last_message_preview)) {
    return { layer: "l1", needsReply: false, state: "closing", reason: null };
  }
  const ageHours = row.last_fan_message_at
    ? (Date.now() - new Date(row.last_fan_message_at).getTime()) / 3_600_000
    : null;
  if (ageHours == null || ageHours < 24) {
    return { layer: "fresh", needsReply: true, state: null, reason: null };
  }
  if (row.l2_needs_reply != null) {
    return { layer: "l2", needsReply: row.l2_needs_reply, state: row.l2_state, reason: row.l2_reason };
  }
  return { layer: "unverified", needsReply: true, state: null, reason: null };
}

const FEATURE_LABEL = "Workboard v2";

function serializeTimestamp(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString();
}

function mapItem(row: WorkboardV2Row): WorkboardV2Item {
  return {
    fanId: Number(row.fan_id),
    fan: {
      platformUserId: row.platform_user_id,
      pageAlias: row.page_alias,
      username: row.username,
      displayName: row.display_name,
    },
    tab: row.tab,
    massSubstate: row.mass_substate,
    value: {
      score: Number(row.value_score),
      tier: row.value_tier,
      confidence: row.value_confidence,
    },
    urgency: {
      score: Number(row.urgency_score),
      severity: row.urgency_severity,
    },
    rankScore: Number(row.rank_score),
    secondaryStatus: row.secondary_status,
    needsReply: row.needs_reply,
    needsHumanTriage: row.needs_human_triage,
    isPurchaseFollowup: row.is_purchase_followup,
    whyNow: {
      code: row.why_now_code,
      value: row.why_now_value == null ? null : Number(row.why_now_value),
    },
    reasonChips: row.reason_chips ?? [],
    quality: {
      qScore: row.q_score == null ? null : Number(row.q_score),
      qConfidence: row.q_confidence,
    },
    closingVerdict: closingVerdict(row),
    online: row.external_presence_at != null
      && Date.now() - new Date(row.external_presence_at).getTime() <= PRESENCE_ONLINE_MINUTES * 60_000,
    ltv: { creatorNetAmountMills: millsToNumber(row.ltv_mills) },
    subscription: {
      expiresAt: serializeTimestamp(row.subscription_expires_at),
      autoRenew: row.auto_renew,
    },
    conversation: {
      lastFanMessageAt: serializeTimestamp(row.last_fan_message_at),
      lastModelMessageAt: serializeTimestamp(row.last_model_message_at),
      preview: row.last_message_preview,
      coverageStatus: row.message_coverage_status,
    },
    serviceReason: row.service_reason,
  } as WorkboardV2Item;
}

export async function getWorkboardV2Report(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  query: WorkboardV2Query,
): Promise<WorkboardV2Response> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);

  const [{ total, rows }, counts] = await Promise.all([
    listWorkboardV2(app.db, {
      platformAccountId: page.id,
      tab: query.tab,
      statuses: query.status,
      limit: query.limit,
      offset: query.offset,
    }),
    getWorkboardV2Counts(app.db, page.id),
  ]);

  const [oldMassBudget, aiCoverage] = await Promise.all([
    query.tab === "old_mass" ? computeOldMassBudget(app, page.id, counts) : Promise.resolve(null),
    computeAiCoverage(app, page.id),
  ]);

  return {
    tab: query.tab,
    total,
    limit: query.limit,
    offset: query.offset,
    items: rows.map(mapItem),
    counts: counts.map((c) => ({
      tab: c.tab,
      secondaryStatus: c.secondary_status,
      count: c.count,
    })),
    oldMassBudget,
    aiCoverage,
  } as WorkboardV2Response;
}

const CLOSING_FEATURE = "closing-classifier";

async function computeAiCoverage(app: AppContext, platformAccountId: number) {
  const businessDate = toBusinessDate(new Date(), UTC_TIME_ZONE);
  const [cache, usage, override] = await Promise.all([
    countClosingCache(app.db, platformAccountId),
    getLlmUsageDaily(app.db, platformAccountId, businessDate, CLOSING_FEATURE),
    getClosingSettings(app.db, platformAccountId),
  ]);
  // Effective (per-page override over env), so the badge matches the AI panel.
  const enabled = resolveClosingSettings(
    app.config,
    override ? { enabled: override.enabled, dailyCapMax: override.daily_cap_max, model: override.model } : null,
  ).enabled;
  return {
    enabled,
    classified: cache.total,
    closingsFound: cache.closings,
    callsToday: usage.calls,
  };
}

const PAGE_DAILY_CAPACITY = 150;
const OLD_MASS_FLOOR = 15;
const HIGHER_TABS = new Set(["subscribers", "spenders", "fresh_mass"]);
const ACTIONABLE_STATUSES = new Set(["recent_purchase", "need_reply", "due_now"]);

async function computeOldMassBudget(
  app: AppContext,
  platformAccountId: number,
  counts: Array<{ tab: string; secondary_status: string; count: number }>,
): Promise<{ used: number; total: number; resetsAt: string }> {
  // Residual budget: a fixed page capacity minus committed higher-tab work (decoupled
  // from same-day volume so quiet days don't starve the long tail), with a floor.
  const higherActionable = counts
    .filter((c) => HIGHER_TABS.has(c.tab) && ACTIONABLE_STATUSES.has(c.secondary_status))
    .reduce((sum, c) => sum + c.count, 0);
  const total = Math.max(OLD_MASS_FLOOR, PAGE_DAILY_CAPACITY - higherActionable);

  const now = new Date();
  const businessDate = toBusinessDate(now, UTC_TIME_ZONE);
  const used = await countOldMassContactsToday(app.db, platformAccountId, businessDate);
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

  return { used, total, resetsAt };
}

export async function recordWorkboardContactV2(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: WorkboardV2ContactBody,
): Promise<{ ok: true; fanId: number }> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);

  await appendWorkboardContact(app.db, {
    modelId: page.modelId,
    platformAccountId: page.id,
    fanId: body.fanId,
    businessDate: toBusinessDate(new Date(), UTC_TIME_ZONE),
    action: body.action,
    wasProductive: body.wasProductive,
  });
  // Re-evaluate just this fan so the row leaves the active queue immediately.
  await recomputeWorkboardFan(app.db, { platformAccountId: page.id, fanId: body.fanId });

  return { ok: true, fanId: body.fanId };
}

export async function snoozeWorkboardV2(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: { fanId: number; days: number },
): Promise<{ ok: true; fanId: number; snoozedUntil: string | null }> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  const result = await snoozeWorkboardFanV2(app.db, { platformAccountId: page.id, fanId: body.fanId, days: body.days });
  await recomputeWorkboardFan(app.db, { platformAccountId: page.id, fanId: body.fanId });
  return { ok: true, fanId: body.fanId, snoozedUntil: result ? result.snoozedUntil.toISOString() : null };
}

export async function unsnoozeWorkboardV2(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  fanId: number,
): Promise<{ ok: true; fanId: number }> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  await unsnoozeWorkboardFan(app.db, { platformAccountId: page.id, fanId });
  await recomputeWorkboardFan(app.db, { platformAccountId: page.id, fanId });
  return { ok: true, fanId };
}

export async function undoWorkboardContactV2(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  fanId: number,
): Promise<{ ok: true; fanId: number }> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  await deleteLastWorkboardContact(app.db, page.id, fanId);
  await recomputeWorkboardFan(app.db, { platformAccountId: page.id, fanId });
  return { ok: true, fanId };
}

export async function triggerWorkboardV2Recompute(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<{ ok: true; evaluated: number }> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  const result = await recomputeWorkboardPage(app.db, { platformAccountId: page.id });
  return { ok: true, evaluated: result.evaluated };
}
