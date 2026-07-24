import pino, { type DestinationStream } from "pino";

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

function loggerOptions(level: string) {
  return {
    level,
    // Preserve the existing runtime shape (no pid/hostname base bindings).
    // Pino's type omits explicit undefined under exactOptionalPropertyTypes,
    // while its runtime treats this value differently from an omitted option.
    base: undefined as never,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...RUNTIME_LOG_REDACT_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      err: (error: unknown) => redactLogValue(pino.stdSerializers.err(error)),
    },
  };
}

export function createLogger(level: string, destination?: DestinationStream) {
  const options = loggerOptions(level);
  return destination ? pino(options, destination) : pino(options);
}
