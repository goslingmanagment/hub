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
