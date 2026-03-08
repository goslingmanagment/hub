import type { OnlyMonsterTokenBundle, ProxyConfig } from "@fansly-connect/shared";

export interface OnlyFansRequestContext {
  auth: OnlyMonsterTokenBundle;
  proxy?: ProxyConfig | null;
}

export interface OnlyMonsterAccount {
  id: number;
  platformAccountId: string;
  platform: "onlyfans";
  name: string;
  email: string | null;
  avatar: string;
  username: string;
  organisationId: string;
  subscribePrice: number | null;
  subscriptionExpirationDate: string | null;
}

export interface OnlyMonsterTransaction {
  id: string;
  amount: number;
  fan: {
    id: string;
  };
  type: string;
  status: string;
  timestamp: string;
}

export interface OnlyMonsterChargeback {
  id: string;
  amount: number;
  fan: {
    id: string;
  };
  type: string;
  status: string;
  chargebackTimestamp: string;
  transactionTimestamp: string;
}

export interface OnlyMonsterAccountsResponse {
  accounts: OnlyMonsterAccount[];
  nextCursor?: string;
}

export interface OnlyMonsterAccountResponse {
  account: OnlyMonsterAccount;
}

export interface OnlyMonsterCursorResponse<TItem> {
  items: TItem[];
  cursor?: string;
}
