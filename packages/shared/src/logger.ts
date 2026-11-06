import pino, { type DestinationStream } from "pino";

import { iterateErrorChain } from "./error-sanitizer.ts";
import { redactSensitiveText } from "./proxy.ts";

const RUNTIME_LOG_REDACT_PATHS = [
  "headers.authorization",
  "headers.Authorization",
  "req.headers.authorization",
  "req.headers.Authorization",
  "request.headers.authorization",
  "request.headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "proxyUrl",
  "*.proxyUrl",
  "proxy.url",
  "*.proxy.url",
  "serviceEgressProxyUrl",
  "*.serviceEgressProxyUrl",
  "config.serviceEgressProxyUrl",
  "botToken",
  "*.botToken",
  "telegramBotToken",
  "*.telegramBotToken",
  "body.botToken",
  "req.body.botToken",
  "request.body.botToken",
] as const;

function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactLogValue(entry, seen)]),
  );
}

// Drizzle's query error writes the statement WITH its bound params into its
// message and stack ("Failed query: …\nparams: …") and keeps them in `params`.
// Those params can be chat text, key digests or a whole audio buffer, and the
// server log never takes raw SQL params (docs/error-handling.md).
const QUERY_PARAMS_CUT = "Failed query (params not logged)";

function isDrizzleQueryError(value: unknown): value is Error {
  return value instanceof Error
    && (value.constructor.name === "DrizzleQueryError" || value.message.startsWith("Failed query:"));
}

/**
 * Many call sites log `{ error }`. With no serializer for that key an Error was
 * written as `{}` (its message and stack are not enumerable), so the cause was
 * lost. It now serializes like `err`, minus Drizzle's bound params; any other
 * value is written as before, with strings redacted.
 */
function serializeErrorKey(value: unknown): unknown {
  if (!(value instanceof Error)) {
    return redactLogValue(value);
  }
  const queryMessages = Array.from(iterateErrorChain(value))
    .filter(isDrizzleQueryError)
    .map((link) => link.message)
    .filter((message) => message.length > 0);
  const serialized: Record<string, unknown> = { ...pino.stdSerializers.err(value) };
  if (queryMessages.length > 0) {
    // The statement itself stays in `query`; only the rendered params go.
    const cut = (text: unknown) => typeof text === "string"
      ? queryMessages.reduce((result, message) => result.split(message).join(QUERY_PARAMS_CUT), text)
      : text;
    serialized.message = cut(serialized.message);
    serialized.stack = cut(serialized.stack);
    if (isDrizzleQueryError(value)) {
      delete serialized.params;
    }
  }
  return redactLogValue(serialized);
}

function loggerOptions(level: string) {
  return {
    level,
    // Preserve the existing runtime shape (no pid/hostname base bindings).
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...RUNTIME_LOG_REDACT_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      err: (error: Parameters<typeof pino.stdSerializers.err>[0]) => redactLogValue(pino.stdSerializers.err(error)),
      error: serializeErrorKey,
    },
  };
}

export function createLogger(level: string, destination?: DestinationStream) {
  const options = loggerOptions(level);
  return destination ? pino(options, destination) : pino(options);
}
