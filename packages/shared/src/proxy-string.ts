import type { ProxyConfig } from "./types.ts";

const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const DEFAULT_PROTOCOL = "socks5://";
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

/**
 * Parse a raw proxy string into a ProxyConfig.
 *
 * Accepted formats:
 * - `user:pass@host:port`        → socks5://host:port with auth
 * - `socks5://user:pass@host:port`
 * - `http://user:pass@host:port`
 * - `host:port`                  → socks5://host:port, no auth
 * - `socks5://host:port`         → no auth
 *
 * Returns `null` for empty/whitespace input.
 */
export function parseProxyString(raw: string): ProxyConfig | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let urlString: string;

  if (PROTOCOL_PATTERN.test(trimmed)) {
    urlString = trimmed;
  } else {
    // No protocol — could be user:pass@host:port or just host:port.
    // Prepend socks5:// so the URL constructor can parse it.
    urlString = `${DEFAULT_PROTOCOL}${trimmed}`;
  }

  const parsed = new URL(urlString);
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Unsupported proxy protocol "${parsed.protocol}". Expected http://, https://, or socks5://`,
    );
  }

  const username = parsed.username.length > 0
    ? decodeURIComponent(parsed.username)
    : null;
  const password = parsed.password.length > 0
    ? decodeURIComponent(parsed.password)
    : null;

  // Build a clean URL without credentials
  parsed.username = "";
  parsed.password = "";
  const cleanUrl = parsed.pathname === "/" && parsed.search.length === 0 && parsed.hash.length === 0
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.toString();

  return {
    url: cleanUrl,
    username,
    password,
  };
}

/**
 * Format a human-readable preview of a raw proxy string.
 * Returns e.g. `"socks5://1.2.3.4:12324 (auth)"` or `null` if empty/invalid.
 */
export function formatProxyPreview(raw: string): string | null {
  try {
    const config = parseProxyString(raw);
    if (!config) {
      return null;
    }

    const parsed = new URL(config.url);
    const hasAuth = config.username !== null || config.password !== null;
    return `${parsed.protocol}//${parsed.host}${hasAuth ? " (auth)" : ""}`;
  } catch {
    return null;
  }
}

export function getProxyStringError(raw: string): string | null {
  if (raw.trim().length === 0) {
    return null;
  }

  try {
    parseProxyString(raw);
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported proxy protocol")) {
      return error.message;
    }

    return "Invalid proxy URL";
  }
}

/**
 * Convenience wrapper for form submission.
 * Returns a ProxyConfig if the raw string is non-empty, otherwise `undefined`.
 */
export function buildProxyConfig(raw: string): ProxyConfig | undefined {
  try {
    return parseProxyString(raw) ?? undefined;
  } catch {
    return undefined;
  }
}
