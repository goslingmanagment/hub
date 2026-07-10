import { inspect } from "node:util";

import { Agent, ProxyAgent, buildConnector, request } from "undici";
import { SocksClient } from "socks";

// Stage 26: the sanctioned undici request for non-platform diagnostics that
// must ride an explicit dispatcher (proxy exit-IP checks). Platform-bound
// traffic resolves its transport from the page context
// (services/page-context.ts → adapter dispatcher); Fansly egress without a
// stored proxy is refused there, fail-closed (W3.1, decision #124).
export { request as undiciRequest };

import type { ProxyConfig } from "./types.ts";
import {
  normalizeProxyConfigWithMetadata,
  redactSensitiveText,
} from "./proxy.ts";

const DISPATCHER_CONNECTIONS = 1;
const DISPATCHER_KEEP_ALIVE_TIMEOUT_MS = 10_000;
const DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;
const DISPATCHER_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS = 250;
const HTTP_RETRY_BASE_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

const TIMEOUT_ERROR_NAMES = new Set([
  "AbortError",
  "BodyTimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "TimeoutError",
]);

function buildDispatcherOptions() {
  return {
    connections: DISPATCHER_CONNECTIONS,
    pipelining: 1,
    // Fansly follower syncs start requests every 5s, so the undici 4s default
    // would tear down the socket and force a fresh TCP/TLS connect on every page.
    keepAliveTimeout: DISPATCHER_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS,
    keepAliveTimeoutThreshold: DISPATCHER_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS,
  } as const;
}

export function createRequestDispatcher() {
  return new Agent(buildDispatcherOptions());
}

