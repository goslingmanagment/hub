import type { HttpRequestObserver, OnlyMonsterTokenBundle, ProxyConfig } from "@agency_hub_core/shared";

export interface OnlyFansRequestContext {
  auth: OnlyMonsterTokenBundle;
  proxy?: ProxyConfig | null;
  requestObserver?: HttpRequestObserver | null;
  rateLimitWaiter?: ((scopes: Array<{
    provider: "fansly" | "onlyfans";
    scope: string;
  }>) => Promise<number>) | null;
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

export interface OnlyMonsterLinkUser {
  link_id: string;
  fan: {
    id: string;
    name: string;
    username: string;
  };
  subscribed_at: string;
  collected_at: string;
}

export interface OnlyMonsterChatFansResponse {
  fan_ids: string[];
}

export interface OnlyMonsterChatMessageMedia {
  id: number;
  type: string;
  can_view: boolean;
  is_ready: boolean;
  has_error: boolean | null;
  converted_to_video: boolean;
  created_at: string | null;
  thumbnail_url: string;
}

export interface OnlyMonsterChatMessage {
  id: number;
  text: string;
  from_user: number;
  is_sent_by_me: boolean;
  created_at: string;
  media: OnlyMonsterChatMessageMedia[];
  media_count: number;
  is_opened: boolean;
  is_new: boolean;
  price: number;
  is_free: boolean;
  can_purchase: boolean;
  can_purchase_reason: string;
}

export interface OnlyMonsterChatMessagesResponse {
  items: OnlyMonsterChatMessage[];
  has_more?: boolean;
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
