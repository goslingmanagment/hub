const MAX_SYNC_ERROR_SUMMARY_CHARS = 1024;

export interface PersistedSyncError {
  type: string;
  summary: string;
  endpoint: string;
  code: string | null;
  truncated: boolean;
  originalMessageLength: number;
}

export interface NormalizedSyncError {
  summary: string;
  error: PersistedSyncError;
}

type NormalizeSyncErrorInput = {
  endpoint: string;
  action: string;
};

export class SyncPayloadPersistenceError extends Error {
  override readonly cause: unknown;
  readonly endpoint: string;
  readonly action: string;

  constructor(input: {
    endpoint: string;
    action: string;
    cause: unknown;
  }) {
    super(`Failed to persist raw payload while ${input.action}`, { cause: input.cause });
    this.name = "SyncPayloadPersistenceError";
    this.endpoint = input.endpoint;
    this.action = input.action;
    this.cause = input.cause;
  }
}

function clampSummary(summary: string) {
  if (summary.length <= MAX_SYNC_ERROR_SUMMARY_CHARS) {
    return {
      summary,
      truncated: false,
    };
  }

  return {
    summary: `${summary.slice(0, MAX_SYNC_ERROR_SUMMARY_CHARS - 3)}...`,
    truncated: true,
  };
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractErrorType(error: unknown) {
  if (error instanceof Error && normalizeString(error.name)) {
    return normalizeString(error.name)!;
  }

  return "Error";
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function extractErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const directCode = normalizeString((error as { code?: unknown }).code);
  if (directCode) {
    return directCode;
  }

  if ("cause" in error) {
    return extractErrorCode((error as { cause?: unknown }).cause);
  }

  return null;
}

function isQueryStyleError(type: string, message: string) {
  return type === "DrizzleQueryError" ||
    message.includes("Failed query:") ||
    message.includes("params:");
}

export function normalizeErrorSummary(summary: string | null | undefined) {
  if (!summary) {
    return null;
  }

  return clampSummary(summary).summary;
}

export function normalizeSyncError(
  error: unknown,
  input: NormalizeSyncErrorInput,
): NormalizedSyncError {
  const endpoint = error instanceof SyncPayloadPersistenceError ? error.endpoint : input.endpoint;
  const action = error instanceof SyncPayloadPersistenceError ? error.action : input.action;
  const source = error instanceof SyncPayloadPersistenceError ? error.cause : error;
  const type = extractErrorType(source);
  const rawMessage = extractErrorMessage(source);
  const code = extractErrorCode(source);
  const queryStyle = isQueryStyleError(type, rawMessage);
  const baseSummary = queryStyle
    ? `${type} while ${action}${code ? ` (${code})` : ""}`
    : (rawMessage || `${type} while ${action}`);
  const clamped = clampSummary(baseSummary);

  return {
    summary: clamped.summary,
    error: {
      type,
      summary: clamped.summary,
      endpoint,
      code,
      truncated: clamped.truncated || queryStyle || baseSummary !== rawMessage,
      originalMessageLength: rawMessage.length,
    },
  };
}
