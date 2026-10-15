import { hostname } from "node:os";

import { Command, InvalidArgumentError } from "commander";

import {
  consumePageBrowserDraft,
  findOnboardingProfile,
  findPageBrowserDraft,
  findPageById,
  findPageByLabel,
  lockPageBrowserDraft,
  insertProfileClearHaltCommand,
  lockPageBrowserProfile,
  forgetPageBrowserProfile,
  insertAuditEvent,
  isPageBrowserProfileForgotten,
  listUnboundPageBrowsers,
  pageBrowserEnvOf,
  PageBrowserRegistrationError,
  registerPageBrowserProfile,
  type Database,
  type OnboardingProfile,
  type PageBrowserEnv,
} from "@agency_hub_core/db";

import { sealPageBrowserSecrets, socksEndpointOfProxy } from "../services/egress/page-browser-link.ts";
import { awaitPageBrowserCommand, SYNC_BROWSER_COMMAND_TTL_MS } from "./browser-levers.ts";
import type { SyncContext } from "./context.ts";
import { SyncOwnerLeverError } from "./inspect.ts";

// `pnpm cli sync browser-profile …` (Project Browser plan §3.2 «Подключение
// новой страницы через браузер», step 1; stage 3 PR 16): the profiles of the
// page browsers in Hub, as `scripts/deploy-page-browser.sh add-profile` and
// `remove-profile` keep them — run there in the api container, never by
// hand with secrets on a command line.
//
// - `draft`: the browser the owner started in the dashboard (0282; owner
//   decision 2026-10-15), as add-profile needs it — the SOCKS5's `ip:port`
//   its container's rules admit (a new page's proxy from the draft, an
//   existing page's its own; the name resolved here, as the hello resolves
//   it), the environment the owner confirmed, the draft's revision. No
//   secret: the proxy's login and password stay sealed in Hub.
// - `add`: the row of a profile the deploy script just made a container of:
//   its three secrets read from the standard input (the engine's RPC token,
//   the API's token, the KasmVNC password — one per line, as the server's
//   secret files hold them) and sealed as a proxy's auth is; the SOCKS5 its
//   container's rules admit; the browser's environment. `--new-page <label>`:
//   a new page's profile, its page empty — the owner connects the page in
//   the dashboard; refused when a page of that label exists. `--page
//   <label>`: an existing page that moves to its browser, bound now.
//   `--from-draft <name> --draft-revision <n>`: the draft add-profile read —
//   the profile takes its proxy (a new page's: the onboarding's proxy from
//   the start) and its environment (`--env` overrides it), and consumes it
//   in the same transaction; refused when the draft changed or its proxy's
//   name no longer resolves to the address the container was made for.
//   Without it (`--socks` and `--env` typed, PR 16's way), a name that has a
//   draft is refused: the draft is the owner's word.
// - `remove`: a profile no page has, forgotten (its container goes after);
//   a bound one is refused. A profile Hub forgot — removed, or said absent
//   (`--absent-ok`) — is never registered again: an `add` whose answer was
//   lost and that commits late is refused, so «absent» is final.
// - `show`: one profile, bound or not, or whether Hub forgot it.
// - `list`: the profiles no page has yet.
// - `clear-halt`: the owner's decision on a halt the operator of a profile no
//   page has holds for him (PR 17, Astra round 4: a re-pin decides only a
//   changed exit IP, and `sync browser start` needs a page): a clearHalt
//   naming that halt, run by the profile's onboarding link — at the operator,
//   then Hub's mirror of it; the CLI waits for its outcome.
// A refusal of `add` (nothing written) prints `"outcome": "refused"` before
// it fails: the deploy script removes what it made on that word only — any
// other failure leaves the outcome unknown (Astra's review of PR 16, round
// 2).
// Each change is audited (`admin.page_browser_profile`). Nothing secret is
// printed, audited or put in an error.

export const PAGE_BROWSER_PROFILE_AUDIT_EVENT = "admin.page_browser_profile";

