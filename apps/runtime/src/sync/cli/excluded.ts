import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import type { FanslyDmMessageSyncExcludedReason } from "@agency_hub_core/shared";

import { createSyncContext, type SyncContext } from "../context.ts";
import {
  EXCLUDED_PROBE_DEFAULT_REASON,
  EXCLUDED_PROBE_DEFAULT_SAMPLE,
  EXCLUDED_PROBE_MAX_SAMPLE,
  liftExcludedChats,
  parseExclusionReason,
  readExcludedProbeReport,
  recordExcludedProbeReport,
  requestExcludedChatProbes,
  unliftExcludedChats,
} from "../excluded.ts";
import { createFanslyRegistry } from "../fansly/registry.ts";

// The owner's CLI of owner decision №8 (step-3 design S3-06, runbook §6.2 S6):
//   pnpm cli sync excluded probe  --page P [--sample 20] [--reason partner_missing_from_aggregation_accounts]
//   pnpm cli sync excluded report --page P [--reason R] [--record]
//   pnpm cli sync excluded lift   --page P --reason R --evidence-page <label>
//   pnpm cli sync excluded unlift --page P --reason R
// JSON on stdout. Probe and lift need a live page.

export interface SyncExcludedCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "close">>;
  print(line: string): void;
}

const defaultDeps: SyncExcludedCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

function reasonOption(value: string): FanslyDmMessageSyncExcludedReason {
  try {
    return parseExclusionReason(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function sampleOption(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > EXCLUDED_PROBE_MAX_SAMPLE) {
    throw new InvalidArgumentError(`Expected a sample between 1 and ${EXCLUDED_PROBE_MAX_SAMPLE}, received "${value}"`);
  }
  return parsed;
}

async function withContext<T>(deps: SyncExcludedCliDeps, body: (ctx: Pick<SyncContext, "db">) => Promise<T>): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

/** A standalone `sync` group with only these commands; errors throw (tests). */
export function buildSyncExcludedCommandGroup(deps: SyncExcludedCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  sync.enablePositionalOptions();
  registerSyncExcludedCommands(sync, deps);
  const exit = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exit(sub);
  };
  exit(sync);
  return sync;
}

export function registerSyncExcludedCommands(sync: Command, deps: SyncExcludedCliDeps = defaultDeps): void {
  const excluded = sync
    .command("excluded")
    .description("owner decision №8: probe the chats excluded from message sync on a live page, and lift the exclusion");

  excluded
    .command("probe")
    .description("one head read per sampled excluded chat of a live page (bound, visible, most recently active first)")
    .requiredOption("--page <label>", "the Fansly page (live)")
    .option("--sample <n>", `how many chats (default ${EXCLUDED_PROBE_DEFAULT_SAMPLE})`, sampleOption, EXCLUDED_PROBE_DEFAULT_SAMPLE)
    .option("--reason <reason>", `the exclusion reason (default ${EXCLUDED_PROBE_DEFAULT_REASON})`, reasonOption, EXCLUDED_PROBE_DEFAULT_REASON)
    .action(async (options: { page: string; sample: number; reason: FanslyDmMessageSyncExcludedReason }) => {
      await withContext(deps, async ({ db }) => {
        const request = await requestExcludedChatProbes(db, createFanslyRegistry(), {
          pageLabel: options.page,
          reason: options.reason,
          sample: options.sample,
          actor: cliActor(),
        });
        deps.print(json({
          page: request.pageLabel,
          reason: request.reason,
          requestAuditId: request.requestAuditId,
          probes: request.chats,
          next: `sync excluded report --page ${request.pageLabel} [--record] (each probe is one planned read of the page)`,
        }));
      });
    });

  excluded
    .command("report")
    .description("the verdicts of the page's newest probe (served / not served / pending) with the evidence ids (JSON)")
    .requiredOption("--page <label>", "the Fansly page")
    .option("--reason <reason>", "the newest probe of this reason (default: the newest probe)", reasonOption)
    .option("--record", "keep the summary as the page's evidence (audit admin.sync_dm_exclusion_probe)", false)
    .action(async (options: { page: string; reason?: FanslyDmMessageSyncExcludedReason; record: boolean }) => {
      await withContext(deps, async ({ db }) => {
        const report = await readExcludedProbeReport(db, {
          pageLabel: options.page,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        });
        const recordedAuditId = options.record ? await recordExcludedProbeReport(db, report, cliActor()) : null;
        deps.print(json({ ...report, recordedAuditId }));
      });
    });

  excluded
    .command("lift")
    .description(
      "stop applying an exclusion on a live page: its bound chats lose the reason and are synced like any chat "
      + "(needs a recorded probe with ≥ 10 chats, ≥ 80 % served, no page-level error)",
    )
    .requiredOption("--page <label>", "the Fansly page (live)")
    .requiredOption("--reason <reason>", "the exclusion reason", reasonOption)
    .requiredOption("--evidence-page <label>", "the page whose recorded probe is the evidence (this page or an earlier one)")
    .action(async (options: { page: string; reason: FanslyDmMessageSyncExcludedReason; evidencePage: string }) => {
      await withContext(deps, async ({ db }) => {
        deps.print(json(await liftExcludedChats(db, {
          pageLabel: options.page,
          reason: options.reason,
          evidencePageLabel: options.evidencePage,
          actor: cliActor(),
        })));
      });
    });

  excluded
    .command("unlift")
    .description("apply the exclusion again on a page (the next conversation list pass marks the chats)")
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--reason <reason>", "the exclusion reason", reasonOption)
    .action(async (options: { page: string; reason: FanslyDmMessageSyncExcludedReason }) => {
      await withContext(deps, async ({ db }) => {
        deps.print(json(await unliftExcludedChats(db, { pageLabel: options.page, reason: options.reason, actor: cliActor() })));
      });
    });
}
