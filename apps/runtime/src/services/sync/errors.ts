import { sanitizeError } from "@agency_hub_core/shared";

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

export class FollowersReconcileConsistencyError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "FollowersReconcileConsistencyError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
  }
}

export class FanslyPurchaseHistoryContractError extends Error {
  readonly code: string;

  constructor(input: { code: string; message: string }) {
    super(input.message);
    this.name = "FanslyPurchaseHistoryContractError";
    this.code = input.code;
  }
}

export function boundSyncErrorSummary(summary: string | null | undefined) {
  if (!summary) {
    return null;
  }

  return sanitizeError(summary, {
    maxChars: MAX_SYNC_ERROR_SUMMARY_CHARS,
    truncation: "ellipsis",
  }).message;
}

export function buildNormalizedSyncError(
  error: unknown,
  input: NormalizeSyncErrorInput,
): NormalizedSyncError {
  const endpoint = error instanceof SyncPayloadPersistenceError ? error.endpoint : input.endpoint;
  const action = error instanceof SyncPayloadPersistenceError ? error.action : input.action;
  const source = error instanceof SyncPayloadPersistenceError ? error.cause : error;
  const sanitized = sanitizeError(source, {
    maxChars: MAX_SYNC_ERROR_SUMMARY_CHARS,
    truncation: "ellipsis",
    queryStyleMessage: ({ name, code }) =>
      `${name} while ${action}${code ? ` (${code})` : ""}`,
    fallbackMessage: ({ name }) => `${name} while ${action}`,
  });

  return {
    summary: sanitized.message,
    error: {
      type: sanitized.name,
      summary: sanitized.message,
      endpoint,
      code: sanitized.code,
      truncated: sanitized.truncated,
      originalMessageLength: sanitized.originalMessageLength,
    },
  };
}
