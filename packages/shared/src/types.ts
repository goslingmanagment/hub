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
  affectsFanLtv: boolean;
}

export const transactionClassificationByType = {
  subscription: {
    bucket: "revenue",
    affectsFanLtv: true,
  },
  tip: {
    bucket: "revenue",
    affectsFanLtv: true,
  },
  message_purchase: {
    bucket: "revenue",
    affectsFanLtv: true,
  },
  post_purchase: {
    bucket: "revenue",
    affectsFanLtv: true,
  },
  stream_tip: {
    bucket: "revenue",
    affectsFanLtv: true,
  },
  chargeback: {
    bucket: "adjustment",
    affectsFanLtv: true,
  },
  refund: {
    bucket: "adjustment",
    affectsFanLtv: true,
  },
  other: {
    bucket: "unclassified",
    affectsFanLtv: true,
  },
  payout_reversal: {
    bucket: "excluded",
    affectsFanLtv: false,
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

export const fanLtvTransactionTypes = filterTransactionTypes(
  (transactionType) => getTransactionClassification(transactionType).affectsFanLtv,
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

export const fanFlagTypes = ["whale", "vip", "risky"] as const;
export type FanFlagType = (typeof fanFlagTypes)[number];

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
