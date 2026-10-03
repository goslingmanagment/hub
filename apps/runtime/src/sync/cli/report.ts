import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import { listSyncPages } from "@agency_hub_core/db";

import { fanslyWsLivePayloadResolver } from "../../services/fansly-ws/live-apply.ts";
import { runtimeImageTag } from "../../services/runtime-heartbeat.ts";
import { createSyncContext, type SyncContext } from "../context.ts";
import { acknowledgeSyncPaceViolations, readSyncAlertStatus } from "../engine/alerts.ts";
import { createEffectiveConfigSettingsSource } from "../engine/ports.ts";
import { createFanslyRegistry } from "../fansly/registry.ts";
import { findSyncPageByLabel } from "../inspect.ts";
import { buildShadowReport } from "../report/shadow-report.ts";
import { pageLabel, parseDurationMs } from "./chain.ts";

// Owner CLI of the engine's observability (design §7.6, §3.12, §9.6):
//   pnpm cli sync shadow report --window <start>/<end> [--replay-since …]
//   pnpm cli sync alerts status [--page <label>]
//   pnpm cli sync alerts ack --page <label> [--note …]
// JSON on stdout; the report can also be written to a file (the step-3 switch
// takes it as `--shadow-report <path>`).

export interface SyncReportCliDeps {
  /** The process's context: its env config under the live overlay is what the
   *  report's module checks read, as the engine host does. */
  openContext(): Promise<Pick<SyncContext, "db" | "logger" | "rawConfig" | "close">>;
  print(line: string): void;
  writeFile(path: string, text: string): Promise<void>;
  now(): Date;
  /** This build's identity, as its heartbeat reports it (the report's
   *  fingerprint names the build that wrote it). */
  buildSha(): string | null;
}

const defaultDeps: SyncReportCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
  writeFile: (path, text) => writeFile(path, text, "utf8"),
  now: () => new Date(),
  buildSha: runtimeImageTag,
};

const HOUR_MS = 3_600_000;
const DEFAULT_CHAINS_SINCE = "2026-07-05T00:00:00Z";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

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

function isoDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`expected an ISO date, got "${value}"`);
  return parsed;
}

/** `<start>/<end>`, or `<start>` alone for one hour. */
export function parseReportWindow(value: string): { start: Date; end: Date } {
  const [startText, endText, ...rest] = value.split("/");
  if (startText === undefined || rest.length > 0) throw new InvalidArgumentError(`expected <start>/<end>, got "${value}"`);
  const start = isoDate(startText);
  const end = endText === undefined || endText === "" ? new Date(start.getTime() + HOUR_MS) : isoDate(endText);
  if (end.getTime() <= start.getTime()) throw new InvalidArgumentError("the window must end after it starts");
  return { start, end };
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

async function withContext<T>(
  deps: SyncReportCliDeps,
  body: (ctx: Pick<SyncContext, "db" | "logger" | "rawConfig">) => Promise<T>,
): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

/** A standalone `sync` group with only these commands; errors throw (tests). */
export function buildSyncReportCommandGroup(deps: SyncReportCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  registerSyncReportCommands(sync, deps);
  const exit = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exit(sub);
  };
  exit(sync);
  return sync;
}

export function registerSyncReportCommands(sync: Command, deps: SyncReportCliDeps = defaultDeps): void {
  const shadow = sync.command("shadow").description("Fansly Sync Engine shadow acceptance");

  shadow
    .command("report")
    .description(
      "Read-only: the shadow acceptance report (design §3.12) — part A over the live window (demand vs estimate, "
        + "legacy volume, live-path decisions, pacer, route budgets, walks per route, the media model), part B over the "
        + "past journal (resource replay ≥ 99.9 %, chain rebuild and end-of-history check, ETA backtest), and the "
        + "fingerprint the switch checks (build, route policy, registry and tiers, S: run it right after the window); "
        + "part B not between 00:00 and 05:00 UTC unless forced",
    )
    .option(
      "--window <start/end>",
      "part A's window, e.g. 2026-10-03T09:00Z/2026-10-03T10:00Z (a start alone: one hour); it must start once every page "
        + "has run in shadow for 10 min, else the report is no acceptance",
      parseReportWindow,
    )
    .option("--part <part>", "a, b or all", "all")
    .option("--page <label>", "one page (default: every Fansly page)")
    .option("--replay-since <iso>", "B5: replay the observations since (default: 7 days before the window end, or now)", isoDate)
    .option("--replay-min <n>", "B5: at least this many observations per kind", positiveInt, 1_000)
    .option("--replay-max <n>", "B5: at most this many observations per kind", positiveInt, 50_000)
    .option("--journal-since <iso>", "B6/B7: the /message journal since", isoDate, new Date(DEFAULT_CHAINS_SINCE))
    .option("--batch-rows <n>", "journal rows per read", positiveInt, 500)
    .option("--sleep-ms <n>", "pause between batches", nonNegativeInt, 200)
    .option("--max-duration <duration>", "stop part B after this long (90s, 30m, 2h)", parseDurationMs)
    .option("--max-listed <n>", "cap of every listed example", positiveInt, 50)
    .option("--force-window", "run part B inside the 00:00–05:00 UTC legacy night window")
    .option("--out <path>", "also write the JSON report to this file")
    .action(async (options: {
      window?: { start: Date; end: Date };
      part: string;
      page?: string;
      replaySince?: Date;
      replayMin: number;
      replayMax: number;
      journalSince: Date;
      batchRows: number;
      sleepMs: number;
      maxDuration?: number;
      maxListed: number;
      forceWindow?: boolean;
      out?: string;
    }, command: Command) => {
      if (!["a", "b", "all"].includes(options.part)) throw new Error("--part is a, b or all");
      const partA = options.part !== "b";
      const partB = options.part !== "a";
      if (partA && options.window === undefined) throw new Error("part A needs --window <start>/<end> (or --part b)");
      const label = pageLabel(options, command);
      const now = deps.now();
      await withContext(deps, async (ctx) => {
        const pages = label === undefined ? await listSyncPages(ctx.db) : [await findSyncPageByLabel(ctx.db, label)];
        const report = await buildShadowReport(ctx, {
          pages,
          registry: createFanslyRegistry(),
          window: partA ? options.window! : null,
          journal: partB
            ? {
              replaySince: options.replaySince ?? new Date((options.window?.end ?? now).getTime() - 7 * 24 * HOUR_MS),
              replayMinPerKind: options.replayMin,
              replayMaxPerKind: options.replayMax,
              chainsSince: options.journalSince,
              pacing: {
                batchRows: options.batchRows,
                sleepMs: options.sleepMs,
                maxDurationMs: options.maxDuration ?? null,
                forceWindow: options.forceWindow === true,
              },
            }
            : null,
          maxListed: options.maxListed,
          resolvePayload: fanslyWsLivePayloadResolver(ctx),
          settings: createEffectiveConfigSettingsSource(ctx.db, ctx.rawConfig),
          reportBuild: deps.buildSha(),
        });
        const text = json(report);
        if (options.out !== undefined) await deps.writeFile(options.out, `${text}\n`);
        deps.print(text);
      });
    });

  const alerts = sync.command("alerts").description("Fansly Sync Engine alerts (plan §10; one incident kind, five alerts)");

  alerts
    .command("status")
    .description("per page: the alert conditions that hold now (shadow: metrics only) and the open latches (JSON)")
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
