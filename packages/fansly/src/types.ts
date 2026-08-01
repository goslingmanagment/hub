import type { FanslySessionBundle, HttpRequestObserver, ProxyConfig } from "@agency_hub_core/shared";

export interface FanslyRequestContext {
  session: FanslySessionBundle;
  proxy?: ProxyConfig | null;
  egressKey?: string | null;
  requestObserver?: HttpRequestObserver | null;
  rateLimitWaiter?: ((scopes: Array<{
    provider: "fansly" | "onlyfans";
    scope: string;
  }>) => Promise<number>) | null;
}

export interface FanslyAccount {
  id: string;
  username: string | null;
  displayName: string | null;
  createdAt?: number;
  statusId?: number;
  lastSeenAt?: number;
  streaming?: {
    channel?: {
      chatRoomId?: string | null;
    } | null;
  } | null;
  notes?: FanslyAccountNote[];
}

export interface FanslyAccountNote {
  id: string;
  contentType?: number;
  contentId?: string | null;
  title?: string | null;
  note?: string | null;
  createdAt?: number;
  updatedAt?: number;
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

export interface FanslyEarningsAccount {
  totalGross: number;
  totalNet: number;
  accountId: string;
  correlationAccountId: string | null;
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
  lastSeenAt?: number;
}

export interface FanslyFollowersPage {
  followers: FanslyFollower[];
  aggregationData?: {
    accounts?: FanslyAccount[];
  };
}

export interface FanslyMessage {
  id: string;
  type: number;
  dataVersion: number;
  content: string;
  groupId: string;
  senderId: string | null;
  correlationId: string | null;
  inReplyTo: string | null;
  inReplyToRoot: string | null;
  createdAt: number;
  attachments: Array<Record<string, unknown>>;
  embeds: Array<Record<string, unknown>>;
  interactions: Array<Record<string, unknown>>;
  likes: Array<Record<string, unknown>>;
  totalTipAmount?: number | null;
}

export interface FanslyMessagingGroupUser {
  groupId: string;
  userId: string;
  type: number;
  permissionFlags: number;
}

export interface FanslyMessagingAggregatedGroup {
  id: string;
  type?: number;
  groupFlags?: number;
  createdBy?: string | null;
  users?: FanslyMessagingGroupUser[];
  lastMessage?: FanslyMessage | null;
}

export interface FanslyMessagingGroup {
  account_id?: string;
  groupId: string;
  partnerAccountId?: string | null;
  partnerUsername?: string | null;
  flags: number;
  unreadCount: number;
  subscriptionTierId?: string | null;
  lastMessageId?: string | null;
  lastUnreadMessageId?: string | null;
}

export interface FanslyMessagingGroupsPage {
  data: FanslyMessagingGroup[];
  aggregationData?: {
    total?: number;
    accounts?: FanslyAccount[];
    groups?: FanslyMessagingAggregatedGroup[];
  };
}

export interface FanslyGroupDetail {
  id: string;
  type: number;
  groupFlags: number;
  groupFlagsMetadata?: string;
  createdBy?: string | null;
  users: FanslyMessagingGroupUser[];
  permissionFlags?: Array<Record<string, unknown>>;
  recipients?: Array<Record<string, unknown>>;
  userSettings?: Record<string, unknown> | null;
  lastMessage?: FanslyMessage | null;
  hasDmPermissionFlags?: boolean;
  partnerMissingDmPermissionFlagsChecked?: boolean;
  dmPermissionFlags?: Array<Record<string, unknown>>;
  accountDmPermissionFlags?: Record<string, unknown> | null;
}

export interface FanslyMessagesPage {
  messages: FanslyMessage[];
  accountMedia?: Array<Record<string, unknown>>;
  accountMediaBundles?: Array<Record<string, unknown>>;
  tips?: Array<Record<string, unknown>>;
  tipGoals?: Array<Record<string, unknown>>;
  accountMediaOrders?: Array<Record<string, unknown>>;
  stories?: Array<Record<string, unknown>>;
  storyOrders?: Array<Record<string, unknown>>;
}

export interface FanslyPaginatedResponse<T> {
  total?: number;
  items: T[];
  done: boolean;
  offset: number;
}

export interface FanslyMessagingGroupsPageResponse extends FanslyPaginatedResponse<FanslyMessagingGroup> {
  accounts: FanslyAccount[];
  groups: FanslyMessagingAggregatedGroup[];
  raw: FanslyMessagingGroupsPage;
}

export interface FanslyMessagesPageResponse {
  items: FanslyMessage[];
  groupId: string;
  before: string | null;
  done: boolean;
  raw: FanslyMessagesPage;
}

/** Minimal stable fields observed on GET /timelinenew/{accountId}. Unknown
 * additive provider fields stay present in the raw page captured by the sync
 * layer; this interface intentionally does not try to model the large media
 * aggregation family returned alongside posts. */
export interface FanslyPost {
  id: string;
  accountId?: string;
  content?: string | null;
  createdAt?: number;
  attachments?: Array<Record<string, unknown>>;
  wallIds?: string[] | null;
  pinned?: boolean | null;
}

export interface FanslyPostsPage {
  posts: FanslyPost[];
  [key: string]: unknown;
}

export interface FanslyPostsPageResponse {
  items: FanslyPost[];
  accountId: string;
  wallId: string | null;
  before: string;
  nextBefore: string | null;
  done: boolean;
  /** False means the successful provider envelope drifted away from
   * `{posts: [...]}`. Callers must capture raw before rejecting the page. */
  contractAccepted: boolean;
  raw: FanslyPostsPage | unknown;
}

export interface FanslyEarningsAccountsPageResponse {
  items: FanslyEarningsAccount[];
  after: Date | null;
  before: Date | null;
  done: boolean;
  raw: FanslyEarningsAccount[];
}
