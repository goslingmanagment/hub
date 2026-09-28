import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { applyFanslyWsPolicyRepair, diagnoseFanslyWsHints, previewFanslyWsPolicyRepair } from "./services/fansly-ws-policy-repair.ts";
import { buildFanslyWsRecoveryManifest } from "./services/fansly-ws-recovery-manifest.ts";
import { pathToFileURL } from "node:url";

import { Command, InvalidArgumentError } from "commander";
import { PgBoss } from "pg-boss";

import {
  assertDomainEventTargetMonthsAttached,
  createModel,
  DomainEventTargetMonthsUnattachedError,
  findPageByLabel,
  findUserById,
  getPageDmConversationById,
  insertDeliveryAttempt,
  insertErasureLog,
  replayFanslyWsDecode,
} from "@agency_hub_core/db";
import {
  createProxyRequestDispatcher,
  createRequestDispatcher,
  creatableUserRoles,
  formatMaskedProxyUrl,
  formatUsdFromMills,
  parsePeriod,
  redactSensitiveText,
  millsFromInteger,
  normalizeProviderStreamFailure,
  undiciRequest,
  type AiProviderFailureClassification,
  type ProxyConfig,
  type TransactionType,
} from "@agency_hub_core/shared";

import { createAppContext } from "./bootstrap.ts";
import { AiGatewayTerminalStreamConsumer, buildAiGatewayTerminalRecord } from "./services/ai-gateway.ts";
import { backfillFanslyPageAliases } from "./services/fansly-page-alias-backfill.ts";
import { handleSuccessfulPageVerificationRecovery } from "./services/notification-incidents.ts";
import { resolveHarvestManifest } from "./services/harvest-manifest.ts";
import {
  runOfapiTransactionsBackfill,
  type OfapiTransactionsBackfillResult,
} from "./services/ofapi-transactions-backfill.ts";
import { backfillOnlyFansPageMetadata } from "./services/onlyfans-page-metadata-backfill.ts";
import { onboardFanslyPage, onboardOnlyFansPage } from "./services/page-onboarding.ts";
import { removePageProxy, setPageProxy } from "./services/page-proxies.ts";
import {
  removeVoiceProfile,
  setVoiceProfile,
  showVoiceProfile,
} from "./services/voice-profiles.ts";
import {
  runFanslyEndpointProbe,
  summarizeEndpointProbe,
} from "./services/fansly-endpoint-probe.ts";
import { runFanslyReplayProbe, summarizeReplayProbe } from "./services/fansly-replay-probe.ts";
import { runCanonicalization } from "./services/canonicalize-driver.ts";
import { runOfapiBindingReconcile } from "./services/ofapi-binding-reconcile.ts";
import { runDmCorrectionsFingerprintBackfill } from "./services/dm-corrections-backfill.ts";
import { runTransactionTipContextsBackfill } from "./services/transaction-tip-contexts-backfill.ts";
import { runDmCorrectionsLineageIntake } from "./services/dm-corrections-lineage-intake.ts";
import { runFansly1970Repair } from "./services/fansly-1970-repair.ts";
import { runOfapiPpvRefRepair } from "./services/ofapi-ppv-ref-repair.ts";
import { runPpvPurchaseBackfill } from "./services/ppv-purchase-backfill.ts";
import { runFanslyMediaStatsForeignPrune } from "./services/fansly-media-stats-foreign-prune.ts";
import { runNotificationReadStateReplay } from "./services/fansly-notification-read-state-replay.ts";
import { runAccountMeRejournal } from "./services/observations-account-me-rejournal.ts";
import {
  countHarvestObservations,
  listFanslyBackscrollManifest,
  listHarvestTransactionResidue,
} from "@agency_hub_core/db";
import {
  runMessageArchiveBackfills,
  runMessageArchiveProjection,
} from "./services/projections/message-archive.ts";
import {
  findProjection,
  projectionNames,
  rebuildRegisteredProjection,
} from "./services/projections/registry.ts";
import {
  assignPageToUser,
  createUserAccount,
  deactivateUser,
  deleteUser,
  listUsersDetailed,
  reactivateUser,
  recordAudit,
  setUserPassword,
  unassignPageFromUser,
} from "./services/auth.ts";
import { getModelRevenueReport, getPageRevenueReport } from "./services/reporting.ts";
import { sendManualDailyRevenueTelegramReport } from "./services/telegram-report.ts";
import { sendTelegramTestMessage } from "./services/telegram.ts";
import {
  verifyServiceEgress,
  type ServiceEgressConsumerSelection,
} from "./services/service-egress-verify.ts";
import {
  loadFanslySessionBundleFromFile,
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "./services/page-context.ts";
import { requestPageSync, waitForRequestedSyncRequests } from "./services/sync-control.ts";
import { refreshPageMetadata } from "./services/sync/shared.ts";
import { getSyncMonitorSnapshot } from "./services/sync-monitor.ts";
import { renderSyncMonitor } from "./services/sync-monitor-view.ts";
import {
  fanSpendForPage,
  getStatusDetail,
  getStatusWatchSnapshot,
  listFans,
  listFollowers,
  listModels,
  listPages,
  listStatus,
  listSubscribers,
} from "./services/sync.ts";
import { resolvePageContext } from "./services/page-context.ts";
import { ensureSyncQueues, sendSyncPlannerWakeup } from "./services/sync-queue.ts";
import {
  ensureTargetedThreadBackfillQueue,
  sendTargetedThreadBackfillJob,
} from "./services/sync/targeted-thread-backfill.ts";
import {
  buildStatusRows,
  listStalledRuns,
  renderStatusDetail,
  renderSyntheticStallLine,
  renderWatchEventLine,
  renderWatchTty,
} from "./services/sync/view.ts";

function requireCustomPeriod(from?: string, to?: string) {
  if (!from || !to) {
    throw new Error("Custom period requires from/to dates");
  }

  return { from, to };
}

function parseUserId(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Expected an immutable positive user ID, received "${value}"`);
  }
  return parsed;
}

function parsePositiveInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

function parseNonnegativeInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative safe integer, received "${value}"`);
  }
  return parsed;
}

function parseServiceEgressConsumer(value: string): ServiceEgressConsumerSelection {
  if (value === "elevenlabs" || value === "telegram" || value === "all") {
    return value;
  }
  throw new InvalidArgumentError("Expected elevenlabs, telegram, or all");
}

