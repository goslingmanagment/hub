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
const ANTHROPIC_LOW_CREDIT_MESSAGE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

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

/** Generic service-vendor transport classifier. Connect failures are separated
 * because retrying a dead/auth-rejected proxy cannot change within one
 * operation and must never trigger a direct-route fallback. */
export function classifyTransportFailure(
  error: unknown,
): "connect" | "timeout" | "transport" {
  if (isConnectFailure(error)) {
    return "connect";
  }
  return classifyTransportError(error);
}

// Failure shapes that mean the upstream CONNECTION never came up (proxy dead,
// host unreachable) — as opposed to an established stream dying mid-flight.
const CONNECT_FAILURE_NAMES = new Set(["ConnectTimeoutError", "SocksClientError"]);
const CONNECT_FAILURE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTDOWN",
  "ENETDOWN",
]);

function isConnectFailure(error: unknown): boolean {
  for (const cause of iterateErrorChain(error)) {
    if (!(cause instanceof Error)) {
      continue;
    }
    if (CONNECT_FAILURE_NAMES.has(cause.name)) {
      return true;
    }
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

export type AiProviderId = "anthropic" | "openrouter";
export type AiProviderFailurePhase = "connect" | "provider_response" | "stream";
export type AiProviderFailureCode =
  | "provider_billing"
  | "provider_auth"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_proxy_unreachable"
  | "provider_stream_failed";

export type AiProviderSdkFailureKind =
  | "authentication"
  | "permission"
  | "rate_limited"
  | "unavailable"
  | "bad_request"
  | "connection"
  | "connection_timeout"
  | "api";

/**
 * Adapter-owned envelope for provider failures. Anthropic supplies SDK class,
 * status, body type, and headers here; OpenRouter supplies the fetch response
 * status and headers. The raw provider error remains only on `cause` for the
 * existing redacted server log path.
 */
export class AiProviderFailureError extends Error {
  readonly provider: AiProviderId;
  readonly failurePhase: AiProviderFailurePhase;
  readonly providerHttpStatus: number | null;
  readonly providerErrorType: string | null;
  readonly providerErrorMessage: string | null;
  readonly retryAfterHeader: string | null;
  readonly sdkFailureKind: AiProviderSdkFailureKind | null;

  constructor(input: {
    provider: AiProviderId;
    failurePhase: AiProviderFailurePhase;
    providerHttpStatus?: number | null;
    providerErrorType?: string | null;
    providerErrorMessage?: string | null;
    retryAfterHeader?: string | null;
    sdkFailureKind?: AiProviderSdkFailureKind | null;
    cause?: unknown;
  }) {
    super(`${input.provider} provider ${input.failurePhase} failure`);
    this.name = "AiProviderFailureError";
    this.provider = input.provider;
    this.failurePhase = input.failurePhase;
    this.providerHttpStatus = input.providerHttpStatus ?? null;
    this.providerErrorType = input.providerErrorType ?? null;
    this.providerErrorMessage = input.providerErrorMessage ?? null;
    this.retryAfterHeader = input.retryAfterHeader ?? null;
    this.sdkFailureKind = input.sdkFailureKind ?? null;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

export interface AiProviderFailureClassification {
  code: AiProviderFailureCode;
  failurePhase: AiProviderFailurePhase;
  providerHttpStatus: number | null;
  retryAfterMs: number | null;
}

interface ProviderHttpMetadata {
  providerHttpStatus: number | null;
  providerErrorType: string | null;
  providerErrorMessage: string | null;
  retryAfterHeader: string | null;
  sdkFailureKind: AiProviderSdkFailureKind | null;
}

/**
 * Family-wide AI provider classifier. Adapter metadata wins; structural
 * fallbacks keep injected/test providers and SDK-compatible errors honest.
 * A failure after streaming has begun is always a stream interruption, even
 * if a nested transport error happens to resemble a connect failure.
 */
export function normalizeProviderStreamFailure(
  error: unknown,
  input?: {
    provider?: AiProviderId;
    failurePhase?: AiProviderFailurePhase;
    now?: number;
  },
): AiProviderFailureClassification {
  const normalized = findAiProviderFailure(error);
  const provider = normalized?.provider ?? input?.provider ?? null;
  const phaseHint = input?.failurePhase ?? normalized?.failurePhase ?? null;
  const metadata = providerHttpMetadata(error, normalized);
  const status = metadata.providerHttpStatus;

  // Once provider output has started, the useful truth is that the stream was
  // interrupted. Do not mislabel a late socket failure as a page-proxy dial
  // failure or an HTTP response rejection.
  if (phaseHint === "stream") {
    return providerFailureClassification("provider_stream_failed", "stream", status, null);
  }

  // Anthropic SDK subclasses are the strongest signal, followed by the
  // provider's typed body, then the numeric HTTP status.
  if (
    metadata.sdkFailureKind === "authentication"
    || metadata.sdkFailureKind === "permission"
    || metadata.providerErrorType === "authentication_error"
    || metadata.providerErrorType === "permission_error"
  ) {
    return providerFailureClassification("provider_auth", "provider_response", status, null);
  }
  if (
    metadata.sdkFailureKind === "rate_limited"
    || metadata.providerErrorType === "rate_limit_error"
  ) {
    return providerFailureClassification(
      "provider_rate_limited",
      "provider_response",
      status,
      parseProviderRetryAfterFrameMs(metadata.retryAfterHeader, input?.now),
    );
  }
  if (
    metadata.sdkFailureKind === "unavailable"
    || metadata.providerErrorType === "overloaded_error"
  ) {
    return providerFailureClassification("provider_unavailable", "provider_response", status, null);
  }

  // The observed Anthropic production billing response has no distinct
  // billing type: it is a BadRequestError / HTTP 400 invalid_request_error.
  // Keep the sole message fallback exact and gated by provider+status+type.
  if (
    provider === "anthropic"
    && status === 400
    && metadata.providerErrorType === "invalid_request_error"
    && metadata.providerErrorMessage === ANTHROPIC_LOW_CREDIT_MESSAGE
  ) {
    return providerFailureClassification("provider_billing", "provider_response", status, null);
  }

  if (status === 401 || status === 403) {
    return providerFailureClassification("provider_auth", "provider_response", status, null);
  }
  if (status === 429) {
    return providerFailureClassification(
      "provider_rate_limited",
      "provider_response",
      status,
      parseProviderRetryAfterFrameMs(metadata.retryAfterHeader, input?.now),
    );
  }
  if (status === 529 || (status !== null && status >= 500 && status <= 599)) {
    return providerFailureClassification("provider_unavailable", "provider_response", status, null);
  }
  if (isConnectFailure(error) || phaseHint === "connect") {
    return providerFailureClassification("provider_proxy_unreachable", "connect", status, null);
  }

  return providerFailureClassification(
    "provider_stream_failed",
    phaseHint ?? (status === null ? "stream" : "provider_response"),
    status,
    null,
  );
}

/** Backward-compatible code-only classifier used by existing callers/tests. */
export function classifyProviderStreamFailure(
  error: unknown,
  input?: {
    provider?: AiProviderId;
    failurePhase?: AiProviderFailurePhase;
    now?: number;
  },
): AiProviderFailureCode {
  return normalizeProviderStreamFailure(error, input).code;
}

function providerFailureClassification(
  code: AiProviderFailureCode,
  failurePhase: AiProviderFailurePhase,
  providerHttpStatus: number | null,
  retryAfterMs: number | null,
): AiProviderFailureClassification {
  return {
    code,
    failurePhase,
    providerHttpStatus,
    retryAfterMs,
  };
}

function findAiProviderFailure(error: unknown) {
  for (const cause of iterateErrorChain(error)) {
    if (cause instanceof AiProviderFailureError) {
      return cause;
    }
  }
  return null;
}

function providerHttpMetadata(
  error: unknown,
  normalized: AiProviderFailureError | null,
): ProviderHttpMetadata {
  let providerHttpStatus = normalized?.providerHttpStatus ?? null;
  let providerErrorType = normalized?.providerErrorType ?? null;
  let providerErrorMessage = normalized?.providerErrorMessage ?? null;
  let retryAfterHeader = normalized?.retryAfterHeader ?? null;
  let sdkFailureKind = normalized?.sdkFailureKind ?? null;

  for (const cause of iterateErrorChain(error)) {
    if (!cause || typeof cause !== "object") {
      continue;
    }
    const fields = cause as Record<string, unknown>;
    if (providerHttpStatus === null && isHttpStatus(fields.status)) {
      providerHttpStatus = fields.status;
    }
    if (providerErrorType === null) {
      providerErrorType = providerTypeFromFields(fields);
    }
    if (providerErrorMessage === null) {
      providerErrorMessage = providerMessageFromFields(fields);
    }
    if (retryAfterHeader === null) {
      retryAfterHeader = headerValue(fields.headers, "retry-after");
    }
    if (sdkFailureKind === null && cause instanceof Error) {
      sdkFailureKind = sdkFailureKindFromName(cause.constructor.name)
        ?? sdkFailureKindFromName(cause.name);
    }
  }

  return {
    providerHttpStatus,
    providerErrorType,
    providerErrorMessage,
    retryAfterHeader,
    sdkFailureKind,
  };
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 100
    && value <= 599;
}

function providerTypeFromFields(fields: Record<string, unknown>): string | null {
  if (typeof fields.type === "string" && fields.type !== "error") {
    return fields.type;
  }
  const payload = providerErrorPayload(fields.error);
  return typeof payload?.type === "string" ? payload.type : null;
}

function providerMessageFromFields(fields: Record<string, unknown>): string | null {
  const payload = providerErrorPayload(fields.error);
  return typeof payload?.message === "string" ? payload.message : null;
}

function providerErrorPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    return record.error as Record<string, unknown>;
  }
  return record;
}

function headerValue(value: unknown, name: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("get" in value && typeof value.get === "function") {
    const header = value.get(name);
    return typeof header === "string" ? header : null;
  }
  for (const [key, header] of Object.entries(value)) {
    if (key.toLowerCase() === name && typeof header === "string") {
      return header;
    }
  }
  return null;
}

function sdkFailureKindFromName(name: string): AiProviderSdkFailureKind | null {
  switch (name) {
    case "AuthenticationError":
      return "authentication";
    case "PermissionDeniedError":
      return "permission";
    case "RateLimitError":
      return "rate_limited";
    case "InternalServerError":
      return "unavailable";
    case "BadRequestError":
      return "bad_request";
    case "APIConnectionTimeoutError":
      return "connection_timeout";
    case "APIConnectionError":
      return "connection";
    case "APIError":
      return "api";
    default:
      return null;
  }
}

function parseProviderRetryAfterFrameMs(retryAfterHeader: string | null, now = Date.now()) {
  if (!retryAfterHeader) {
    return null;
  }
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), Number.MAX_SAFE_INTEGER);
  }
  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) {
    return null;
  }
  return Math.min(Math.max(0, retryAt - now), Number.MAX_SAFE_INTEGER);
}

/** Wraps a fetch so that once a connect-level failure is observed, every
 * subsequent call fails instantly with the same error. Scoped to one client
 * resolution (= one generation): the Anthropic SDK's retry policy re-dials
 * connection errors, and against a dead proxy each re-dial burns a full
 * connect timeout for an outcome that cannot change within the request. */
export function createStickyConnectFailureFetch(fetchImpl: typeof fetch): typeof fetch {
  let connectFailure: unknown = null;
  return async (input, init) => {
    if (connectFailure !== null) {
      throw connectFailure;
    }
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (isConnectFailure(error)) {
        connectFailure = error;
      }
      throw error;
    }
  };
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
