import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { Command, InvalidArgumentError } from "commander";

import { issueSyncSwitchCapability } from "@agency_hub_core/db";

import { createSyncContext, type SyncContext } from "../context.ts";
import { LIVE_LOOP_ENABLED } from "../engine/host.ts";
import { createFanslyRegistry } from "../fansly/registry.ts";
import { findSyncPageByLabel } from "../inspect.ts";
import { isShadowVerdictCheck, SHADOW_RED_LINES, SHADOW_VERDICT_CHECKS } from "../report/shadow-report.ts";
import { acceptanceExitCode, checkSwitchAcceptance } from "../switch/acceptance.ts";
import { SWITCH_TIMING, type SwitchContext, type SwitchTiming } from "../switch/context.ts";
import { runSyncRollback } from "../switch/rollback.ts";
import { runSyncSwitch, runSyncSwitchOpenRequests } from "../switch/switch.ts";

// The step-3 switch CLIs (design step 3 §3.5 item 8, runbook §6):
//   pnpm cli sync switch --page P --shadow-report <path> [--dry-run]
//        [--accept-red-lines <a1,a2,a3,b5,b6,b7> --red-lines-reason "<evidence>"]
//   pnpm cli sync switch --page P --open-requests
//   pnpm cli sync switch check --page P [--page Q …] --since <iso> [--until <iso>] [--out <path>]
//   pnpm cli sync rollback --page P [--with-auth-hold]
// THE only place the switch capability is issued (I17, pinned by
// tests/sync-engine-repositories.test.ts): `handover` and `live` are
// reachable through these commands alone.
//
// Exit codes: 0 done; 2 the switch reverted to shadow (A or B timed out);
// 3 the rollback (or a revert) waits for a stop confirmation; 4 C timed out
// (the page is live with the guard handed and no owner); 5 the rollback
// refused under an auth hold; 6 the rollback waits for the page's route holds
// to end; 1 refused or failed. `switch check`: 0 every page accepted, 1 a page
// failed, 2 otherwise (inconclusive, or 429s on two routes of a page for the
// owner's review).

export interface SyncSwitchCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "rawConfig" | "logger" | "close">>;
  print(line: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** The rollback's `requestPageSync(scope 'all', reason 'recovery')`. */
  requestLegacyRecovery(pageLabel: string): Promise<void>;
  /** The process exit code (the CLI's result). */
  setExitCode(code: number): void;
  /** This build's identity (`process.env.GIT_SHA`). */
  buildSha(): string | null;
  /** TESTS ONLY: scaled waits. */
  timing?: SwitchTiming;
  /** TESTS ONLY: the live-loop constant this build has. */
  liveLoopEnabled?: boolean;
}

function defaultDeps(requestLegacyRecovery: SyncSwitchCliDeps["requestLegacyRecovery"]): SyncSwitchCliDeps {
  return {
    openContext: () => createSyncContext(),
    print: (line) => console.log(line),
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text, "utf8"),
    sleep: async (ms) => {
      await delay(ms);
    },
    requestLegacyRecovery,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    buildSha: () => process.env.GIT_SHA ?? null,
  };
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

function isoDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`expected an ISO date, got "${value}"`);
  return parsed;
}

/** `--accept-red-lines a1,b6` → the red lines, each once; a hard check or an
 *  unknown name is refused (step 3b ruling 12). */
export function parseRedLines(value: string): string[] {
  const listed = [...new Set(value.split(",").map((key) => key.trim().toLowerCase()).filter((key) => key !== ""))];
  if (listed.length === 0) throw new InvalidArgumentError(`expected red lines (${SHADOW_RED_LINES.join(", ")})`);
  for (const key of listed) {
    if (!isShadowVerdictCheck(key)) {
      throw new InvalidArgumentError(`${key} is no check of the shadow report (red lines: ${SHADOW_RED_LINES.join(", ")})`);
    }
    if (SHADOW_VERDICT_CHECKS[key] === "hard") {
      throw new InvalidArgumentError(`${key} is a hard check of the shadow report, never accepted (red lines: ${SHADOW_RED_LINES.join(", ")})`);
    }
  }
  return listed;
}

/** `--page a --page b,c` → [a, b, c]. */
function collectLabels(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(",").map((label) => label.trim()).filter((label) => label !== "")];
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

async function withSwitchContext<T>(deps: SyncSwitchCliDeps, body: (ctx: SwitchContext) => Promise<T>): Promise<T> {
  const opened = await deps.openContext();
  try {
    return await body({
      db: opened.db,
      rawConfig: opened.rawConfig,
      logger: opened.logger,
      actor: cliActor(),
      buildSha: deps.buildSha(),
      liveLoopEnabled: deps.liveLoopEnabled ?? LIVE_LOOP_ENABLED,
      timing: deps.timing ?? SWITCH_TIMING,
      print: deps.print,
      sleep: deps.sleep,
      readFile: deps.readFile,
      requestLegacyRecovery: deps.requestLegacyRecovery,
    });
  } finally {
    await opened.close();
  }
}

/** The capability of one page for one purpose (I17). */
function capabilityFor(purpose: string) {
  return (pageId: number) => issueSyncSwitchCapability({ pageId, purpose });
}

