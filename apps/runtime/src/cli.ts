import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { Command } from "commander";
import { PgBoss } from "pg-boss";

import {
  createModel,
} from "@agency_hub_core/db";
import {
  creatableUserRoles,
  formatMaskedProxyUrl,
  formatUsdFromMills,
  parsePeriod,
  redactSensitiveText,
  toMills,
  type TransactionType,
} from "@agency_hub_core/shared";

import { createAppContext } from "./bootstrap.ts";
import { handleSuccessfulPageVerificationRecovery } from "./services/notification-incidents.ts";
import { onboardFanslyPage, onboardOnlyFansPage } from "./services/page-onboarding.ts";
import { removePageProxy, setPageProxy } from "./services/page-proxies.ts";
import {
  assignPageToUser,
  createUserAccount,
  issueChatterApiKey,
  listApiKeysForUsers,
  listUsersDetailed,
  revokeUserApiKeys,
  setUserPassword,
  unassignPageFromUser,
} from "./services/auth.ts";
import { getModelRevenueReport, getPageRevenueReport } from "./services/reporting.ts";
import { sendManualDailyRevenueTelegramReport } from "./services/telegram-report.ts";
import { sendTelegramTestMessage } from "./services/telegram.ts";
import { loadFanslySessionBundleFromFile, loadOnlyMonsterTokenBundleFromFile } from "./services/page-context.ts";
import { requestPageSync, waitForRequestedSyncRevisions } from "./services/sync-control.ts";
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

function buildProxyInput(options: {
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
}) {
  return options.proxyUrl
    ? {
      url: options.proxyUrl,
      username: options.proxyUsername ?? null,
      password: options.proxyPassword ?? null,
    }
    : null;
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

async function queueInitialFullSyncAfterPageCreate(
  databaseUrl: string,
  app: Awaited<ReturnType<typeof createAppContext>>,
  pageLabel: string,
) {
  const boss = new PgBoss({ connectionString: databaseUrl });

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
    );
  } finally {
    await boss.stop().catch(() => undefined);
  }
}

async function queuePlannerRecovery(
  databaseUrl: string,
) {
  const boss = new PgBoss({ connectionString: databaseUrl });

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
  console.log(`  Revenue: ${formatUsdFromMills(toMills(summary.revenueMills))}`);
  console.log(`  Adjustments: ${formatUsdFromMills(toMills(summary.adjustmentMills))}`);
  console.log(`  Unclassified: ${formatUsdFromMills(toMills(summary.unclassifiedMills))}`);
  console.log(`  Net earnings: ${formatUsdFromMills(toMills(summary.netEarningsMills))}`);
  for (const [type, label] of Object.entries(revenueLabels) as Array<[TransactionType, string]>) {
    const total = totals.get(type) ?? 0n;
    if (total === 0n) {
      continue;
    }
    console.log(`  ${label}: ${formatUsdFromMills(total)}`);
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
          revenue.breakdown.map((row) => [row.canonicalType, toMills(row.netAmountMills)]),
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
            `  ${page.pageLabel}: ${formatUsdFromMills(toMills(page.netEarningsMills))}`,
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
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const session = await loadFanslySessionBundleFromFile(options.sessionFile);
        const proxy = buildProxyInput(options);
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
    .requiredOption("--token-file <file>")
    .requiredOption("--username <username>")
    .option("--proxy-url <url>")
    .option("--proxy-username <username>")
    .option("--proxy-password <password>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const auth = await loadOnlyMonsterTokenBundleFromFile(options.tokenFile);
        const proxy = buildProxyInput(options);

        const { page: created } = await onboardOnlyFansPage(app, {
          modelSlug: options.model,
          label: options.label,
          auth,
          username: options.username,
          proxy,
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
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await setPageProxy(app, options.page, buildProxyInput(options)!);
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
        if (context.platform === "fansly") {
          const verified = await refreshPageMetadata(app, context, "light");
          await handleSuccessfulPageVerificationRecovery(app, {
            platformAccountId: context.page.id,
            pageLabel: context.page.label,
            platform: context.platform,
          });
          console.log(
            `Verified page ${options.page}: ${verified.parsed.account.username} (${verified.parsed.account.id})`,
          );
        } else {
          const verified = await refreshPageMetadata(app, context, "light");
          await handleSuccessfulPageVerificationRecovery(app, {
            platformAccountId: context.page.id,
            pageLabel: context.page.label,
            platform: context.platform,
          });
          console.log(
            `Verified page ${options.page}: ${verified.parsed.account.username} (${verified.parsed.account.platform_account_id})`,
          );
        }
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

        const boss = new PgBoss({ connectionString: app.config.databaseUrl });
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

          if (noWait) {
            console.log(`Queued ${options.scope} sync for ${options.page}`);
            return;
          }

          await waitForRequestedSyncRevisions(app, {
            platformAccountId: request.page.id,
            revisions: request.revisions,
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
          breakdown.breakdown.map((row) => [row.canonicalType, toMills(row.netAmountMills)]),
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
          password: options.password,
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
          ["username", "role", "assigned_pages"],
          users.map((user) => [
            user.username,
            user.role,
            user.assignedPages.map((page) => page.label).join(","),
          ]),
        );
      } finally {
        await app.close();
      }
    });

  user
    .command("set-password")
    .requiredOption("--username <username>")
    .requiredOption("--password <password>")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        await setUserPassword(app, {
          username: options.username,
          password: options.password,
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
