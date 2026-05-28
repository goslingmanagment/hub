import { createHash } from "node:crypto";

import type { ProxyConfig } from "./types.ts";

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);
const URL_CANDIDATE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const TELEGRAM_BOT_TOKEN_PATH_PATTERN = /^\/(?:file\/)?bot[^/]+(?=\/|$)/i;

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

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isIpv4Literal(hostname: string) {
  const octets = hostname.split(".");
  return octets.length === 4 && octets.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255;
  });
}

function isIpv6Literal(hostname: string) {
  return hostname.includes(":");
}

function parseIpv6Groups(hostname: string) {
  const withoutZone = hostname.split("%", 1)[0]?.toLowerCase() ?? "";
  const normalized = withoutZone.includes(".")
    ? replaceDottedIpv4Tail(withoutZone)
    : withoutZone;
  if (!normalized) {
    return null;
  }

  const compressedParts = normalized.split("::");
  if (compressedParts.length > 2) {
    return null;
  }

  const left = compressedParts[0]
    ? compressedParts[0].split(":").filter((part) => part.length > 0)
    : [];
  const right = compressedParts.length === 2 && compressedParts[1]
    ? compressedParts[1].split(":").filter((part) => part.length > 0)
    : [];
  const missingGroupCount = compressedParts.length === 2
    ? 8 - left.length - right.length
    : 0;
  if (missingGroupCount < 0 || (compressedParts.length === 1 && left.length !== 8)) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: missingGroupCount }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) {
    return null;
  }

  const parsed = groups.map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return Number.NaN;
    }
    return Number.parseInt(group, 16);
  });
  return parsed.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? parsed
    : null;
}

function replaceDottedIpv4Tail(hostname: string) {
  const lastColon = hostname.lastIndexOf(":");
  if (lastColon === -1) {
    return hostname;
  }

  const ipv4Tail = hostname.slice(lastColon + 1);
  if (!isIpv4Literal(ipv4Tail)) {
    return hostname;
  }

  const [a = 0, b = 0, c = 0, d = 0] = ipv4Tail.split(".").map((part) => Number.parseInt(part, 10));
  return `${hostname.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function mappedIpv6ToIpv4(hostname: string) {
  const groups = parseIpv6Groups(hostname);
  if (!groups) {
    return null;
  }

  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!isMapped) {
    return null;
  }

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".");
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = mappedIpv6ToIpv4(normalized);
  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }

  const groups = parseIpv6Groups(normalized);
  if (!groups) {
    return false;
  }

  const [firstGroup = 0] = groups;
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isUniqueLocal = (firstGroup & 0xfe00) === 0xfc00;
  const isLinkLocal = (firstGroup & 0xffc0) === 0xfe80;
  const isSiteLocal = (firstGroup & 0xffc0) === 0xfec0;
  const isMulticast = (firstGroup & 0xff00) === 0xff00;

  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isSiteLocal ||
    isMulticast
  );
}

export function isDisallowedProxyHostname(hostname: string) {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost") ||
    (isIpv4Literal(normalizedHostname) && isPrivateIpv4(normalizedHostname)) ||
    (isIpv6Literal(normalizedHostname) && isPrivateIpv6(normalizedHostname))
  );
}

export function assertProxyTargetAllowed(proxy: ProxyConfig) {
  const normalized = parseNormalizedProxyConfig(proxy);
  if (
    isDisallowedProxyHostname(normalized.hostname)
  ) {
    throw new Error("Proxy host must not be loopback, private, link-local, multicast, or localhost");
  }
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

function redactTelegramBotTokenUrl(url: URL) {
  if (url.hostname !== "api.telegram.org") {
    return null;
  }

  const redactedPath = url.pathname.replace(TELEGRAM_BOT_TOKEN_PATH_PATTERN, (match) =>
    match.replace(/bot[^/]+/i, "bot[REDACTED]"));

  if (redactedPath === url.pathname) {
    return null;
  }

  return `${url.origin}${redactedPath}${url.search}${url.hash}`;
}

function formatMaskedCredentialUrl(url: URL) {
  if (!url.username && !url.password) {
    return null;
  }

  const masked = new URL(url.toString());
  masked.username = "";
  masked.password = "";
  const origin = masked.host.length > 0
    ? `${masked.protocol}//${masked.host}`
    : `${masked.protocol}//`;
  const suffix = masked.pathname === "/" && masked.search.length === 0 && masked.hash.length === 0
    ? ""
    : `${masked.pathname}${masked.search}${masked.hash}`;
  return `${origin}${suffix} (auth)`;
}

export function redactSensitiveText(value: string) {
  return value.replace(URL_CANDIDATE_PATTERN, (candidate) => {
    const { core, suffix } = splitTrailingPunctuation(candidate);

    try {
      const parsed = new URL(core);
      const redactedTelegramUrl = redactTelegramBotTokenUrl(parsed);
      if (redactedTelegramUrl) {
        return `${redactedTelegramUrl}${suffix}`;
      }

      if (SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        if (!parsed.username && !parsed.password) {
          return candidate;
        }

        return `${formatMaskedProxyUrl({ url: core })}${suffix}`;
      }

      const redactedCredentialUrl = formatMaskedCredentialUrl(parsed);
      if (redactedCredentialUrl) {
        return `${redactedCredentialUrl}${suffix}`;
      }

      return candidate;
    } catch {
      return candidate;
    }
  });
}