export interface BrowserProfileCliDeps {
  openContext(): Promise<Pick<SyncContext, "db" | "rawConfig" | "close">>;
  print(line: string): void;
  /** The standard input, whole (the secrets of `add`). */
  readStdin?: () => Promise<string>;
  /** A proxy's name to its IPv4 address (tests: no DNS). */
  resolve?: (host: string) => Promise<string>;
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

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new InvalidArgumentError(`Expected the draft's revision, received "${value}"`);
  return revision;
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
    // The halt the operator holds for the owner, as Hub mirrors it (its id
    // is what `clear-halt --halt` names).
    halt: profile.halt === null ? null : { id: profile.halt.id, reason: profile.halt.reason, at: profile.halt.at?.toISOString() ?? null },
    identity: profile.identityResult?.ok === true
      ? { accountId: profile.identityResult.accountId, username: profile.identityResult.username, at: profile.identityResult.sentAt }
      : null,
    createdAt: profile.createdAt.toISOString(),
  };
}

/** The SOCKS5 a page's proxy names, as its container is made for it, or
 *  the refusal. */
async function socksEndpointFor(url: string, what: string, resolve?: (host: string) => Promise<string>): Promise<string> {
  const read = await socksEndpointOfProxy(url, resolve === undefined ? {} : { resolve });
  if ("problem" in read) throw new SyncOwnerLeverError(`${what}: ${read.problem}`);
  return read.endpoint;
}

/** `draft`: what add-profile makes the container from (no secret). */
export async function showBrowserProfileDraft(
  db: Database,
  name: string,
  options: { resolve?: (host: string) => Promise<string> } = {},
): Promise<{ name: string; existingPage: boolean; page: string | null; socks: string; env: PageBrowserEnv; revision: number }> {
  const draft = await findPageBrowserDraft(db, name);
  if (draft === null) {
    throw new SyncOwnerLeverError(`Hub has no draft of the browser ${name}: start it in the dashboard (Настройки → Страницы → «Новые страницы через серверный браузер»), or give --socks and --env`);
  }
  const env = pageBrowserEnvOf(draft.env);
  if (env === null) throw new SyncOwnerLeverError(`the draft of ${name} has no well-formed environment: save it again in the dashboard`);
  let url: string;
  if (draft.pageId === null) {
    url = draft.proxy!.url;
  } else {
    const page = await findPageById(db, draft.pageId);
    if (page === null) throw new SyncOwnerLeverError(`the draft of ${name} names page ${draft.pageId}, which is not active`);
    if (page.proxy == null) throw new SyncOwnerLeverError(`page ${name} has no proxy: give it its SOCKS5 first`);
    url = page.proxy.url;
  }
  const socks = await socksEndpointFor(url, `the proxy of ${name}`, options.resolve);
  return { name, existingPage: draft.pageId !== null, page: draft.pageLabel, socks, env, revision: draft.revision };
}

/** `add`: the profile's row, audited, in one transaction — from the owner's
 *  draft (consumed with it), or from what was typed. */
