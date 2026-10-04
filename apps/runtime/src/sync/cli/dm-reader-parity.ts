import { writeFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import { createSyncContext, type SyncContext } from "../context.ts";
import { runDmReaderParity, summarizeDmReaderParity } from "../parity/run.ts";
import { pageLabel, parseDurationMs } from "./chain.ts";

// Step 4, S4-06 (owner decision №11): the DM reader parity, read-only.
//   pnpm cli sync dm-reader-parity --window 1h --rounds 12 --interval 5m [--page P] [--full] --out <json>
// Runs in the worker container on the app connection (the read_only role
// cannot read these tables); every statement runs in a READ ONLY
// transaction. The full report goes to --out, the owner's summary to stdout,
// progress to stderr. Exits 1 on a fail verdict.

export interface SyncDmReaderParityCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "close">>;
  print(line: string): void;
  progress(line: string): void;
  writeReport(path: string, json: string): Promise<void>;
  setExitCode(code: number): void;
}

const defaultDeps: SyncDmReaderParityCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
  progress: (line) => console.error(line),
  writeReport: (path, json) => writeFile(path, json, "utf8"),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

/** A standalone `sync` group with only this command; errors throw (tests). */
export function buildSyncDmReaderParityCommandGroup(deps: SyncDmReaderParityCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  sync.enablePositionalOptions();
  registerSyncDmReaderParityCommands(sync, deps);
  for (const command of sync.commands) command.exitOverride();
  return sync;
}

export function registerSyncDmReaderParityCommands(sync: Command, deps: SyncDmReaderParityCliDeps = defaultDeps): void {
  sync
    .command("dm-reader-parity")
    .description(
      "Read-only (step 4, decision №11): compare every DM reader of page_dm_messages with its message_archive "
        + "variant on a sample per round; missing_in_archive fails only if it persists ≥ 2 min; JSON report to --out",
    )
    .option("--window <duration>", "start no round after this long (90s, 30m, 1h)", parseDurationMs, 3_600_000)
    .option("--rounds <n>", "rounds", positiveInt, 12)
    .option("--interval <duration>", "between round starts; the first round looks back this far", parseDurationMs, 300_000)
    .option("--page <label>", "one Fansly page (default: every page)")
    .option("--full", "also compare every Fansly hot row with its archive row", false)
    .requiredOption("--out <path>", "where the JSON report goes")
    .action(async (options: {
      window: number;
      rounds: number;
      interval: number;
      page?: string;
      full: boolean;
      out: string;
    }, command: Command) => {
      const page = pageLabel(options, command);
      const ctx = await deps.openContext();
      try {
        const report = await runDmReaderParity({ db: ctx.db, progress: deps.progress }, {
          windowMs: options.window,
          rounds: options.rounds,
          intervalMs: options.interval,
          ...(page === undefined ? {} : { pageLabel: page }),
          full: options.full,
        });
        await deps.writeReport(
          options.out,
          `${JSON.stringify(report, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
        );
        for (const line of summarizeDmReaderParity(report)) deps.print(line);
        deps.print(`  report: ${options.out}`);
        if (report.verdict === "fail") deps.setExitCode(1);
      } finally {
        await ctx.close();
      }
    });
}
