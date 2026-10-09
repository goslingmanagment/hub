import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import { createSyncContext, type SyncContext } from "../context.ts";
import {
  readSyncPublicLookupQueue,
  readSyncPublicLookupStatus,
  recheckSyncPublicLookupMarks,
  resumeSyncPublicLookup,
  setSyncPublicLookupEnabled,
} from "../public-lookup.ts";
import {
  describeFanslyPublicEgress,
  removeFanslyPublicProxy,
  saveFanslyPublicProxy,
  type FanslyPublicEgressView,
} from "../../services/egress/fansly-public.ts";

// The owner's CLI of the session-less public account reader (arena "vanished
// chat" R5, plan §7; the reader is sync/fansly/public-lookup.ts, the levers
// sync/public-lookup.ts):
//   pnpm cli sync public-lookup status [--json]          read-only
//   pnpm cli sync public-lookup queue [--limit N] [--json] read-only: whom the next requests ask about
//   pnpm cli sync public-lookup enable | disable --note "…"   the live switch (audited)
//   pnpm cli sync public-lookup resume --note "…"        after a stop (audited; resolves the incident)
//   pnpm cli sync public-lookup recheck-marks --note "…" Р2 (а): enqueue the legacy deleted marks once
//   pnpm cli sync public-lookup proxy show
//   pnpm cli sync public-lookup proxy set --proxy-url <url> [--proxy-username <user>]
//     (--proxy-password-stdin | --proxy-password-env <NAME> | --proxy-password-file <file>) --note "…"
//   pnpm cli sync public-lookup proxy remove --note "…"
// The reader's own proxy, which no page uses. The secret comes from 1Password
// at the moment of setting (`op read … |` into stdin, or an env variable or a
// file the shell filled from it) and is stored encrypted, never printed. None
// of these sends a request — to Fansly or to the proxy: the reader asks in its
// own pace, in the `sync` process.

export interface SyncPublicLookupCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "config" | "rawConfig" | "logger" | "close">>;
  print(line: string): void;
  /** The whole of stdin, for `--proxy-password-stdin`. */
  readStdin(): Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

const defaultDeps: SyncPublicLookupCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
  readStdin: readAllStdin,
};

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseNote(value: string): string {
  const note = value.trim();
  if (note.length === 0 || note.length > 500) {
    throw new InvalidArgumentError(`--note is 1–500 characters (received ${note.length})`);
  }
  return note;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || parsed > 1000) throw new InvalidArgumentError(`--limit is 1–1000 (received "${value}")`);
  return parsed;
}

async function withContext<T>(
  deps: SyncPublicLookupCliDeps,
  body: (ctx: Pick<SyncContext, "db" | "config" | "rawConfig" | "logger">) => Promise<T>,
): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

/** The proxy password from exactly one of its three sources, or null. A
 *  trailing newline (`op read` prints one) is not part of it. */
async function readProxyPassword(
  deps: SyncPublicLookupCliDeps,
  options: { proxyPasswordStdin?: boolean; proxyPasswordEnv?: string; proxyPasswordFile?: string },
): Promise<string | null> {
  const given = [options.proxyPasswordStdin === true, options.proxyPasswordEnv !== undefined, options.proxyPasswordFile !== undefined]
    .filter(Boolean).length;
  if (given > 1) {
    throw new InvalidArgumentError("Use only one of --proxy-password-stdin, --proxy-password-env or --proxy-password-file");
  }
  let value: string | null = null;
  if (options.proxyPasswordStdin === true) value = await deps.readStdin();
  if (options.proxyPasswordEnv !== undefined) {
    const fromEnv = process.env[options.proxyPasswordEnv];
    if (fromEnv === undefined) throw new InvalidArgumentError(`Environment variable ${options.proxyPasswordEnv} is not set`);
    value = fromEnv;
  }
  if (options.proxyPasswordFile !== undefined) value = await readFile(options.proxyPasswordFile, "utf8");
  if (value === null) return null;
  const trimmed = value.replace(/\r?\n$/, "");
  return trimmed.length === 0 ? null : trimmed;
}

function egressLines(view: FanslyPublicEgressView): string[] {
  if (!view.configured) {
    return ["public egress: not configured — the public account reader sends nothing"];
  }
  return [
    `public egress: ${view.route ?? "(unreadable)"} (egress key ${view.egressKey ?? "?"}, set ${view.updatedAt ?? "?"})`,
    view.sharedWithPages.length === 0
      ? "no page uses this proxy"
      : `REFUSED: it is the proxy of page(s) ${view.sharedWithPages.join(", ")} — the reader will not use it`,
  ];
}