export async function addBrowserProfile(
  ctx: Pick<SyncContext, "db" | "rawConfig">,
  input: {
    profileId: string;
    container: string;
    socks: string;
    /** Undefined: the draft's. */
    env?: PageBrowserEnv;
    page: { existing: string } | { new: string };
    secrets: { engineToken: string; apiToken: string; vncPassword: string };
    actor: string;
    fromDraft?: { name: string; revision: number };
    resolve?: (host: string) => Promise<string>;
  },
): Promise<{ profileId: string; container: string; socksEndpoint: string; boundTo: string | null; fromDraft: { name: string; revision: number } | null }> {
  const label = "existing" in input.page ? input.page.existing : input.page.new;
  const found = await findPageByLabel(ctx.db, label);
  if ("existing" in input.page) {
    // A page of another platform: the registration refuses it (a Fansly page only).
    if (found === null) throw new SyncOwnerLeverError(`no active page ${label}: a new page's profile is added with --new-page`);
  } else if (found !== null) {
    throw new SyncOwnerLeverError(`a page ${label} exists: its profile is added with --page ${label} (it moves to its browser)`);
  }
  const fromDraft = input.fromDraft ?? null;
  if (fromDraft === null) {
    if (input.env === undefined) throw new SyncOwnerLeverError("the browser's environment: --env, or --from-draft (the owner's draft in the dashboard)");
    if ((await findPageBrowserDraft(ctx.db, label)) !== null) {
      throw new SyncOwnerLeverError(`the owner started the browser ${label} in the dashboard: add-profile takes it from his draft (no --socks, no --env), or he deletes the draft`);
    }
  } else {
    if (fromDraft.name !== label) throw new SyncOwnerLeverError(`the draft ${fromDraft.name} is not the browser ${label}'s`);
    // The draft's proxy names the address the container was made for (its
    // name resolved again: a container's rules admit one address).
    const drafted = await findPageBrowserDraft(ctx.db, label);
    if (drafted !== null && drafted.pageId === null && drafted.proxy !== null) {
      const now = await socksEndpointFor(drafted.proxy.url, `the proxy of ${label}`, input.resolve);
      if (now !== input.socks) throw new SyncOwnerLeverError(`the proxy of ${label} names ${now} now, not ${input.socks} the container was made for: run add-profile again`);
    }
  }
  const sealed = sealPageBrowserSecrets(ctx.rawConfig, input.secrets);
  try {
    await ctx.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      let env: PageBrowserEnv | null = input.env ?? null;
      let onboardingProxy: { url: string; encryptedAuth: string | null; keyVersion: number | null } | null = null;
      if (fromDraft !== null) {
        const draft = await lockPageBrowserDraft(tx, fromDraft.name);
        if (draft === null) throw new SyncOwnerLeverError(`Hub has no draft of the browser ${label} any more (deleted, or another add-profile took it)`);
        if (draft.revision !== fromDraft.revision) throw new SyncOwnerLeverError(`the owner changed the draft of ${label} meanwhile (revision ${draft.revision}, not ${fromDraft.revision}): run add-profile again`);
        if ((draft.pageId !== null) !== ("existing" in input.page)) {
          throw new SyncOwnerLeverError(draft.pageId !== null ? `the draft of ${label} moves the existing page to its browser: add-profile --existing` : `the draft of ${label} is a new page's: add-profile without --existing`);
        }
        if (draft.pageId !== null && draft.pageId !== found!.page.id) throw new SyncOwnerLeverError(`the draft of ${label} names another page`);
        env ??= pageBrowserEnvOf(draft.env);
        if (env === null) throw new SyncOwnerLeverError(`the draft of ${label} has no well-formed environment`);
        onboardingProxy = draft.proxy;
        if (!(await consumePageBrowserDraft(tx, fromDraft))) throw new SyncOwnerLeverError(`the draft of ${label} changed meanwhile: run add-profile again`);
      }
      await registerPageBrowserProfile(tx, {
        profileId: input.profileId,
        container: input.container,
        ...sealed,
        socksEndpoint: input.socks,
        env: env as unknown as Record<string, unknown>,
        pageId: "existing" in input.page ? found!.page.id : null,
        onboardingProxy,
      });
      await insertAuditEvent(tx, {
        platformAccountId: "existing" in input.page ? found!.page.id : null,
        source: "cli",
        eventType: PAGE_BROWSER_PROFILE_AUDIT_EVENT,
        metadata: {
          actor: input.actor, action: "add", profileId: input.profileId, container: input.container, socksEndpoint: input.socks,
          ...("existing" in input.page ? { page: label } : { newPage: label }),
          ...(fromDraft === null ? {} : { fromDraft: fromDraft.name, draftRevision: fromDraft.revision, envOverridden: input.env !== undefined }),
        },
      });
    });
  } catch (error) {
    if (error instanceof PageBrowserRegistrationError) throw new SyncOwnerLeverError(error.message);
    throw error;
  }
  return { profileId: input.profileId, container: input.container, socksEndpoint: input.socks, boundTo: "existing" in input.page ? label : null, fromDraft };
}

/** `remove`: a profile no page has, forgotten and audited (`removed`). A
 *  bound one is refused. With `absentOk` (the deploy script's remove-profile,
 *  run again after Hub's answer was lost), a profile Hub has not is
 *  forgotten all the same (`absent`). Either way Hub never registers it
 *  again. */
export async function removeBrowserProfile(
  db: Database,
  input: { profileId: string; actor: string; absentOk?: boolean },
): Promise<{ profileId: string; container: string | null; outcome: "removed" | "absent" }> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const forgot = await forgetPageBrowserProfile(tx, { profileId: input.profileId, by: input.actor });
    if (forgot.outcome === "bound") throw new SyncOwnerLeverError(`profile ${input.profileId} is bound to page ${forgot.pageId}: it is that page's (to-node, then down)`);
    if (forgot.outcome === "absent" && input.absentOk !== true) throw new SyncOwnerLeverError(`no profile ${input.profileId} in Hub`);
    await insertAuditEvent(tx, {
      platformAccountId: null,
      source: "cli",
      eventType: PAGE_BROWSER_PROFILE_AUDIT_EVENT,
      metadata: forgot.outcome === "removed"
        ? { actor: input.actor, action: "remove", profileId: input.profileId, container: forgot.profile.container, onboarding: forgot.profile.onboarding }
        : { actor: input.actor, action: "forget_absent", profileId: input.profileId },
    });
    return { profileId: input.profileId, container: forgot.outcome === "removed" ? forgot.profile.container : null, outcome: forgot.outcome };
  });
}

