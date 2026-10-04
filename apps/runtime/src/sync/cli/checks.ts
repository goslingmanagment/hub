import { writeFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import { acceptanceExitCode, checkLiveHour } from "../checks/live-hour.ts";
import { createSyncContext, type SyncContext } from "../context.ts";
import { findSyncPageByLabel } from "../inspect.ts";

// The engine's read-only checks (`sync/checks/`):
//   pnpm cli sync check live-hour --page P [--page Q …] --since <iso> [--until <iso>] [--out <path>]
// The check of a page's first hour on the engine, with the combined pace
// audit of both journals — `sync switch check` until step 4 (S4-21), when
// the switch and its rollback went: a page reaches `live` only by being
// onboarded since, and this judges an onboarded page the same way.
//
// Exit codes: 0 every page accepted, 1 a page failed, 2 otherwise
// (inconclusive, or 429s on two routes of a page for the owner's review).

export interface SyncCheckCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "close">>;
  print(line: string): void;
  writeFile(path: string, text: string): Promise<void>;
  /** The process exit code (the CLI's result). */
  setExitCode(code: number): void;
}

function defaultDeps(): SyncCheckCliDeps {
  return {
    openContext: () => createSyncContext(),
    print: (line) => console.log(line),
    writeFile: (path, text) => writeFile(path, text, "utf8"),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function isoDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`expected an ISO date, got "${value}"`);
  return parsed;
}

/** `--page a --page b,c` → [a, b, c]. */
function collectLabels(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(",").map((label) => label.trim()).filter((label) => label !== "")];
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

/** Add `sync check …` to the `sync` command group. */
export function registerSyncCheckCommands(sync: Command, deps: SyncCheckCliDeps = defaultDeps()): void {
  const check = sync
    .command("check")
    .description("read-only checks of the Fansly Sync Engine's live pages");

  check
    .command("live-hour")
    .description(
      "the check of a page's first hour on the engine (step 3b ruling 13, A6) as JSON on stdout, read-only; each page over "
      + "[T_i, T* + 1 h) (exit 0 accepted, 1 a page failed, 2 inconclusive or the owner's review)",
    )
    .option("--page <labels>", "a Fansly page; repeat it (or separate by commas) for pages that went live together", collectLabels, [])
    .requiredOption("--since <iso>", "no window starts earlier: T_i = the later of this and the page's live instant", isoDate)
    .option("--until <iso>", "the window's end (default: the last page's live instant + 1 h)", isoDate)
    .option("--out <path>", "also write the JSON to this file")
    .action(async (options: { page: string[]; since: Date; until?: Date; out?: string }) => {
      if (options.page.length === 0) throw new Error("sync check live-hour needs --page <label>");
      const opened = await deps.openContext();
      try {
        const pageIds: number[] = [];
        for (const label of options.page) pageIds.push((await findSyncPageByLabel(opened.db, label)).pageId);
        const report = await checkLiveHour(opened.db, { pageIds, since: options.since, until: options.until ?? null });
        const text = json(report);
        deps.print(text);
        if (options.out !== undefined) await deps.writeFile(options.out, `${text}\n`);
        deps.setExitCode(acceptanceExitCode(report));
      } finally {
        await opened.close();
      }
    });
}

/** A standalone `sync` group with the check commands; errors throw instead of
 *  exiting (tests and tools). */
export function buildSyncCheckCommandGroup(deps: SyncCheckCliDeps): Command {
  const sync = new Command("sync").exitOverride();
  sync.enablePositionalOptions();
  registerSyncCheckCommands(sync, deps);
  for (const command of sync.commands) {
    command.exitOverride();
    for (const sub of command.commands) sub.exitOverride();
  }
  return sync;
}
