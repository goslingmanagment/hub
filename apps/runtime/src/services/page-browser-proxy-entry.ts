import { isIP } from "node:net";

import type { PageBrowserMaskedProxy, PageBrowserProxyCheckResponse } from "@agency_hub_core/contracts";
import {
  decryptJsonWithKeyVersion,
  encryptJson,
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

import { checkProxy, resolveProxyHost, type ProxyCheckOptions, type ProxyHostRead } from "./egress/proxy-check.ts";
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
 *  the proxy names' DNS, and the addresses taken as public (a test's
 *  SOCKS5 listens on loopback). */
export interface ProxyCheckOverrides {
  options?: ProxyCheckOptions;
  resolve?: (host: string) => Promise<string[]>;
  allowAddresses?: (ip: string) => boolean;
}

/** The proxy's host resolved ONCE and judged (every address public): the
 *  IPv4 address the check connects to and a page's container is made for. */
export function proxyHostOf(proxy: Pick<PastedProxy, "host" | "hostKind">, overrides?: ProxyCheckOverrides): Promise<ProxyHostRead> {
  return resolveProxyHost(proxy.host, proxy.hostKind, {
    ...(overrides?.resolve === undefined ? {} : { resolve: overrides.resolve }),
    ...(overrides?.allowAddresses === undefined ? {} : { allow: overrides.allowAddresses }),
  });
}

/** Why a host cannot be a page browser's proxy, in the owner's words. */
function hostProblemText(read: Exclude<ProxyHostRead, { ip: string }>): string {
  switch (read.problem) {
    case "dns":
      return "Имя прокси не находится в DNS — проверьте адрес";
    case "ipv6":
      return "Адрес прокси — только IPv6, а сеть браузеров страниц только IPv4";
    case "private_address":
      return "Адрес прокси локальный, частный или служебный: нужна прокси с публичным адресом в интернете";
  }
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

/**
 * The SOCKS5 endpoint a page's container is made for: the proxy's host
 * resolved once, every address public, `ip:port` of its IPv4 one — or a 400
 * in the owner's words (`reason: proxy_unusable`). Stored with the draft:
 * add-profile takes this address, never a later DNS answer (Astra's review
 * of PR #627, item 3).
 */
export async function socksEndpointOrRefuse(proxy: Pick<PastedProxy, "host" | "hostKind" | "port">, overrides?: ProxyCheckOverrides): Promise<string> {
  const read = await proxyHostOf(proxy, overrides);
  if (!("ip" in read)) throw new BadRequestError(hostProblemText(read), { reason: "proxy_unusable" });
  return `${read.ip}:${proxy.port}`;
}

/**
 * A pasted proxy a page's browser can go out through, sealed for storing:
 * its URL (`socks5://host:port`) and its login and password as one
 * encrypted envelope with the key version, and the public `ip:port` it was
 * judged at. A 400 in the owner's words otherwise (`reason:
 * proxy_unusable`).
 */
export async function sealUsableProxy(
  config: SecretsConfig,
  proxy: PastedProxy,
  overrides?: ProxyCheckOverrides,
): Promise<{ url: string; encryptedAuth: string; keyVersion: number; masked: PageBrowserMaskedProxy; socksEndpoint: string }> {
  const problem = pageBrowserProxyProblem(proxy);
  if (problem !== null) throw new BadRequestError(problem, { reason: "proxy_unusable" });
  const socksEndpoint = await socksEndpointOrRefuse(proxy, overrides);
  const stored = pastedProxyConfig(proxy);
  return {
    url: stored.url,
    encryptedAuth: JSON.stringify(encryptJson({ username: stored.username, password: stored.password }, config.encryptionKey, config.encryptionKeyVersion)),
    keyVersion: config.encryptionKeyVersion,
    masked: maskPastedProxy(proxy),
    socksEndpoint,
  };
}

/**
 * The owner's check of a proxy: refused before any connection when Hub can
 * say why already (IPv6, a local or private address), else through the
 * proxy (`checkProxy`) — and the environment proposed from its exit.
 */
export async function checkPageBrowserProxy(proxy: PastedProxy, overrides?: ProxyCheckOverrides): Promise<PageBrowserProxyCheckResponse> {
  const base = { proxy: maskPastedProxy(proxy), checkedAt: new Date().toISOString() };
  // Resolved once, every address judged; the check connects to that address.
  const host = await proxyHostOf(proxy, overrides);
  if (!("ip" in host)) {
    return { ...base, ok: false, problem: { code: host.problem, detail: host.detail }, spoken: null, socksEndpoint: null, latencyMs: null, exit: null, ipInfoService: null, env: null };
  }
  const result = await checkProxy({ ip: host.ip, port: proxy.port, username: proxy.username, password: proxy.password }, overrides?.options);
  const env = result.exit === null ? null : proposeBrowserEnv(result.exit);
  return { ...base, ...result, env };
}