function parseDateOption(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Expected an ISO date or timestamp, received "${value}"`);
  }
  return parsed;
}

function parseSinceOption(value: string) {
  const relative = value.match(/^(\d+)([mhd])$/i);
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10);
    const unit = relative[2]!.toLowerCase();
    const multiplier = unit === "m"
      ? 60_000
      : unit === "h"
        ? 60 * 60_000
        : 24 * 60 * 60_000;
    return new Date(Date.now() - amount * multiplier);
  }

  return parseDateOption(value);
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return String(value);
}

function printRows(headers: string[], rows: Array<unknown[]>) {
  console.log(headers.join("\t"));
  for (const row of rows) {
    console.log(row.map((value) => formatCell(value)).join("\t"));
  }
}

async function readSecretOption(input: {
  value?: string;
  file?: string;
  env?: string;
  label: string;
}) {
  const provided = [
    input.value !== undefined,
    input.file !== undefined,
    input.env !== undefined,
  ].filter(Boolean).length;
  if (provided > 1) {
    throw new Error(`Use only one of --${input.label}, --${input.label}-file, or --${input.label}-env`);
  }

  if (input.value !== undefined) {
    return input.value;
  }
  if (input.file !== undefined) {
    return (await readFile(input.file, "utf8")).replace(/\r?\n$/, "");
  }
  if (input.env !== undefined) {
    const value = process.env[input.env];
    if (value === undefined) {
      throw new Error(`Environment variable ${input.env} is not set`);
    }
    return value;
  }

  return undefined;
}

async function buildProxyInput(options: {
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  proxyPasswordFile?: string;
  proxyPasswordEnv?: string;
}) {
  const proxyPassword = await readSecretOption({
    value: options.proxyPassword,
    file: options.proxyPasswordFile,
    env: options.proxyPasswordEnv,
    label: "proxy-password",
  });
  return options.proxyUrl
    ? {
      url: options.proxyUrl,
      username: options.proxyUsername ?? null,
      password: proxyPassword ?? null,
    }
    : null;
}

async function readPasswordOption(options: {
  password?: string;
  passwordFile?: string;
  passwordEnv?: string;
}) {
  return readSecretOption({
    value: options.password,
    file: options.passwordFile,
    env: options.passwordEnv,
    label: "password",
  });
}

function collectStringOption(value: string, previous: string[] = []) {
  return [...previous, value];
}

async function lookupExitIpViaDispatcher(input: { url: string } | null) {
  const dispatcher = input
    ? createProxyRequestDispatcher(input)
    : createRequestDispatcher();

  try {
    const { statusCode, body } = await undiciRequest("https://api.ipify.org?format=json", {
      method: "GET",
      signal: AbortSignal.timeout(30_000),
      dispatcher,
    });
    const text = await body.text();
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`IP check returned HTTP ${statusCode}`);
    }

    const payload = JSON.parse(text) as { ip?: unknown };
    if (typeof payload.ip !== "string" || payload.ip.length === 0) {
      throw new Error("IP check returned an invalid payload");
    }

    return payload.ip;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

function describeExitIpLookupError(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

async function resolvePageRoute(app: Awaited<ReturnType<typeof createAppContext>>, pageLabel: string) {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new Error(`Page not found for label "${pageLabel}"`);
  }

  return {
    pageLabel: stored.page.label,
    platform: stored.page.platform,
    proxy: resolveStoredProxyConfig(app, stored.proxy),
    egressKey: resolveStoredProxyEgressKey(stored.proxy),
  };
}

async function resolvePageEgressSummary(input: {
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  proxy: ProxyConfig | null;
  egressKey: string;
}) {
  try {
    return {
      ...input,
      route: input.proxy ? formatMaskedProxyUrl(input.proxy) : "direct",
      egressKey: input.egressKey,
      exitIp: await lookupExitIpViaDispatcher(input.proxy),
      exitIpError: null,
    };
  } catch (error) {
    return {
      ...input,
      route: input.proxy ? formatMaskedProxyUrl(input.proxy) : "direct",
      egressKey: input.egressKey,
      exitIp: null,
      exitIpError: describeExitIpLookupError(error),
    };
  }
}

function printPageEgressSummary(summary: Awaited<ReturnType<typeof resolvePageEgressSummary>>) {
  console.log(`Page: ${summary.pageLabel}`);
  console.log(`Platform: ${summary.platform}`);
  console.log(`Egress key: ${summary.egressKey}`);
  console.log(`Route: ${summary.route}`);
  console.log(
    `Exit IP: ${summary.exitIp ?? `unavailable (${summary.exitIpError ?? "unknown error"})`}`,
  );
}

async function watchStatus(
  options: {
    page?: string;
    limit: number;
    since?: Date;
  },
) {
  const app = await createAppContext();
  let afterEventId = 0;
  const emittedStalledRuns = new Set<number>();
  let stopped = false;
  const handleStop = () => {
    stopped = true;
  };

  process.once("SIGINT", handleStop);
  process.once("SIGTERM", handleStop);

  try {
    while (!stopped) {
      const snapshot = await getStatusWatchSnapshot(app, {
        pageLabel: options.page,
        limit: options.limit,
        since: options.since,
        afterEventId,
      });

      if (snapshot.events.length > 0) {
        afterEventId = snapshot.events[snapshot.events.length - 1]!.id;
      }

      if (process.stdout.isTTY) {
        process.stdout.write("\u001bc");
        console.log(renderWatchTty(snapshot));
      } else {
        for (const event of snapshot.events) {
          console.log(renderWatchEventLine(event));
        }

        const stalledRuns = listStalledRuns(snapshot);
        const stalledRunIds = new Set(stalledRuns.map((run) => run.runId));
        for (const run of stalledRuns) {
          if (!emittedStalledRuns.has(run.runId)) {
            console.log(renderSyntheticStallLine(run));
            emittedStalledRuns.add(run.runId);
          }
        }

        for (const runId of Array.from(emittedStalledRuns)) {
          if (!stalledRunIds.has(runId)) {
            emittedStalledRuns.delete(runId);
          }
        }
      }

      if (stopped) {
        break;
      }

      await delay(2000);
    }
  } finally {
    await app.close();
    process.removeListener("SIGINT", handleStop);
    process.removeListener("SIGTERM", handleStop);
  }
}

async function watchSyncMonitor(
  options: {
    page?: string;
    windowHours: number;
    intervalSeconds: number;
  },
) {
  const app = await createAppContext();
  let stopped = false;
  const handleStop = () => {
    stopped = true;
  };

  process.once("SIGINT", handleStop);
  process.once("SIGTERM", handleStop);

  try {
    while (!stopped) {
      const snapshot = await getSyncMonitorSnapshot(app, {
        pageLabel: options.page,
        windowHours: options.windowHours,
      });

      if (process.stdout.isTTY) {
        process.stdout.write("\u001bc");
        console.log(renderSyncMonitor(snapshot));
      } else {
        console.log(renderSyncMonitor(snapshot));
        console.log("");
      }

      if (stopped) {
        break;
      }

      await delay(Math.max(1, options.intervalSeconds) * 1000);
    }
  } finally {
    await app.close();
    process.removeListener("SIGINT", handleStop);
    process.removeListener("SIGTERM", handleStop);
  }
}

function auditContext() {
  return {
    source: "cli",
    actorUserId: null,
  };
}

function describeError(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

// PgBoss extends EventEmitter: without a listener an 'error' event throws and
// kills the CLI mid-operation, skipping the try/finally cleanup (audit B8).
function attachCliPgBossErrorLogger(boss: PgBoss) {
  boss.on("error", (error) => {
    console.error(`pg-boss error: ${describeError(error)}`);
  });
}

async function queueInitialFullSyncAfterPageCreate(
  databaseUrl: string,
  app: Awaited<ReturnType<typeof createAppContext>>,
  pageLabel: string,
) {
  const boss = new PgBoss({ connectionString: databaseUrl });
  attachCliPgBossErrorLogger(boss);

  try {
    await boss.start();
    await ensureSyncQueues(boss);
    await requestPageSync(app, boss, {
      pageLabel,
      scope: "all",
      reason: "onboarding",
    });
  } catch (error) {
    throw new Error(
      `Page "${pageLabel}" was created, but the automatic sync could not be queued: ${describeError(error)}`,
      { cause: error },
    );
  } finally {
    await boss.stop().catch(() => undefined);
  }
}

async function queueTargetedThreadBackfill(
  databaseUrl: string,
  input: { threadId: number; platformAccountId: number; ignoreRetentionLimit: boolean },
) {
  const boss = new PgBoss({ connectionString: databaseUrl });
  attachCliPgBossErrorLogger(boss);

  try {
    await boss.start();
    await ensureTargetedThreadBackfillQueue(boss);
    return await sendTargetedThreadBackfillJob(boss, input);
  } finally {
    await boss.stop().catch(() => undefined);
  }
}

async function queuePlannerRecovery(
  databaseUrl: string,
) {
  const boss = new PgBoss({ connectionString: databaseUrl });
  attachCliPgBossErrorLogger(boss);

  try {
    await boss.start();
    await ensureSyncQueues(boss);
    return await sendSyncPlannerWakeup(boss);
  } finally {
    await boss.stop().catch(() => undefined);
  }
}

const revenueLabels: Record<TransactionType, string> = {
  subscription: "Subscriptions",
  tip: "Tips",
  message_purchase: "Messages",
  post_purchase: "Posts",
  stream_tip: "Streams",
  chargeback: "Chargebacks",
  refund: "Refunds",
  payout_reversal: "Payout reversals",
  other: "Other",
};

function printRevenueTotals(
  totals: Map<TransactionType, bigint>,
  summary: {
    revenueMills: number;
    adjustmentMills: number;
    unclassifiedMills: number;
    netEarningsMills: number;
  },
  period: string,
) {
  console.log(`${period} revenue summary:`);
  console.log(`  Revenue: ${formatUsdFromMills(millsFromInteger(summary.revenueMills))}`);
  console.log(`  Adjustments: ${formatUsdFromMills(millsFromInteger(summary.adjustmentMills))}`);
  console.log(`  Unclassified: ${formatUsdFromMills(millsFromInteger(summary.unclassifiedMills))}`);
  console.log(`  Net earnings: ${formatUsdFromMills(millsFromInteger(summary.netEarningsMills))}`);
  for (const [type, label] of Object.entries(revenueLabels) as Array<[TransactionType, string]>) {
    const total = totals.get(type) ?? 0n;
    if (total === 0n) {
      continue;
    }
    console.log(`  ${label}: ${formatUsdFromMills(total)}`);
  }
}

function printOfapiTransactionsBackfillResult(result: OfapiTransactionsBackfillResult) {
  console.log(`OFAPI transactions backfill (${result.mode})`);
  console.log(`Window: ${result.from.toISOString()} -> ${result.to?.toISOString() ?? "open"}`);

  for (const page of result.pages) {
    console.log("");
    console.log(`Page: ${page.pageLabel}`);
    console.log(`  status=${page.status}${page.reason ? ` reason=${page.reason}` : ""}`);
    console.log(`  page_id=${page.pageId ?? ""} ofapi_account_id=${page.ofapiAccountId ?? ""}`);
    console.log(
      `  has_credentials=${page.hasCredentials} active_non_ofapi_transactions=${page.activeNonOfapiTransactions}`,
    );
    console.log(
      `  api_pages=${page.apiPages} raw_rows=${page.rawRows} normalized_rows=${page.normalizedRows} skipped_rows=${page.skippedRows} written_rows=${page.writtenRows}`
        + (page.paginationStopReason && page.paginationStopReason !== "completed"
          ? ` pagination=${page.paginationStopReason}`
          : ""),
    );
    console.log(
      `  occurred_at=${page.minOccurredAt?.toISOString() ?? ""}..${page.maxOccurredAt?.toISOString() ?? ""}`,
    );
    console.log(
      `  webhook_overlap=${page.overlap.matched}/${page.overlap.checked}`
        + ` (${page.overlap.matchRate === null ? "n/a" : `${(page.overlap.matchRate * 100).toFixed(1)}%`})`,
    );

    const typeRows = Object.entries(page.typeHistogram)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, count]) => [type, count]);
    if (typeRows.length > 0) {
      console.log("  type histogram:");
      printRows(["type", "count"], typeRows);
    }

    const skippedRows = Object.entries(page.skippedReasons)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => [reason, count]);
    if (skippedRows.length > 0) {
      console.log("  skipped rows:");
      printRows(["reason", "count"], skippedRows);
    }

    if (page.months.length > 0) {
      console.log("  months:");
      printRows(
        ["month", "rows", "gross", "net"],
        page.months.map((month) => [
          month.month,
          month.rows,
          formatUsdFromMills(month.grossAmountMills),
          formatUsdFromMills(month.creatorNetAmountMills),
        ]),
      );
    }
  }

  if (result.pages.some((page) => page.paginationStopReason === "budget_exhausted")) {
    console.log("");
    console.log(
      "Day credit budget exhausted (ofapiBackfillDailyCreditBudget) — coverage above is"
        + " partial. Re-run the same window after the UTC-day rollover to resume;"
        + " re-runs converge (upserts add no duplicate rows).",
    );
  }
}

/**
 * The month instants an `events:replay --from/--to` window can aim a
 * provider-dated append at. One instant per month start in the window, which is
 * all the census needs: it name-matches domain_events_YYYY_MM and passes
 * everything outside 2026-2030 through. An open-ended window is anchored at the
 * other bound; a window with neither bound is not checked here at all — the
 * engine gate inside runCanonicalization still covers it.
 */
export function replayWindowMonths(from: Date | null, to: Date | null): Date[] {
  const start = from ?? to;
  const end = to ?? from;
  if (start === null || end === null) {
    return [];
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const months: Date[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const limit = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  // 120 months of guard rail: a nonsense window must not build an endless list.
  for (let index = 0; cursor <= limit && index < 120; index += 1) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function buildProgram() {
  const program = new Command();

  program.name("pnpm cli");

  const model = program.command("model");

  model
    .command("add")
    .requiredOption("--slug <slug>")
    .requiredOption("--name <name>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const created = await createModel(app.db, {
          slug: options.slug,
          name: options.name,
        });
        console.log(`Created model ${created.slug} (${created.id})`);
      } finally {
        await app.close();
      }
    });

  model
    .command("list")
    .action(async () => {
      const app = await createAppContext();
      try {
        const rows = await listModels(app);
        printRows(
          ["slug", "name", "page_count"],
          rows.map((row) => [row.slug, row.name, row.page_count]),
        );
      } finally {
        await app.close();
      }
    });

  model
    .command("revenue")
    .requiredOption("--slug <slug>")
    .requiredOption("--period <period>")
    .option("--from <from>")
    .option("--to <to>")
    .action(async (options) => {
      const period = parsePeriod(options.period);
      const custom = period === "custom"
        ? requireCustomPeriod(options.from, options.to)
        : undefined;
      const app = await createAppContext();
      try {
        const revenue = await getModelRevenueReport(app, options.slug, {
          period,
          custom,
        });
        const totals = new Map(
          revenue.breakdown.map((row) => [row.canonicalType, millsFromInteger(row.netAmountMills)]),
        );

        console.log(`Model: ${revenue.model.name} (${revenue.model.slug})`);
        printRevenueTotals(totals, {
          revenueMills: revenue.revenueMills,
          adjustmentMills: revenue.adjustmentMills,
          unclassifiedMills: revenue.unclassifiedMills,
          netEarningsMills: revenue.netEarningsMills,
        }, period);
        for (const page of revenue.pages) {
          console.log(
            `  ${page.pageLabel}: ${formatUsdFromMills(millsFromInteger(page.netEarningsMills))}`,
          );
        }
      } finally {
        await app.close();
      }
    });

  const agent = program.command("agent");
  const agentHydration = agent.command("hydration");

  agentHydration
    .command("list")
    .description(
      "Slice C: the owner approval queue. Prints requestRef, rowVersion and "
        + "coverageFingerprint as JSON — the three values `agent hydration decide` needs.",
    )
    .option("--state <state>", "requested | approved | dispatching | completed | ...")
    .option("--limit <n>", "rows to print", parsePositiveInt, 50)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { listAgentHydrationRequests } = await import("@agency_hub_core/db");
        const { rows } = await listAgentHydrationRequests(app.db, {
          ...(options.state === undefined
            ? {}
            : { states: [options.state as "requested"] }),
          limit: options.limit as number,
        });
        const { toWireHydrationRequest } = await import("./modules/agent-read/index.ts");
        console.log(JSON.stringify(rows.map(toWireHydrationRequest), null, 2));
      } finally {
        await app.close();
      }
    });

  agentHydration
    .command("decide")
    .description(
      "Slice C: approve or reject one hydration request. Runs the SAME code path as the "
        + "dashboard (CAS on --expected-version, staleness check on --coverage-fingerprint, "
        + "the #158 mark-read consent rule) — this is a second client, not a second "
        + "implementation.",
    )
    .requiredOption("--request <uuid>", "requestRef from `agent hydration list`")
    .requiredOption("--decision <decision>", "approve | reject")
    .requiredOption("--expected-version <n>", "rowVersion the decision was formed against", (value: string) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new InvalidArgumentError("Expected a non-negative integer");
      }
      return parsed;
    })
    .requiredOption("--coverage-fingerprint <sha256>", "the fingerprint that was SHOWN to you")
    // All three are REQUIRED on an approval (the shared decision schema refuses
    // otherwise): the OnlyFans capture lane cannot schedule a job missing any of
    // them, and one approval buys exactly one attempt.
    .option("--max-calls <n>", "hard cap on vendor calls (required to approve)", parsePositiveInt)
    .option("--max-credits <n>", "hard cap on OFAPI credits (required to approve)", parsePositiveInt)
    .option("--max-pages <n>", "hard cap on vendor pages (required to approve)", parsePositiveInt)
    .option("--max-items <n>", "hard cap on accepted items", parsePositiveInt)
    .option("--expires-in-hours <n>", "how long the approval stays executable", parsePositiveInt, 24)
    .option(
      "--allow-mark-read",
      "#158: consent to the vendor read marking the thread READ on the platform",
    )
    .option("--no-allow-mark-read", "refuse the mark-read side effect (approval must state it)")
    .option("--reason <text>", "required on a rejection")
    .option("--as-user-id <id>", "immutable owner user ID to attribute the decision to", parseUserId)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const decision = options.decision as string;
        if (decision !== "approve" && decision !== "reject") {
          throw new Error(`--decision must be approve or reject, received "${decision}"`);
        }
        const { listUsers } = await import("@agency_hub_core/db");
        // The decision is attributed to a REAL owner: the audit row and the
        // event journal both name a person, never "the CLI".
        const actor = options.asUserId
          ? await findUserById(app.db, options.asUserId as number)
          : (await listUsers(app.db)).find((user) => user.role === "owner" && user.disabledAt === null);
        if (!actor || actor.role !== "owner" || actor.disabledAt !== null || actor.deletedAt !== null) {
          throw new Error("A hydration decision needs an owner user; pass --as-user-id <id>");
        }
        const { applyHydrationDecision, toWireHydrationRequest } = await import(
          "./modules/agent-read/index.ts"
        );
        const outcome = await applyHydrationDecision(app, {
          requestRef: options.request as string,
          actorUserId: actor.id,
          body: {
            decision,
            expectedVersion: options.expectedVersion as number,
            coverageFingerprint: options.coverageFingerprint as string,
            idempotencyKey: randomUUID(),
            ...(decision === "approve"
              ? {
                expiresAt: new Date(
                  Date.now() + (options.expiresInHours as number) * 60 * 60 * 1000,
                ).toISOString(),
                allowMarkReadSideEffect: options.allowMarkRead === true,
              }
              : {}),
            ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls as number }),
            ...(options.maxCredits === undefined
              ? {}
              : { maxCredits: options.maxCredits as number }),
            ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages as number }),
            ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems as number }),
            ...(options.reason === undefined ? {} : { reason: options.reason as string }),
          },
        });
        console.log(JSON.stringify({
          disposition: outcome.disposition,
          request: toWireHydrationRequest(outcome.request),
        }, null, 2));
      } finally {
        await app.close();
      }
    });

  const dm = program.command("dm");
  const page = program.command("page");
  const pageAdd = page.command("add");
  const sync = program.command("sync");
  sync.enablePositionalOptions();
  const queue = program.command("queue");
  const telegram = program.command("telegram");
  const serviceEgress = program.command("service-egress");

  dm
    .command("backfill-thread")
    .description(
      "Slice C′: queue a one-shot deep backfill of ONE Fansly DM thread. The worker "
        + "executes it under the page's dm_messages sync lease; this process never "
        + "touches the vendor.",
    )
    .requiredOption("--thread <id>", "page_dm_threads id", parsePositiveInt)
    .option(
      "--ignore-retention-limit",
      "walk past the per-thread depth cap for THIS run only (global config unchanged)",
    )
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const threadId = options.thread as number;
        // The queue key is the PAGE (Stage 25: one sync chunk per page at a
        // time), so the enqueue resolves the thread's page first.
        const thread = await getPageDmConversationById(app.db, threadId);
        if (!thread) {
          throw new Error(`DM thread ${threadId} not found`);
        }
        const jobId = await queueTargetedThreadBackfill(app.config.databaseUrl, {
          threadId,
          platformAccountId: thread.platformAccountId,
          ignoreRetentionLimit: options.ignoreRetentionLimit === true,
        });
        console.log(JSON.stringify({ jobId, threadId }));
      } finally {
        await app.close();
      }
    });

  program
    .command("tiering:run")
    .description("Stage 28: export→verify→detach aged ledger partitions into the lake")
    .option("--execute", "actually tier (default is a dry-run listing)")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { runTieringCycle } = await import("./services/tiering/index.ts");
        const cycle = await runTieringCycle(app, { dryRun: !options.execute });
        console.log(JSON.stringify(cycle, null, 2));
        if (cycle.failed > 0) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  // -------------------------------------------------------------------------
  // G5 slice 3c-2 — the historical rewrite.
  //
  // FOUR COMMANDS, NO SCHEDULE, NO CONFIG FLAG. Every one of them is an
  // owner-initiated act with the erasure's governance: dry-run is the default,
  // `--execute` opts in, the destructive ones also demand `--confirm <exact
  // name>`, and every real run leaves a tombstone in `capture_rewrite_runs`.
  // A schedule was never on the table — this walks tens of GB on a box whose
  // free space is the reason the project exists, and it must run with someone
  // watching. The ritual is docs/runbooks/capture-historical-rewrite.md.
  program
    .command("capture:backfill")
    .description(
      "G5 3c-2: put HISTORICAL capture bodies in the content-addressed catalog and stamp each "
        + "row with its address (dry-run default)",
    )
    .requiredOption("--table <table>", "observations | sync_raw_payloads")
    .option("--month <YYYY-MM>", "observations only: which monthly partition (required there)")
    .option("--batch <n>", "rows per keyset page", parsePositiveInt, 200)
    .option("--pause-ms <n>", "pause between pages", parseNonnegativeInt, 250)
    .option("--limit <n>", "stop after this many pages (0 = until the scope is done)", parseNonnegativeInt, 0)
    .option("--execute", "actually write (default is a dry-run census)")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { parseCaptureRewriteScope } = await import("./services/capture-rewrite/scope.ts");
        const { runCaptureBackfill } = await import("./services/capture-rewrite/index.ts");
        const scope = parseCaptureRewriteScope({ table: options.table, month: options.month });
        const result = await runCaptureBackfill(app, {
          scope,
          dryRun: !options.execute,
          batch: options.batch,
          pauseMs: options.pauseMs,
          maxBatches: options.limit,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.forecast !== null) {
          // #239: the gate says whether this step MAY run; the forecast says
          // whether finishing is worth starting. July learned the difference
          // the expensive way.
          console.log(`\n${result.forecast.line}`);
        }
        if (result.headroom !== null) {
          console.log(`headroom: ${result.headroom.reason}`);
        }
        if (result.dryRun) {
          console.log(
            `\nDRY RUN — nothing written. ${result.census.unreferencedWithBody} row(s) in `
              + `${result.relation} carry a body and no reference.\nTo execute:\n`
              + `  capture:backfill --table ${scope.table}`
              + `${scope.month === null ? "" : ` --month ${scope.month}`} --execute`,
          );
        } else {
          console.log(
            `\nreferenced ${result.referenced} (deduped ${result.deduped}), codec-refused `
              + `${result.codecRefused}, raced ${result.raced}, in ${result.batches} batches; `
              + `stopped: ${result.stoppedBecause}`,
          );
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("capture:verify-backfill")
    .description(
      "G5 3c-2: prove a scope is safe to reclaim — every row referenced, every reference "
        + "resolving, bodies identical on a random sample. Writes only its own verdict",
    )
    .requiredOption("--table <table>", "observations | sync_raw_payloads")
    .option("--month <YYYY-MM>", "observations only")
    .option("--sample <n>", "bodies to compare octet-for-octet", parseNonnegativeInt, 500)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { parseCaptureRewriteScope } = await import("./services/capture-rewrite/scope.ts");
        const { runCaptureVerifyBackfill } = await import("./services/capture-rewrite/index.ts");
        const scope = parseCaptureRewriteScope({ table: options.table, month: options.month });
        const result = await runCaptureVerifyBackfill(app, { scope, sample: options.sample });
        console.log(JSON.stringify(result, null, 2));
        console.log(
          `\nVERDICT ${result.verdict.toUpperCase()} for ${result.scopeRef}: `
            + `${result.census.rows} rows, ${result.census.referenced} referenced, `
            + `${result.provedCodecRefused} proved codec-refused, `
            + `${result.unexplainedUnreferenced} unexplained, ${result.danglingRefs} dangling; `
            + `sample ${result.sample.matched}/${result.sample.compared} matched`,
        );
        for (const refusal of result.refusals) {
          console.log(`  REFUSED: ${refusal}`);
        }
        if (result.verdict !== "ok") {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("capture:reclaim")
    .description(
      "G5 3c-2: return the space. observations: --phase shadow then --phase swap. "
        + "sync_raw_payloads: --phase null-bodies then --phase vacuum-full (writers must be down)",
    )
    .requiredOption("--table <table>", "observations | sync_raw_payloads")
    .option("--month <YYYY-MM>", "observations only")
    .requiredOption("--phase <phase>", "shadow | swap | null-bodies | vacuum-full")
    .option("--batch <n>", "rows per page for the copying/updating phases", parsePositiveInt, 2000)
    .option("--pause-ms <n>", "pause between pages", parseNonnegativeInt, 250)
    .option("--lock-timeout-ms <n>", "how long the swap may WAIT for its lock", parsePositiveInt, 3000)
    .option(
      "--assume-free-bytes <n>",
      "DRY-RUN DRILL ONLY: evaluate the headroom law against this figure instead of measuring "
        + "the volume. Rejected together with --execute",
      parseNonnegativeInt,
    )
    .option("--execute", "actually act (default is a dry-run precondition report)")
    .option("--confirm <name>", "swap/vacuum-full: the exact relation name")
    .action(async (options) => {
      // #223: THE DRILL SEAM MAY NOT ANSWER FOR THE REAL GATE, and the check
      // is here — before the app context, before a single query — because the
      // combination is not a bad run, it is a category error. `--assume-free-
      // bytes` exists so an owner staring at a refusal can ask "how much would
      // I have to free up"; passing it to an EXECUTING run replaces the one
      // measurement standing between a nearly-full volume and a `VACUUM FULL`
      // with a number somebody typed. The flag was already journaled in the
      // tombstone, which records the bypass but does not prevent it.
      if (options.assumeFreeBytes !== undefined && options.execute) {
        throw new InvalidArgumentError(
          "--assume-free-bytes is a DRY-RUN drill and cannot be combined with --execute: an "
            + "executed run's headroom gate must read the real volume. Drop --execute to model "
            + "a hypothetical, or free the space and run for real.",
        );
      }
      const app = await createAppContext();
      try {
        const { parseCaptureRewriteScope } = await import("./services/capture-rewrite/scope.ts");
        const { runCaptureReclaim } = await import("./services/capture-rewrite/reclaim.ts");
        const scope = parseCaptureRewriteScope({ table: options.table, month: options.month });
        const result = await runCaptureReclaim(app, {
          scope,
          phase: options.phase,
          dryRun: !options.execute,
          confirm: options.confirm,
          batch: options.batch,
          pauseMs: options.pauseMs,
          lockTimeoutMs: options.lockTimeoutMs,
          ...(options.assumeFreeBytes === undefined
            ? {}
            : { freeBytesOverride: options.assumeFreeBytes }),
        });
        console.log(JSON.stringify(result, null, 2));
        console.log(
          `\n${result.dryRun ? "DRY RUN — " : ""}${result.phase} on ${result.scopeRef}: `
            + `${result.verdict.toUpperCase()}`,
        );
        for (const refusal of result.refusals) {
          console.log(`  REFUSED: ${refusal}`);
        }
        if (result.verdict !== "ok") {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("capture:drop-parked")
    .description(
      "G5 3c-2: DESTROY one superseded partition parked by a swap. The only command in the "
        + "slice that deletes anything, and it can reach nothing outside capture_pending_drop",
    )
    .option("--list", "print the parking schema inventory and exit")
    .option("--relation <name>", "the exact parked relation name")
    .option("--min-grace-hours <n>", "how long it must have been parked", parseNonnegativeInt, 24)
    .option("--execute", "actually drop (default is a dry-run report)")
    .option("--confirm <name>", "must equal --relation exactly")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { listCaptureParkedRelations, runCaptureDropParked } = await import(
          "./services/capture-rewrite/reclaim.ts"
        );
        if (options.list || !options.relation) {
          const parked = await listCaptureParkedRelations(app);
          console.log(JSON.stringify(parked, null, 2));
          if (!options.list) {
            console.log("\n--relation is required to drop anything.");
            process.exitCode = 1;
          }
          return;
        }
        const result = await runCaptureDropParked(app, {
          relation: options.relation,
          confirm: options.confirm,
          dryRun: !options.execute,
          minGraceHours: options.minGraceHours,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.dryRun && result.verdict === "ok") {
          console.log(
            `\nDRY RUN — nothing destroyed. To execute:\n  capture:drop-parked `
              + `--relation ${options.relation} --execute --confirm '${options.relation}'`,
          );
        }
        for (const refusal of result.refusals) {
          console.log(`  REFUSED: ${refusal}`);
        }
        if (result.verdict !== "ok") {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("ai:personas-seed")
    .description("Create missing bundled personas without changing existing owner content")
    .action(async () => {
      const app = await createAppContext();
      try {
        const { createBundledPersonalities } = await import("./modules/ai/index.ts");
        const { seedBundledAiPersona } = await import("@agency_hub_core/db");
        for (const persona of createBundledPersonalities()) {
          if (persona.builtinVersion === undefined) {
            throw new Error(`Bundled persona ${persona.id} is missing builtinVersion`);
          }
          const result = await seedBundledAiPersona(app.db, {
            key: persona.id,
            displayName: persona.name,
            systemBlock: persona.content,
            bundledVersion: persona.builtinVersion,
          });
          console.log(
            `seeded ${result.persona.key} (${result.persona.displayName}); action=${result.action}; version=${result.persona.revision}`,
          );
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("ai:feature-smoke")
    .description("Stage 30: exercise a kernel AI feature end-to-end against this environment (spends provider budget)")
    .requiredOption("--feature <feature>", "fast-reply | improve-draft | help-me | fan-summary | chat-review | ping | hi-greeting | coach-chat")
    .requiredOption("--page <label>", "page label")
    .requiredOption("--conversation <ref>", "conversation ref (OF: the fan id; Fansly canonical: the groupId)")
    .requiredOption("--as-user-id <id>", "immutable chatter/owner ID the generation is attributed to", parseUserId)
    .option("--draft <text>", "improve-draft input")
    .option("--question <text>", "coach-chat: the chatter's question (required for coach-chat)")
    .option("--fan <ref>", "canonical fan ref (Fansly: separate from the --conversation groupId)")
    .option("--model <model>", "gateway model override")
    .action(async (options) => {
      // Fail fast with a clear CLI message instead of a server 400: the T5 gate
      // rejects coach-chat without a chatterQuestion before any provider call.
      // This is platform-independent, so it stays ahead of the app context.
      if (options.feature === "coach-chat" && !options.question?.trim()) {
        throw new Error("coach-chat requires --question <text>");
      }
      const app = await createAppContext();
      try {
        const { prepareAiFeatureStream } = await import("./modules/ai/index.ts");
        // Resolve the page BEFORE the platform-specific --fan guard: the server
        // requires fanRef only on Fansly (P1-3), where the conversation is the
        // canonical groupId. On OnlyFans the conversation IS the fan id, so a
        // valid smoke needs no --fan. Load the page first so the guard keys off
        // the REAL platform instead of rejecting every coach-chat.
        const pageRow = await findPageByLabel(app.db, options.page);
        if (!pageRow) {
          throw new Error(`unknown page: ${options.page}`);
        }
        // Blocker 2 (P1-3): canonical Fansly coach-chat REQUIRES --fan so the
        // stored record's fan_ref carries the fan identity (conversationRef is
        // the groupId, which survives fan-scope erasure). Fail fast to match the
        // server gate before any provider spend.
        if (
          options.feature === "coach-chat"
          && pageRow.page.platform === "fansly"
          && !options.fan?.trim()
        ) {
          throw new Error("coach-chat requires --fan <ref> on fansly");
        }
        const user = await findUserById(app.db, options.asUserId);
        if (!user || user.disabledAt !== null || user.deletedAt !== null
          || (user.role !== "owner" && user.role !== "chatter")) {
          throw new Error(`Active chatter or owner required: user ID ${options.asUserId}`);
        }
        const startedAt = Date.now();
        // Operator smoke runs as the named user with owner-style page reach
        // (canAccessPage: owner role passes; others need the assignment).
        const principal = {
          authMethod: "device_token" as const,
          user: { id: user.id, username: user.username, role: user.role },
          assignedPageIds: [pageRow.page.id],
        };
        const stream = await prepareAiFeatureStream(
          app,
          principal as never,
          options.feature,
          {
            clientRequestId: randomUUID(),
            pageLabel: options.page,
            platform: pageRow.page.platform as "onlyfans" | "fansly",
            conversationRef: options.conversation,
            ...(options.draft ? { draftText: options.draft } : {}),
            ...(options.question ? { chatterQuestion: options.question } : {}),
            ...(options.fan ? { fanRef: options.fan } : {}),
            ...(options.model ? { model: options.model } : {}),
          },
        );
        const preparedMs = Date.now() - startedAt;
        let firstTokenMs: number | null = null;
        const abort = new AbortController();
        // Blocker 5 (P1-5a): drive the SAME terminal-stream consumer the HTTP
        // pump uses, so the CLI honors the coach ceiling and threads the real
        // outcome + stopReason into recordTerminal. Without this the smoke could
        // store a max_tokens-truncated fan-summary as `completed` with a NULL
        // stopReason, which the recap selector would then attach to a coach turn.
        const consumer = new AiGatewayTerminalStreamConsumer(stream.visibleOutputCeilingChars);
        let terminalFailure: AiProviderFailureClassification | null = null;
        let providerError: unknown;
        let rethrowProviderError = false;
        try {
          for await (const frame of stream.stream(abort.signal)) {
            if (frame.type === "content_delta" && frame.text.length > 0 && firstTokenMs === null) {
              firstTokenMs = Date.now() - startedAt;
            }
            const { ceilingCrossed } = consumer.note(frame);
            if (ceilingCrossed) {
              abort.abort();
              break;
            }
          }
          consumer.finish();
        } catch (error) {
          if (consumer.ceilingExceeded) {
            consumer.outcome = "failed";
          } else if (abort.signal.aborted) {
            consumer.outcome = "cancelled";
            providerError = error;
            rethrowProviderError = true;
          } else {
            consumer.outcome = "failed";
            terminalFailure = normalizeProviderStreamFailure(error, {
              provider: stream.provider,
              ...(consumer.streamedContent ? { failurePhase: "stream" as const } : {}),
            });
            providerError = error;
            rethrowProviderError = true;
          }
        }
        const totalMs = Date.now() - startedAt;
        await stream.recordTerminal(buildAiGatewayTerminalRecord(consumer, {
          outcome: consumer.outcome,
          failure: terminalFailure,
          durationMs: totalMs,
          completedAt: new Date(),
        }));
        if (rethrowProviderError) {
          throw providerError;
        }
        console.log(JSON.stringify({
          feature: options.feature,
          generationRef: stream.requestId,
          outcome: consumer.outcome,
          stopReason: consumer.stopReason,
          latencyMs: { contextAndPrepare: preparedMs, firstToken: firstTokenMs, total: totalMs },
          usage: consumer.usage,
          completionPreview: consumer.completionText.slice(0, 200),
        }, null, 2));
      } finally {
        await app.close();
      }
    });

  program
    .command("erasure:run")
    .description("Stage 28: audited break-glass erasure across hot DB, ledger partitions, and lake (dry-run default)")
    .requiredOption("--scope <scope>", "fan | page | model")
    .requiredOption("--initiated-by-user-id <id>", "immutable owner ID initiating the erasure", parseUserId)
    .option("--platform <platform>", "fan scope: onlyfans | fansly")
    .option("--ref <ref>", "fan scope: the platform-native fan id")
    .option("--page <label>", "page scope: the page label")
    .option("--model <slug>", "model scope: the model slug")
    .option("--execute", "actually erase (requires --confirm)")
    .option("--confirm <scopeRef>", "must equal the scope ref printed by the dry run")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { planErasure, executeErasure, erasureScopeRef } = await import("./services/erasure/index.ts");
        const scope = (() => {
          if (options.scope === "fan") {
            if (!options.platform || !options.ref) {
              throw new Error("fan scope requires --platform and --ref");
            }
            return { scopeType: "fan" as const, platform: options.platform, fanRef: options.ref };
          }
          if (options.scope === "page") {
            if (!options.page) {
              throw new Error("page scope requires --page");
            }
            return { scopeType: "page" as const, pageLabel: options.page };
          }
          if (options.scope === "model") {
            if (!options.model) {
              throw new Error("model scope requires --model");
            }
            return { scopeType: "model" as const, modelSlug: options.model };
          }
          throw new Error(`unknown scope: ${options.scope}`);
        })();

        const initiator = await findUserById(app.db, options.initiatedByUserId);
        if (!initiator || initiator.role !== "owner"
          || initiator.disabledAt !== null || initiator.deletedAt !== null) {
          throw new Error(`Active owner required: user ID ${options.initiatedByUserId}`);
        }
        const scopeRef = erasureScopeRef(scope);

        if (!options.execute) {
          const plan = await planErasure(app, scope);
          await insertErasureLog(app.db, {
            scopeType: scope.scopeType,
            scopeRef,
            initiatedBy: initiator.id,
            dryRun: true,
            plan: plan as unknown as Record<string, unknown>,
          });
          await recordAudit(app, {
            source: "cli",
            actorUserId: initiator.id,
            eventType: "erasure.dry_run",
            metadata: { scopeRef, totalRows: plan.totalRows },
          });
          console.log(JSON.stringify(plan, null, 2));
          console.log(`\nDRY RUN — nothing erased. To execute:\n  erasure:run ... --execute --confirm '${scopeRef}'`);
          return;
        }

        if (options.confirm !== scopeRef) {
          throw new Error(`--execute requires --confirm '${scopeRef}' (got: ${options.confirm ?? "nothing"})`);
        }
        // The service records the executed-erasure audit itself (dual-write).
        const result = await executeErasure(app, scope, { initiatedBy: initiator.id });
        console.log(JSON.stringify({ logId: result.logId, executedCounts: result.executedCounts }, null, 2));
      } finally {
        await app.close();
      }
    });

  program
    .command("tiering:restore-drill")
    .description("Stage 28: rebuild a tiered partition from Parquet alone and re-attach it")
    .requiredOption("--table <table>", "observations | domain_events")
    .requiredOption("--year <yyyy>")
    .requiredOption("--month <mm>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { runRestoreDrill } = await import("./services/tiering/index.ts");
        const result = await runRestoreDrill(app, {
          table: options.table,
          year: options.year,
          month: options.month,
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.countsMatch) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  const user = program.command("user");

  pageAdd
    .command("fansly")
    .requiredOption("--model <slug>")
    .requiredOption("--label <label>")
    .requiredOption("--session-file <file>")
    .requiredOption("--proxy-url <url>")
    .option("--proxy-username <username>")
    .option("--proxy-password <password>")
    .option("--proxy-password-file <file>")
    .option("--proxy-password-env <name>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const session = await loadFanslySessionBundleFromFile(options.sessionFile);
        const proxy = await buildProxyInput(options);
        if (!proxy) {
          throw new Error("Fansly onboarding requires --proxy-url");
        }
        const { page: created } = await onboardFanslyPage(app, {
          modelSlug: options.model,
          label: options.label,
          session,
          proxy,
        });
        await queueInitialFullSyncAfterPageCreate(app.config.databaseUrl, app, created.label);

        console.log(`Created Fansly page ${created.label} (${created.id})`);
        console.log(`Queued initial full sync for ${created.label}`);
      } finally {
        await app.close();
      }
    });

  pageAdd
    .command("onlyfans")
    .requiredOption("--model <slug>")
    .requiredOption("--label <label>")
    .requiredOption("--username <username>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        // Stage 18: no pasted tokens, no hub proxy — identity is matched
        // against the accounts connected at the OFAPI vendor.
        const { page: created } = await onboardOnlyFansPage(app, {
          modelSlug: options.model,
          label: options.label,
          username: options.username,
        });
        await queueInitialFullSyncAfterPageCreate(app.config.databaseUrl, app, created.label);

        console.log(`Created OnlyFans page ${created.label} (${created.id})`);
        console.log(`Queued initial full sync for ${created.label}`);
      } finally {
        await app.close();
      }
    });

  page
    .command("list")
    .action(async () => {
      const app = await createAppContext();
      try {
        const rows = await listPages(app);
        printRows(
          [
            "platform",
            "model",
            "label",
            "username",
            "follower_count",
            "subscriber_count",
            "last_light_sync_at",
            "last_follower_sync_at",
            "proxy",
          ],
          rows.map((row) => [
            row.platform,
            row.model,
            row.label,
            row.username,
            row.follower_count,
            row.subscriber_count,
            row.last_light_sync_at,
            row.last_follower_sync_at,
            typeof row.proxy_url === "string"
              ? formatMaskedProxyUrl({
                url: row.proxy_url,
                hasAuth: Boolean(row.proxy_has_auth),
              })
              : null,
          ]),
        );
      } finally {
        await app.close();
      }
    });

  page
    .command("set-proxy")
    .requiredOption("--page <label>")
    .requiredOption("--proxy-url <url>")
    .option("--proxy-username <username>")
    .option("--proxy-password <password>")
    .option("--proxy-password-file <file>")
    .option("--proxy-password-env <name>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await setPageProxy(app, options.page, (await buildProxyInput(options))!);
        console.log(`Updated proxy for page ${options.page}`);
      } finally {
        await app.close();
      }
    });

  page
    .command("remove-proxy")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await removePageProxy(app, options.page);
        console.log(`Removed proxy for page ${options.page}`);
      } finally {
        await app.close();
      }
    });

  page
    .command("verify")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const context = await resolvePageContext(app, options.page);
        const egressSummaryPromise = resolvePageEgressSummary({
          pageLabel: context.page.label,
          platform: context.platform,
          proxy: context.proxy,
          egressKey: context.egressKey,
        });
        if (context.platform === "fansly") {
          const verified = await refreshPageMetadata(app, context, "light");
          const recoveredAt = new Date();
          printPageEgressSummary(await egressSummaryPromise);
          await handleSuccessfulPageVerificationRecovery(app, {
            platformAccountId: context.page.id,
            pageLabel: context.page.label,
            platform: context.platform,
            recoveredAt,
          });
          console.log(
            `Verified page ${options.page}: ${verified.parsed.account.username} (${verified.parsed.account.id})`,
          );
        } else {
          // Stage 18: OnlyMonster retired — OnlyFans pages have no pasted
          // credentials to verify; their access is the OFAPI mapping.
          printPageEgressSummary(await egressSummaryPromise);
          throw new Error(
            "OnlyMonster is retired: OnlyFans pages verify via their OFAPI mapping (setPageOfapiAccountId), not pasted credentials",
          );
        }
      } finally {
        await app.close();
      }
    });

  page
    .command("proxy-ip")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const route = await resolvePageRoute(app, options.page);
        if (!route.proxy) {
          throw new Error(`Page ${options.page} has no proxy configured`);
        }

        const [proxyIp, directIp] = await Promise.all([
          lookupExitIpViaDispatcher(route.proxy),
          lookupExitIpViaDispatcher(null),
        ]);

        console.log(`Page: ${route.pageLabel}`);
        console.log(`Platform: ${route.platform}`);
        console.log(`Proxy: ${formatMaskedProxyUrl(route.proxy)}`);
        console.log(`Proxy exit IP: ${proxyIp}`);
        console.log(`Direct exit IP: ${directIp}`);
        console.log(`Differs from direct: ${proxyIp !== directIp ? "yes" : "no"}`);
      } finally {
        await app.close();
      }
    });

  const voiceProfile = program.command("voice-profile");
  voiceProfile
    .command("set")
    .description("Bind an ElevenLabs voice to a Fansly page (upsert; version auto-increments)")
    .requiredOption("--page <label>")
    .requiredOption("--voice-id <id>")
    .option("--model <model>", "ElevenLabs model id", "eleven_v3")
    .option("--stability <value>", "voice stability preset or number (stored in settings)", "natural")
    .option("--output-format <format>", "rendered audio format", "mp3_44100_128")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { version } = await setVoiceProfile(app, options.page, {
          voiceId: options.voiceId,
          model: options.model,
          stability: options.stability,
          outputFormat: options.outputFormat,
        });
        console.log(`Set voice profile for page ${options.page} (version ${version})`);
      } finally {
        await app.close();
      }
    });

  voiceProfile
    .command("show")
    .description("Print the Fansly page's voice binding (config only; no secrets)")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const profile = await showVoiceProfile(app, options.page);
        if (!profile) {
          console.log(`Page ${options.page}: no voice profile`);
          return;
        }
        console.log(`Page: ${options.page}`);
        console.log(`Voice id: ${profile.voiceId}`);
        console.log(`Model: ${profile.model}`);
        console.log(`Output format: ${profile.outputFormat}`);
        console.log(`Settings: ${JSON.stringify(profile.settings)}`);
        console.log(`Version: ${profile.version}`);
        console.log(`Updated at: ${profile.updatedAt.toISOString()}`);
      } finally {
        await app.close();
      }
    });

  voiceProfile
    .command("clear")
    .description("Remove the Fansly page's voice binding (no-op when none exists)")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await removeVoiceProfile(app, options.page);
        console.log(`Cleared voice profile for page ${options.page}`);
      } finally {
        await app.close();
      }
    });

  program
    .command("fansly:replay-probe")
    .description(
      "Stage 6 gate: probe whether core can replay Fansly earnings/order-history endpoints server-side",
    )
    .option("--page <label>", "Fansly page label; may be repeated", collectStringOption, [])
    .option("--calls <n>", "calls per family per page (default 1)", (value) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        // NaN would fire zero probes yet print the green verdict (review R1-5).
        throw new InvalidArgumentError("--calls must be a positive integer");
      }
      return parsed;
    }, 1)
    .option("--fan <accountId>", "fan account id → correlationAccountId + order-history accountIds (well-formed call)")
    .option("--media <accountMediaId>", "accountMediaId for order-history (well-formed call)")
    .option("--bundle <accountMediaBundleId>", "accountMediaBundleId for order-history (well-formed call)")
    .option(
      "--transactions-parity",
      "fire only the /earnings/transactions query-bound matrix",
    )
    .option(
      "--transactions-after <iso>",
      "non-empty lower bound for --transactions-parity",
      parseDateOption,
    )
    .option("--dry-run", "resolve contexts and print the plan without calling Fansly")
    .action(async (options) => {
      const pageLabels: string[] = options.page;
      if (pageLabels.length === 0) {
        throw new Error("fansly:replay-probe requires at least one --page <label>");
      }
      const app = await createAppContext();
      try {
        const results = await runFanslyReplayProbe(app, {
          pageLabels,
          calls: options.calls,
          dryRun: Boolean(options.dryRun),
          correlationAccountId: options.fan ?? null,
          mediaAccountIds: options.fan ?? null,
          accountMediaId: options.media ?? null,
          accountMediaBundleId: options.bundle ?? null,
          transactionsParity: Boolean(options.transactionsParity),
          transactionsAfter: options.transactionsAfter,
        });
        for (const result of results) {
          console.log(JSON.stringify(result));
        }
        console.log("");
        console.log(summarizeReplayProbe(results));
      } finally {
        await app.close();
      }
    });

  program
    .command("fansly:ws-recovery-manifest")
    .description("Read-only provenance and reader-state check for up to 20 exact retained WS messages; never prints message text")
    .requiredOption("--input <file>", "JSON with pageLabel and exact observationId/groupRef/messageRef targets")
    .action(async (options: { input: string }) => {
      const request: unknown = JSON.parse(await readFile(options.input, "utf8"));
      const app = await createAppContext();
      try { console.log(JSON.stringify(await buildFanslyWsRecoveryManifest(app, request), null, 2)); }
      finally { await app.close(); }
    });

  program
    .command("fansly:ws-policy")
    .description("Inspect B1 generation, preview an account-verified repair, or apply an exact reviewed preview")
    .requiredOption("--page <label>", "exact Fansly page label")
    .option("--preview", "read-only preview; one account/me request through the page proxy")
    .option("--apply <file>", "apply a saved preview after repeating account binding and config CAS checks")
    .action(async (options: { page: string; preview?: boolean; apply?: string }) => {
      if (options.preview && options.apply) throw new Error("Choose preview or apply");
      const app = await createAppContext();
      try {
        if (options.apply) {
          const document = JSON.parse(await readFile(options.apply, "utf8")) as { proposal?: { pageLabel?: unknown } };
          if (!document.proposal) throw new Error("Preview has no applicable repair proposal; inspect its state and blockers");
          if (document.proposal?.pageLabel !== options.page) throw new Error("Preview page does not match --page");
          console.log(JSON.stringify(await applyFanslyWsPolicyRepair(app, document.proposal)));
        } else console.log(JSON.stringify(options.preview
          ? await previewFanslyWsPolicyRepair(app, options.page)
          : await diagnoseFanslyWsHints(app, options.page), null, 2));
      } finally { await app.close(); }
    });

  program
    .command("fansly:endpoint-probe")
    .description(
      "Liveness probe for the endpoints-cover initiative: fires ONE read-only GET per WP-F9 "
        + "(`dm_commerce`) route, the [E1] bare `/post/{id}/replies`, the WP-F3 catalog routes "
        + "and [F1]'s `/it/amoie/stats` MONTH form (year/month, two months back — it prints the "
        + "served window so one run says whether the month was honoured), through the page's own "
        + "proxy. Answers 'does the server serve this to us at all' BEFORE any capture machinery "
        + "is designed around it. Writes nothing to Fansly and nothing to Postgres beyond ordinary "
        + "sync telemetry. Never issues `POST /postreply/verify` — doing so would destroy the only "
        + "question [E1] asks.",
    )
    .option("--page <label>", "Fansly page label; may be repeated", collectStringOption, [])
    .option(
      "--post <id>",
      "[E1] post id with a KNOWN visible reply. Without it [E1] is skipped, not answered — "
        + "the id is a path segment, so there is no bare form of that call.",
    )
    .option("--group <id>", "conversation id for /groups/mediaoffers (else the call fires bare)")
    .option("--fan <accountId>", "fan account id for /tips/account and /groups/mediaoffers")
    .option("--story <id>", "story id for /mediastory/views (else the call fires bare)")
    .option("--media <id>", "[F3] a known accountMedia id for /account/media?ids=")
    .option("--bundle <id>", "[F3] a known bundle id for /account/media/bundle?ids=")
    .option("--album <id>", "[F3] a known vault album id for /media/vaultnew")
    .option("--only <substr>", "fire only routes whose key contains this substring (e.g. mediaoffers)")
    .option("--ids", "print allowlisted identifier fields per list row (ids, type, price, flags — never text/URLs)")
    .option("--dry-run", "resolve page contexts and print the plan without calling Fansly")
    .action(async (options) => {
      const pageLabels: string[] = options.page;
      if (pageLabels.length === 0) {
        throw new Error("fansly:endpoint-probe requires at least one --page <label>");
      }
      const app = await createAppContext();
      try {
        const results = await runFanslyEndpointProbe(app, {
          pageLabels,
          dryRun: Boolean(options.dryRun),
          postId: options.post ?? null,
          groupId: options.group ?? null,
          fanAccountId: options.fan ?? null,
          storyId: options.story ?? null,
          mediaId: options.media ?? null,
          bundleId: options.bundle ?? null,
          albumId: options.album ?? null,
          only: options.only ?? null,
          ids: Boolean(options.ids),
        });
        for (const result of results) {
          console.log(JSON.stringify(result));
        }
        console.log("");
        console.log(summarizeEndpointProbe(results));
      } finally {
        await app.close();
      }
    });

  program
    .command("fansly:replay")
    .description(
      "Slice D: canonicalize the four parse_version-0 Fansly pull kinds (followers, subscribers, "
        + "dm_conversations, account_me) out of the journal and project them into the identity/"
        + "audience planes. Zero vendor credits. Gated by fanslyReplayMode (off/shadow/on); refuses "
        + "outright when a journal partition covering the window is detached.",
    )
    .option("--account <id>", "restrict to one internal page id", parsePositiveInt)
    .option("--kind <k>", "replayed kind; may be repeated (default: all four)", collectStringOption, [])
    .option("--from <iso>", "received_at lower bound (inclusive)")
    .option("--to <iso>", "received_at upper bound (exclusive)")
    .option("--page-size <n>", "observations per batch (default 200)", parsePositiveInt)
    .option("--max-pages <n>", "batches per run; the run is resumable (default 20)", parsePositiveInt)
    .option(
      "--after-id <n>",
      "resume after this observation id — take coverage.nextAfterId from the previous run. A "
        + "shadow run stamps nothing, so this is the only way it advances past its first batch",
      parsePositiveInt,
    )
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { runFanslyReplay } = await import("./services/fansly-replay.ts");
        const report = await runFanslyReplay(app, {
          ...(options.account !== undefined ? { accountId: options.account as number } : {}),
          ...(options.kind.length > 0 ? { kinds: options.kind as string[] } : {}),
          ...(options.from ? { from: new Date(options.from) } : {}),
          ...(options.to ? { to: new Date(options.to) } : {}),
          ...(options.pageSize !== undefined ? { pageSize: options.pageSize as number } : {}),
          ...(options.maxPages !== undefined ? { maxPages: options.maxPages as number } : {}),
          ...(options.afterId !== undefined ? { afterId: options.afterId as number } : {}),
        });
        console.log(JSON.stringify(report, null, 2));
        if (!report.refused && !report.coverage.complete) {
          console.log(
            `[partial] examined ${report.coverage.examined} of ${report.coverage.eligibleTotal} `
              + `eligible rows; resume with --after-id ${report.coverage.nextAfterId}`,
          );
        }
        if (report.refused) {
          // A detached month makes every floor this run would publish a lie.
          process.exitCode = 1;
        } else if ((report.canonicalize?.errored ?? 0) > 0) {
          // Rows that failed to append stay unstamped and are retried, but a
          // run that limped must not look like a clean one. An EMPTY detached
          // partition in the append range surfaces exactly here, one
          // ExecFindPartition 23514 per row — the preflight cannot see it,
          // because an empty partition hides no rows.
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("fansly:decode-ws")
    .description("B0: settle bounded metadata receipts from durable WS raw; no provider requests")
    .requiredOption("--page <label>", "one exact page label")
    .option("--max-batches <n>", "at most 20 retained observations per batch", "50")
    .action(async (options) => {
      const limit = Number(options.maxBatches);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new InvalidArgumentError("max-batches must be 1..1000");
      const app = await createAppContext();
      try {
        const stored = await findPageByLabel(app.db, options.page);
        if (!stored) throw new Error("Page not found");
        let decoded = 0;
        for (let batch = 0; batch < limit; batch++) {
          const count = await replayFanslyWsDecode(app.db, stored.page.id);
          decoded += count;
          if (count < 20) break;
        }
        console.log(JSON.stringify({ pageId: stored.page.id, decoded }));
      } finally { await app.close(); }
    });

  program
    .command("ofapi:bindings:reconcile")
    .description(
      "Decision 382: reconcile OFAPI custody against the live roster — seed creator ids, "
        + "rebind pages whose account died, attach same-creator accounts as history (report only by default)",
    )
    .option("--execute", "apply the reported actions (default: report without writing)")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        // The CLI is an operator act: it runs regardless of the minutely flag.
        const result = await runOfapiBindingReconcile(app, { dryRun: !options.execute, force: true });
        console.log(JSON.stringify(result, null, 2));
        if (result.skipped !== null) process.exitCode = 1;
      } finally {
        await app.close();
      }
    });

  program
    .command("events:replay")
    .description(
      "Stage 8: re-run canonicalizers over retained observations (idempotent via domain_event_keys)",
    )
    .option("--kind <k>", "observation kind; may be repeated", collectStringOption, [])
    .option("--from <iso>", "received_at lower bound (inclusive)")
    .option("--to <iso>", "received_at upper bound (exclusive)")
    .option("--account <id>", "restrict to one internal account (page) id", (v) => Number.parseInt(v, 10))
    .option("--parse-version <n>", "process observations below this parse version (default: each family's current)", (v) => Number.parseInt(v, 10))
    .option("--dry-run", "canonicalize and count without appending or stamping")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        // §3.2c(ii), up front: a drain across history aims PROVIDER-DATED
        // appends (message.material_observed, post.observed) at the months it
        // is asked to replay. If one of those months has no attached
        // domain_events partition, every such row fails ExecFindPartition
        // (23514) and is retried by every later sweep — so refuse before
        // dispatching any work, exactly as `fansly:replay` does. The engine
        // gate inside runCanonicalization still covers the rows this window
        // check cannot see; this one exists so an operator learns it in one
        // second instead of after an hour of blocked rows.
        if (!options.dryRun && (options.from || options.to)) {
          const months = replayWindowMonths(
            options.from ? new Date(options.from) : null,
            options.to ? new Date(options.to) : null,
          );
          try {
            await assertDomainEventTargetMonthsAttached(app.db, months);
          } catch (error) {
            if (error instanceof DomainEventTargetMonthsUnattachedError) {
              console.error(`REFUSED before dispatching work: ${error.message}`);
              for (const blocked of error.blocked) {
                console.error(
                  `  ${blocked.month}: ${blocked.shape}`
                    + (blocked.detachedRelations.length > 0
                      ? ` (${blocked.detachedRelations.join(", ")})`
                      : "")
                    + ` — recovery: ${blocked.recovery}`,
                );
              }
              process.exitCode = 1;
              return;
            }
            throw error;
          }
        }
        const result = await runCanonicalization(app, {
          ...(options.kind.length > 0 ? { kinds: options.kind } : {}),
          ...(options.account !== undefined ? { accountId: options.account } : {}),
          ...(options.from ? { from: new Date(options.from) } : {}),
          ...(options.to ? { to: new Date(options.to) } : {}),
          ...(options.parseVersion !== undefined ? { belowParseVersion: options.parseVersion } : {}),
          dryRun: Boolean(options.dryRun),
        });
        console.log(JSON.stringify(result));
        console.log(
          `${options.dryRun ? "[dry-run] would append" : "appended"} ${result.appended}, ` +
            `deduped ${result.deduped}, stamped ${result.stamped}, ` +
            `scanned ${result.scanned}, skipped-unmapped ${result.skippedUnmapped}, ` +
            `quarantined ${result.quarantined}, ` +
            `errored ${result.errored}, partition-blocked ${result.partitionBlocked}, binding-conflicts ${result.bindingConflicts.length}`,
        );
        if (result.partitionBlocked > 0) {
          // A run reporting partitionBlocked > 0 is a SKIPPED step, not a
          // passed one (#191/#194).
          for (const anomaly of result.partitionAnomalies) {
            console.error(
              `BLOCKED ${anomaly.family} @ ${anomaly.month} (${anomaly.shape}) — `
                + `recovery: ${anomaly.recovery}`,
            );
          }
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("corrections:backfill-fingerprints")
    .description(
      "Wave 2 preamble: fingerprint every dm_message_archive row; close emitted_* against "
        + "existing ledger claims; seed legacy provenance. MUST run (and drainOpen be sized) "
        + "BEFORE enabling OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED",
    )
    .option("--dry-run", "count without writing", false)
    .option("--batch <n>", "batch size (default 500)", (v) => Number.parseInt(v, 10))
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runDmCorrectionsFingerprintBackfill(app, {
          dryRun: Boolean(options.dryRun),
          ...(options.batch !== undefined ? { batchSize: options.batch } : {}),
        });
        console.log(JSON.stringify(result));
        console.log(
          `${options.dryRun ? "[dry-run] would fingerprint" : "fingerprinted"} ${result.fingerprinted} `
            + `(closed-in-ledger ${result.emittedClosed}, INITIAL DRAIN BOUND ${result.drainOpen} first `
            + `events, stubs skipped ${result.stubsSkipped}) of ${result.scanned} scanned`,
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("tip-contexts:backfill")
    .description(
      "Replay retained Fansly dm_messages raw payloads into exact transaction tip contexts",
    )
    .option("--account <id>", "restrict to one internal account (page) id", parsePositiveInt)
    .option("--after-id <id>", "start after this sync_raw_payloads id", parseNonnegativeInt, 0)
    .option("--batch-size <n>", "raw keyset batch size, max 5000", parsePositiveInt, 500)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runTransactionTipContextsBackfill(app, {
          afterRawPayloadId: options.afterId,
          batchSize: options.batchSize,
          ...(options.account === undefined ? {} : { accountId: options.account }),
        });
        console.log(JSON.stringify(result));
        console.log(
          `scanned ${result.rawPayloadsScanned} raw payloads in ${result.batches} batches; `
            + `parsed ${result.contextsParsed}/${result.tipItemsSeen} tip items, `
            + `upserted ${result.contextsUpserted}, unchanged ${result.contextsUnchanged}, `
            + `conflicts ${result.conversationConflicts}, rejected ${result.rejectedItems}, `
            + `erasure-fenced ${result.contextsErasureFenced}, `
            + `invalid sidecars ${result.invalidSidecars}; `
            + `last raw id ${result.lastRawPayloadId} `
            + `(frozen high-water ${result.rawHighWaterId})`,
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("corrections:intake-lineage")
    .description(
      "W2.1 (decision #123): journal the observations the reconciler cannot lineage-resolve — "
        + "verbatim from the webhook journal/snapshot when the payload survives, reconstructed "
        + "from the archive material head when it does not. Run BEFORE re-enabling "
        + "OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED",
    )
    .option("--dry-run", "count without writing", false)
    .option("--batch <n>", "batch size (default 200)", (v) => Number.parseInt(v, 10))
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runDmCorrectionsLineageIntake(app, {
          dryRun: Boolean(options.dryRun),
          ...(options.batch !== undefined ? { batchSize: options.batch } : {}),
        });
        console.log(JSON.stringify(result));
        console.log(
          `${options.dryRun ? "[dry-run] would intake" : "intaken"} ${result.journalIntaken} journal `
            + `+ ${result.materialIntaken} material (already-resolvable ${result.alreadyResolvable}, `
            + `stubs ${result.stubsSkipped}, errored ${result.errored}) of ${result.scanned} scanned`,
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("events:repair-fansly-1970")
    .description(
      "Wave 2: append superseding events (corrected timestamps from source observations) for "
        + "the Fansly 1970 message events — replay cannot heal them (msg dedup key). Idempotent; "
        + "the archive projection sweep applies the heal",
    )
    .option("--dry-run", "count without writing", false)
    .option("--account <id>", "restrict to one internal account (page) id", (v) => Number.parseInt(v, 10))
    .option("--limit <n>", "max events to scan this run", (v) => Number.parseInt(v, 10))
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runFansly1970Repair(app, {
          dryRun: Boolean(options.dryRun),
          ...(options.account !== undefined ? { accountId: options.account } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        console.log(JSON.stringify(result));
        console.log(
          `${options.dryRun ? "[dry-run] would repair" : "repaired"} ${result.repaired} `
            + `(already ${result.alreadyRepaired}, missing-obs ${result.missingObservation}, `
            + `missing-item ${result.missingItem}, out-of-range ${result.outOfRange}, `
            + `errored ${result.errored}) of ${result.scanned} scanned`,
        );
      } finally {
        await app.close();
      }
    });

  // M11. An owner-run one-off like the two below: dry-run is the default
  // (inside a READ ONLY transaction), `--execute` opts in, a re-run reports
  // zeros. It deletes queue state only and makes no Fansly call.
  program
    .command("fansly:media-stats-prune-foreign")
    .description(
      "M11: delete the never-visited media_stats queue rows of media the page does not own "
        + "(every media.observed for the ref names another account, e.g. a fan's DM media), "
        + "which the route can only ever fail. Heads and journal stay. Dry-run default; idempotent",
    )
    .option("--execute", "actually delete (default is a read-only dry-run count)")
    .option("--account <id>", "restrict to one internal account (page) id", parsePositiveInt)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runFanslyMediaStatsForeignPrune(app, {
          dryRun: !options.execute,
          ...(options.account !== undefined ? { accountId: options.account } : {}),
        });
        console.log(JSON.stringify(result));
        for (const page of result.pages) {
          console.log(`page ${page.pageId} (${page.pageLabel}): ${page.rows} (failing ${page.failing})`);
        }
        console.log(
          `${result.dryRun ? "[dry-run] would delete" : "deleted"} ${result.rows} `
            + `foreign media_stats rows (failing ${result.failing}) on ${result.pages.length} page(s)`,
        );
      } finally {
        await app.close();
      }
    });

  // J7. Owner-run one-off like M11 above: dry-run default (READ ONLY),
  // `--execute` opts in, a re-run reports zeros, no platform call.
  program
    .command("fansly:notifications-replay-read-state")
    .description(
      "J7: replay the notification.observed looks the pre-J7 head guard discarded on a "
        + "createdAt tie (below the fansly_engagement watermark) through the fixed "
        + "platform_notifications upsert, so rows first seen unread get their read state. "
        + "Touches nothing else — NOT a projection rebuild. Dry-run default; idempotent",
    )
    .option("--execute", "actually replay (default is a read-only dry-run count)")
    .option("--account <id>", "restrict to one internal account (page) id", parsePositiveInt)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runNotificationReadStateReplay(app, {
          dryRun: !options.execute,
          ...(options.account !== undefined ? { accountId: options.account } : {}),
        });
        console.log(JSON.stringify(result));
        for (const page of result.pages) {
          console.log(
            `page ${page.pageId}: ${page.events} look(s), heads ${page.heads}, `
              + `acknowledged ${page.acknowledged}, unacknowledged ${page.unacknowledged}`,
          );
        }
        console.log(
          `${result.dryRun ? "[dry-run] would move" : "moved"} ${result.heads} notification head(s) `
            + `(acknowledged ${result.acknowledged}, unacknowledged ${result.unacknowledged}; `
            + `${result.events} look(s) replayed, erasure-fenced ${result.erasureFenced}, `
            + `deferred ${result.deferred})`,
        );
        if (result.deferred > 0) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  // H2 (INC-001). Both commands are owner-run one-offs: dry-run is the
  // default (inside a READ ONLY transaction — it cannot write), `--execute`
  // opts in, a re-run reports zeros. Neither calls OFAPI.
  program
    .command("events:repair-ofapi-ppv-refs")
    .description(
      "INC-001: append superseding message.ppv_unlocked events (refs re-derived from the source "
        + "observation, original occurred_at, dedup supersedes:<id>) for the pre-2026-07-15 "
        + "events that carry the creator id as fan/conversation ref. Dry-run default; idempotent",
    )
    .option("--execute", "actually append (default is a read-only dry-run count)")
    .option("--account <id>", "restrict to one internal account (page) id", parsePositiveInt)
    .option("--limit <n>", "max candidate events to examine this run", parsePositiveInt)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runOfapiPpvRefRepair(app, {
          dryRun: !options.execute,
          ...(options.account !== undefined ? { accountId: options.account } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        console.log(JSON.stringify(result));
        console.log(
          `${result.dryRun ? "[dry-run] would repair" : "repaired"} ${result.repaired} `
            + `(already ${result.alreadyRepaired}, already-correct ${result.alreadyCorrect}, `
            + `missing-obs ${result.missingObservation}, lineage-mismatch ${result.lineageMismatch}, `
            + `body-unavailable ${result.unavailableBody}, no-chat-ref ${result.missingChatRef}, `
            + `partition-blocked ${result.partitionBlocked}, errored ${result.errored}) `
            + `of ${result.scanned} scanned`,
        );
        if (result.errored > 0 || result.partitionBlocked > 0) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("archive:backfill-ppv-purchases")
    .description(
      "INC-001: carry historical PPV purchases (unlock events + hot purchased_at) into "
        + "page_dm_messages.purchased_at, message_archive.is_opened and "
        + "dm_message_archive.is_opened. Monotonic, never inserts. Dry-run default; idempotent",
    )
    .option("--execute", "actually write (default is a read-only dry-run count)")
    .option("--account <id>", "restrict to one internal account (page) id", parsePositiveInt)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runPpvPurchaseBackfill(app, {
          dryRun: !options.execute,
          ...(options.account !== undefined ? { accountId: options.account } : {}),
        });
        console.log(JSON.stringify(result));
        console.log(
          `${result.dryRun ? "[dry-run] would mark" : "marked"}: `
            + `hot purchased_at ${result.hotPurchasedMarked}, `
            + `message_archive is_opened ${result.messageArchiveOpened}, `
            + `dm_message_archive is_opened ${result.dmArchiveOpened} `
            + `(${result.facts} purchase facts in scope)`,
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("money:repair-negations")
    .description(
      "W7.3 (A21+B4): deactivate double-negative twins and orphan negatives "
        + "(no active settled original), then rebuild spender/revenue rollups per page. "
        + "Never deletes. Run --dry-run first",
    )
    .option("--dry-run", "census only, no writes", false)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { repairNegationAnomalies } = await import("./services/money-negation-guards.ts");
        const result = await repairNegationAnomalies(app, { dryRun: Boolean(options.dryRun) });
        console.log(JSON.stringify(result));
        console.log(
          `${result.dryRun ? "[dry-run] would deactivate" : "deactivated"} `
            + `${result.dryRun ? result.pairs + result.orphans : result.deactivated} `
            + `(pairs ${result.pairs}, orphans ${result.orphans}); pages rebuilt ${result.pagesRebuilt}`,
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("observations:rejournal-collisions")
    .description(
      "W8 / E5 (A22): re-journal the pull observations swallowed by the pre-f8c4409 "
        + "chunk-constant idempotency key (2026-07-05..07-07 window) — verbatim from "
        + "sync_raw_payloads, producer 'rejournal:a22', append-only, idempotent. "
        + "Run --dry-run first; the canonicalize sweep then consumes the rows "
        + "(domain_event_keys dedup makes repeats no-ops)",
    )
    .option("--dry-run", "census only, no writes", false)
    .option("--from <iso>", "captured_at lower bound (default: the E5 window start)")
    .option("--to <iso>", "captured_at upper bound (default: the E5 window end)")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { runObservationsRejournal } = await import("./services/observations-rejournal.ts");
        const result = await runObservationsRejournal(app, {
          dryRun: Boolean(options.dryRun),
          ...(options.from ? { from: new Date(options.from) } : {}),
          ...(options.to ? { to: new Date(options.to) } : {}),
        });
        console.log(JSON.stringify(result));
        for (const [stream, counts] of Object.entries(result.perStream)) {
          console.log(
            `${stream}: raw ${counts.rawFetches}, observed ${counts.observed}, `
              + `missing ${counts.missing}, rejournaled ${counts.rejournaled}, `
              + `already ${counts.alreadyRejournaled}`,
          );
        }
        console.log(
          `${result.dryRun ? "[dry-run] would re-journal" : "re-journaled"} `
            + `${result.dryRun
              ? result.totals.missing - result.totals.alreadyRejournaled
              : result.totals.rejournaled} `
            + `(missing ${result.totals.missing}, already ${result.totals.alreadyRejournaled}) `
            + `across ${result.groupsScanned} chunk groups`,
        );
      } finally {
        await app.close();
      }
    });

  // J4. Owner-run one-off: dry-run default (READ ONLY, body reads included),
  // `--execute` opts in, a re-run writes nothing (it reports the earlier
  // run's rows as already re-journaled), no platform call.
  program
    .command("observations:rejournal-account-me")
    .description(
      "J4: re-journal the account_me captures whose observation the pre-J4 run-less key "
        + "dropped (a request journaled fewer account_me bodies than it captured) — verbatim "
        + "from sync_raw_payloads, producer 'repair:account_me', dated at capture, "
        + "append-only. Dry-run default; idempotent",
    )
    .option("--execute", "actually append (default is a read-only dry-run count)")
    .option("--account <id>", "restrict to one internal account (page) id", parsePositiveInt)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await runAccountMeRejournal(app, {
          dryRun: !options.execute,
          ...(options.account !== undefined ? { accountId: options.account } : {}),
        });
        console.log(JSON.stringify(result));
        for (const [stream, counts] of Object.entries(result.perStream)) {
          console.log(
            `${stream}: missing ${counts.missing}, re-journaled ${counts.rejournaled}, `
              + `already ${counts.alreadyRejournaled}, body-unavailable ${counts.unavailableBody}, `
              + `errored ${counts.errored}`,
          );
        }
        console.log(
          `${result.dryRun ? "[dry-run] would re-journal" : "re-journaled"} `
            + `${result.totals.rejournaled} account_me capture(s) `
            + `(missing ${result.totals.missing}, already ${result.totals.alreadyRejournaled}) `
            + `across ${result.requests} request(s); unpaired requests left alone `
            + `${result.unpairedRequests}`,
        );
        if (result.totals.errored > 0 || result.totals.unavailableBody > 0) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("ofapi:pending-reconcile")
    .description(
      "W7.4 (A47): settle-or-expire stale OFAPI pending transactions — REST rescan "
        + "(spends credits) settles what completed; whatever stays pending after a fresh "
        + "scan is retired like the Fansly anchor. Also runs daily at 03:25 UTC",
    )
    .option("--dry-run", "rescan in dry-run and report; expire nothing", false)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { runOfapiPendingReconcile } = await import("./services/ofapi-pending-reconcile.ts");
        const result = await runOfapiPendingReconcile(app, {
          mode: options.dryRun ? "dry-run" : "write",
        });
        console.log(JSON.stringify(result));
      } finally {
        await app.close();
      }
    });

  program
    .command("fansly:backscroll-report")
    .description("Stage 17 manifest: per-conversation hot vs archive coverage + cursor state")
    .action(async () => {
      const app = await createAppContext();
      try {
        const rows = await listFanslyBackscrollManifest(app.db);
        for (const row of rows) {
          console.log(JSON.stringify(row));
        }
        const complete = rows.filter((row) => row.archiveCount >= row.hotCount).length;
        console.log("");
        console.log(`conversations: ${rows.length}; archive>=hot: ${complete}; gaps: ${rows.length - complete}`);
      } finally {
        await app.close();
      }
    });

  program
    .command("grants:parity")
    .description("Stage 22: diff the access-grants projection against user_page_assignments for every user (must be exactly zero before the read-path flip)")
    .action(async () => {
      const app = await createAppContext();
      try {
        const { listUsers, listUserPageAssignments, resolveGrantedPageAssignments } = await import("@agency_hub_core/db");
        const users = await listUsers(app.db);
        let mismatchedUsers = 0;
        for (const user of users) {
          const [assignments, granted] = await Promise.all([
            listUserPageAssignments(app.db, user.id),
            resolveGrantedPageAssignments(app.db, user.id),
          ]);
          const left = assignments.map((row) => row.pageId).sort((a, b) => a - b);
          const right = granted.map((row) => row.pageId).sort((a, b) => a - b);
          const equal = left.length === right.length && left.every((id, i) => id === right[i]);
          if (!equal) {
            mismatchedUsers += 1;
            console.log(`MISMATCH ${user.username}: assignments=[${left.join(",")}] grants=[${right.join(",")}]`);
          }
        }
        console.log(mismatchedUsers === 0
          ? `PARITY OK across ${users.length} users`
          : `PARITY FAILED for ${mismatchedUsers}/${users.length} users`);
        if (mismatchedUsers > 0) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("harvest:reconcile")
    .description("Stage 12: reconcile a machine's harvest manifest against kernel observation counts")
    .requiredOption(
      "--manifest <path>",
      "canonical ...-latest.json (timestamped snapshots auto-follow a canonical sibling)",
    )
    .action(async (options) => {
      const resolvedManifest = await resolveHarvestManifest(options.manifest);
      const manifest = resolvedManifest.manifest;
      if (resolvedManifest.supersededPath !== null) {
        console.log(
          `Using canonical harvest manifest ${resolvedManifest.path} `
            + `(supersedes ${resolvedManifest.supersededPath})`,
        );
      }

      const app = await createAppContext();
      try {
        console.log(`Harvest reconciliation for machine ${manifest.machineId}`);
        let mismatches = 0;
        for (const entry of manifest.tables) {
          const counted = await countHarvestObservations(app.db, {
            machineId: manifest.machineId,
            kind: entry.kind,
          });
          // The lane counts accepted+duplicates per batch; the kernel-side
          // count must equal the WALKED rows once the machine has fully
          // drained (over-upload is free, under-upload is the only failure).
          const ok = counted === entry.walked;
          if (!ok) {
            mismatches += 1;
          }
          console.log(
            `  ${entry.kind}: walked=${entry.walked} uploaded=${entry.uploaded}`
              + ` duplicates=${entry.duplicates} kernel=${counted} ${ok ? "OK" : "MISMATCH"}`,
          );
        }
        const residue = await listHarvestTransactionResidue(app.db, {
          machineId: manifest.machineId,
          limit: 50,
        });
        console.log("");
        console.log(
          `transaction residue (harvested, no kernel counterpart): ${residue.total}`
            + (residue.total > 0 ? " — REVIEW REQUIRED (report-only; nothing was ingested)" : ""),
        );
        for (const row of residue.sample) {
          console.log(`  ${JSON.stringify(row)}`);
        }
        console.log("");
        console.log(mismatches === 0
          ? "RECONCILED: kernel holds every walked row."
          : `INCOMPLETE: ${mismatches} kind(s) mismatch — resume the harvest on this machine.`);
        if (mismatches > 0) {
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("projection:rebuild")
    .description("Stage 10/W10/WP-F1: rebuild a projection from the domain-event ledger. "
      + "The set of names comes from the PROJECTION REGISTRY "
      + "(services/projections/registry.ts), not from a hardcoded list here — a "
      + "projector nobody can rebuild is a projection you cannot repair, and the "
      + "registry is what makes forgetting one impossible. Every rebuild runs the "
      + "§3.2c(i) detached-partition preflight first; message_archive builds a SHADOW "
      + "and is never rebuilt in place (decision #134).")
    .argument(
      "<projection>",
      `projection name (${projectionNames().join(" | ")})`,
    )
    .option("--account <id>", "restrict to one internal account (page) id", (v) => Number.parseInt(v, 10))
    .action(async (projection, options) => {
      const definition = findProjection(projection);
      if (definition === null) {
        throw new Error(`Unknown projection: ${projection}. Known: ${projectionNames().join(" | ")}`);
      }
      const app = await createAppContext();
      try {
        const scope = options.account !== undefined ? { accountId: options.account } : {};
        const result = await rebuildRegisteredProjection(app, definition.name, scope);
        console.log(JSON.stringify(result, null, definition.rebuildKind === "bespoke_shadow" ? 2 : 0));
        if (definition.rebuildKind === "bespoke_shadow") {
          // W10 (decision #134): the old delete+replay rebuild was lossy — the
          // replay sees only attached domain_events partitions and the reset
          // destroyed legacy-seed rows. The shadow build lifts legacy seeds
          // verbatim, replays behind the detached-partition hard gate, and
          // NEVER touches the live table; the swap is a separate command.
          console.log(
            "Shadow build complete. Next: `archive:rebuild-verify` (must report ok), "
              + "then the owner-gated `archive:rebuild-switch --execute` "
              + "(docs/runbooks/message-archive-rebuild.md).",
          );
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("archive:rebuild-preflight")
    .description("W10 R0: message-archive rebuild census — per-account event-sourced rows, "
      + "legacy seeds by source, unrecoverable-if-dropped rows, detached-partition census")
    .option("--account <id>", "restrict to one internal account (page) id", (v) => Number.parseInt(v, 10))
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { runArchiveRebuildPreflight } = await import(
          "./services/projections/message-archive-rebuild.ts"
        );
        const scope = options.account !== undefined ? { accountId: options.account } : {};
        const result = await runArchiveRebuildPreflight(app, scope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await app.close();
      }
    });

  program
    .command("archive:rebuild-verify")
    .description("W10 R2: fidelity proof — shadow ⊇ message_archive set difference plus "
      + "per-row material comparison; nonzero missing rows exits 1 and forbids the switch")
    .option("--account <id>", "restrict to one internal account (page) id", (v) => Number.parseInt(v, 10))
    .option("--sample <n>", "max diff/missing sample rows (default 20)", (v) => Number.parseInt(v, 10))
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { verifyMessageArchiveShadow } = await import(
          "./services/projections/message-archive-rebuild.ts"
        );
        const result = await verifyMessageArchiveShadow(app, {
          ...(options.account !== undefined ? { accountId: options.account } : {}),
          ...(options.sample !== undefined ? { sampleLimit: options.sample } : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) {
          console.error(
            `VERIFICATION FAILED: ${result.missing} message_archive row(s) missing from the shadow.`,
          );
          process.exitCode = 1;
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("archive:rebuild-switch")
    .description("W10 R3 (OWNER-GATED — ask the owner before running with --execute): atomically "
      + "swap message_archive_shadow into place in ONE transaction (old table kept as "
      + "message_archive_retired_<ts>, watermark reset to the shadow's replay high-seq). "
      + "PAUSE the archive sweep worker for the window: docs/runbooks/message-archive-rebuild.md")
    .option("--execute", "actually switch (default is a dry-run report)")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { planMessageArchiveShadowSwitch, switchMessageArchiveShadow } = await import(
          "./services/projections/message-archive-rebuild.ts"
        );
        if (!options.execute) {
          const plan = await planMessageArchiveShadowSwitch(app);
          console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
          console.log(
            plan.wouldSwitch
              ? "Dry run only. Before --execute: (1) owner confirmation, (2) PAUSE the archive "
                + "sweep worker (`docker compose stop worker` on the VPS), (3) fresh "
                + "archive:rebuild-verify. Runbook: docs/runbooks/message-archive-rebuild.md"
              : "Switch would be REFUSED (missing rows) — re-run the shadow build, then verify.",
          );
          if (!plan.wouldSwitch) {
            process.exitCode = 1;
          }
          return;
        }
        const result = await switchMessageArchiveShadow(app);
        console.log(JSON.stringify(result, null, 2));
        console.log(
          `Switched. Old table kept as ${result.retiredTable} (its drop is a separate owner `
            + "decision). Resume the archive sweep worker now (`docker compose start worker`).",
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("archive:backfill")
    .description("Stage 10: idempotent archive backfills from dm_message_archive + the hot table")
    .action(async () => {
      const app = await createAppContext();
      try {
        const result = await runMessageArchiveBackfills(app);
        const swept = await runMessageArchiveProjection(app);
        console.log(JSON.stringify({ ...result, projectionAfter: swept }));
      } finally {
        await app.close();
      }
    });

  program
    .command("onlyfans-page-metadata-backfill")
    .option("--page <label>", "restrict to one page label", collectStringOption, [])
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await backfillOnlyFansPageMetadata(app, {
          pageLabels: options.page,
        });

        printRows(
          [
            "page_label",
            "status",
            "username",
            "display_name",
            "avatar_url",
            "error",
          ],
          result.pages.map((page) => [
            page.pageLabel,
            page.status,
            page.username,
            page.displayName,
            page.avatarUrl,
            page.error,
          ]),
        );

        console.log("");
        console.log(`pages=${result.totalPages}`);
        console.log(`updated=${result.updatedPages}`);
        console.log(`failed=${result.failedPages}`);
      } finally {
        await app.close();
      }
    });

  program
    .command("fansly-page-alias-backfill")
    .option("--page <label>", "restrict to one page label", collectStringOption, [])
    .option("--chunk-size <n>", "max account ids per Fansly request", parsePositiveInt, 100)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await backfillFanslyPageAliases(app, {
          pageLabels: options.page,
          chunkSize: options.chunkSize,
        });

        printRows(
          [
            "page_label",
            "memberships_scanned",
            "unique_fan_ids",
            "accounts_returned",
            "fallback_misses",
            "reconciled_accounts",
            "notes_seen",
            "notes_upserted",
            "notes_deactivated",
            "aliases_set",
            "aliases_cleared",
          ],
          result.pages.map((page) => [
            page.pageLabel,
            page.membershipsScanned,
            page.uniqueFanIds,
            page.accountsReturned,
            page.fallbackMisses,
            page.reconciledAccounts,
            page.notesSeen,
            page.notesUpserted,
            page.notesDeactivated,
            page.aliasesSet,
            page.aliasesCleared,
          ]),
        );

        console.log("");
        console.log(`pages=${result.totalPages}`);
        console.log(`memberships_scanned=${result.totalMembershipsScanned}`);
        console.log(`unique_fan_ids=${result.totalUniqueFanIds}`);
        console.log(`accounts_returned=${result.totalAccountsReturned}`);
        console.log(`fallback_misses=${result.totalFallbackMisses}`);
        console.log(`reconciled_accounts=${result.totalReconciledAccounts}`);
        console.log(`notes_seen=${result.totalNotesSeen}`);
        console.log(`notes_upserted=${result.totalNotesUpserted}`);
        console.log(`notes_deactivated=${result.totalNotesDeactivated}`);
        console.log(`aliases_set=${result.totalAliasesSet}`);
        console.log(`aliases_cleared=${result.totalAliasesCleared}`);
      } finally {
        await app.close();
      }
    });

  program
    .command("ofapi:media-locators:recover")
    .description(
      "Desktop media images: rebuild media locators from journaled webhook payloads and "
        + "captured gateway responses of the last N hours. Local only: no OFAPI request, no credits",
    )
    .option("--hours <n>", "look-back window in hours (max 720)", parsePositiveInt, 48)
    .option("--limit <n>", "max rows per source", parsePositiveInt, 20000)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { recoverOfapiMediaLocators } = await import("./services/ofapi-media-locators.ts");
        const result = await recoverOfapiMediaLocators(app, {
          hours: Math.min(options.hours, 720),
          limit: options.limit,
        });
        console.log(JSON.stringify(result));
      } finally {
        await app.close();
      }
    });

  program
    .command("ofapi-transactions-backfill")
    .description("Dry-run or apply OFAPI REST transaction backfill for OFAPI-only OnlyFans pages")
    .option("--page <label>", "page label; may be repeated", collectStringOption, [])
    .requiredOption("--from <date>", "inclusive ISO start date", parseDateOption)
    .option("--to <date>", "exclusive ISO end date", parseDateOption)
    .option("--limit <n>", "OFAPI page size, max 100", parsePositiveInt, 100)
    .option("--write", "write transactions after passing eligibility gates", false)
    .action(async (options) => {
      if (options.page.length === 0) {
        throw new Error("At least one --page <label> is required");
      }

      const app = await createAppContext();
      try {
        const result = await runOfapiTransactionsBackfill(app, {
          pageLabels: options.page,
          from: options.from,
          to: options.to ?? null,
          limit: options.limit,
          mode: options.write ? "write" : "dry-run",
        });
        printOfapiTransactionsBackfillResult(result);
      } finally {
        await app.close();
      }
    });

  sync
    .option("--page <label>")
    .option("--scope <scope>", "light|followers|data|messages|posts|all", "all")
    .option("--transactions-start <iso>", "OnlyFans-only manual rescan start", parseDateOption)
    .option("--no-wait", "queue the sync and return without waiting")
    .action(async (options) => {
      if (!options.page) {
        throw new Error("required option '--page <label>' not specified");
      }

      const app = await createAppContext();
      try {
        if (options.transactionsStart && options.scope !== "light" && options.scope !== "all") {
          throw new Error("--transactions-start is only supported with light or all sync scopes");
        }

        const route = await resolvePageRoute(app, options.page);
        const egressSummaryPromise = resolvePageEgressSummary(route);

        const boss = new PgBoss({ connectionString: app.config.databaseUrl });
        attachCliPgBossErrorLogger(boss);
        try {
          await boss.start();
          await ensureSyncQueues(boss);
          const noWait = options.wait === false || options.noWait === true;
          const request = await requestPageSync(app, boss, {
            pageLabel: options.page,
            scope: options.scope,
            reason: "manual",
            onlyFansTransactionsStart: options.transactionsStart ?? null,
          });
          printPageEgressSummary(await egressSummaryPromise);

          if (noWait) {
            console.log(`Queued ${options.scope} sync for ${options.page}`);
            return;
          }

          await waitForRequestedSyncRequests(app, {
            pageId: request.page.id,
            requests: request.requests,
          });
          console.log(`Completed ${options.scope} sync for ${options.page}`);
        } finally {
          await boss.stop().catch(() => undefined);
        }
      } finally {
        await app.close();
      }
    });

  sync
    .command("status")
    .option("--page <label>")
    .option("--watch", "watch aggregated sync monitor output")
    .option("--interval <seconds>", "watch refresh interval", parsePositiveInt, 10)
    .option("--window-hours <n>", "recent window in hours", parsePositiveInt, 24)
    .action(async (options, command) => {
      const parentOptions = command.parent?.opts() as { page?: string } | undefined;
      const page = options.page ?? parentOptions?.page;

      if (options.watch) {
        await watchSyncMonitor({
          page,
          windowHours: options.windowHours,
          intervalSeconds: options.interval,
        });
        return;
      }

      const app = await createAppContext();
      try {
        const snapshot = await getSyncMonitorSnapshot(app, {
          pageLabel: page,
          windowHours: options.windowHours,
        });
        console.log(renderSyncMonitor(snapshot));
      } finally {
        await app.close();
      }
    });

  queue
    .command("planner-recover")
    .action(async () => {
      const app = await createAppContext();
      try {
        const jobId = await queuePlannerRecovery(app.config.databaseUrl);
        if (jobId === null) {
          console.log("sync.planner is already queued or active");
          return;
        }

        console.log(`Queued sync.planner recovery job ${jobId}`);
      } finally {
        await app.close();
      }
    });

  telegram
    .command("test")
    .action(async () => {
      const app = await createAppContext();
      try {
        const result = await sendTelegramTestMessage(app);
        await insertDeliveryAttempt(app.db, {
          kind: "test",
          status: result.status,
          messageId: result.status === "sent" ? result.messageId : null,
          error: result.status === "failed"
            ? result.error
            : result.status === "skipped"
              ? result.reason
              : null,
        });
        if (result.status === "skipped") {
          console.log("Telegram is not configured; skipping");
          process.exitCode = 1;
          return;
        }

        if (result.status === "failed") {
          console.log(`Telegram test delivery failed: ${result.error}`);
          process.exitCode = 1;
          return;
        }

        console.log(`Sent Telegram test message to ${result.chatId}`);
      } finally {
        await app.close();
      }
    });

  serviceEgress
    .command("verify")
    .requiredOption(
      "--consumer <consumer>",
      "consumer to verify: elevenlabs, telegram, or all",
      parseServiceEgressConsumer,
    )
    .action(async (options: { consumer: ServiceEgressConsumerSelection }) => {
      const app = await createAppContext();
      try {
        const results = await verifyServiceEgress(app, options.consumer);
        for (const result of results) {
          console.log(
            `${result.consumer}\troute=${result.route}\tegress_key=${result.egressKey}`
              + `\texit_ip=${result.exitIp}`,
          );
        }
      } finally {
        await app.close();
      }
    });

  telegram
    .command("report")
    .action(async () => {
      const app = await createAppContext();
      try {
        const result = await sendManualDailyRevenueTelegramReport(app);
        if (result.delivery.status === "skipped") {
          console.log("Telegram is not configured; skipping");
          return;
        }

        if (result.delivery.status === "failed") {
          console.log(`Telegram daily report delivery failed: ${result.delivery.error}`);
          return;
        }

        console.log(`Sent Telegram daily report for ${result.report?.reportDate ?? "yesterday"}`);
      } finally {
        await app.close();
      }
    });

  program
    .command("status")
    .option("--page <label>")
    .option("--limit <n>", "maximum number of rows", parsePositiveInt, 20)
    .option("--run <id>", "show a detailed view for one sync run", parsePositiveInt)
    .option("--since <window>", "ISO timestamp or relative window like 30m, 6h, 2d", parseSinceOption)
    .option("--watch", "watch sync activity live")
    .action(async (options) => {
      if (options.watch) {
        await watchStatus({
          page: options.page,
          limit: options.limit,
          since: options.since,
        });
        return;
      }

      const app = await createAppContext();
      try {
        if (options.run) {
          const detail = await getStatusDetail(app, options.run);
          console.log(renderStatusDetail(detail));
          return;
        }

        const rows = await listStatus(app, {
          pageLabel: options.page,
          limit: options.limit,
          since: options.since,
        });
        printRows(
          [
            "run_id",
            "page_label",
            "stream",
            "trigger",
            "status",
            "health",
            "duration",
            "request_attempts",
            "retry_attempts",
            "failed_attempts",
            "boundary_or_scan",
            "checkpoint",
            "anomalies",
          ],
          buildStatusRows(rows),
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("fans")
    .requiredOption("--page <label>")
    .option("--limit <n>", "maximum number of rows", parsePositiveInt, 20)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const rows = await listFans(app, options.page, options.limit);
        printRows(
          [
            "rank",
            "username",
            "platform_user_id",
            "creator_net",
            "is_subscriber",
            "is_follower",
            "last_transaction_at",
          ],
          rows.map((row, index) => [
            index + 1,
            row.username,
            row.platform_user_id,
            formatUsdFromMills(row.total_creator_net_mills as bigint),
            row.is_subscriber,
            row.is_follower,
            row.last_transaction_at,
          ]),
        );
      } finally {
        await app.close();
      }
    });

  program
    .command("revenue")
    .requiredOption("--page <label>")
    .requiredOption("--period <period>")
    .option("--from <from>")
    .option("--to <to>")
    .action(async (options) => {
      const period = parsePeriod(options.period);
      const custom = period === "custom"
        ? requireCustomPeriod(options.from, options.to)
        : undefined;
      const app = await createAppContext();
      try {
        const breakdown = await getPageRevenueReport(app, options.page, {
          period,
          custom,
        });

        const totals = new Map(
          breakdown.breakdown.map((row) => [row.canonicalType, millsFromInteger(row.netAmountMills)]),
        );

        console.log(`Page: ${options.page}`);
        printRevenueTotals(totals, {
          revenueMills: breakdown.revenueMills,
          adjustmentMills: breakdown.adjustmentMills,
          unclassifiedMills: breakdown.unclassifiedMills,
          netEarningsMills: breakdown.netEarningsMills,
        }, period);
      } finally {
        await app.close();
      }
    });

  program
    .command("followers")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const rows = await listFollowers(app, options.page);
        for (const row of rows) {
          const followedAt = new Date(row.followed_at as string | Date).toISOString();
          console.log(`${row.username ?? row.platform_user_id} followed_at=${followedAt}`);
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("subscribers")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const rows = await listSubscribers(app, options.page);
        for (const row of rows) {
          const endsAt = row.ends_at
            ? new Date(row.ends_at as string | Date).toISOString()
            : "unknown";
          console.log(
            `${row.username ?? row.platform_user_id} ends=${endsAt} renew=${row.auto_renew ? "on" : "off"}`,
          );
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("fan-spend")
    .requiredOption("--page <label>")
    .requiredOption("--fan <identifier>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await fanSpendForPage(app, options.page, options.fan);
        if (!result) {
          console.log("Fan not found");
          return;
        }
        console.log(
          `${result.username ?? result.platform_user_id}: creator net ${
            formatUsdFromMills(result.total_creator_net_mills as bigint)
          }`,
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("add")
    .requiredOption("--username <username>")
    .requiredOption("--role <role>")
    .option("--password <password>")
    .option("--password-file <file>")
    .option("--password-env <name>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const role = creatableUserRoles.find((candidate) => candidate === options.role);
        if (!role) {
          throw new Error(`Invalid role: ${options.role}. Expected one of ${creatableUserRoles.join(", ")}`);
        }

        const user = await createUserAccount(app, {
          username: options.username,
          role,
          password: await readPasswordOption(options),
        }, auditContext());

        console.log(
          `Created user ${user?.username ?? options.username} (${user?.role ?? options.role})`,
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("list")
    .action(async () => {
      const app = await createAppContext();
      try {
        const users = await listUsersDetailed(app);
        printRows(
          ["id", "username", "role", "assigned_pages", "status"],
          users.map((user) => [
            user.id,
            user.username,
            user.role,
            user.assignedPages.map((page) => page.label).join(","),
            user.disabledAt ? "deactivated" : "active",
          ]),
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("deactivate")
    .requiredOption("--user-id <id>", "immutable user ID from user list", parseUserId)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await deactivateUser(app, {
          userId: options.userId,
        }, auditContext());
        console.log(
          `Deactivated ${options.userId} (revoked ${result.revokedDeviceTokens} `
          + `device token(s), ${result.revokedSessions} session(s))`,
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("delete")
    .description("Permanently delete an account and free its login; historical attribution remains")
    .requiredOption("--user-id <id>", "immutable user ID from user list", parseUserId)
    .requiredOption("--confirm-user-id <id>", "repeat the same ID to confirm permanent account removal", parseUserId)
    .action(async (options) => {
      if (options.userId !== options.confirmUserId) {
        throw new Error("--confirm-user-id must match --user-id");
      }
      const app = await createAppContext();
      try {
        const result = await deleteUser(app, { userId: options.userId }, auditContext());
        console.log(`Deleted account ID ${options.userId}; login released. Revoked `
          + `${result.revokedDeviceTokens} device token(s), `
          + `${result.revokedSessions} session(s).`);
      } finally {
        await app.close();
      }
    });

  user
    .command("reactivate")
    .requiredOption("--user-id <id>", "immutable user ID from user list", parseUserId)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await reactivateUser(app, {
          userId: options.userId,
        }, auditContext());
        console.log(`Reactivated account ID ${options.userId}; the stored password works again. Previous sign-ins remain revoked — the person signs in again on each device.`);
      } finally {
        await app.close();
      }
    });

  user
    .command("set-password")
    .requiredOption("--user-id <id>", "immutable user ID from user list", parseUserId)
    .option("--password <password>")
    .option("--password-file <file>")
    .option("--password-env <name>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const password = await readPasswordOption(options);
        if (password === undefined) {
          throw new Error("set-password requires --password, --password-file, or --password-env");
        }
        await setUserPassword(app, {
          userId: options.userId,
          password,
        }, auditContext());
        // Decision 370: this is the full reset primitive — every device token,
        // reservation and session of that person is now revoked.
        console.log(
          `Updated password for ${options.userId} — all of their sign-ins were ended`,
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("assign-page")
    .requiredOption("--user-id <id>", "immutable user ID from user list", parseUserId)
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await assignPageToUser(app, {
          userId: options.userId,
          pageLabel: options.page,
        }, auditContext());
        console.log(`Assigned ${options.userId} to ${options.page}`);
      } finally {
        await app.close();
      }
    });

  user
    .command("unassign-page")
    .requiredOption("--user-id <id>", "immutable user ID from user list", parseUserId)
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await unassignPageFromUser(app, {
          userId: options.userId,
          pageLabel: options.page,
        }, auditContext());
        console.log(`Unassigned ${options.userId} from ${options.page}`);
      } finally {
        await app.close();
      }
    });

  return program;
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  const program = buildProgram();
  program.parseAsync(process.argv).catch((error) => {
    console.error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
