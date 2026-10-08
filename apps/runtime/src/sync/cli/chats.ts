import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import { noteUnavailableChat, readUnavailableChats, type UnavailableChatView } from "../chats.ts";
import { createSyncContext, type SyncContext } from "../context.ts";

// The owner's CLI of the chats Fansly does not serve to a page (arena
// "vanished chat", plan §4; `sync/chats.ts`):
//   pnpm cli sync chats unavailable --page P [--ended] [--json]
//   pnpm cli sync chats note --page P --chat G --note "…" [--at <iso>]
// Neither sends a request to Fansly. The list is read-only; the note writes
// the episode's owner's note and an audit row, nothing the actor writes.

export interface SyncChatsCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "close">>;
  print(line: string): void;
}

const defaultDeps: SyncChatsCliDeps = {
  openContext: () => createSyncContext(),
  print: (line) => console.log(line),
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

function parseGroupId(value: string): string {
  if (!/^[0-9]{1,30}$/.test(value)) throw new InvalidArgumentError(`Expected a Fansly group id (digits), received "${value}"`);
  return value;
}

function parseInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`Expected an ISO timestamp, received "${value}"`);
  return parsed;
}

async function withContext<T>(deps: SyncChatsCliDeps, body: (ctx: Pick<SyncContext, "db">) => Promise<T>): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

/** A standalone `sync` group with only these commands; errors throw (tests). */
export function buildSyncChatsCommandGroup(deps: SyncChatsCliDeps = defaultDeps): Command {
  const sync = new Command("sync").exitOverride();
  sync.enablePositionalOptions();
  registerSyncChatsCommands(sync, deps);
  const exit = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exit(sub);
  };
  exit(sync);
  return sync;
}

const COLUMNS = [
  "chat", "partner", "state", "refusals", "opened_at", "established_at", "last_refusal", "retry_not_before", "ended",
  "attempts", "observations", "owner_note",
] as const;

/** One episode as a line of the table (tab-separated, as `sync ownership status`). */
function episodeLine(episode: UnavailableChatView): string {
  return [
    episode.chat,
    episode.partner.username ?? episode.partner.platformUserId ?? "",
    episode.state,
    String(episode.refusals),
    episode.openedAt,
    episode.establishedAt ?? "",
    `${episode.lastRefusalAt}${episode.lastHttpStatus === null ? "" : ` (${episode.lastHttpStatus})`}`,
    episode.retryNotBefore ?? "",
    episode.endedAt === null ? "" : `${episode.endReason ?? "?"} ${episode.endedAt}`,
    `${episode.evidence.firstAttemptId}..${episode.evidence.lastAttemptId}`,
    `${episode.evidence.firstObservation.id}..${episode.evidence.lastObservation.id}`,
    episode.ownerNote === null ? "" : `${episode.ownerNote.at.slice(0, 10)}: ${episode.ownerNote.text.replace(/\s+/g, " ")}`,
  ].join("\t");
}

export function registerSyncChatsCommands(sync: Command, deps: SyncChatsCliDeps = defaultDeps): void {
  const chats = sync
    .command("chats")
    .description("the chats Fansly does not serve to a page (unavailability episodes): list them, note one; no request to Fansly");

  chats
    .command("unavailable")
    .description(
      "a page's open unavailability episodes — refusing and established — with the attempts and raw answers that prove "
      + "them (read-only; --ended: every episode of the page)",
    )
    .requiredOption("--page <label>", "the Fansly page")
    .option("--ended", "the ended episodes too", false)
    .option("--json", "the report as JSON", false)
    .action(async (options: { page: string; ended: boolean; json: boolean }) => {
      await withContext(deps, async ({ db }) => {
        const report = await readUnavailableChats(db, { pageLabel: options.page, ended: options.ended });
        if (options.json) {
          deps.print(json(report));
          return;
        }
        deps.print(`${report.page}: ${report.established} established, ${report.refusing} refusing`
          + (report.ended ? `, ${report.episodes.length - report.established - report.refusing} ended` : "")
          + " (sync why --resource dm-messages.head --subject <chat> for a chat's work)");
        if (report.episodes.length === 0) return;
        deps.print(COLUMNS.join("\t"));
        for (const episode of report.episodes) deps.print(episodeLine(episode));
      });
    });

  chats
    .command("note")
    .description(
      "the owner's observation on a chat's unavailability episode (its open one, else its newest): written with its "
      + "date and audited; nothing else of the episode changes",
    )
    .requiredOption("--page <label>", "the Fansly page")
    .requiredOption("--chat <group id>", "the chat's Fansly group id", parseGroupId)
    .requiredOption("--note <text>", "what the owner observed (1–2000 characters)")
    .option("--at <iso>", "when it was observed (default: now)", parseInstant)
    .action(async (options: { page: string; chat: string; note: string; at?: Date }) => {
      await withContext(deps, async ({ db }) => {
        const result = await noteUnavailableChat(db, {
          pageLabel: options.page,
          chat: options.chat,
          note: options.note,
          at: options.at ?? null,
          actor: cliActor(),
        });
        const { episode } = result;
        deps.print(`${result.page}: chat ${episode.chat}, episode ${episode.episodeId} (${episode.state}): `
          + `the owner's note ${result.replaced ? "replaced" : "written"}, as of ${episode.ownerNote?.at ?? "?"} `
          + `(audit ${result.auditId})`);
      });
    });
}
