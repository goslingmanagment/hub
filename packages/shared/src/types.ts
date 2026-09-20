export const platforms = ["fansly", "onlyfans"] as const;

/**
 * The values `exportPolicy` may take on the wire (spec 11 staging).
 *
 * Declared ONCE here because three sites need it and they must not drift: the
 * contract enum (`routes.ts`), the config descriptor's `enumValues`, and the env
 * parser. The staging is: widen the wire type first (a code deploy the fleet
 * re-vendors), flip the served VALUE second (a config flip). A single list is
 * what makes "widened but not yet flipped" a checkable state rather than a hope.
 */
export const agentExportPolicyValues = [
  "no_raw_transcript_export_endpoint_yet",
  "agent_read_plane_v1",
] as const;
export type AgentExportPolicyValue = (typeof agentExportPolicyValues)[number];
export type Platform = (typeof platforms)[number];

export const transactionTypes = [
  "subscription",
  "tip",
  "message_purchase",
  "post_purchase",
  "stream_tip",
  "chargeback",
  "refund",
  "payout_reversal",
  "other",
] as const;

export type TransactionType = (typeof transactionTypes)[number];

export const transactionReportingBuckets = [
  "revenue",
  "adjustment",
  "unclassified",
  "excluded",
] as const;

export type TransactionReportingBucket = (typeof transactionReportingBuckets)[number];

export interface TransactionClassificationMetadata {
  bucket: TransactionReportingBucket;
  affectsSpenderAnalytics: boolean;
}

export const transactionClassificationByType = {
  subscription: {
    bucket: "revenue",
    affectsSpenderAnalytics: true,
  },
  tip: {
    bucket: "revenue",
    affectsSpenderAnalytics: true,
  },
  message_purchase: {
    bucket: "revenue",
    affectsSpenderAnalytics: true,
  },
  post_purchase: {
    bucket: "revenue",
    affectsSpenderAnalytics: true,
  },
  stream_tip: {
    bucket: "revenue",
    affectsSpenderAnalytics: true,
  },
  chargeback: {
    bucket: "adjustment",
    affectsSpenderAnalytics: true,
  },
  refund: {
    bucket: "adjustment",
    affectsSpenderAnalytics: true,
  },
  other: {
    bucket: "unclassified",
    affectsSpenderAnalytics: true,
  },
  payout_reversal: {
    bucket: "excluded",
    affectsSpenderAnalytics: false,
  },
} as const satisfies Record<TransactionType, TransactionClassificationMetadata>;

function filterTransactionTypes(
  predicate: (transactionType: TransactionType) => boolean,
): TransactionType[] {
  return transactionTypes.filter(predicate);
}

export function getTransactionClassification(
  transactionType: TransactionType,
): TransactionClassificationMetadata {
  return transactionClassificationByType[transactionType];
}

export const reportableTransactionTypes = filterTransactionTypes(
  (transactionType) => getTransactionClassification(transactionType).bucket !== "excluded",
);

export const spenderAnalyticsTransactionTypes = filterTransactionTypes(
  (transactionType) => getTransactionClassification(transactionType).affectsSpenderAnalytics,
);

export const transactionTypesByReportingBucket = Object.fromEntries(
  transactionReportingBuckets.map((bucket) => [
    bucket,
    filterTransactionTypes(
      (transactionType) => getTransactionClassification(transactionType).bucket === bucket,
    ),
  ]),
) as Record<TransactionReportingBucket, TransactionType[]>;

export const transactionStates = ["pending", "posted", "unknown"] as const;

export type TransactionState = (typeof transactionStates)[number];

export const ofapiCaptureJobStates = [
  "ready",
  "leased",
  "awaiting_parse",
  "retry_wait",
  "blocked",
  "complete",
  "cancelled",
] as const;
export type OfapiCaptureJobState = (typeof ofapiCaptureJobStates)[number];

// Decision 370: `content_manager` left the wire enum with the API-key lane —
// the role had no credential path (no session, no bearer) and zero rows in
// production. The PG enum value stays (migrations are forward-only), so a
// historical row is still readable by raw SQL; it simply cannot be created,
// authenticated or serialized any more.
export const userRoles = ["owner", "team_lead", "chatter"] as const;
export type UserRole = (typeof userRoles)[number];
export const creatableUserRoles = ["owner", "team_lead", "chatter"] as const;
export type CreatableUserRole = (typeof creatableUserRoles)[number];

