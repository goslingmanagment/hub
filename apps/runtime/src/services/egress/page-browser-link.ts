import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { sql } from "drizzle-orm";

import {
  findOnboardingProfile,
  findPageBrowserByPage,
  findPageById,
  pageBrowserEnvOf,
  type Database,
  type OnboardingProfile,
  type PageBrowserRow,
} from "@agency_hub_core/db";
import {
  decryptJsonWithKeyVersion,
  encryptJson,
  normalizeProxyConfigWithMetadata,
  type AppConfig,
} from "@agency_hub_core/shared";

import type { Hello, OperatorParams } from "./page-browser-protocol.ts";
import type { PageBrowserLinkSettings } from "./page-browser-rpc.ts";

// A page's browser as the engine reaches it (Project Browser, plan §3.1, §4.5,
// §4.13; 0275): the RPC address of its container on pb-control, the secrets
// Hub keeps of it (sealed as a proxy's auth is), and what the engine's hello
// tells its operator — the page's token, its expected account, its SOCKS5
// (the operator dials an IP: the name is resolved here, plan §4.5) and the
// settings the caller gives (the pinned exit IP and the page's environment,
// which Hub keeps elsewhere).

type SecretsConfig = Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion" | "encryptionKeysByVersion">;

/** The operator's RPC port on pb-control (plan §3.1). */
export const PAGE_BROWSER_RPC_PORT = 7700;

export function pageBrowserRpcUrl(container: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(container)) throw new Error("not a page browser container name");
  return `ws://${container}:${PAGE_BROWSER_RPC_PORT}/rpc`;
}

export interface PageBrowserSecrets {
  engineToken: string;
  apiToken: string;
  vncPassword: string;
}

/** The page's browser secrets, each an encrypted JSON envelope with the
 *  current key (as `egress_endpoints.encrypted_auth`). */
export function sealPageBrowserSecrets(config: SecretsConfig, secrets: PageBrowserSecrets): {
  encryptedEngineToken: string;
  encryptedApiToken: string;
  encryptedVncPassword: string;
  keyVersion: number;
} {
  const seal = (value: string) => JSON.stringify(encryptJson({ value }, config.encryptionKey, config.encryptionKeyVersion));
  return {
    encryptedEngineToken: seal(secrets.engineToken),
    encryptedApiToken: seal(secrets.apiToken),
    encryptedVncPassword: seal(secrets.vncPassword),
    keyVersion: config.encryptionKeyVersion,
  };
}

/** One sealed secret, opened (any key version the process knows). */
export function openPageBrowserSecret(config: SecretsConfig, sealed: string): string {
  const opened = decryptJsonWithKeyVersion<{ value?: unknown }>(sealed, config.encryptionKeysByVersion);
  if (typeof opened.value !== "string" || opened.value.length === 0) throw new Error("a page browser secret that does not read");
  return opened.value;
}

/** What the page's settings say of its browser that Hub does not store with
 *  the profile (the caller reads them where they live). */
export interface PageBrowserPageSettings {
  pinnedExitIp: string;
  env: Hello["env"];
  params?: OperatorParams;
}

export class PageBrowserNotConfiguredError extends Error {
  constructor(readonly pageId: number, readonly why: string) {
    super(`Page ${pageId} has no usable browser: ${why}`);
    this.name = "PageBrowserNotConfiguredError";
  }
}

/**
 * The settings of the page's browser that Hub keeps on its profile (0277):
 * the pinned exit IP and the environment — or why they cannot be had (no
 * profile bound to the page, nothing pinned, no well-formed environment).
 */
export async function readPageBrowserPageSettings(
  db: Database,
  pageId: number,
): Promise<{ profile: PageBrowserRow; settings: PageBrowserPageSettings } | { problem: string }> {
  const profile = await findPageBrowserByPage(db, pageId);
  if (profile === null) return { problem: "no browser profile is bound to the page" };
  if (profile.pinnedExitIp === null) return { problem: "its browser has no pinned exit IP" };
  const env = pageBrowserEnvOf(profile.env);
  if (env === null) return { problem: "its browser has no environment (time zone, languages, geolocation)" };
  return { profile, settings: { pinnedExitIp: profile.pinnedExitIp, env } };
}