function buildProxyAuthToken(proxy: {
  username?: string | null;
  password?: string | null;
}) {
  if (proxy.username === null && proxy.password === null) {
    return null;
  }

  return `Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`).toString("base64")}`;
}

function createSocksProxyDispatcher(proxy: ProxyConfig) {
  const normalized = normalizeProxyConfigWithMetadata(proxy);
  const tlsConnector = buildConnector({
    timeout: CONNECT_TIMEOUT_MS,
    keepAliveInitialDelay: DISPATCHER_KEEP_ALIVE_TIMEOUT_MS,
  });

  return new Agent({
    ...buildDispatcherOptions(),
    connect: (options, callback) => {
      SocksClient.createConnection({
        command: "connect",
        timeout: CONNECT_TIMEOUT_MS,
        set_tcp_nodelay: true,
        proxy: {
          host: normalized.hostname,
          port: normalized.port,
          type: 5,
          userId: normalized.hasAuth ? (normalized.username ?? "") : undefined,
          password: normalized.hasAuth ? (normalized.password ?? "") : undefined,
        },
        destination: resolveSocksDestination(options),
      }).then(({ socket }) => {
        socket.setKeepAlive(true, DISPATCHER_KEEP_ALIVE_TIMEOUT_MS);
        socket.setNoDelay(true);

        if (options.protocol !== "https:") {
          callback(null, socket);
          return;
        }

        tlsConnector({
          ...options,
          servername: options.servername ?? options.hostname,
          httpSocket: socket,
        }, callback);
      }).catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), null);
      });
    },
  });
}

function resolveSocksDestination(options: Parameters<ReturnType<typeof buildConnector>>[0]) {
  const explicitPort = options.port.length > 0 ? Number.parseInt(options.port, 10) : Number.NaN;
  if (Number.isFinite(explicitPort)) {
    return {
      host: options.hostname,
      port: explicitPort,
    };
  }

  return {
    host: options.hostname,
    port: defaultPortForProtocol(options.protocol),
  };
}

function defaultPortForProtocol(protocol: string) {
  switch (protocol) {
    case "http:":
      return 80;
    case "https:":
      return 443;
    default:
      throw new Error(`Unsupported protocol for SOCKS destination: ${protocol}`);
  }
}

export function createProxyRequestDispatcher(proxy: ProxyConfig) {
  const normalized = normalizeProxyConfigWithMetadata(proxy);
  if (normalized.protocol === "socks5:") {
    return createSocksProxyDispatcher(normalized);
  }

  return new ProxyAgent({
    uri: normalized.url,
    token: buildProxyAuthToken(normalized) ?? undefined,
    ...buildDispatcherOptions(),
  });
}

export function classifyTransportError(error: unknown): "timeout" | "transport" {
  for (const cause of iterateErrorChain(error)) {
    if (cause instanceof Error && TIMEOUT_ERROR_NAMES.has(cause.name)) {
      return "timeout";
    }
  }

  return "transport";
}

export function formatObservedError(error: unknown) {
  return redactSensitiveText(Array.from(iterateErrorChain(error))
    .map((cause, index) => `${index === 0 ? "" : `cause(${index}): `}${formatErrorCause(cause)}`)
    .join(" | "));
}

export function parseRetryAfterDelayMs(retryAfterHeader: string | null, now = Date.now()) {
  if (!retryAfterHeader) {
    return null;
  }

  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.min(Math.max(0, retryAt - now), MAX_RETRY_DELAY_MS);
}

export function exponentialRetryDelayMs(attemptNumber: number) {
  const delay = HTTP_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptNumber - 1));
  // Spread retries across the [50%, 100%] band so concurrent failures (e.g. a
  // shared proxy returning 503) don't all retry on the same boundary.
  return Math.round(delay * (0.5 + Math.random() * 0.5));
}

export function resolveRetryDelayMs(retryAfterHeader: string | null, attemptNumber: number, now = Date.now()) {
  return parseRetryAfterDelayMs(retryAfterHeader, now) ?? exponentialRetryDelayMs(attemptNumber);
}

function formatErrorCause(error: unknown) {
  if (error instanceof Error) {
    const metadata = extractErrorMetadata(error);
    const summary = redactSensitiveText(`${error.name}: ${error.message || "(no message)"}`);
    return metadata.length > 0 ? `${summary} (${metadata.join(", ")})` : summary;
  }

  if (typeof error === "string") {
    return redactSensitiveText(error);
  }

  return redactSensitiveText(inspect(error, { depth: 2, breakLength: Infinity }));
}

function extractErrorMetadata(error: Error) {
  const metadata: string[] = [];
  const fields = error as Error & Record<string, unknown>;

  pushErrorField(metadata, "code", fields.code);
  pushErrorField(metadata, "errno", fields.errno);
  pushErrorField(metadata, "syscall", fields.syscall);
  pushErrorField(metadata, "address", fields.address);
  pushErrorField(metadata, "port", fields.port);

  const socketDetails = formatSocketDetails(fields.socket);
  if (socketDetails) {
    metadata.push(`socket={${socketDetails}}`);
  }

  return metadata;
}

function pushErrorField(metadata: string[], label: string, value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    metadata.push(`${label}=${value}`);
  }
}

function formatSocketDetails(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const socket = value as Record<string, unknown>;
  const fields: string[] = [];

  pushErrorField(fields, "localAddress", socket.localAddress);
  pushErrorField(fields, "localPort", socket.localPort);
  pushErrorField(fields, "remoteAddress", socket.remoteAddress);
  pushErrorField(fields, "remotePort", socket.remotePort);
  pushErrorField(fields, "remoteFamily", socket.remoteFamily);
  pushErrorField(fields, "timeout", socket.timeout);
  pushErrorField(fields, "bytesWritten", socket.bytesWritten);
  pushErrorField(fields, "bytesRead", socket.bytesRead);

  return fields.length > 0 ? fields.join(", ") : null;
}

function* iterateErrorChain(error: unknown) {
  let current = error;
  const visited = new Set<object>();

  while (current !== null && current !== undefined) {
    yield current;

    if (typeof current !== "object") {
      return;
    }

    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
}
