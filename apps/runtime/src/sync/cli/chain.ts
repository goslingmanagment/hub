import { InvalidArgumentError, type Command } from "commander";

import { listSyncPages, readThreadChain, type SyncPageRow } from "@agency_hub_core/db";

import { createAppContext } from "../../bootstrap.ts";
import { checkEndRule, checkWindow, type EndRulePageReport } from "../fansly/lib/chain-checks.ts";
import {
  ChainRebuildRefusedError,
  rebuildPageChains,
  ScanGovernor,
  type ChainRebuildPageReport,
} from "../fansly/lib/chain-rebuild.ts";

// Owner CLI `pnpm cli sync chain …` (design §7.6, §8.2, §8.3): the DM chain
// rebuild from the legacy journal and its read-only checks. JSON reports on
// stdout, progress on stderr.

const DEFAULT_SINCE = "2026-07-05T00:00:00Z";

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function nonNegativeInt(value: string): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`expected a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/** `90s`, `30m`, `2h`, or plain seconds. */
export function parseDurationMs(value: string): number {
  const match = /^([0-9]+)([smh]?)$/.exec(value.trim());
  if (!match) throw new InvalidArgumentError(`expected a duration like 90s, 30m or 2h, got "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000;
  if (amount <= 0) throw new InvalidArgumentError("the duration must be positive");
  return amount * unit;
}

function isoDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`expected an ISO date, got "${value}"`);
  return parsed;
}

type AppContext = Awaited<ReturnType<typeof createAppContext>>;

/** The Fansly pages a run covers: `--page`, the page of `--thread`, or all. */
async function resolvePages(
  app: AppContext,
  options: { page?: string; thread?: number },
): Promise<{ pages: SyncPageRow[]; threadId?: number }> {
  const pages = await listSyncPages(app.db);
  if (options.thread !== undefined) {
    const thread = await readThreadChain(app.db, options.thread);
    if (thread === null) throw new Error(`No DM thread ${options.thread}`);
    const page = pages.find((row) => row.pageId === thread.pageId);
    if (!page) throw new Error(`Thread ${options.thread} is not on a Fansly page`);
    if (options.page !== undefined && page.pageLabel !== options.page) {
      throw new Error(`Thread ${options.thread} belongs to ${page.pageLabel ?? page.pageId}, not ${options.page}`);
    }
    return { pages: [page], threadId: options.thread };
  }
  if (options.page !== undefined) {
    const page = pages.find((row) => row.pageLabel === options.page);
    if (!page) throw new Error(`No Fansly page labelled ${options.page}`);
    return { pages: [page] };
  }
  return { pages };
}

/**
 * `--page` of a `sync chain` command. The root program is not positional, so
 * commander splits `sync chain rebuild --page x` at the root and the `sync`
 * command (which has its own `--page`) takes the value; `sync status` reads it
 * the same way.
 */