/** The page's browser profile and its RPC address (null: the page has none). */
export async function readPageBrowserAddress(db: Database, pageId: number): Promise<{ profileId: string; url: string } | null> {
  const row = await findPageBrowserByPage(db, pageId);
  return row === null ? null : { profileId: row.profileId, url: pageBrowserRpcUrl(row.container) };
}

/**
 * The settings of one hello of the page's browser (spec §6.1): read anew at
 * every connect, so a changed proxy or token goes in the next hello. The
 * page's proxy must be a SOCKS5 one; its host is resolved to an IP here.
 */
export async function readPageBrowserLinkSettings(
  ctx: { db: Database; config: SecretsConfig },
  pageId: number,
  page: PageBrowserPageSettings,
  options: { resolve?: (host: string) => Promise<string> } = {},
): Promise<PageBrowserLinkSettings> {
  const [browser, stored] = await Promise.all([findPageBrowserByPage(ctx.db, pageId), findPageById(ctx.db, pageId)]);
  if (browser === null) throw new PageBrowserNotConfiguredError(pageId, "no browser profile is bound to it");
  if (stored === null) throw new PageBrowserNotConfiguredError(pageId, "the page is not active");
  const expectedAccountId = stored.page.platformAccountId;
  if (expectedAccountId === null || expectedAccountId === "") throw new PageBrowserNotConfiguredError(pageId, "its account id is not known");
  const proxy = stored.proxy;
  if (proxy === undefined || proxy === null) throw new PageBrowserNotConfiguredError(pageId, "it has no proxy");
  const auth = proxy.encryptedAuth === null
    ? null
    : decryptJsonWithKeyVersion<{ username: string | null; password: string | null }>(proxy.encryptedAuth, ctx.config.encryptionKeysByVersion);
  const normalized = normalizeProxyConfigWithMetadata({ url: proxy.url, username: auth?.username ?? null, password: auth?.password ?? null });
  if (!normalized.protocol.startsWith("socks5")) throw new PageBrowserNotConfiguredError(pageId, "its proxy is not a SOCKS5 one");
  const host = normalized.hostname.replace(/^\[|\]$/g, "");
  const ip = isIP(host) !== 0 ? host : await (options.resolve ?? resolveHost)(host);
  if (isIP(ip) === 0) throw new PageBrowserNotConfiguredError(pageId, "its proxy's host does not resolve to an address");
  return {
    token: openPageBrowserSecret(ctx.config, browser.encryptedEngineToken),
    pageId,
    expectedAccountId,
    pinnedExitIp: page.pinnedExitIp,
    socks5: { ip, port: Number(normalized.port), username: normalized.username ?? "", password: normalized.password ?? "" },
    env: page.env,
    ...(page.params === undefined ? {} : { params: page.params }),
  };
}

/** The rows a link revision is made of, read in one statement: the page's
 *  browser profile (null: none bound), the page's account (null: the page is
 *  not active) and its proxy row as stored (null: none), with the profile's
 *  pin and environment as stored. */
interface LinkRevisionRow {
  profile: { id: string; container: string; token: string; pinnedExitIp: string | null; env: Record<string, unknown> | null } | null;
  account: string | null;
  proxy: { id: number; url: string; auth: string | null; keyVersion: number | null } | null;
}

