import type { FanslySessionBundle, HttpRequestObserver, ProxyConfig } from "@agency_hub_core/shared";

export interface FanslyRequestContext {
  session: FanslySessionBundle;
  proxy?: ProxyConfig | null;
  requestObserver?: HttpRequestObserver | null;
}

export interface FanslyAccount {
  id: string;
  username: string | null;
  displayName: string | null;
  createdAt?: number;
}

export interface FanslyAccountMeResponse {
  account: {
    id: string;
    username: string;
    displayName: string | null;
    createdAt: number;
    followCount: number;
    subscriberCount: number;
    earningsWallet?: {
      id: string;
      balance: number;
    } | null;
    walls?: Array<Record<string, unknown>>;
    subscriptionTiers?: Array<Record<string, unknown>>;
  };
}

export interface FanslyEarningsTransaction {
  walletId: string;
  transactionId: string;
  accountId: string;
  correlationId: string | null;
  correlationAccountId: string | null;
  type: number;
  destination: number | null;
  amount: number;
  destinationTax: number | null;
  destinationAmount: number;
  newBalance: number | null;
  newBalance64: number | null;
  createdAt: number;
  updatedAt: number | null;
  status: number;
  senderId: string | null;
  receiverId: string | null;
}

export interface FanslyTransactionsPage {
  total: number;
  data: FanslyEarningsTransaction[];
}

export interface FanslySubscriber {
  id: string;
  historyId: string | null;
  subscriberId: string;
  subscriptionTierId: string | null;
  subscriptionTierName: string | null;
  subscriptionTierColor: string | null;
  planId: string | null;
  status: number;
  price: number;
  renewPrice: number;
  autoRenew: number | null;
  billingCycle: number | null;
  duration: number | null;
  renewDate: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  endsAt: number | null;
}

export interface FanslySubscribersPage {
  stats: {
    totalActive: number;
    totalExpired: number;
    total: number;
  };
  subscriptions: FanslySubscriber[];
}

export interface FanslyFollower {
  id: string;
  followerId: string;
}

export interface FanslyFollowersPage {
  followers: FanslyFollower[];
  aggregationData?: {
    accounts?: FanslyAccount[];
  };
}

export interface FanslyPaginatedResponse<T> {
  total?: number;
  items: T[];
  done: boolean;
  offset: number;
}
