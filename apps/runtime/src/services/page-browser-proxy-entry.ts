import { isIP } from "node:net";

import type { PageBrowserMaskedProxy, PageBrowserProxyCheckResponse } from "@agency_hub_core/contracts";
import {
  decryptJsonWithKeyVersion,
  encryptJson,
  maskPastedProxy,
  nonGlobalAddressReason,
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
import type { ProxyCheckLedger, ProxyCheckRefusal } from "./page-browser-proxy-checks.ts";

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
  /** The checks' clock (a check is named by a save while fresh). */
  now?: () => number;
}

/** The proxy's host resolved ONCE and judged (every address public): the
 *  IPv4 address the check connects to and a page's container is made for. */
export function proxyHostOf(proxy: Pick<PastedProxy, "host" | "hostKind">, overrides?: ProxyCheckOverrides): Promise<ProxyHostRead> {
  return resolveProxyHost(proxy.host, proxy.hostKind, {
    ...(overrides?.resolve === undefined ? {} : { resolve: overrides.resolve }),
    ...(overrides?.allowAddresses === undefined ? {} : { allow: overrides.allowAddresses }),
  });
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
 * A pasted proxy a page's browser can go out through, sealed for storing:
 * its URL (`socks5://host:port`) and its login and password as one
 * encrypted envelope with the key version. A 400 in the owner's words
 * otherwise (`reason: proxy_unusable`). Nothing is resolved here: the
 * address it is stored with is its check's (`endpointOfCheck`).
 */
export function sealUsableProxy(
  config: SecretsConfig,
  proxy: PastedProxy,
): { url: string; encryptedAuth: string; keyVersion: number; masked: PageBrowserMaskedProxy } {
  const problem = pageBrowserProxyProblem(proxy);
  if (problem !== null) throw new BadRequestError(problem, { reason: "proxy_unusable" });
  const stored = pastedProxyConfig(proxy);
  return {
    url: stored.url,
    encryptedAuth: JSON.stringify(encryptJson({ username: stored.username, password: stored.password }, config.encryptionKey, config.encryptionKeyVersion)),
    keyVersion: config.encryptionKeyVersion,
    masked: maskPastedProxy(proxy),
  };
}

const CHECK_REFUSALS: Record<ProxyCheckRefusal, { reason: string; text: string }> = {
  no_check: { reason: "check_missing", text: "Сначала проверьте прокси: сохраняется адрес, к которому подключилась проверка" },
  stale: { reason: "check_stale", text: "Проверка устарела: проверьте прокси ещё раз" },
  proxy_changed: { reason: "check_other_proxy", text: "Проверялась другая прокси: проверьте эту" },
};

/**
 * The SOCKS5 address a proxy is stored with: the one its check connected to
 * — the check named, of this very proxy, still fresh (Astra's review of PR
 * #627, round 2) — and still a public one. Nothing is resolved: a 400 in
 * the owner's words otherwise.
 */
export function endpointOfCheck(ledger: ProxyCheckLedger, checkId: string, proxy: PastedProxy, overrides?: ProxyCheckOverrides): string {
  const taken = ledger.take(checkId, proxy);
  if ("refusal" in taken) {
    const refusal = CHECK_REFUSALS[taken.refusal];
    throw new BadRequestError(refusal.text, { reason: refusal.reason });
  }
  const ip = taken.socksEndpoint.slice(0, taken.socksEndpoint.lastIndexOf(":"));
  if (overrides?.allowAddresses?.(ip) !== true && nonGlobalAddressReason(ip) !== null) {
    throw new BadRequestError("Адрес прокси не публичный", { reason: "proxy_unusable" });
  }
  return taken.socksEndpoint;
}

/**
 * The owner's check of a proxy: refused before any connection when Hub can
 * say why already (IPv6, a local or private address), else through the
 * proxy (`checkProxy`) — and the environment proposed from its exit.
 */
export async function checkPageBrowserProxy(proxy: PastedProxy, ledger: ProxyCheckLedger, overrides?: ProxyCheckOverrides): Promise<PageBrowserProxyCheckResponse> {
  const base = { proxy: maskPastedProxy(proxy), checkedAt: new Date().toISOString() };
  // Resolved once, every address judged; the check connects to that address.
  const host = await proxyHostOf(proxy, overrides);
  if (!("ip" in host)) {
    return { ...base, ok: false, problem: { code: host.problem, detail: host.detail }, spoken: null, socksEndpoint: null, latencyMs: null, exit: null, ipInfoService: null, env: null, checkId: null };
  }
  const result = await checkProxy({ ip: host.ip, port: proxy.port, username: proxy.username, password: proxy.password }, overrides?.options);
  const env = result.exit === null ? null : proposeBrowserEnv(result.exit);
  // A check that logged in through the proxy at that address is one a save
  // may name: the address is then the one stored.
  const loggedIn = result.socksEndpoint !== null && result.spoken === "socks5" && (result.ok || result.problem?.code === "ip_info_failed");
  const checkId = loggedIn ? ledger.record(proxy, result.socksEndpoint!) : null;
  return { ...base, ...result, env, checkId };
}
