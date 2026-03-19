import { createHash } from "node:crypto";

import type { ProxyConfig } from "./types.ts";

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);
const URL_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

type SupportedProxyProtocol = "http:" | "https:" | "socks5:";

export interface NormalizedProxyConfig extends ProxyConfig {
  protocol: SupportedProxyProtocol;
  hostname: string;
  host: string;
  port: number;
  hasAuth: boolean;
}

function normalizeCredentialValue(value: string | null | undefined) {
  return value === undefined || value === null || value.length === 0 ? null : value;
}

function decodeUrlCredential(value: string) {
  return value.length === 0 ? null : decodeURIComponent(value);
}

function resolveCredentialField(
  field: "username" | "password",
  explicitValue: string | null | undefined,
  inlineValue: string | null,
) {
  const explicit = normalizeCredentialValue(explicitValue);
  if (explicit === null) {
    return inlineValue;
  }

  if (inlineValue !== null && inlineValue !== explicit) {
    throw new Error(`Proxy ${field} conflicts with inline credentials in proxy URL`);
  }

  return explicit;
}

function normalizeProxyUrl(url: URL) {
  url.username = "";
  url.password = "";
  if (url.pathname === "/" && url.search.length === 0 && url.hash.length === 0) {
    return `${url.protocol}//${url.host}`;
  }

  return url.toString();
}

function defaultPortForProtocol(protocol: SupportedProxyProtocol) {
  switch (protocol) {
    case "http:":
      return 80;
    case "https:":
      return 443;
    case "socks5:":
      return 1080;
  }
}

function parseNormalizedProxyConfig(proxy: ProxyConfig): NormalizedProxyConfig {
  const parsed = new URL(proxy.url);
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Unsupported proxy protocol "${parsed.protocol}". Expected http://, https://, or socks5://`,
    );
  }

  const protocol = parsed.protocol as SupportedProxyProtocol;
  const inlineUsername = decodeUrlCredential(parsed.username);
  const inlinePassword = decodeUrlCredential(parsed.password);
  const username = resolveCredentialField("username", proxy.username, inlineUsername);
  const password = resolveCredentialField("password", proxy.password, inlinePassword);

  return {
    url: normalizeProxyUrl(parsed),
    username,
    password,
    protocol,
    hostname: parsed.hostname,
    host: parsed.host,
    port: parsed.port.length > 0
      ? Number.parseInt(parsed.port, 10)
      : defaultPortForProtocol(protocol),
    hasAuth: username !== null || password !== null,
  };
}

export function normalizeProxyConfig(proxy: ProxyConfig): ProxyConfig {
  const normalized = parseNormalizedProxyConfig(proxy);
  return {
    url: normalized.url,
    username: normalized.username,
    password: normalized.password,
  };
}

export function normalizeProxyConfigWithMetadata(proxy: ProxyConfig): NormalizedProxyConfig {
  return parseNormalizedProxyConfig(proxy);
}

export function buildProxyDispatcherCacheKey(proxy: ProxyConfig) {
  const normalized = parseNormalizedProxyConfig(proxy);
  const hash = createHash("sha256")
    .update(normalized.url)
    .update("\0")
    .update(normalized.username ?? "")
    .update("\0")
    .update(normalized.password ?? "")
    .digest("hex")
    .slice(0, 16);

  return `${normalized.protocol}//${normalized.host}#${hash}`;
}

export function buildProxyEgressKey(proxy: ProxyConfig | null | undefined): string {
  if (!proxy) {
    return "direct";
  }

  const normalized = normalizeProxyConfigWithMetadata(proxy);
  return `${normalized.protocol}//${normalized.hostname}:${normalized.port}`;
}

export function buildSyncPageExecuteGroupId(
  provider: "fansly" | "onlyfans",
  egressKey: string,
) {
  return `${provider}:${egressKey}`;
}

export function formatMaskedProxyUrl(
  proxy: ProxyConfig | {
    url: string;
    username?: string | null;
    password?: string | null;
    hasAuth?: boolean | null;
  },
) {
  const normalized = parseNormalizedProxyConfig(proxy);
  const hasAuth = normalized.hasAuth || ("hasAuth" in proxy && Boolean(proxy.hasAuth));
  return `${normalized.protocol}//${normalized.host}${hasAuth ? " (auth)" : ""}`;
}

function splitTrailingPunctuation(candidate: string) {
  let end = candidate.length;
  while (end > 0 && ".,);]".includes(candidate[end - 1]!)) {
    end -= 1;
  }

  return {
    core: candidate.slice(0, end),
    suffix: candidate.slice(end),
  };
}

export function redactSensitiveText(value: string) {
  return value.replace(URL_CANDIDATE_PATTERN, (candidate) => {
    const { core, suffix } = splitTrailingPunctuation(candidate);

    try {
      const parsed = new URL(core);
      if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        return candidate;
      }

      if (!parsed.username && !parsed.password) {
        return candidate;
      }

      return `${formatMaskedProxyUrl({ url: core })}${suffix}`;
    } catch {
      return candidate;
    }
  });
}
