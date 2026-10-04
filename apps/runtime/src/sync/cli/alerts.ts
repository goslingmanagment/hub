import { hostname } from "node:os";

import { Command } from "commander";

import { listSyncPages } from "@agency_hub_core/db";

import { fanslyWsLivePayloadResolver } from "../../services/fansly-ws/live-apply.ts";
import { createSyncContext, type SyncContext } from "../context.ts";
import { acknowledgeSyncPaceViolations, readSyncAlertStatus } from "../engine/alerts.ts";
import { createFanslyRegistry } from "../fansly/registry.ts";
import { findSyncPageByLabel } from "../inspect.ts";
import { pageLabel } from "./chain.ts";

// Owner CLI of the engine's alerts (design §9.6):
//   pnpm cli sync alerts status [--page <label>]
//   pnpm cli sync alerts ack --page <label> [--note …]
// The status is JSON on stdout.

export interface SyncAlertsCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "logger" | "close">>;
  print(line: string): void;
}

const defaultDeps: SyncAlertsCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

async function withContext<T>(
  deps: SyncAlertsCliDeps,
  body: (ctx: Pick<SyncContext, "db" | "logger">) => Promise<T>,
): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

/** A standalone `sync` group with only these commands; errors throw (tests). */
export function buildSyncAlertsCommandGroup(deps: SyncAlertsCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  registerSyncAlertsCommands(sync, deps);
  const exit = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exit(sub);
  };
  exit(sync);
  return sync;
}

/** Add `sync alerts …` to the `sync` command group. */
export function registerSyncAlertsCommands(sync: Command, deps: SyncAlertsCliDeps = defaultDeps): void {
  const alerts = sync.command("alerts").description("Fansly Sync Engine alerts (plan §10; one incident kind, five alerts)");

  alerts
    .command("status")
    .description("per page: the alert conditions that hold now and the open latches (JSON)")
    .option("--page <label>", "one page (default: every Fansly page)")
    .action(async (options: { page?: string }, command: Command) => {
      const label = pageLabel(options, command);
      await withContext(deps, async (ctx) => {
        const pages = label === undefined ? await listSyncPages(ctx.db) : [await findSyncPageByLabel(ctx.db, label)];
        deps.print(json(await readSyncAlertStatus(ctx.db, {
          registry: createFanslyRegistry(),
          pages,
          resolvePayload: fanslyWsLivePayloadResolver(ctx),
        })));
      });
    });

  alerts
    .command("ack")
    .description("the owner has looked at a page's pace violations: resolve its pace latch (an older violation never reopens it)")
    .option("--page <label>", "the Fansly page (required)")
    .option("--note <text>", "what was found (stored with the acknowledgement)")
    .action(async (options: { page?: string; note?: string }, command: Command) => {
      const label = pageLabel(options, command);
      if (label === undefined) throw new Error("required option '--page <label>' not specified");
      await withContext(deps, async (ctx) => {
        const page = await findSyncPageByLabel(ctx.db, label);
        const result = await acknowledgeSyncPaceViolations(ctx, { page, actor: cliActor(), note: options.note ?? null });
        deps.print(`${label}: pace latch ${result.wasOpen ? "resolved" : "was not open"} at ${result.acknowledgedAt.toISOString()}`);
      });
    });
}
