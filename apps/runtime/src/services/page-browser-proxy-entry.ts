import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { PageBrowserMaskedProxy, PageBrowserProxyCheckResponse } from "@agency_hub_core/contracts";
import {
  decryptJsonWithKeyVersion,
  encryptJson,
  isDisallowedProxyHostname,
  maskPastedProxy,
  normalizeProxyConfigWithMetadata,
  pageBrowserProxyProblem,
  pastedProxyConfig,
  proposeBrowserEnv,
  readPastedProxy,
  type AppConfig,
  type PastedProxy,
  type PastedProxyOrder,
} from "@agency_hub_core/shared";

import { checkProxy, type ProxyCheckOptions } from "./egress/proxy-check.ts";
import { BadRequestError } from "./errors.ts";

// The proxy of a page's server browser as the owner gives it (Project
// Browser, owner decision 2026-10-15): one field, any common format, read by
// Hub (`readPastedProxy` — the dashboard's preview is the same reading, but
// Hub reads the text again and takes nothing else); a proxy a page's browser
// can use (SOCKS5 with its login and password, a public IPv4 address or
// name); its login and password sealed as `egress_endpoints.encrypted_auth`
// is, never returned. And the owner's check of it (`proxy-check.ts`), with
// the browser's environment proposed from where it goes out.

type SecretsConfig = Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion" | "encryptionKeysByVersion">;

/** TESTS ONLY: the check's options (its services behind a local SOCKS5),
 *  and loopback proxies let through (a test's SOCKS5 listens there). */
export interface ProxyCheckOverrides {
  options?: ProxyCheckOptions;
  allowLoopback?: boolean;
}

/** The pasted text read by Hub, or a 400 in the owner's words (`reason`:
 *  `proxy_unreadable`, `proxy_ambiguous`, `proxy_empty`). */
export function readProxyText(input: { text: string; order?: PastedProxyOrder | undefined }): PastedProxy {
  const read = readPastedProxy(input.text, input.order);
  switch (read.kind) {
    case "parsed":
      return read.proxy;
    case "empty":
      throw new BadRequestError("Прокси не вставлена", { reason: "proxy_empty" });
    case "invalid":
      throw new BadRequestError(read.reason, { reason: "proxy_unreadable" });
    case "ambiguous":
      throw new BadRequestError("Не понять, где адрес, а где логин: выберите, как читать прокси", { reason: "proxy_ambiguous" });
  }
}

/** A proxy Hub stores (URL, sealed auth) as the parts the check takes. */
export function storedProxyAsPasted(config: SecretsConfig, stored: { url: string; encryptedAuth: string | null }): PastedProxy {
  const auth = stored.encryptedAuth === null
    ? null
    : decryptJsonWithKeyVersion<{ username: string | null; password: string | null }>(stored.encryptedAuth, config.encryptionKeysByVersion);
  const normalized = normalizeProxyConfigWithMetadata({ url: stored.url, username: auth?.username ?? null, password: auth?.password ?? null });
  const host = normalized.hostname.replace(/^\[|\]$/g, "");
  return {
    scheme: normalized.protocol === "socks5:" ? "socks5" : normalized.protocol === "https:" ? "https" : "http",
    schemeGiven: true,
    host,
    hostKind: isIP(host) === 4 ? "ipv4" : isIP(host) === 6 ? "ipv6" : "name",
    port: normalized.port,
    username: normalized.username ?? null,
    password: normalized.password ?? null,
  };
}

/** What may be shown of a stored proxy (its password never). */
export function maskStoredProxy(config: SecretsConfig, stored: { url: string; encryptedAuth: string | null }): PageBrowserMaskedProxy | null {
  try {
    return maskPastedProxy(storedProxyAsPasted(config, stored));
  } catch {
    return null;
  }
}

/** Why the proxy's address is a local or private one (its name resolved),
 *  or null. */
async function privateAddressProblem(proxy: PastedProxy): Promise<string | null> {
  if (isDisallowedProxyHostname(proxy.host)) return "Адрес прокси локальный или частный: нужна прокси в интернете";
  if (proxy.hostKind !== "name") return null;
  try {
    const addresses = await lookup(proxy.host, { all: true, verbatim: true });
    if (addresses.some((address) => isDisallowedProxyHostname(address.address))) return "Имя прокси ведёт на локальный или частный адрес";
  } catch {
    // A name that does not resolve: the check says so in its own words.
  }
  return null;
}

/**
 * A pasted proxy a page's browser can go out through, sealed for storing:
 * its URL (`socks5://host:port`) and its login and password as one
 * encrypted envelope with the key version. A 400 in the owner's words
 * otherwise (`reason: proxy_unusable`).
 */
export async function sealUsableProxy(
  config: SecretsConfig,
  proxy: PastedProxy,
  overrides?: ProxyCheckOverrides,
): Promise<{ url: string; encryptedAuth: string; keyVersion: number; masked: PageBrowserMaskedProxy }> {
  const problem = pageBrowserProxyProblem(proxy)
    ?? (overrides?.allowLoopback === true ? null : await privateAddressProblem(proxy));
  if (problem !== null) throw new BadRequestError(problem, { reason: "proxy_unusable" });
  const stored = pastedProxyConfig(proxy);
  return {
    url: stored.url,
    encryptedAuth: JSON.stringify(encryptJson({ username: stored.username, password: stored.password }, config.encryptionKey, config.encryptionKeyVersion)),
    keyVersion: config.encryptionKeyVersion,
    masked: maskPastedProxy(proxy),
  };
}

/**
 * The owner's check of a proxy: refused before any connection when Hub can
 * say why already (IPv6, a local or private address), else through the
 * proxy (`checkProxy`) — and the environment proposed from its exit.
 */
export async function checkPageBrowserProxy(proxy: PastedProxy, overrides?: ProxyCheckOverrides): Promise<PageBrowserProxyCheckResponse> {
  const base = { proxy: maskPastedProxy(proxy), checkedAt: new Date().toISOString() };
  if (proxy.hostKind === "ipv6") {
    return { ...base, ok: false, problem: { code: "ipv6", detail: "the page browsers' network is IPv4 only" }, spoken: null, socksEndpoint: null, latencyMs: null, exit: null, ipInfoService: null, env: null };
  }
  const local = overrides?.allowLoopback === true ? null : await privateAddressProblem(proxy);
  if (local !== null) {
    return { ...base, ok: false, problem: { code: "private_address", detail: "a local or private address" }, spoken: null, socksEndpoint: null, latencyMs: null, exit: null, ipInfoService: null, env: null };
  }
  const result = await checkProxy(
    { host: proxy.host, hostKind: proxy.hostKind, port: proxy.port, username: proxy.username, password: proxy.password },
    overrides?.options,
  );
  const env = result.exit === null ? null : proposeBrowserEnv(result.exit);
  return { ...base, ...result, env };
}
