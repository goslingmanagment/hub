export const platforms = ["fansly", "onlyfans"] as const;
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

export const userRoles = ["owner", "team_lead", "chatter", "content_manager"] as const;
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
  // Stage 29: internal gateway lane for the workboard closing classifier.
  "workboard-closing",
  // Voice notes: the ElevenLabs TTS lane's script-generation feature.
  "voice-script",
] as const;
export type AiUsageFeature = (typeof aiUsageFeatures)[number];

export interface FanslySessionBundle {
  authorization: string;
  fanslyClientId?: string;
  fanslyClientCheck?: string;
  fanslySessionId?: string;
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

export const httpRequestFailureKinds = ["timeout", "transport", "http", "provider"] as const;
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
