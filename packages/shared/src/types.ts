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

export const transactionStates = ["pending", "posted", "unknown"] as const;

export type TransactionState = (typeof transactionStates)[number];

export interface FanslySessionBundle {
  authorization: string;
  fanslyClientId?: string;
  fanslyClientCheck?: string;
  fanslySessionId?: string;
}

export interface ProxyConfig {
  url: string;
  username?: string | null;
  password?: string | null;
}
