import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Command, InvalidArgumentError } from "commander";
import { PgBoss } from "pg-boss";

import {
  createModel,
  findPageByLabel,
  findUserByUsername,
  insertErasureLog,
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
  undiciRequest,
  type ProxyConfig,
  type TransactionType,
} from "@agency_hub_core/shared";

import { createAppContext } from "./bootstrap.ts";
import { backfillFanslyPageAliases } from "./services/fansly-page-alias-backfill.ts";
import { handleSuccessfulPageVerificationRecovery } from "./services/notification-incidents.ts";
import {
  runOfapiTransactionsBackfill,
  type OfapiTransactionsBackfillResult,
} from "./services/ofapi-transactions-backfill.ts";
import { backfillOnlyFansPageMetadata } from "./services/onlyfans-page-metadata-backfill.ts";
import { onboardFanslyPage, onboardOnlyFansPage } from "./services/page-onboarding.ts";
import { removePageProxy, setPageProxy } from "./services/page-proxies.ts";
import { runFanslyReplayProbe, summarizeReplayProbe } from "./services/fansly-replay-probe.ts";
import { runCanonicalization } from "./services/canonicalize-driver.ts";
import { runDmCorrectionsFingerprintBackfill } from "./services/dm-corrections-backfill.ts";
import { runDmCorrectionsLineageIntake } from "./services/dm-corrections-lineage-intake.ts";
import { runFansly1970Repair } from "./services/fansly-1970-repair.ts";
import {
  countHarvestObservations,
  listFanslyBackscrollManifest,
  listHarvestTransactionResidue,
} from "@agency_hub_core/db";
import {
  runMessageArchiveBackfills,
  runMessageArchiveProjection,
} from "./services/projections/message-archive.ts";
import { rebuildFanEarningsProjection } from "./services/projections/fan-earnings.ts";
import {
  assignPageToUser,
  createUserAccount,
  deactivateUser,
  issueChatterApiKey,
  listApiKeysForUsers,
  listUsersDetailed,
  reactivateUser,
  recordAudit,
  revokeUserApiKeys,
  setUserPassword,
  unassignPageFromUser,
} from "./services/auth.ts";
import { getModelRevenueReport, getPageRevenueReport } from "./services/reporting.ts";
import { sendManualDailyRevenueTelegramReport } from "./services/telegram-report.ts";
import { sendTelegramTestMessage } from "./services/telegram.ts";
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

function parsePositiveInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
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

  const page = program.command("page");
  const pageAdd = page.command("add");
  const sync = program.command("sync");
  sync.enablePositionalOptions();
  const queue = program.command("queue");
  const telegram = program.command("telegram");
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

  program
    .command("ai:personas-seed")
    .description("Stage 30: upsert the bundled personas into ai_personas (idempotent)")
    .action(async () => {
      const app = await createAppContext();
      try {
        const { createBundledPersonalities } = await import("./modules/ai/index.ts");
        const { upsertAiPersona } = await import("@agency_hub_core/db");
        for (const persona of createBundledPersonalities()) {
          const row = await upsertAiPersona(app.db, {
            key: persona.id,
            displayName: persona.name,
            systemBlock: persona.content,
          });
          console.log(`seeded ${row.key} (${row.displayName})`);
        }
      } finally {
        await app.close();
      }
    });

  program
    .command("ai:feature-smoke")
    .description("Stage 30: exercise a kernel AI feature end-to-end against this environment (spends provider budget)")
    .requiredOption("--feature <feature>", "fast-reply | improve-draft | help-me | fan-summary | chat-review | ping | hi-greeting")
    .requiredOption("--page <label>", "page label")
    .requiredOption("--conversation <ref>", "fan conversation ref (OF: the fan id)")
    .requiredOption("--as <username>", "chatter/owner user the generation is attributed to")
    .option("--draft <text>", "improve-draft input")
    .option("--model <model>", "gateway model override")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const { prepareAiFeatureStream } = await import("./modules/ai/index.ts");
        const user = await findUserByUsername(app.db, options.as);
        if (!user) {
          throw new Error(`unknown user: ${options.as}`);
        }
        const pageRow = await findPageByLabel(app.db, options.page);
        if (!pageRow) {
          throw new Error(`unknown page: ${options.page}`);
        }
        const startedAt = Date.now();
        // Operator smoke runs as the named user with owner-style page reach
        // (canAccessPage: owner role passes; others need the assignment).
        const principal = {
          authMethod: "api_key" as const,
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
            ...(options.model ? { model: options.model } : {}),
          },
        );
        const preparedMs = Date.now() - startedAt;
        let text = "";
        let usage: Record<string, unknown> | null = null;
        let firstTokenMs: number | null = null;
        const abort = new AbortController();
        for await (const frame of stream.stream(abort.signal)) {
          if (frame.type === "content_delta") {
            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - startedAt;
            }
            text += frame.text;
          } else if (frame.type === "usage") {
            usage = frame.usage as unknown as Record<string, unknown>;
          }
        }
        const totalMs = Date.now() - startedAt;
        await stream.recordTerminal({
          outcome: "completed",
          usage: usage as never,
          providerResponseId: null,
          cacheHit: false,
          durationMs: totalMs,
          completedAt: new Date(),
          completionText: text,
        });
        console.log(JSON.stringify({
          feature: options.feature,
          generationRef: stream.requestId,
          latencyMs: { contextAndPrepare: preparedMs, firstToken: firstTokenMs, total: totalMs },
          usage,
          completionPreview: text.slice(0, 200),
        }, null, 2));
      } finally {
        await app.close();
      }
    });

  program
    .command("erasure:run")
    .description("Stage 28: audited break-glass erasure across hot DB, ledger partitions, and lake (dry-run default)")
    .requiredOption("--scope <scope>", "fan | page | model")
    .requiredOption("--initiated-by <username>", "the owner account initiating the erasure")
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

        const initiator = await findUserByUsername(app.db, options.initiatedBy);
        if (!initiator) {
          throw new Error(`unknown user: ${options.initiatedBy}`);
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
  const apiKey = program.command("apikey");

  pageAdd
    .command("fansly")
    .requiredOption("--model <slug>")
    .requiredOption("--label <label>")
    .requiredOption("--session-file <file>")
    .option("--proxy-url <url>")
    .option("--proxy-username <username>")
    .option("--proxy-password <password>")
    .option("--proxy-password-file <file>")
    .option("--proxy-password-env <name>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const session = await loadFanslySessionBundleFromFile(options.sessionFile);
        const proxy = await buildProxyInput(options);
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
            `errored ${result.errored}`,
        );
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
    .requiredOption("--manifest <path>", "chatgoose-harvest-manifest-<machineId>-<stamp>.json")
    .action(async (options) => {
      const { readFile } = await import("node:fs/promises");
      const manifest = JSON.parse(await readFile(options.manifest, "utf8")) as {
        machineId: string;
        appVersion?: string;
        tables: Array<{
          table: string;
          kind: string;
          walked: number;
          uploaded: number;
          duplicates: number;
          minObservedAt?: string | null;
          maxObservedAt?: string | null;
        }>;
      };
      if (!manifest.machineId || !Array.isArray(manifest.tables)) {
        throw new Error("Manifest must carry machineId and tables[]");
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
      } finally {
        await app.close();
      }
    });

  program
    .command("projection:rebuild")
    .description("Stage 10: rebuild a projection from the domain-event ledger (truncate scope + replay)")
    .argument("<projection>", "projection name (fan_earnings_stats; message_archive rebuild is disabled)")
    .option("--account <id>", "restrict to one internal account (page) id", (v) => Number.parseInt(v, 10))
    .action(async (projection, options) => {
      if (projection !== "message_archive" && projection !== "fan_earnings_stats") {
        throw new Error(`Unknown projection: ${projection}`);
      }
      if (projection === "message_archive") {
        // Fast-reply freshness Wave 1 (PR1): the rebuild replays only the
        // ATTACHED domain_events parent — detached/tiered partitions are
        // invisible to it — and the reset destroys backfill_source rows that
        // have no event-ledger counterpart. Running it would silently shrink
        // the archive. Disabled until a partition-complete rebuild exists.
        throw new Error(
          "projection:rebuild message_archive is disabled: the replay only sees attached "
            + "domain_events partitions and destroys backfill_source rows (fastreply-freshness PR1)",
        );
      }
      const app = await createAppContext();
      try {
        const scope = options.account !== undefined ? { accountId: options.account } : {};
        const result = await rebuildFanEarningsProjection(app, scope);
        console.log(JSON.stringify(result));
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
    .option("--scope <scope>", "light|followers|all", "all")
    .option("--transactions-start <iso>", "OnlyFans-only manual rescan start", parseDateOption)
    .option("--no-wait", "queue the sync and return without waiting")
    .action(async (options) => {
      if (!options.page) {
        throw new Error("required option '--page <label>' not specified");
      }

      const app = await createAppContext();
      try {
        if (options.scope === "followers" && options.transactionsStart) {
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
        if (result.status === "skipped") {
          console.log("Telegram is not configured; skipping");
          return;
        }

        if (result.status === "failed") {
          console.log(`Telegram test delivery failed: ${result.error}`);
          return;
        }

        console.log(`Sent Telegram test message to ${result.chatId}`);
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
          ["username", "role", "assigned_pages", "status"],
          users.map((user) => [
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
    .requiredOption("--username <username>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await deactivateUser(app, {
          username: options.username,
        }, auditContext());
        console.log(
          `Deactivated ${options.username} (revoked ${result.revokedApiKeys} key(s), `
          + `${result.revokedDeviceTokens} device token(s), ${result.revokedSessions} session(s))`,
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("reactivate")
    .requiredOption("--username <username>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await reactivateUser(app, {
          username: options.username,
        }, auditContext());
        console.log(`Reactivated ${options.username} — password login works again; issue fresh keys if needed`);
      } finally {
        await app.close();
      }
    });

  user
    .command("set-password")
    .requiredOption("--username <username>")
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
          username: options.username,
          password,
        }, auditContext());
        console.log(`Updated password for ${options.username}`);
      } finally {
        await app.close();
      }
    });

  user
    .command("assign-page")
    .requiredOption("--username <username>")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await assignPageToUser(app, {
          username: options.username,
          pageLabel: options.page,
        }, auditContext());
        console.log(`Assigned ${options.username} to ${options.page}`);
      } finally {
        await app.close();
      }
    });

  user
    .command("unassign-page")
    .requiredOption("--username <username>")
    .requiredOption("--page <label>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await unassignPageFromUser(app, {
          username: options.username,
          pageLabel: options.page,
        }, auditContext());
        console.log(`Unassigned ${options.username} from ${options.page}`);
      } finally {
        await app.close();
      }
    });

  apiKey
    .command("create")
    .requiredOption("--username <username>")
    .option(
      "--page <label>",
      "also assign the user to this page before rotating the single API key",
    )
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const result = await issueChatterApiKey(app, {
          username: options.username,
          pageLabel: options.page,
        }, auditContext());
        console.log(result.key);
      } finally {
        await app.close();
      }
    });

  apiKey
    .command("revoke")
    .requiredOption("--username <username>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const revoked = await revokeUserApiKeys(app, {
          username: options.username,
        }, auditContext());
        console.log(`Revoked ${revoked.length} API key(s) for ${options.username}`);
      } finally {
        await app.close();
      }
    });

  apiKey
    .command("list")
    .action(async () => {
      const app = await createAppContext();
      try {
        const rows = await listApiKeysForUsers(app);
        printRows(
          ["username", "role", "key_prefix", "created_at", "last_used_at", "revoked_at"],
          rows.map((row) => [
            row.username,
            row.role,
            row.keyPrefix,
            row.createdAt,
            row.lastUsedAt,
            row.revokedAt,
          ]),
        );
      } finally {
        await app.close();
      }
    });

  apiKey
    .command("show")
    .requiredOption("--username <username>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const rows = await listApiKeysForUsers(app, [options.username]);
        printRows(
          ["username", "role", "key_prefix", "created_at", "last_used_at", "revoked_at"],
          rows.map((row) => [
            row.username,
            row.role,
            row.keyPrefix,
            row.createdAt,
            row.lastUsedAt,
            row.revokedAt,
          ]),
        );
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