async function readLinkRevisionRow(db: Database, pageId: number): Promise<LinkRevisionRow> {
  // Started from the page id, so a page with no browser profile still reads
  // its account and proxy (as `findPageBrowserByPage` + `findPageById` did).
  // egress_endpoints.platform_account_id and page_browsers.page_id are UNIQUE:
  // the joins add at most one row each.
  const result = await db.execute<{
    profileId: string | null;
    container: string | null;
    token: string | null;
    pinnedExitIp: string | null;
    env: unknown;
    account: string | null;
    proxyId: string | null;
    proxyUrl: string | null;
    proxyAuth: string | null;
    proxyKeyVersion: number | null;
  }>(sql`
    select b.profile_id::text as "profileId",
           b.container,
           b.encrypted_engine_token as "token",
           b.pinned_exit_ip as "pinnedExitIp",
           b.env,
           p.external_page_id as "account",
           e.id::text as "proxyId",
           e.url as "proxyUrl",
           e.encrypted_auth as "proxyAuth",
           e.key_version as "proxyKeyVersion"
      from (select ${pageId}::bigint as id) x
      left join page_browsers b on b.page_id = x.id
      left join pages p on p.id = x.id and p.status = 'active'
      left join egress_endpoints e on e.platform_account_id = p.id
  `);
  const row = result.rows[0]!;
  return {
    profile: row.profileId === null
      ? null
      : {
          id: row.profileId,
          container: row.container!,
          token: row.token!,
          pinnedExitIp: row.pinnedExitIp,
          env: row.env !== null && typeof row.env === "object" && !Array.isArray(row.env) ? row.env as Record<string, unknown> : null,
        },
    account: row.account,
    proxy: row.proxyId === null
      ? null
      : { id: Number(row.proxyId), url: row.proxyUrl!, auth: row.proxyAuth, keyVersion: row.proxyKeyVersion },
  };
}

function linkRevisionOf(row: LinkRevisionRow, page: PageBrowserPageSettings): string {
  return createHash("sha256").update(JSON.stringify({
    profile: row.profile === null ? null : { id: row.profile.id, container: row.profile.container, token: row.profile.token },
    account: row.account,
    proxy: row.proxy,
    page,
  })).digest("hex");
}

/**
 * A cheap revision of what `readPageBrowserLinkSettings` is made of — the
 * profile's token as stored, the page's account, its proxy row as stored and
 * the caller's settings — with no decryption and no name resolution (a proxy
 * host that resolves round-robin is not a change). The RPC client compares it
 * before each request to say hello again when it moved.
 */
export async function readPageBrowserLinkRevision(
  ctx: { db: Database },
  pageId: number,
  page: PageBrowserPageSettings,
): Promise<string> {
  return linkRevisionOf(await readLinkRevisionRow(ctx.db, pageId), page);
}

/**
 * The same revision with the caller's settings taken from the profile's own
 * pin and environment (`readPageBrowserPageSettings`), all in one statement —
 * or why they cannot be had (the same reasons, in the same order).
 */
export async function readPageBrowserLinkRevisionOfPage(
  ctx: { db: Database },
  pageId: number,
): Promise<{ revision: string } | { problem: string }> {
  const row = await readLinkRevisionRow(ctx.db, pageId);
  if (row.profile === null) return { problem: "no browser profile is bound to the page" };
  if (row.profile.pinnedExitIp === null) return { problem: "its browser has no pinned exit IP" };
  const env = pageBrowserEnvOf(row.profile.env);
  if (env === null) return { problem: "its browser has no environment (time zone, languages, geolocation)" };
  return { revision: linkRevisionOf(row, { pinnedExitIp: row.profile.pinnedExitIp, env }) };
}

async function resolveHost(host: string): Promise<string> {
  return (await lookup(host, { family: 4 })).address;
}

// ── a profile no page has yet (Project Browser PR 16) ─────────────────────

/** The hello's page of a profile that serves no page yet: the operator keeps
 *  its owner generations apart from every page's (`rpc/generation.ts`). */
export const ONBOARDING_PAGE_ID = 0;

/** Why the link to a profile no page has cannot say hello (no proxy given,
 *  nothing pinned, no environment, bound meanwhile), or null. */