/** `clear-halt`: the owner's audited clearHalt of a halt the operator of a
 *  profile no page has holds — the command and its audit row in one
 *  transaction; a bound profile's halt is its page's start's. */
export async function clearBrowserProfileHalt(db: Database, input: { profileId: string; haltId: string; actor: string; note?: string | null }) {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const locked = await lockPageBrowserProfile(tx, input.profileId);
    if (locked === null) throw new SyncOwnerLeverError(`no page browser profile ${input.profileId}`);
    if (locked.pageId !== null) throw new SyncOwnerLeverError(`profile ${input.profileId} serves a page: its halt is cleared by sync browser start <page>`);
    const profile = await findOnboardingProfile(tx, input.profileId);
    const command = await insertProfileClearHaltCommand(tx, {
      profileId: input.profileId, haltId: input.haltId, requestedBy: input.actor, note: input.note ?? null, ttlMs: SYNC_BROWSER_COMMAND_TTL_MS,
    });
    if (command === null) throw new SyncOwnerLeverError(`profile ${input.profileId} serves a page: its halt is cleared by sync browser start <page>`);
    const mirrored = profile?.halt ?? null;
    await insertAuditEvent(tx, {
      platformAccountId: null,
      source: "cli",
      eventType: PAGE_BROWSER_PROFILE_AUDIT_EVENT,
      metadata: {
        actor: input.actor, action: "clear_halt", profileId: input.profileId, haltId: input.haltId, commandId: command.id,
        mirrored: mirrored === null ? null : { id: mirrored.id, reason: mirrored.reason }, ...(input.note == null ? {} : { note: input.note }),
      },
    });
    return {
      profileId: input.profileId,
      haltId: input.haltId,
      mirrored: mirrored === null ? null : { id: mirrored.id, reason: mirrored.reason, at: mirrored.at?.toISOString() ?? null },
      command: { id: command.id, kind: command.kind, expiresAt: command.expiresAt.toISOString() },
    };
  });
}

/** `show`: one profile as Hub holds it (bound or not), or that it has none
 *  — and whether it forgot it. */
