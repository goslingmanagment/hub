import { hostname } from "node:os";

import { InvalidArgumentError, type Command } from "commander";

import {
  deleteUnboundPageBrowser,
  findOnboardingProfile,
  findPageByLabel,
  insertAuditEvent,
  listUnboundPageBrowsers,
  pageBrowserEnvOf,
  PageBrowserRegistrationError,
  registerPageBrowserProfile,
  type Database,
  type OnboardingProfile,
  type PageBrowserEnv,
} from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../services/egress/page-browser-link.ts";
import type { SyncContext } from "./context.ts";
import { SyncOwnerLeverError } from "./inspect.ts";

// `pnpm cli sync browser-profile …` (Project Browser plan §3.2 «Подключение
// новой страницы через браузер», step 1; stage 3 PR 16): the profiles of the
// page browsers in Hub, as `scripts/deploy-page-browser.sh add-profile` and
// `remove-profile` keep them — run there in the api container, never by
// hand with secrets on a command line.
//
// - `add`: the row of a profile the deploy script just made a container of:
//   its three secrets read from the standard input (the engine's RPC token,
//   the API's token, the KasmVNC password — one per line, as the server's
//   secret files hold them) and sealed as a proxy's auth is; the SOCKS5 its
//   container's rules admit; the browser's environment. `--new-page <label>`:
//   a new page's profile, its page empty — the owner connects the page in
//   the dashboard; refused when a page of that label exists. `--page
//   <label>`: an existing page that moves to its browser, bound now.
// - `remove`: a profile no page has, forgotten (its container goes after);
//   a bound one is refused.
// - `list`: the profiles no page has yet.
// Each change is audited (`admin.page_browser_profile`). Nothing secret is
// printed, audited or put in an error.

export const PAGE_BROWSER_PROFILE_AUDIT_EVENT = "admin.page_browser_profile";

export interface BrowserProfileCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "rawConfig" | "close">>;
  print(line: string): void;
  /** The standard input, whole (the secrets of `add`). */
  readStdin?: () => Promise<string>;
}

function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

/** The three secrets, one per line, in the order the deploy script cats
 *  them: never echoed, never in an error. */
export function parseProfileSecrets(text: string): { engineToken: string; apiToken: string; vncPassword: string } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length !== 3) throw new SyncOwnerLeverError(`the standard input holds ${lines.length} secret lines, not 3 (the engine's token, the API's token, the screen password)`);
  for (const line of lines) {
    if (line.length < 16 || line.length > 1024 || /\s/.test(line)) throw new SyncOwnerLeverError("a secret line of the standard input is not one (16 to 1024 characters, no space)");
  }
  return { engineToken: lines[0]!, apiToken: lines[1]!, vncPassword: lines[2]! };
}

function parseEnv(value: string): PageBrowserEnv {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError("Expected the environment as JSON");
  }
  const env = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? pageBrowserEnvOf(parsed as Record<string, unknown>) : null;
  if (env === null) throw new InvalidArgumentError("Expected {timeZone, languages: [...], geolocation: {latitude, longitude, accuracyM}} as JSON");
  return env;
}

function parseUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new InvalidArgumentError(`Expected a profile UUID, received "${value}"`);
  return value;
}

function parseSocks(value: string): string {
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) throw new InvalidArgumentError(`Expected the SOCKS5 as ip:port, received "${value}"`);
  return value;
}

function parseContainer(value: string): string {
  if (!/^page-browser-[a-z0-9][a-z0-9-]{0,40}$/.test(value)) throw new InvalidArgumentError(`Expected page-browser-<name>, received "${value}"`);
  return value;
}

/** A profile as the CLI shows it: no secret. */
export function profileView(profile: OnboardingProfile) {
  return {
    profileId: profile.profileId,
    container: profile.container,
    pageId: profile.pageId,
    onboarding: profile.onboarding,
    socksEndpoint: profile.socksEndpoint,
    proxySet: profile.proxy !== null,
    pinnedExitIp: profile.pinnedExitIp,
    envSet: pageBrowserEnvOf(profile.env) !== null,
    step: profile.step,
    stopReason: profile.stopReason,
    mode: profile.mode,
    exitIp: profile.exitIp,
    lastStateAt: profile.lastStateAt?.toISOString() ?? null,
    identity: profile.identityResult?.ok === true
      ? { accountId: profile.identityResult.accountId, username: profile.identityResult.username, at: profile.identityResult.sentAt }
      : null,
    createdAt: profile.createdAt.toISOString(),
  };
}