export const fanFlagTypes = ["whale", "vip", "risky"] as const;
export type FanFlagType = (typeof fanFlagTypes)[number];

export const aiUsageFeatures = [
  "fast-reply",
  "improve-draft",
  "help-me",
  "fan-summary",
  "chat-review",
  "scan",
  "ping",
  "hi-greeting",
  "coach-chat",
  // Voice notes: the ElevenLabs TTS lane's script-generation feature.
  "voice-script",
] as const;
export type AiUsageFeature = (typeof aiUsageFeatures)[number];

export const FANSLY_CLIENT_CHECK_ROUTES = [
  "message",
  "group",
  "account",
  "earnings",
  "messagingGroups",
  "subscribers",
  "media",
] as const;
export type FanslyClientCheckRoute = (typeof FANSLY_CLIENT_CHECK_ROUTES)[number];

export interface FanslySessionBundle {
  authorization: string;
  fanslyClientId?: string;
  /** Legacy pasted value. Retained for credential compatibility, never reused
   * across routes by the adapter. */
  fanslyClientCheck?: string;
  fanslySessionId?: string;
  routeChecks?: Partial<Record<FanslyClientCheckRoute, string>>;
}

export interface OnlyMonsterTokenBundle {
  token: string;
}

export type StoredPlatformCredentialBundle =
  | {
    platform: "fansly";
    session: FanslySessionBundle;
  }
  | {
    platform: "onlyfans";
    auth: OnlyMonsterTokenBundle;
  };

export interface ProxyConfig {
  url: string;
  username?: string | null;
  password?: string | null;
}

export const syncHealthStates = ["healthy", "degraded", "suspicious", "failed"] as const;
export type SyncHealth = (typeof syncHealthStates)[number];

export const httpRequestStates = ["started", "success", "retry", "failed"] as const;
export type HttpRequestState = (typeof httpRequestStates)[number];

export const httpRequestFailureKinds = ["timeout", "transport", "http", "provider", "policy"] as const;
export type HttpRequestFailureKind = (typeof httpRequestFailureKinds)[number];

export const syncTelemetryEventSeverities = ["info", "warn", "error"] as const;
export type SyncTelemetryEventSeverity = (typeof syncTelemetryEventSeverities)[number];

export interface HttpRequestPagination {
  offset?: number | null;
  limit?: number | null;
  pageIndex?: number | null;
  cursorPresent?: boolean | null;
}

export interface HttpRequestEventBase {
  requestId: string;
  operation: string;
  endpointTemplate: string;
  method: string;
  attemptNumber: number;
  timestamp: Date;
  pagination?: HttpRequestPagination | null;
  requestMetadata?: Record<string, unknown>;
  rateLimitWaitMs?: number | null;
}

export interface HttpRequestStartedEvent extends HttpRequestEventBase {
  state: "started";
}

export interface HttpRequestSuccessEvent extends HttpRequestEventBase {
  state: "success";
  httpStatus: number;
  durationMs: number;
  responseMetadata?: Record<string, unknown>;
}

export interface HttpRequestRetryEvent extends HttpRequestEventBase {
  state: "retry";
  httpStatus?: number | null;
  failureKind?: HttpRequestFailureKind | null;
  retryDelayMs: number;
  durationMs: number;
  responseMetadata?: Record<string, unknown>;
  errorMessage?: string | null;
}

export interface HttpRequestFailedEvent extends HttpRequestEventBase {
  state: "failed";
  httpStatus?: number | null;
  failureKind?: HttpRequestFailureKind | null;
  durationMs: number;
  responseMetadata?: Record<string, unknown>;
  errorMessage?: string | null;
}

export type HttpRequestEvent =
  | HttpRequestStartedEvent
  | HttpRequestSuccessEvent
  | HttpRequestRetryEvent
  | HttpRequestFailedEvent;

export interface HttpRequestObserver {
  onRequestEvent(event: HttpRequestEvent): Promise<void>;
}
