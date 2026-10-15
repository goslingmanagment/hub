import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
  const [browser, stored] = await Promise.all([findPageBrowserByPage(ctx.db, pageId), findPageById(ctx.db, pageId)]);
  return createHash("sha256").update(JSON.stringify({
    profile: browser === null ? null : { id: browser.profileId, container: browser.container, token: browser.encryptedEngineToken },
    account: stored?.page.platformAccountId ?? null,
    proxy: stored?.proxy == null ? null : { id: stored.proxy.id, url: stored.proxy.url, auth: stored.proxy.encryptedAuth, keyVersion: stored.proxy.keyVersion },
    page,
  })).digest("hex");
}

async function resolveHost(host: string): Promise<string> {
  return (await lookup(host, { family: 4 })).address;
}

/**
 * `ip:port` of a SOCKS5 proxy as a page's container is made for it — its
 * host resolved to an IPv4 address here, as the hello resolves it (the
 * container's rules admit that address alone; pb-egress has no IPv6) — or
 * why it cannot be one, in the owner's words.
 */
export async function socksEndpointOfProxy(
  url: string,
  options: { resolve?: (host: string) => Promise<string> } = {},
): Promise<{ endpoint: string } | { problem: string }> {
  let normalized: ReturnType<typeof normalizeProxyConfigWithMetadata>;
  try {
    normalized = normalizeProxyConfigWithMetadata({ url });
  } catch {
    return { problem: "the proxy's URL does not read" };
  }
  if (!normalized.protocol.startsWith("socks5")) return { problem: "a page's browser goes out through a SOCKS5 proxy only (socks5://…)" };
  const host = normalized.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 6) return { problem: "the proxy's address is IPv6: a page's browser reaches IPv4 only" };
  let ip: string;
  try {
    ip = isIP(host) === 4 ? host : await (options.resolve ?? resolveHost)(host);
  } catch {
    return { problem: `the proxy's host ${host} does not resolve` };
  }
  if (isIP(ip) !== 4) return { problem: `the proxy's host ${host} does not resolve to an IPv4 address` };
  return { endpoint: `${ip}:${Number(normalized.port)}` };
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
 * own read — the proxy the owner gave for the page to be (SOCKS5 only, its
 * host resolved here), the pinned exit IP and the environment.
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
  const host = normalized.hostname.replace(/^\[|\]$/g, "");
  const ip = isIP(host) !== 0 ? host : await (options.resolve ?? resolveHost)(host);
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

/** The proxy given for a page to be names the SOCKS5 its profile's
 *  container admits (`socks_endpoint`): the host resolved as the hello
 *  resolves it. Null: it does (or the container's is not known); otherwise
 *  why not, in the owner's words. */
export async function onboardingProxyMismatch(
  profile: Pick<OnboardingProfile, "socksEndpoint">,
  proxy: { url: string; username?: string | null; password?: string | null },
  options: { resolve?: (host: string) => Promise<string> } = {},
): Promise<string | null> {
  const normalized = normalizeProxyConfigWithMetadata({ url: proxy.url, username: proxy.username ?? null, password: proxy.password ?? null });
  if (!normalized.protocol.startsWith("socks5")) return "a page's browser goes out through a SOCKS5 proxy only (socks5://…)";
  if (profile.socksEndpoint === null) return null;
  const host = normalized.hostname.replace(/^\[|\]$/g, "");
  let ip: string;
  try {
    ip = isIP(host) !== 0 ? host : await (options.resolve ?? resolveHost)(host);
  } catch {
    return `the proxy's host ${host} does not resolve`;
  }
  const endpoint = `${ip}:${Number(normalized.port)}`;
  return endpoint === profile.socksEndpoint
    ? null
    : `the browser's container was made for the SOCKS5 ${profile.socksEndpoint}; this proxy is ${endpoint}`;
}
