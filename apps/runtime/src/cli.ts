import { pathToFileURL } from "node:url";

import { Command } from "commander";

import {
  createModel,
  updatePageMetadata,
} from "@fansly-connect/db";
import {
  formatUsdFromMills,
  parsePeriod,
  toMills,
  type TransactionType,
} from "@fansly-connect/shared";

import { createAppContext } from "./bootstrap.ts";
import { onboardFanslyPage } from "./services/page-onboarding.ts";
import {
  fanSpendForPage,
  listFans,
  listFollowers,
  listModels,
  listPages,
  listStatus,
  listSubscribers,
  revenueBreakdownForPage,
  runAllSync,
  runFollowerSync,
  runLightSync,
} from "./services/sync.ts";
import { loadSessionBundleFromFile, resolvePageContext } from "./services/page-context.ts";

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

  const page = program.command("page");
  const pageAdd = page.command("add");

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
        const session = await loadSessionBundleFromFile(options.sessionFile);
        const proxy = options.proxyUrl
          ? {
            url: options.proxyUrl,
            username: options.proxyUsername ?? null,
            password: options.proxyPassword ?? null,
          }
          : null;
        const { page: created } = await onboardFanslyPage(app, {
          modelSlug: options.model,
          label: options.label,
          session,
          proxy,
        });

        console.log(`Created Fansly page ${created.label} (${created.id})`);
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
          ]),
        );
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
        const verified = await app.adapter.verifySession({
          session: context.session,
          proxy: context.proxy,
        });
        await updatePageMetadata(app.db, context.page.id, {
          platformAccountIdValue: verified.parsed.account.id,
          username: verified.parsed.account.username,
          displayName: verified.parsed.account.displayName,
          followerCount: verified.parsed.account.followCount,
          subscriberCount: verified.parsed.account.subscriberCount,
          earningsBalanceMills: toMills(verified.parsed.account.earningsWallet?.balance ?? 0),
          metadata: {
            walls: verified.parsed.account.walls ?? [],
            subscriptionTiers: verified.parsed.account.subscriptionTiers ?? [],
          },
          syncType: "light",
        });
        console.log(`Verified page ${options.page}: ${verified.parsed.account.username} (${verified.parsed.account.id})`);
      } finally {
        await app.close();
      }
    });

  program
    .command("sync")
    .requiredOption("--page <label>")
    .option("--scope <scope>", "light|followers|all", "all")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        if (options.scope === "light") {
          const result = await runLightSync(app, options.page);
          console.log(`Synced ${(result.stats.transactions as { processed?: number } | undefined)?.processed ?? 0} transactions`);
          console.log(`Synced ${(result.stats.subscribers as { processed?: number } | undefined)?.processed ?? 0} subscribers`);
          return;
        }

        if (options.scope === "followers") {
          const result = await runFollowerSync(app, options.page);
          console.log(`Synced ${result.processed} followers (delta: +${result.delta})`);
          return;
        }

        const result = await runAllSync(app, options.page);
        const txCount =
          (result.light.stats.transactions as { processed?: number } | undefined)?.processed ?? 0;
        console.log(`✓ Synced ${txCount} transactions`);
        console.log(
          `✓ Synced ${result.followers.processed} followers (delta: +${result.followers.delta})`,
        );
        console.log("✓ Built daily rollups");
      } finally {
        await app.close();
      }
    });

  program
    .command("status")
    .option("--page <label>")
    .option("--limit <n>", "maximum number of rows", parsePositiveInt, 20)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const rows = await listStatus(app, {
          pageLabel: options.page,
          limit: options.limit,
        });
        printRows(
          [
            "run_id",
            "page_label",
            "stream",
            "trigger",
            "status",
            "started_at",
            "finished_at",
            "error_summary",
          ],
          rows.map((row) => [
            row.runId,
            row.pageLabel,
            row.stream,
            row.trigger,
            row.status,
            row.startedAt,
            row.finishedAt,
            row.errorSummary,
          ]),
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
        const breakdown = await revenueBreakdownForPage(
          app,
          options.page,
          period,
          custom,
        );

        const totals = new Map(
          breakdown.rows.map((row) => [row.canonicalType, toMills(row.total)]),
        );
        const overall = Array.from(totals.values()).reduce((sum, value) => sum + value, 0n);

        console.log(`Page: ${options.page}`);
        console.log(`${period} net revenue: ${formatUsdFromMills(overall)}`);
        const labels: Record<TransactionType, string> = {
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

        for (const [type, label] of Object.entries(labels) as Array<
          [TransactionType, string]
        >) {
          const total = totals.get(type) ?? 0n;
          if (total === 0n) {
            continue;
          }
          console.log(`  ${label}: ${formatUsdFromMills(total)}`);
        }
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

  return program;
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  const program = buildProgram();
  program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
