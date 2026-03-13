import { inspect } from "node:util";

import { Agent, ProxyAgent } from "undici";

const DISPATCHER_CONNECTIONS = 1;
const DISPATCHER_KEEP_ALIVE_TIMEOUT_MS = 10_000;
const DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;
const DISPATCHER_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS = 250;
const HTTP_RETRY_BASE_DELAY_MS = 5_000;

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

export function createProxyRequestDispatcher(proxyUrl: string) {
  return new ProxyAgent({
    uri: proxyUrl,
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
  return Array.from(iterateErrorChain(error))
    .map((cause, index) => `${index === 0 ? "" : `cause(${index}): `}${formatErrorCause(cause)}`)
    .join(" | ");
}

export function parseRetryAfterDelayMs(retryAfterHeader: string | null, now = Date.now()) {
  if (!retryAfterHeader) {
    return null;
  }

  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - now);
}

export function exponentialRetryDelayMs(attemptNumber: number) {
  return HTTP_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptNumber - 1));
}

export function resolveRetryDelayMs(retryAfterHeader: string | null, attemptNumber: number, now = Date.now()) {
  return parseRetryAfterDelayMs(retryAfterHeader, now) ?? exponentialRetryDelayMs(attemptNumber);
}

function formatErrorCause(error: unknown) {
  if (error instanceof Error) {
    const metadata = extractErrorMetadata(error);
    const summary = `${error.name}: ${error.message || "(no message)"}`;
    return metadata.length > 0 ? `${summary} (${metadata.join(", ")})` : summary;
  }

  if (typeof error === "string") {
    return error;
  }

  return inspect(error, { depth: 2, breakLength: Infinity });
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