/** A standalone `sync` group with only these commands; errors throw (tests). */
export function buildSyncPublicLookupCommandGroup(deps: SyncPublicLookupCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  sync.enablePositionalOptions();
  registerSyncPublicLookupCommands(sync, deps);
  const exit = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exit(sub);
  };
  exit(sync);
  return sync;
}

export function registerSyncPublicLookupCommands(sync: Command, deps: SyncPublicLookupCliDeps = defaultDeps): Command {
  const publicLookup = sync
    .command("public-lookup")
    .description("the session-less public Fansly account reader (arena R5): status, queue, switch, resume, re-check, its own egress");

  publicLookup
    .command("status")
    .description("the switch, the proxy, a stop and its Retry-After, the budget, the demand and the re-check (read-only)")
    .option("--json", "as JSON", false)
    .action(async (options: { json: boolean }) => {
      await withContext(deps, async (ctx) => {
        const status = await readSyncPublicLookupStatus(ctx);
        if (options.json) {
          deps.print(json(status));
          return;
        }
        deps.print(`public account reader: ${status.enabled ? "on" : "off"} (fanslyPublicLookupEnabled), `
          + `${status.batchSize} ids a request`);
        for (const line of egressLines(status.egress)) deps.print(line);
        deps.print(status.state.stopped
          ? `STOPPED ${status.state.stoppedAt}: ${status.state.stopReason}${status.state.stopHttpStatus === null ? "" : ` (HTTP ${status.state.stopHttpStatus})`}`
            + ` — ${status.state.stopDetail ?? ""}; resume with sync public-lookup resume`
          : "not stopped");
        if (status.state.retryNotBefore !== null) deps.print(`Retry-After honoured until ${status.state.retryNotBefore}`);
        deps.print(`answers: first ${status.state.firstAnswerAt ?? "never"}, latest ${status.state.lastAnswerAt ?? "never"}`);
        deps.print(`budget: ${status.budget.sentLastDay}/${status.budget.dayBudget} requests in 24 h, last ${status.budget.lastSentAt ?? "never"}`);
        deps.print(`demand: ${status.demand.total} fans (owner's re-check ${status.demand.byDemand.deleted_mark}, `
          + `episode partners ${status.demand.byDemand.episode_partner}, page lookup misses ${status.demand.byDemand.page_lookup_miss})`);
        const p = status.progress;
        deps.print(`re-check of the deleted marks: ${p.queuePending} pending, ${p.queueDone} done — `
          + `${p.queueMarksCleared} found and taken off, ${p.queueNotFound} not found and kept; ${p.marksRemaining} marks remain`);
        deps.print(`next pass: ${status.next}`);
      });
    });

  publicLookup
    .command("queue")
    .description("the fans the next requests ask about, in order, and why (read-only)")
    .option("--limit <n>", "how many (1–1000)", parseLimit, 100)
    .option("--json", "as JSON", false)
    .action(async (options: { limit: number; json: boolean }) => {
      await withContext(deps, async (ctx) => {
        const queue = await readSyncPublicLookupQueue(ctx, { limit: options.limit });
        if (options.json) {
          deps.print(json(queue));
          return;
        }
        deps.print(`${queue.length} fan(s) next (owner's re-check first, then episode partners, then page lookup misses)`);
        if (queue.length === 0) return;
        deps.print(["fan_id", "fansly_id", "username", "why", "last_checked"].join("\t"));
        for (const fan of queue) {
          deps.print([
            String(fan.fanId), fan.platformUserId, fan.username ?? "", fan.demands.join(","),
            fan.publicCheckedAt?.toISOString() ?? "",
          ].join("\t"));
        }
      });
    });

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    publicLookup
      .command(name)
      .description(`${enabled ? "turn on" : "turn off"} the reader (the live setting fanslyPublicLookupEnabled; audited as admin.config_update)`)
      .requiredOption("--note <why>", "why; stored in the audit rows", parseNote)
      .action(async (options: { note: string }) => {
        await withContext(deps, async (ctx) => {
          const result = await setSyncPublicLookupEnabled(ctx, { enabled, note: options.note });
          deps.print(`fanslyPublicLookupEnabled = ${enabled} (override version ${result.version}); the reader reads it on its next pass`);
          if (enabled) {
            const status = await readSyncPublicLookupStatus(ctx);
            deps.print(`next pass: ${status.next}`);
          }
        });
      });
  }

  publicLookup
    .command("resume")
    .description("resume the reader after a stop (audited; resolves its incident; a Retry-After still ahead is waited for)")
    .requiredOption("--note <why>", "what was checked before resuming; stored in the audit row", parseNote)
    .action(async (options: { note: string }) => {
      await withContext(deps, async (ctx) => {
        const result = await resumeSyncPublicLookup(ctx, { note: options.note, actor: cliActor() });
        deps.print(`resumed after ${result.resumed.stopReason ?? "?"} (stopped ${result.resumed.stoppedAt ?? "?"}); `
          + `audited as admin.fansly_public_lookup_resume`
          + (result.retryNotBefore === null ? "" : `; it waits for Retry-After until ${result.retryNotBefore}`));
      });
    });

  publicLookup
    .command("recheck-marks")
    .description("owner decision Р2 (а): queue every fan with the legacy deleted mark for one public check (only enqueues; audited)")
    .requiredOption("--note <why>", "why; stored in the audit row", parseNote)
    .action(async (options: { note: string }) => {
      await withContext(deps, async (ctx) => {
        const result = await recheckSyncPublicLookupMarks(ctx, { note: options.note, actor: cliActor() });
        deps.print(`${result.marks} fans carry the deleted mark: ${result.enqueued} queued, ${result.alreadyPending} were already `
          + `pending — about ${result.requests} request(s) of ${result.batchSize} ids in the reader's own pace; `
          + "a found account loses the mark, a missing one keeps it");
      });
    });

  const proxy = publicLookup
    .command("proxy")
    .description("the public reader's own proxy (no page uses it): show, set or remove; sends nothing");

  proxy
    .command("show")
    .description("the configured proxy, masked (read-only)")
    .option("--json", "as JSON", false)
    .action(async (options: { json: boolean }) => {
      await withContext(deps, async (ctx) => {
        const view = await describeFanslyPublicEgress(ctx);
        if (options.json) {
          deps.print(json(view));
          return;
        }
        for (const line of egressLines(view)) deps.print(line);
      });
    });

  proxy
    .command("set")
    .description(
      "set the public reader's proxy (a proxy no page uses; its secret from 1Password, stored encrypted; audited)",
    )
    .requiredOption("--proxy-url <url>", "the proxy URL without credentials (http, https or socks5, explicit port)")
    .option("--proxy-username <username>", "the proxy user")
    .option("--proxy-password-stdin", "read the proxy password from stdin (e.g. piped from `op read`)")
    .option("--proxy-password-env <name>", "read the proxy password from this environment variable")
    .option("--proxy-password-file <file>", "read the proxy password from this file")
    .requiredOption("--note <why>", "why the proxy is set; stored in the audit row", parseNote)
    .action(async (options: {
      proxyUrl: string;
      proxyUsername?: string;
      proxyPasswordStdin?: boolean;
      proxyPasswordEnv?: string;
      proxyPasswordFile?: string;
      note: string;
    }) => {
      await withContext(deps, async (ctx) => {
        const password = await readProxyPassword(deps, options);
        // An error goes to the CLI's own handler, which prints its message
        // through `redactSensitiveText` (a proxy error may quote the URL).
        const view = await saveFanslyPublicProxy(ctx, {
          proxy: { url: options.proxyUrl, username: options.proxyUsername ?? null, password },
          actor: cliActor(),
          note: options.note,
        });
        for (const line of egressLines(view)) deps.print(line);
        deps.print("audited as admin.fansly_public_egress_set; nothing was sent");
      });
    });

  proxy
    .command("remove")
    .description("remove the public reader's proxy: it sends nothing from its next pass (audited)")
    .requiredOption("--note <why>", "why the proxy goes; stored in the audit row", parseNote)
    .action(async (options: { note: string }) => {
      await withContext(deps, async (ctx) => {
        const removed = await removeFanslyPublicProxy(ctx, { actor: cliActor(), note: options.note });
        deps.print(removed
          ? "public egress removed; audited as admin.fansly_public_egress_remove"
          : "public egress: not configured — nothing to remove");
      });
    });

  return publicLookup;
}
