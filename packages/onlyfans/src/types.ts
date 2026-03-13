import type { HttpRequestObserver, OnlyMonsterTokenBundle, ProxyConfig } from "@agency_hub_core/shared";

export interface OnlyFansRequestContext {
  auth: OnlyMonsterTokenBundle;
  proxy?: ProxyConfig | null;
  requestObserver?: HttpRequestObserver | null;
}

export interface OnlyMonsterAccount {
  id: number;
  platform_account_id: string;
  platform: "onlyfans";
  name: string;
  email: string | null;
  avatar: string;
  username: string;
  organisation_id: string;
  subscribe_price: number | null;
  subscription_expiration_date: string | null;
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
  chargeback_timestamp: string;
  transaction_timestamp: string;
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
