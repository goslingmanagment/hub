import { inspect } from "node:util";

import { redactSensitiveText } from "./proxy.ts";

export interface SanitizedErrorContext {
  name: string;
  code: string | null;
}

export interface SanitizeErrorOptions {
  /** The message alone preserves compact persistence/log projections. */
  format?: "message" | "chain";
  /** Omit for an unbounded result. */
  maxChars?: number;
  /** Existing callers use either an ellipsis clamp or a literal slice. */
  truncation?: "ellipsis" | "clip";
  /** Applied before the clamp. */
  trim?: boolean;
  /**
   * Query-style errors can embed SQL params (including large payloads) in the
   * message. Supplying this callback replaces that body with caller-owned
   * context while retaining the shared type/code extraction.
   */
  queryStyleMessage?: (context: SanitizedErrorContext) => string;
  /** Used only when the selected, sanitized message is empty. */
  fallbackMessage?: string | ((context: SanitizedErrorContext) => string);
}

export interface SanitizedError {
  name: string;
  code: string | null;
  message: string;
  queryStyle: boolean;
  truncated: boolean;
  originalMessageLength: number;
}

export function* iterateErrorChain(error: unknown) {
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

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractErrorName(error: unknown) {
  return error instanceof Error ? (normalizeString(error.name) ?? "Error") : "Error";
}

function extractErrorCode(error: unknown) {
  for (const cause of iterateErrorChain(error)) {
    if (!cause || typeof cause !== "object") {
      continue;
    }
    const code = normalizeString((cause as { code?: unknown }).code);
    if (code) {
      return code;
    }
  }
  return null;
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isQueryStyleError(name: string, message: string) {
  return name === "DrizzleQueryError"
    || message.includes("Failed query:")
    || message.includes("params:");
}

function pushErrorField(output: string[], label: string, value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(`${label}=${value}`);
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

function formatErrorCause(error: unknown) {
  if (error instanceof Error) {
    const metadata = extractErrorMetadata(error);
    const summary = `${error.name}: ${error.message || "(no message)"}`;
    return redactSensitiveText(
      metadata.length > 0 ? `${summary} (${metadata.join(", ")})` : summary,
    );
  }
  if (typeof error === "string") {
    return redactSensitiveText(error);
  }
  return redactSensitiveText(inspect(error, { depth: 2, breakLength: Infinity }));
}

function formatErrorChain(error: unknown) {
  return Array.from(iterateErrorChain(error))
    .map((cause, index) =>
      `${index === 0 ? "" : `cause(${index}): `}${formatErrorCause(cause)}`)
    .join(" | ");
}

function resolveConfiguredMessage(
  value: string | ((context: SanitizedErrorContext) => string),
  context: SanitizedErrorContext,
) {
  return typeof value === "function" ? value(context) : value;
}

function clampMessage(
  message: string,
  maxChars: number | undefined,
  truncation: "ellipsis" | "clip",
) {
  if (maxChars === undefined || message.length <= maxChars) {
    return { message, truncated: false };
  }

  if (truncation === "ellipsis" && maxChars >= 3) {
    return {
      message: `${message.slice(0, maxChars - 3)}...`,
      truncated: true,
    };
  }
  return {
    message: message.slice(0, Math.max(0, maxChars)),
    truncated: true,
  };
}

/**
 * The single shared projection for caught errors and error-like text. It
 * redacts first, optionally removes query bodies, then applies the caller's
 * historical clamp semantics.
 */
export function sanitizeError(
  error: unknown,
  options: SanitizeErrorOptions = {},
): SanitizedError {
  const name = extractErrorName(error);
  const code = extractErrorCode(error);
  const context = { name, code };
  const sourceMessage = redactSensitiveText(extractErrorMessage(error));
  const queryStyle = isQueryStyleError(name, sourceMessage);
  let message = options.format === "chain"
    ? formatErrorChain(error)
    : sourceMessage;
  let replaced = false;

  if (queryStyle && options.queryStyleMessage) {
    message = redactSensitiveText(resolveConfiguredMessage(options.queryStyleMessage, context));
    replaced = true;
  }
  if (options.trim) {
    message = message.trim();
  }
  if (message.length === 0 && options.fallbackMessage !== undefined) {
    message = redactSensitiveText(resolveConfiguredMessage(options.fallbackMessage, context));
    replaced = true;
  }

  const clamped = clampMessage(
    message,
    options.maxChars,
    options.truncation ?? "ellipsis",
  );
  return {
    name,
    code,
    message: clamped.message,
    queryStyle,
    truncated: replaced || clamped.truncated,
    originalMessageLength: sourceMessage.length,
  };
}
