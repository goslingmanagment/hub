import pino from "pino";

import { redactSensitiveText } from "./proxy.ts";

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

export function createLogger(level: string) {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: (error) => redactLogValue(pino.stdSerializers.err(error)),
    },
  });
}