/** `add`: the profile's row, audited, in one transaction. */
export async function addBrowserProfile(
  ctx: Pick<SyncContext, "db" | "rawConfig">,
  input: {
    profileId: string;
    container: string;
    socks: string;
    env: PageBrowserEnv;
    page: { existing: string } | { new: string };
    secrets: { engineToken: string; apiToken: string; vncPassword: string };
    actor: string;
  },
): Promise<{ profileId: string; container: string; socksEndpoint: string; boundTo: string | null }> {
  const label = "existing" in input.page ? input.page.existing : input.page.new;
  const found = await findPageByLabel(ctx.db, label);
  if ("existing" in input.page) {
    // A page of another platform: the registration refuses it (a Fansly page only).
    if (found === null) throw new SyncOwnerLeverError(`no active page ${label}: a new page's profile is added with --new-page`);
  } else if (found !== null) {
    throw new SyncOwnerLeverError(`a page ${label} exists: its profile is added with --page ${label} (it moves to its browser)`);
  }
  const sealed = sealPageBrowserSecrets(ctx.rawConfig, input.secrets);
  try {
    await ctx.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await registerPageBrowserProfile(tx, {
        profileId: input.profileId,
        container: input.container,
        ...sealed,
        socksEndpoint: input.socks,
        env: input.env as unknown as Record<string, unknown>,
        pageId: "existing" in input.page ? found!.page.id : null,
      });
      await insertAuditEvent(tx, {
        platformAccountId: "existing" in input.page ? found!.page.id : null,
        source: "cli",
        eventType: PAGE_BROWSER_PROFILE_AUDIT_EVENT,
        metadata: { actor: input.actor, action: "add", profileId: input.profileId, container: input.container, socksEndpoint: input.socks, ...("existing" in input.page ? { page: label } : { newPage: label }) },
      });
    });
  } catch (error) {
    if (error instanceof PageBrowserRegistrationError) throw new SyncOwnerLeverError(error.message);
    throw error;
  }
  return { profileId: input.profileId, container: input.container, socksEndpoint: input.socks, boundTo: "existing" in input.page ? label : null };
}

/** `remove`: a profile no page has, forgotten and audited. */
export async function removeBrowserProfile(db: Database, input: { profileId: string; actor: string }): Promise<{ profileId: string; container: string }> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const profile = await findOnboardingProfile(tx, input.profileId);
    if (profile === null) throw new SyncOwnerLeverError(`no profile ${input.profileId} in Hub`);
    if (profile.pageId !== null) throw new SyncOwnerLeverError(`profile ${input.profileId} is bound to page ${profile.pageId}: it is that page's (to-node, then down)`);
    if (!(await deleteUnboundPageBrowser(tx, input.profileId))) throw new SyncOwnerLeverError(`profile ${input.profileId} could not be removed (bound meanwhile?)`);
    await insertAuditEvent(tx, {
      platformAccountId: null,
      source: "cli",
      eventType: PAGE_BROWSER_PROFILE_AUDIT_EVENT,
      metadata: { actor: input.actor, action: "remove", profileId: input.profileId, container: profile.container, onboarding: profile.onboarding },
    });
    return { profileId: input.profileId, container: profile.container };
  });
}

export function registerSyncBrowserProfileCommands(sync: Command, deps: BrowserProfileCliDeps): void {
  const group = sync.command("browser-profile").description("Project Browser: the page browsers' profiles in Hub (scripts/deploy-page-browser.sh add-profile, remove-profile)");
  const withContext = async <T>(body: (ctx: Pick<SyncContext, "db" | "rawConfig">) => Promise<T>): Promise<T> => {
    const ctx = await deps.openContext();
    try {
      return await body(ctx);
    } finally {
      await ctx.close();
    }
  };
  const print = (value: unknown) => deps.print(JSON.stringify(value, null, 2));

  group
    .command("add")
    .description("register a profile the deploy script made a container of; its three secrets on the standard input (audited)")
    .requiredOption("--profile <uuid>", "the profile", parseUuid)
    .requiredOption("--container <name>", "page-browser-<name>", parseContainer)
    .requiredOption("--socks <ip:port>", "the SOCKS5 its container's rules admit", parseSocks)
    .requiredOption("--env <json>", "{timeZone, languages, geolocation: {latitude, longitude, accuracyM}}", parseEnv)
    .option("--page <label>", "an existing page that moves to its browser: bound now")
    .option("--new-page <label>", "a new page's profile: its page empty until the owner connects it")
    .option("--secrets-stdin", "read the secrets from the standard input (required)", false)
    .action(async (options: { profile: string; container: string; socks: string; env: PageBrowserEnv; page?: string; newPage?: string; secretsStdin: boolean }) => {
      if ((options.page === undefined) === (options.newPage === undefined)) throw new SyncOwnerLeverError("one of --page <label> (an existing page) and --new-page <label>");
      if (!options.secretsStdin) throw new SyncOwnerLeverError("the secrets come on the standard input (--secrets-stdin), never on a command line");
      const secrets = parseProfileSecrets(await (deps.readStdin ?? readProcessStdin)());
      await withContext(async (ctx) => {
        print(await addBrowserProfile(ctx, {
          profileId: options.profile,
          container: options.container,
          socks: options.socks,
          env: options.env,
          page: options.page !== undefined ? { existing: options.page } : { new: options.newPage! },
          secrets,
          actor: cliActor(),
        }));
      });
    });

  group
    .command("remove")
    .description("forget a profile no page has (its container goes after, on the server); a bound one is refused (audited)")
    .requiredOption("--profile <uuid>", "the profile", parseUuid)
    .action(async (options: { profile: string }) => {
      await withContext(async ({ db }) => print(await removeBrowserProfile(db, { profileId: options.profile, actor: cliActor() })));
    });

  group
    .command("list")
    .description("the profiles no page has yet: their onboarding, proxy, pin, the operator's last word (JSON, no secret)")
    .action(async () => {
      await withContext(async ({ db }) => print((await listUnboundPageBrowsers(db)).map(profileView)));
    });
}
