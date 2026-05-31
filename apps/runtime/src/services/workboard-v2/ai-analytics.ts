import type {
  WorkboardV2AiClassifyBody,
  WorkboardV2AiClassifyResponse,
  WorkboardV2AiReport,
  WorkboardV2AiRunsResponse,
  WorkboardV2AiSettingsBody,
} from "@agency_hub_core/contracts";
import {
  clearClosingCacheForPage,
  countClosingCache,
  countUnansweredTails,
  getClosingSettings,
  getClosingStateDistribution,
  getLlmUsageRange,
  insertClassifierRun,
  listClassifierRuns,
  listClosingClassificationCandidates,
  listRecentClosingVerdicts,
  upsertClosingSettings,
} from "@agency_hub_core/db";
import { UTC_TIME_ZONE, addUtcDays, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AuthPrincipal } from "../auth.ts";
import { BadRequestError } from "../errors.ts";
import { resolveAccessibleFanslyPage } from "../fansly-page.ts";
import { type ClosingSettingsOverride, estimateCostUsd, resolveClosingSettings } from "./ai-settings.ts";
import { CLOSING_CLASSIFIER_FEATURE, runClosingClassificationForPage } from "./classify-closing.ts";
import { isClosingMessage } from "./closing.ts";
import { createAnthropicClosingClassifier } from "./closing-classifier.ts";
import { recomputeWorkboardPage } from "./recompute.ts";

const FEATURE_LABEL = "Workboard v2 AI";
const USAGE_DAYS = 30;
const RECENT_LIMIT = 25;

function toOverride(
  row: { enabled: boolean | null; daily_cap_max: number | null; model: string | null } | null,
): ClosingSettingsOverride | null {
  return row ? { enabled: row.enabled, dailyCapMax: row.daily_cap_max, model: row.model } : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getWorkboardV2AiReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<WorkboardV2AiReport> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  const now = new Date();
  const today = toBusinessDate(now, UTC_TIME_ZONE);
  const fromDate = toBusinessDate(addUtcDays(now, -USAGE_DAYS), UTC_TIME_ZONE);

  const [override, usageRows, cache, tails, candidates, states, recent] = await Promise.all([
    getClosingSettings(app.db, page.id),
    getLlmUsageRange(app.db, page.id, CLOSING_CLASSIFIER_FEATURE, fromDate),
    countClosingCache(app.db, page.id),
    countUnansweredTails(app.db, page.id),
    listClosingClassificationCandidates(app.db, page.id),
    getClosingStateDistribution(app.db, page.id),
    listRecentClosingVerdicts(app.db, page.id, RECENT_LIMIT),
  ]);

  const eff = resolveClosingSettings(app.config, toOverride(override));

  const daily = usageRows.map((r) => ({
    date: r.business_date,
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: estimateCostUsd(eff.model, r.input_tokens, r.output_tokens),
  }));
  const zero = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const todayRow = daily.find((d) => d.date === today);
  const today_ = todayRow
    ? { calls: todayRow.calls, inputTokens: todayRow.inputTokens, outputTokens: todayRow.outputTokens, costUsd: todayRow.costUsd }
    : zero;
  const last30d = daily.reduce(
    (a, d) => ({
      calls: a.calls + d.calls,
      inputTokens: a.inputTokens + d.inputTokens,
      outputTokens: a.outputTokens + d.outputTokens,
      costUsd: a.costUsd + d.costUsd,
    }),
    zero,
  );

  // Pending = L1-undecided tails not yet in the cache (what a run would spend on next).
  const pending = candidates.filter((c) => !isClosingMessage(c.content)).length;

  return {
    settings: {
      enabled: eff.enabled,
      hasApiKey: eff.hasApiKey,
      model: eff.model,
      dailyCapMin: eff.capMin,
      dailyCapMax: eff.capMax,
      envEnabled: app.config.wbClosingLlmEnabled ?? false,
      source: eff.source,
      override: {
        enabled: override?.enabled ?? null,
        dailyCapMax: override?.daily_cap_max ?? null,
        model: override?.model ?? null,
      },
    },
    usage: { today: today_, last30d, daily },
    coverage: { tails, classified: cache.total, closings: cache.closings, pending },
    states: states.map((s) => ({ state: s.state, count: s.count })),
    recent: recent.map((r) => ({
      messageId: r.platform_message_id,
      tail: r.tail,
      state: r.state as WorkboardV2AiReport["recent"][number]["state"],
      needsReply: r.needs_reply,
      reason: r.reason,
      model: r.model,
      classifiedAt: iso(r.classified_at),
    })),
  } as WorkboardV2AiReport;
}

export async function updateWorkboardV2AiSettings(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: WorkboardV2AiSettingsBody,
): Promise<WorkboardV2AiReport> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  await upsertClosingSettings(app.db, {
    platformAccountId: page.id,
    enabled: body.enabled,
    dailyCapMax: body.dailyCapMax,
    model: body.model,
  });
  return getWorkboardV2AiReport(app, principal, pageLabel);
}

export async function runWorkboardV2AiClassify(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: WorkboardV2AiClassifyBody,
): Promise<WorkboardV2AiClassifyResponse> {
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, FEATURE_LABEL);
  if (!app.config.anthropicApiKey) {
    throw new BadRequestError("ANTHROPIC_API_KEY is not configured");
  }
  const eff = resolveClosingSettings(app.config, toOverride(await getClosingSettings(app.db, page.id)));

  const cleared = body.reclassify ? await clearClosingCacheForPage(app.db, page.id) : 0;
  const classifier = createAnthropicClosingClassifier({ apiKey: app.config.anthropicApiKey, model: eff.model });
  const result = await runClosingClassificationForPage(app.db, classifier, {
    platformAccountId: page.id,
    capMin: eff.capMin,
    capMax: eff.capMax,
  });
  // Apply the fresh verdicts to the board immediately.
  await recomputeWorkboardPage(app.db, { platformAccountId: page.id });

  // Log the run (always, even 0 calls, so the operator sees the click landed).
  await insertClassifierRun(app.db, {
    platformAccountId: page.id,
    trigger: body.reclassify ? "reclassify" : "manual",
    model: eff.model,
    classified: result.classified,
    calls: result.calls,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    deferred: result.deferred,
    cleared,
  });

  return { ok: true, classified: result.classified, calls: result.calls, deferred: result.deferred, cleared };
}

const RUN_LOG_LIMIT = 100;

/** Global classifier run log (owner-only; cross-page activity stream). */
export async function listWorkboardV2AiRuns(app: AppContext): Promise<WorkboardV2AiRunsResponse> {
  const runs = await listClassifierRuns(app.db, RUN_LOG_LIMIT);
  return {
    runs: runs.map((r) => ({
      id: r.id,
      pageLabel: r.page_label,
      trigger: r.trigger as WorkboardV2AiRunsResponse["runs"][number]["trigger"],
      model: r.model,
      classified: r.classified,
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      deferred: r.deferred,
      cleared: r.cleared,
      costUsd: estimateCostUsd(r.model ?? "claude-haiku-4-5", r.input_tokens, r.output_tokens),
      status: r.status,
      error: r.error,
      createdAt: iso(r.created_at),
    })),
  } as WorkboardV2AiRunsResponse;
}
