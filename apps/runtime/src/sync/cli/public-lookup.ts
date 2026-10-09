import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import { createSyncContext, type SyncContext } from "../context.ts";
import {
  describeFanslyPublicEgress,
  removeFanslyPublicProxy,
  saveFanslyPublicProxy,
  type FanslyPublicEgressView,
} from "../../services/egress/fansly-public.ts";

// The owner's CLI of the session-less public account reader (arena "vanished
// chat" R5, plan §7):
//   pnpm cli sync public-lookup proxy show
//   pnpm cli sync public-lookup proxy set --proxy-url <url> [--proxy-username <user>]
//     (--proxy-password-stdin | --proxy-password-env <NAME> | --proxy-password-file <file>) --note "…"
//   pnpm cli sync public-lookup proxy remove --note "…"
// The reader's own proxy, which no page uses. The secret comes from 1Password
// at the moment of setting (`op read … |` into stdin, or an env variable or a
// file the shell filled from it) and is stored encrypted, never printed. None
// of these sends a request — to Fansly or to the proxy.

export interface SyncPublicLookupCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "config" | "close">>;
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

async function withContext<T>(
  deps: SyncPublicLookupCliDeps,
  body: (ctx: Pick<SyncContext, "db" | "config">) => Promise<T>,
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
    .description("the session-less public Fansly account reader (arena R5): its own egress");

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