export async function showBrowserProfile(db: Database, profileId: string) {
  const profile = await findOnboardingProfile(db, profileId);
  if (profile !== null) return { present: true as const, ...profileView(profile) };
  return { present: false as const, profileId, forgotten: await isPageBrowserProfileForgotten(db, profileId) };
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
    .option("--env <json>", "{timeZone, languages, geolocation: {latitude, longitude, accuracyM}} (with --from-draft: overrides the draft's)", parseEnv)
    .option("--from-draft <name>", "the owner's draft in the dashboard (`draft`): its proxy and environment, consumed")
    .option("--draft-revision <n>", "the draft's revision `draft` printed: refused when it changed since", parseRevision)
    .option("--page <label>", "an existing page that moves to its browser: bound now")
    .option("--new-page <label>", "a new page's profile: its page empty until the owner connects it")
    .option("--secrets-stdin", "read the secrets from the standard input (required)", false)
    .action(async (options: { profile: string; container: string; socks: string; env?: PageBrowserEnv; fromDraft?: string; draftRevision?: number; page?: string; newPage?: string; secretsStdin: boolean }) => {
      if ((options.page === undefined) === (options.newPage === undefined)) throw new SyncOwnerLeverError("one of --page <label> (an existing page) and --new-page <label>");
      if (!options.secretsStdin) throw new SyncOwnerLeverError("the secrets come on the standard input (--secrets-stdin), never on a command line");
      if ((options.fromDraft === undefined) !== (options.draftRevision === undefined)) throw new SyncOwnerLeverError("--from-draft and --draft-revision go together");
      try {
        const secrets = parseProfileSecrets(await (deps.readStdin ?? readProcessStdin)());
        await withContext(async (ctx) => {
          print(await addBrowserProfile(ctx, {
            profileId: options.profile,
            container: options.container,
            socks: options.socks,
            ...(options.env === undefined ? {} : { env: options.env }),
            page: options.page !== undefined ? { existing: options.page } : { new: options.newPage! },
            secrets,
            actor: cliActor(),
            ...(options.fromDraft === undefined ? {} : { fromDraft: { name: options.fromDraft, revision: options.draftRevision! } }),
            ...(deps.resolve === undefined ? {} : { resolve: deps.resolve }),
          }));
        });
      } catch (error) {
        // Hub's refusal: nothing was written (a check before the write, or
        // the registration's transaction rolled back). Only this word lets
        // the deploy script remove what it made.
        if (error instanceof SyncOwnerLeverError) print({ profileId: options.profile, outcome: "refused", reason: error.message });
        throw error;
      }
    });

  group
    .command("draft")
    .description("the browser the owner started in the dashboard, as add-profile makes it: its SOCKS5's ip:port, its environment, its revision (JSON, no secret)")
    .requiredOption("--name <name>", "the browser's name (the page's label)")
    .action(async (options: { name: string }) => {
      await withContext(async ({ db }) => print(await showBrowserProfileDraft(db, options.name, deps.resolve === undefined ? {} : { resolve: deps.resolve })));
    });

  group
    .command("remove")
    .description("forget a profile no page has (its container goes after, on the server); a bound one is refused (audited)")
    .requiredOption("--profile <uuid>", "the profile", parseUuid)
    .option("--absent-ok", "a profile Hub does not have is no error (`outcome: absent`): the deploy script's clean-up after an add whose answer was lost", false)
    .action(async (options: { profile: string; absentOk: boolean }) => {
      await withContext(async ({ db }) => print(await removeBrowserProfile(db, { profileId: options.profile, actor: cliActor(), absentOk: options.absentOk })));
    });

  group
    .command("show")
    .description("one profile as Hub holds it, bound or not — or that it has none, and whether it forgot it (JSON, no secret)")
    .requiredOption("--profile <uuid>", "the profile", parseUuid)
    .action(async (options: { profile: string }) => {
      await withContext(async ({ db }) => print(await showBrowserProfile(db, options.profile)));
    });

  group
    .command("clear-halt")
    .description("clear a halt the operator of a profile no page has holds for the owner, by its id (`show` names it): run by the profile's onboarding link (audited)")
    .requiredOption("--profile <uuid>", "the profile", parseUuid)
    .requiredOption("--halt <id>", "the halt's id (`show`: halt.id)", parseUuid)
    .option("--note <text>", "why (audited)")
    .option("--wait-ms <ms>", `how long to wait for its outcome (default ${SYNC_BROWSER_COMMAND_TTL_MS + 30_000})`, (value: string) => {
      const ms = Number(value);
      if (!Number.isSafeInteger(ms) || ms < 0) throw new InvalidArgumentError(`Expected milliseconds, received "${value}"`);
      return ms;
    })
    .action(async (options: { profile: string; halt: string; note?: string; waitMs?: number }) => {
      await withContext(async ({ db }) => {
        const asked = await clearBrowserProfileHalt(db, { profileId: options.profile, haltId: options.halt, actor: cliActor(), ...(options.note === undefined ? {} : { note: options.note }) });
        const ran = await awaitPageBrowserCommand(db, asked.command.id, { waitMs: options.waitMs ?? SYNC_BROWSER_COMMAND_TTL_MS + 30_000 });
        print({ ...asked, result: ran === null ? null : { outcome: ran.outcome, ok: ran.ok, detail: ran.detail, doneAt: ran.doneAt?.toISOString() ?? null } });
      });
    });

  group
    .command("list")
    .description("the profiles no page has yet: their onboarding, proxy, pin, the operator's last word (JSON, no secret)")
    .action(async () => {
      await withContext(async ({ db }) => print((await listUnboundPageBrowsers(db)).map(profileView)));
    });
}

/** The commands as a group of their own (`sync`), for a caller that runs
 *  them without the whole CLI (tests): errors thrown, never an exit. */
export function buildSyncBrowserProfileCommandGroup(deps: BrowserProfileCliDeps): Command {
  const sync = new Command("sync").exitOverride();
  registerSyncBrowserProfileCommands(sync, deps);
  return sync;
}