export function pageLabel(options: { page?: string }, command: Command): string | undefined {
  if (options.page !== undefined) return options.page;
  for (let parent = command.parent; parent; parent = parent.parent) {
    const inherited = (parent.opts() as { page?: unknown }).page;
    if (typeof inherited === "string") return inherited;
  }
  return undefined;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function registerSyncChainCommands(sync: Command): void {
  const chain = sync
    .command("chain")
    .description("Fansly Sync Engine DM chains: rebuild from the legacy journal and its read-only checks");

  chain
    .command("rebuild")
    .description(
      "Re-prove DM chains from the legacy /message journal (no Fansly request). Dry run unless --write; "
        + "writes only the chain columns; refuses handover/live pages; not between 00:00 and 05:00 UTC",
    )
    .option("--page <label>", "one page (default: every Fansly page)")
    .option("--thread <id>", "one thread (page_dm_threads.id)", positiveInt)
    .option("--write", "write the rebuilt chains (default: dry run)")
    .option("--full", "ignore earlier rebuilds and fold the whole journal from empty chains")
    .option("--batch-rows <n>", "journal rows per read", positiveInt, 500)
    .option("--sleep-ms <n>", "pause between batches", nonNegativeInt, 200)
    .option("--max-duration <duration>", "stop after this long (90s, 30m, 2h)", parseDurationMs)
    .option("--force-window", "run inside the 00:00–05:00 UTC legacy night window")
    .action(async (options: {
      page?: string;
      thread?: number;
      write?: boolean;
      full?: boolean;
      batchRows: number;
      sleepMs: number;
      maxDuration?: number;
      forceWindow?: boolean;
    }, command: Command) => {
      const page = pageLabel(options, command);
      const app = await createAppContext();
      try {
        const { pages, threadId } = await resolvePages(app, {
          ...(page === undefined ? {} : { page }),
          ...(options.thread === undefined ? {} : { thread: options.thread }),
        });
        const refused = pages.filter((page) => page.mode === "handover" || page.mode === "live");
        if (refused.length > 0) {
          throw new ChainRebuildRefusedError(refused[0]!.pageId, refused[0]!.mode);
        }
        const pacing = {
          batchRows: options.batchRows,
          sleepMs: options.sleepMs,
          maxDurationMs: options.maxDuration ?? null,
          forceWindow: options.forceWindow === true,
        };
        const governor = new ScanGovernor(pacing);
        const reports: ChainRebuildPageReport[] = [];
        for (const target of pages) {
          const report = await rebuildPageChains(app, {
            ...pacing,
            pageId: target.pageId,
            ...(threadId === undefined ? {} : { threadId }),
            write: options.write === true,
            full: options.full === true,
            audit: { source: "cli", actorUserId: null },
            onBatch: (progress) => {
              console.error(
                `[sync chain rebuild] ${target.pageLabel ?? target.pageId}: through raw ${progress.throughRawId}, `
                  + `${progress.rowsScanned} rows, ${progress.batches} batches`,
              );
            },
          }, governor);
          reports.push(report);
          if (report.scan.stoppedBy !== null) break;
        }
        print({ write: options.write === true, full: options.full === true, pages: reports });
      } finally {
        await app.close();
      }
    });

  chain
    .command("check-end-rule")
    .description(
      "Read-only: short-page counterexamples, empty-page soundness, the first-second heuristic and legacy "
        + "verdicts over the legacy /message journal (design §8.3)",
    )
    .option("--since <iso>", "journal rows captured since", isoDate, new Date(DEFAULT_SINCE))
    .option("--page <label>", "one page (default: every Fansly page)")
    .option("--batch-rows <n>", "journal rows per read", positiveInt, 500)
    .option("--sleep-ms <n>", "pause between batches", nonNegativeInt, 200)
    .option("--max-listed <n>", "cap of each detailed list", positiveInt, 1000)
    .option("--force-window", "run inside the 00:00–05:00 UTC legacy night window")
    .action(async (options: {
      since: Date;
      page?: string;
      batchRows: number;
      sleepMs: number;
      maxListed: number;
      forceWindow?: boolean;
    }, command: Command) => {
      const page = pageLabel(options, command);
      const app = await createAppContext();
      try {
        const { pages } = await resolvePages(app, page === undefined ? {} : { page });
        const pacing = {
          batchRows: options.batchRows,
          sleepMs: options.sleepMs,
          maxDurationMs: null,
          forceWindow: options.forceWindow === true,
        };
        const governor = new ScanGovernor(pacing);
        const reports: EndRulePageReport[] = [];
        for (const target of pages) {
          const report = await checkEndRule(app, {
            ...pacing,
            pageId: target.pageId,
            since: options.since,
            maxListed: options.maxListed,
          }, governor);
          reports.push(report);
          if (report.scan.stoppedBy !== null) break;
        }
        const listing = {
          since: options.since.toISOString(),
          counterexampleRawIds: reports.flatMap((report) => report.shortPages.counterexampleRawIds).sort((a, b) => a - b),
          pages: reports,
        };
        print(listing);
      } finally {
        await app.close();
      }
    });

  chain
    .command("check-window")
    .description(
      "Read-only: compare the stored-window columns of a page's threads with the window recomputed from "
        + "their messages (the drift check of the engine's incremental legacy summary)",
    )
    .option("--page <label>", "the page (required)")
    .option("--thread <id>", "one thread (page_dm_threads.id)", positiveInt)
    .option("--max-threads <n>", "check at most this many threads", positiveInt, 100_000)
    .option("--max-listed <n>", "cap of the drift examples", positiveInt, 200)
    .action(async (options: { page?: string; thread?: number; maxThreads: number; maxListed: number }, command: Command) => {
      const page = pageLabel(options, command);
      if (page === undefined) throw new Error("required option '--page <label>' not specified");
      const app = await createAppContext();
      try {
        const { pages, threadId } = await resolvePages(app, {
          page,
          ...(options.thread === undefined ? {} : { thread: options.thread }),
        });
        print(await checkWindow(app, {
          pageId: pages[0]!.pageId,
          ...(threadId === undefined ? {} : { threadId }),
          maxThreads: options.maxThreads,
          maxListed: options.maxListed,
        }));
      } finally {
        await app.close();
      }
    });
}
