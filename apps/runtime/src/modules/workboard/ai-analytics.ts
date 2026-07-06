import type {
  WorkboardV2AiClassifyBody,
  WorkboardV2AiClassifyResponse,
  WorkboardV2AiReport,
  WorkboardV2AiRunsResponse,
  WorkboardV2AiSettingsBody,
} from "@agency_hub_core/contracts";
import {
  supersedeClosingCacheForPage,
  countClosingCache,
  countUnansweredTails,
  failStaleClassifierRuns,
  finishClassifierRun,
  getClosingSettings,
  getLlmUsageRange,
  insertClassifierRunRunningIfIdle,
  listSpenderDiagnosisRows,
  listClassifierRuns,
  listClosingClassificationCandidates,
  listRecentClosingVerdicts,
  upsertClosingSettings,
} from "@agency_hub_core/db";
import { UTC_TIME_ZONE, addUtcDays, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { AuthPrincipal } from "../../services/auth.ts";
import { BadRequestError } from "../../services/errors.ts";
import { resolveAccessibleWorkboardPage } from "./page-access.ts";
import { type ClosingSettingsOverride, DEFAULT_MODEL, estimateCostUsd, resolveClosingSettings } from "./ai-settings.ts";
import { CLOSING_CLASSIFIER_FEATURE, runClosingClassificationForPage } from "./classify-closing.ts";
import { isClosingMessage } from "./closing.ts";
import { createGatewayClosingClassifier } from "./closing-classifier.ts";
import { recomputeWorkboardPage } from "./recompute.ts";
import { summarizeSpenderDiagnostics } from "./spender-diagnostics.ts";

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
  const page = await resolveAccessibleWorkboardPage(app, principal, pageLabel);
  const now = new Date();
  const today = toBusinessDate(now, UTC_TIME_ZONE);
  const fromDate = toBusinessDate(addUtcDays(now, -USAGE_DAYS), UTC_TIME_ZONE);

  const [override, usageRows, cache, tails, candidates, spenderRows, recent] = await Promise.all([
    getClosingSettings(app.db, page.id),
    getLlmUsageRange(app.db, page.id, CLOSING_CLASSIFIER_FEATURE, fromDate),
    countClosingCache(app.db, page.id),
    countUnansweredTails(app.db, page.id),
    // includeContext:false — we only need the tail content to count L1-undecided pending.
    listClosingClassificationCandidates(app.db, page.id, { includeContext: false }),
    listSpenderDiagnosisRows(app.db, page.id),
    listRecentClosingVerdicts(app.db, page.id, RECENT_LIMIT),
  ]);

  const eff = resolveClosingSettings(app.config, toOverride(override));
  const spenderDiagnostics = summarizeSpenderDiagnostics(spenderRows);

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
    coverage: {
      tails,
      classified: cache.total,
      closings: cache.closings,
      pending,
      spenders: spenderDiagnostics.spenders,
      spenderDiagnosed: spenderDiagnostics.diagnosed,
      spenderPending: spenderDiagnostics.pending,
      spenderL2Classified: spenderDiagnostics.l2Classified,
      spenderClosings: spenderDiagnostics.closings,
      spenderNoVisibleDialog: spenderDiagnostics.noVisibleDialog,
      spenderModelLast: spenderDiagnostics.modelLast,
      spenderFanLast: spenderDiagnostics.fanLast,
      spenderUnknownLast: spenderDiagnostics.unknownLast,
    },
    states: spenderDiagnostics.states,
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
  const page = await resolveAccessibleWorkboardPage(app, principal, pageLabel);
  await upsertClosingSettings(app.db, {
    platformAccountId: page.id,
    enabled: body.enabled,
    dailyCapMax: body.dailyCapMax,
    model: body.model,
  });
  return getWorkboardV2AiReport(app, principal, pageLabel);
}

/**
 * The heavy part of a manual run — clears (if reclassify), classifies, recomputes,
 * then finalizes the run-log row. Runs detached from the HTTP request so the UI gets
 * an instant "running" row and polls for completion (the row is the status tracker).
 */
async function executeClassifyRun(
  app: AppContext,
  platformAccountId: number,
  runId: number,
  eff: { capMin: number; capMax: number; model: string },
  reclassify: boolean,
): Promise<void> {
  try {
    const cleared = reclassify ? await supersedeClosingCacheForPage(app.db, platformAccountId) : 0;
    const classifier = createGatewayClosingClassifier(app, { model: eff.model });
    const result = await runClosingClassificationForPage(app.db, classifier, {
      platformAccountId,
      capMin: eff.capMin,
      capMax: eff.capMax,
    });
    await recomputeWorkboardPage(app.db, { platformAccountId });
    await finishClassifierRun(app.db, runId, {
      status: "ok",
      classified: result.classified,
      calls: result.calls,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      deferred: result.deferred,
      cleared,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.logger.error({ err, platformAccountId, runId }, "Workboard v2 manual classify run failed");
    await finishClassifierRun(app.db, runId, { status: "error", error: message.slice(0, 500) }).catch(() => undefined);
  }
}

export async function runWorkboardV2AiClassify(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: WorkboardV2AiClassifyBody,
): Promise<WorkboardV2AiClassifyResponse> {
  const page = await resolveAccessibleWorkboardPage(app, principal, pageLabel);
  if (!app.config.anthropicApiKey) {
    throw new BadRequestError("ANTHROPIC_API_KEY is not configured");
  }
  const eff = resolveClosingSettings(app.config, toOverride(await getClosingSettings(app.db, page.id)));
  // One in-flight run per page — the DB transaction closes the SELECT→INSERT race.
  const run = await insertClassifierRunRunningIfIdle(app.db, {
    platformAccountId: page.id,
    trigger: body.reclassify ? "reclassify" : "manual",
    model: eff.model,
  });
  if (run.alreadyRunning) {
    return { ok: true, runId: run.id, status: "running", alreadyRunning: true };
  }

  // Detach: respond immediately; the run-log row tracks progress to completion.
  void executeClassifyRun(app, page.id, run.id, eff, body.reclassify);

  return { ok: true, runId: run.id, status: "running", alreadyRunning: false };
}

const RUN_LOG_LIMIT = 100;

const STALE_RUN_MINUTES = 20;

/** Global classifier run log (owner-only; cross-page activity stream). */
export async function listWorkboardV2AiRuns(app: AppContext): Promise<WorkboardV2AiRunsResponse> {
  // Reconcile orphaned 'running' rows (detached work lost to a process restart) so the
  // log never shows a perpetual "выполняется…".
  await failStaleClassifierRuns(app.db, STALE_RUN_MINUTES);
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
      costUsd: estimateCostUsd(r.model ?? DEFAULT_MODEL, r.input_tokens, r.output_tokens),
      status: r.status,
      error: r.error,
      createdAt: iso(r.created_at),
    })),
  } as WorkboardV2AiRunsResponse;
}
