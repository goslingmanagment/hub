import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import { HISTORY_ITEM_STATES, HISTORY_REQUEST_STATES, listSyncPages, type HistoryItemState, type HistoryRequestState } from "@agency_hub_core/db";

import { createSyncContext, type SyncContext } from "../context.ts";
import { ScanGovernor } from "../fansly/lib/chain-rebuild.ts";
import { findSyncPageByLabel } from "../inspect.ts";
import { backtestPageEta, type EtaBacktestPageReport } from "../requests/eta-backtest.ts";
import {
  cancelHistoryRequest,
  getHistoryRequest,
  HistoryRequestError,
  listHistoryRequestViews,
  submitHistoryRequest,
  type HistoryDepthInput,
} from "../requests/history.ts";
import type { HistoryFanInput } from "../requests/history-rules.ts";
import { pageLabel, parseDurationMs } from "./chain.ts";

// Owner CLI `pnpm cli sync history …` (design §7.6): file, read, cancel and
// list history requests, and the ETA backtest over the legacy journal. The
// same service functions as the owner routes; requests are refused with 409
// on every page that is not live (all of step 2). JSON on stdout.

export interface SyncHistoryCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "rawConfig" | "logger" | "close">>;
  print(line: string): void;
  readFile(path: string): Promise<string>;
  /** A refusal (400/404/409) is printed as JSON and fails the command. */
  setExitCode(code: number): void;
}

const defaultDeps: SyncHistoryCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
  readFile: (path) => readFile(path, "utf8"),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

const DEFAULT_SINCE = "2026-07-05T00:00:00Z";

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

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function oneOf<T extends string>(allowed: readonly T[], what: string) {
  return (value: string, previous: T[] = []): T[] => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new InvalidArgumentError(`${what} must be one of ${allowed.join(", ")}, got "${value}"`);
    }
    return [...previous, value as T];
  };
}

/**
 * One fan per line of a list file: a Fansly chat link (`…fansly.com/messages/<id>`)
 * is a chat, `conversation:<id>` a conversation ref, anything else a fan's
 * account id. Blank lines and `#` comments are skipped.
 */
export function parseFanListFile(text: string): HistoryFanInput[] {
  const fans: HistoryFanInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ref = line.trim();
    if (ref === "" || ref.startsWith("#")) continue;
    if (ref.toLowerCase().includes("fansly.com/")) fans.push({ kind: "chat_url", url: ref });
    else if (ref.startsWith("conversation:")) fans.push({ kind: "conversation", conversationRef: ref.slice("conversation:".length) });
    else fans.push({ kind: "fan", platformUserId: ref });
  }
  return fans;
}

async function withContext<T>(
  deps: SyncHistoryCliDeps,
  body: (ctx: Pick<SyncContext, "db" | "rawConfig" | "logger">) => Promise<T>,
): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } catch (error) {
    // A refusal is an answer, not a crash: print it as the routes would.
    if (error instanceof HistoryRequestError) {
      deps.print(json({ error: { status: error.status, code: error.code, message: error.message, ...error.detail } }));
      deps.setExitCode(1);
      return undefined as T;
    }
    throw error;
  } finally {
    await ctx.close();
  }
}

/** A standalone `sync` group with only the history commands; errors throw
 *  instead of exiting (tests). */
export function buildSyncHistoryCommandGroup(deps: SyncHistoryCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  registerSyncHistoryCommands(sync, deps);
  const exit = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exit(sub);
  };
  exit(sync);
  return sync;
}