export function onboardingLinkProblem(profile: OnboardingProfile): string | null {
  if (profile.pageId !== null) return "the profile is bound to a page";
  if (profile.proxy === null) return "no proxy is given for the page to be";
  if (profile.pinnedExitIp === null) return "its exit IP is not pinned";
  if (pageBrowserEnvOf(profile.env) === null) return "its browser has no environment (time zone, languages, geolocation)";
  return null;
}

/**
 * The settings of one hello to the browser of a profile no page has yet
 * (plan §3.2 «Подключение новой страницы через браузер»): the profile's own
 * token, no page (`ONBOARDING_PAGE_ID`) and no expected account — the
 * operator confirms no session then, and Hub learns the account from its
 * own read — the proxy the owner gave for the page to be (SOCKS5 only, at
 * the address its container was made for — its host resolved here only for
 * a profile that has none), the pinned exit IP and the environment.
 */
export async function readOnboardingLinkSettings(
  ctx: { db: Database; config: SecretsConfig },
  profileId: string,
  options: { resolve?: (host: string) => Promise<string> } = {},
): Promise<PageBrowserLinkSettings> {
  const profile = await findOnboardingProfile(ctx.db, profileId);
  if (profile === null) throw new Error(`No page browser profile ${profileId}`);
  const problem = onboardingLinkProblem(profile);
  if (problem !== null) throw new Error(`Page browser profile ${profileId} cannot be linked: ${problem}`);
  const proxy = profile.proxy!;
  const auth = proxy.encryptedAuth === null
    ? null
    : decryptJsonWithKeyVersion<{ username: string | null; password: string | null }>(proxy.encryptedAuth, ctx.config.encryptionKeysByVersion);
  const normalized = normalizeProxyConfigWithMetadata({ url: proxy.url, username: auth?.username ?? null, password: auth?.password ?? null });
  if (!normalized.protocol.startsWith("socks5")) throw new Error(`Page browser profile ${profileId}: the proxy given is not a SOCKS5 one`);
  let ip: string;
  if (profile.socksEndpoint !== null) {
    // The address the container was made for, judged public when the owner
    // gave the proxy: no DNS answer of now replaces it (Astra's review of PR
    // #627, item 3). Its port must be the proxy's.
    const [endpointIp, endpointPort] = profile.socksEndpoint.split(":");
    if (Number(endpointPort) !== Number(normalized.port)) {
      throw new Error(`Page browser profile ${profileId}: the proxy's port is not the one of the SOCKS5 its container was made for (${profile.socksEndpoint})`);
    }
    ip = endpointIp!;
  } else {
    const host = normalized.hostname.replace(/^\[|\]$/g, "");
    ip = isIP(host) !== 0 ? host : await (options.resolve ?? resolveHost)(host);
  }
  if (isIP(ip) === 0) throw new Error(`Page browser profile ${profileId}: the proxy's host does not resolve to an address`);
  return {
    token: openPageBrowserSecret(ctx.config, profile.encryptedEngineToken),
    pageId: ONBOARDING_PAGE_ID,
    expectedAccountId: "",
    pinnedExitIp: profile.pinnedExitIp!,
    socks5: { ip, port: Number(normalized.port), username: normalized.username ?? "", password: normalized.password ?? "" },
    env: pageBrowserEnvOf(profile.env)!,
  };
}

/** A cheap revision of what `readOnboardingLinkSettings` is made of (the
 *  rows as stored; no decryption, no name resolution): a moved pin or proxy
 *  is said in a new hello. */
export async function readOnboardingLinkRevision(ctx: { db: Database }, profileId: string): Promise<string> {
  const profile = await findOnboardingProfile(ctx.db, profileId);
  return createHash("sha256").update(JSON.stringify(profile === null ? null : {
    id: profile.profileId,
    container: profile.container,
    token: profile.encryptedEngineToken,
    proxy: profile.proxy,
    pin: profile.pinnedExitIp,
    env: profile.env,
    bound: profile.pageId,
  })).digest("hex");
}
