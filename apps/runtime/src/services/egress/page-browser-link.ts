import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { findPageBrowserByPage, findPageById, type Database } from "@agency_hub_core/db";
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
