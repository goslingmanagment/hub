import { Command } from "commander";

import {
  createModel,
  createFanslyPage,
  findModelBySlug,
  updatePageMetadata,
} from "@fansly-connect/db";
import {
  formatUsdFromMills,
  toMills,
  type TransactionType,
} from "@fansly-connect/shared";

import { createAppContext } from "./bootstrap.ts";
import {
  fanSpendForPage,
  listSubscribers,
  revenueBreakdownForPage,
  runAllSync,
  runFollowerSync,
  runLightSync,
} from "./services/sync.ts";
import { loadSessionBundleFromFile, saveEncryptedSession, saveProxy, resolvePageContext } from "./services/page-context.ts";

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
      const model = await findModelBySlug(app.db, options.model);
      if (!model) {
        throw new Error(`Model "${options.model}" does not exist`);
      }

      const created = await createFanslyPage(app.db, {
        modelId: model.id,
        label: options.label,
      });
      const session = await loadSessionBundleFromFile(options.sessionFile);
      await saveEncryptedSession(app, created.id, session);

      if (options.proxyUrl) {
        await saveProxy(app, created.id, {
          url: options.proxyUrl,
          username: options.proxyUsername ?? null,
          password: options.proxyPassword ?? null,
        });
      }

      console.log(`Created Fansly page ${created.label} (${created.id})`);
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
        platformAccountIdValue: verified.account.id,
        username: verified.account.username,
        displayName: verified.account.displayName,
        followerCount: verified.account.followCount,
        subscriberCount: verified.account.subscriberCount,
        earningsBalanceMills: toMills(verified.account.earningsWallet?.balance ?? 0),
        metadata: {
          walls: verified.account.walls ?? [],
          subscriptionTiers: verified.account.subscriptionTiers ?? [],
        },
        syncType: "light",
      });
      console.log(`Verified page ${options.page}: ${verified.account.username} (${verified.account.id})`);
    } finally {
      await app.close();
    }
  });

program
  .command("sync")
  .requiredOption("--account <label>")
  .option("--scope <scope>", "light|followers|all", "all")
  .action(async (options) => {
    const app = await createAppContext();
    try {
      if (options.scope === "light") {
        const result = await runLightSync(app, options.account);
        console.log(`Synced ${(result.stats.transactions as { processed?: number } | undefined)?.processed ?? 0} transactions`);
        console.log(`Synced ${(result.stats.subscribers as { processed?: number } | undefined)?.processed ?? 0} subscribers`);
        return;
      }

      if (options.scope === "followers") {
        const result = await runFollowerSync(app, options.account);
        console.log(`Synced ${result.processed} followers (delta: +${result.delta})`);
        return;
      }

      const result = await runAllSync(app, options.account);
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
  .command("revenue")
  .requiredOption("--page <label>")
  .requiredOption("--period <period>")
  .option("--from <from>")
  .option("--to <to>")
  .action(async (options) => {
    const app = await createAppContext();
    try {
      const period = options.period as "today" | "7d" | "30d" | "all" | "custom";
      const breakdown = await revenueBreakdownForPage(
        app,
        options.page,
        period,
        period === "custom"
          ? { from: options.from, to: options.to }
          : undefined,
      );

      const totals = new Map(
        breakdown.rows.map((row) => [row.canonicalType, toMills(row.total)]),
      );
      const overall = Array.from(totals.values()).reduce((sum, value) => sum + value, 0n);

      console.log(`Page: ${options.page}`);
      console.log(`${options.period} net revenue: ${formatUsdFromMills(overall)}`);
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
        `${result.username ?? result.platform_user_id}: ${formatUsdFromMills(result.total_spent_mills as bigint)}`,
      );
    } finally {
      await app.close();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