export function registerSyncHistoryCommands(sync: Command, deps: SyncHistoryCliDeps = defaultDeps): void {
  const history = sync
    .command("history")
    .description("Fansly Sync Engine history requests (live pages only; others answer 409)");

  history
    .command("request")
    .description("file a history request for up to 1000 fans of one page (JSON)")
    .option("--page <label>", "the Fansly page (required)")
    .option("--fan <id>", "a fan's Fansly account id (repeatable)", collect, [])
    .option("--conversation <id>", "a chat's Fansly group id (repeatable)", collect, [])
    .option("--chat-url <url>", "a chat link https://fansly.com/messages/<id> (repeatable)", collect, [])
    .option("--file <path>", "one fan per line (account id, chat link, or conversation:<id>)")
    .option("--all", "the whole chat, proven to its first message", false)
    .option("--latest <n>", "the latest N messages of each chat", positiveInt)
    .requiredOption("--reason <text>", "why (stored as a digest)")
    .option("--idempotency-key <uuid>", "repeat-safe key (default: a new one)")
    .action(async (options: {
      page?: string;
      fan: string[];
      conversation: string[];
      chatUrl: string[];
      file?: string;
      all: boolean;
      latest?: number;
      reason: string;
      idempotencyKey?: string;
    }, command: Command) => {
      const label = pageLabel(options, command);
      if (label === undefined) throw new Error("required option '--page <label>' not specified");
      if (options.all === (options.latest !== undefined)) throw new Error("say the depth: --all or --latest <n>");
      const fans: HistoryFanInput[] = [
        ...options.fan.map((platformUserId): HistoryFanInput => ({ kind: "fan", platformUserId })),
        ...options.conversation.map((conversationRef): HistoryFanInput => ({ kind: "conversation", conversationRef })),
        ...options.chatUrl.map((url): HistoryFanInput => ({ kind: "chat_url", url })),
        ...(options.file === undefined ? [] : parseFanListFile(await deps.readFile(options.file))),
      ];
      if (fans.length === 0) throw new Error("name at least one fan: --fan, --conversation, --chat-url or --file");
      if (fans.length > 1000) throw new Error(`at most 1000 fans per request (got ${fans.length}); split the list by page and chunk`);
      const depth: HistoryDepthInput = options.latest === undefined ? { kind: "all" } : { kind: "latest", count: options.latest };
      await withContext(deps, async (ctx) => {
        const page = await findSyncPageByLabel(ctx.db, label);
        const result = await submitHistoryRequest(ctx, {
          pageId: page.pageId,
          requester: { kind: "owner_cli", userId: null },
          fans,
          depth,
          reason: options.reason,
          idempotencyKey: options.idempotencyKey ?? randomUUID(),
        }, { audit: { source: "cli", actorUserId: null } });
        deps.print(json(result));
      });
    });

  history
    .command("status")
    .description("one request: counts, reads, ETA and a page of its fans (JSON)")
    .requiredOption("--request <ref>", "the request ref")
    .option("--state <state>", `only fans in this state (${HISTORY_ITEM_STATES.join(", ")}; repeatable)`, oneOf(HISTORY_ITEM_STATES, "--state"), [])
    .option("--limit <n>", "fans per page (≤ 200)", positiveInt, 200)
    .option("--after <ordinal>", "fans after this ordinal (the previous page's nextAfterOrdinal)", nonNegativeInt)
    .action(async (options: { request: string; state: HistoryItemState[]; limit: number; after?: number }) => {
      await withContext(deps, async (ctx) => {
        deps.print(json(await getHistoryRequest(ctx, options.request, {
          limit: options.limit,
          afterOrdinal: options.after ?? null,
          ...(options.state.length === 0 ? {} : { states: options.state }),
        })));
      });
    });

  history
    .command("cancel")
    .description("cancel a request: its fans stop being read, what was loaded stays (JSON)")
    .requiredOption("--request <ref>", "the request ref")
    .option("--reason <text>", "why (stored as a digest)")
    .action(async (options: { request: string; reason?: string }) => {
      await withContext(deps, async (ctx) => {
        deps.print(json(await cancelHistoryRequest(ctx, options.request, {
          reason: options.reason ?? null,
          audit: { source: "cli", actorUserId: null },
        })));
      });
    });

  history
    .command("list")
    .description("requests newest first (JSON)")
    .option("--page <label>", "one Fansly page")
    .option("--state <state>", `${HISTORY_REQUEST_STATES.join(" | ")}`, (value: string) => {
      if (!(HISTORY_REQUEST_STATES as readonly string[]).includes(value)) {
        throw new InvalidArgumentError(`--state must be one of ${HISTORY_REQUEST_STATES.join(", ")}`);
      }
      return value as HistoryRequestState;
    })
    .option("--limit <n>", "at most this many", positiveInt, 50)
    .option("--offset <n>", "skip this many", nonNegativeInt, 0)
    .action(async (options: { page?: string; state?: HistoryRequestState; limit: number; offset: number }, command: Command) => {
      const label = pageLabel(options, command);
      await withContext(deps, async (ctx) => {
        const pageId = label === undefined ? undefined : (await findSyncPageByLabel(ctx.db, label)).pageId;
        deps.print(json(await listHistoryRequestViews(ctx, {
          ...(pageId === undefined ? {} : { pageId }),
          ...(options.state === undefined ? {} : { state: options.state }),
          limit: options.limit,
          offset: options.offset,
        })));
      });
    });

  history
    .command("eta-backtest")
    .description(
      "Read-only: the ETA's fact / forecast over every chain the legacy /message journal proves complete "
        + "(design §7.2.4); not between 00:00 and 05:00 UTC unless forced",
    )
    .option("--page <label>", "one page (default: every Fansly page)")
    .option("--since <iso>", "journal rows captured since", isoDate, new Date(DEFAULT_SINCE))
    .option("--batch-rows <n>", "journal rows per read", positiveInt, 500)
    .option("--sleep-ms <n>", "pause between batches", nonNegativeInt, 200)
    .option("--max-duration <duration>", "stop after this long (90s, 30m, 2h)", parseDurationMs)
    .option("--max-listed <n>", "cap of the listed examples per page", positiveInt, 20)
    .option("--force-window", "run inside the 00:00–05:00 UTC legacy night window")
    .action(async (options: {
      page?: string;
      since: Date;
      batchRows: number;
      sleepMs: number;
      maxDuration?: number;
      maxListed: number;
      forceWindow?: boolean;
    }, command: Command) => {
      const label = pageLabel(options, command);
      await withContext(deps, async (ctx) => {
        const pages = label === undefined ? await listSyncPages(ctx.db) : [await findSyncPageByLabel(ctx.db, label)];
        const pacing = {
          batchRows: options.batchRows,
          sleepMs: options.sleepMs,
          maxDurationMs: options.maxDuration ?? null,
          forceWindow: options.forceWindow === true,
        };
        const governor = new ScanGovernor(pacing);
        const reports: EtaBacktestPageReport[] = [];
        for (const page of pages) {
          const report = await backtestPageEta(ctx, {
            ...pacing,
            pageId: page.pageId,
            since: options.since,
            maxListed: options.maxListed,
          }, governor);
          reports.push(report);
          if (report.scan.stoppedBy !== null) break;
        }
        deps.print(json({ since: options.since.toISOString(), pages: reports }));
      });
    });
}