/** Add `sync switch …` and `sync rollback` to the `sync` command group. */
export function registerSyncSwitchCommands(
  sync: Command,
  deps: SyncSwitchCliDeps | { requestLegacyRecovery: SyncSwitchCliDeps["requestLegacyRecovery"] },
): void {
  const resolved: SyncSwitchCliDeps = "openContext" in deps ? deps : defaultDeps(deps.requestLegacyRecovery);

  const switchCommand = sync
    .command("switch")
    .description(
      "step 3: switch a page from the shadow engine to the live Fansly Sync Engine (resumable; "
      + "exit 2 reverted, 3 waits for a stop confirmation, 4 no live owner)",
    )
    .option("--page <label>", "the Fansly page")
    .option("--shadow-report <path>", "the accepted `sync shadow report --out` file")
    .option(
      "--accept-red-lines <checks>",
      `the owner accepts the report's failing red lines (step 3b ruling 12; of ${SHADOW_RED_LINES.join(", ")}, comma-separated; `
        + "a hard check — coverage, A4, route budgets, walks, build — never): needs --red-lines-reason, audited",
      parseRedLines,
    )
    .option("--red-lines-reason <text>", "the owner's evidence for --accept-red-lines (audited with the switch)")
    .option("--dry-run", "check every precondition and change nothing", false)
    .option("--open-requests", "the first page, once its requests opened: convert its hydration requests", false)
    // `check` takes its own --page: the parent's options come before it.
    .enablePositionalOptions()
    .action(async (options: {
      page?: string;
      shadowReport?: string;
      acceptRedLines?: string[];
      redLinesReason?: string;
      dryRun: boolean;
      openRequests: boolean;
    }) => {
      if (options.page === undefined) throw new Error("sync switch needs --page <label>");
      const reason = options.redLinesReason?.trim() ?? "";
      if (options.acceptRedLines !== undefined && reason === "") {
        throw new Error("--accept-red-lines needs --red-lines-reason \"<the owner's evidence>\" (audited with the switch)");
      }
      if (options.acceptRedLines === undefined && options.redLinesReason !== undefined) {
        throw new Error("--red-lines-reason goes with --accept-red-lines");
      }
      if (options.openRequests && options.acceptRedLines !== undefined) {
        throw new Error("--accept-red-lines judges a shadow report: it goes with --shadow-report, not --open-requests");
      }
      await withSwitchContext(resolved, async (ctx) => {
        const outcome = options.openRequests
          ? await runSyncSwitchOpenRequests(ctx, { pageLabel: options.page! })
          : await runSyncSwitch(ctx, {
            pageLabel: options.page!,
            shadowReportPath: options.shadowReport ?? null,
            acceptRedLines: options.acceptRedLines === undefined ? null : { checks: options.acceptRedLines, reason },
            dryRun: options.dryRun,
            registry: createFanslyRegistry(),
            capabilityFor: capabilityFor("sync switch"),
          });
        resolved.setExitCode(outcome.exitCode);
      });
    });

  switchCommand
    .command("check")
    .description(
      "the live-hour acceptance of switched pages (step 3b ruling 13, A6) as JSON on stdout, read-only; each page over "
      + "[T_i, T* + 1 h) (exit 0 accepted, 1 a page failed, 2 inconclusive or the owner's review)",
    )
    .option("--page <labels>", "a Fansly page; repeat it (or separate by commas) for pages switched together", collectLabels, [])
    .requiredOption("--since <iso>", "no window starts earlier: T_i = the later of this and the page's live instant", isoDate)
    .option("--until <iso>", "the window's end (default: the last page's live instant + 1 h)", isoDate)
    .option("--out <path>", "also write the JSON to this file")
    .action(async (options: { page: string[]; since: Date; until?: Date; out?: string }) => {
      if (options.page.length === 0) throw new Error("sync switch check needs --page <label>");
      await withSwitchContext(resolved, async (ctx) => {
        const pageIds: number[] = [];
        for (const label of options.page) pageIds.push((await findSyncPageByLabel(ctx.db, label)).pageId);
        const report = await checkSwitchAcceptance(ctx.db, { pageIds, since: options.since, until: options.until ?? null });
        const text = json(report);
        resolved.print(text);
        if (options.out !== undefined) await resolved.writeFile(options.out, `${text}\n`);
        resolved.setExitCode(acceptanceExitCode(report));
      });
    });

  sync
    .command("rollback")
    .description(
      "step 3: give a live (or switching) page back to the legacy engine (resumable; "
      + "exit 3 waits for a stop confirmation, 5 refused under an auth hold, 6 waits for the page's route holds to end)",
    )
    .requiredOption("--page <label>", "the Fansly page")
    .option("--with-auth-hold", "roll back although an auth/identity hold is in force (the owner's word)", false)
    .action(async (options: { page: string; withAuthHold: boolean }) => {
      await withSwitchContext(resolved, async (ctx) => {
        const outcome = await runSyncRollback(ctx, {
          pageLabel: options.page,
          withAuthHold: options.withAuthHold,
          capabilityFor: capabilityFor("sync rollback"),
        });
        resolved.setExitCode(outcome.exitCode);
      });
    });
}

/** A standalone `sync` group with the switch commands; errors throw instead of
 *  exiting (tests and tools). */
export function buildSyncSwitchCommandGroup(deps: SyncSwitchCliDeps): Command {
  const sync = new Command("sync").exitOverride();
  sync.enablePositionalOptions();
  registerSyncSwitchCommands(sync, deps);
  for (const command of sync.commands) {
    command.exitOverride();
    for (const sub of command.commands) sub.exitOverride();
  }
  return sync;
}
