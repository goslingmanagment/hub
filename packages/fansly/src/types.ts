import type {
  FanslySessionBundle,
  HttpRequestObserver,
  Mills,
  ProxyConfig,
} from "@agency_hub_core/shared";

import type { FanslySendGuard } from "./send-guard.ts";

export interface FanslyRequestContext {
  session: FanslySessionBundle;
  proxy?: ProxyConfig | null;
  egressKey?: string | null;
  requestObserver?: HttpRequestObserver | null;
  /** Durable lane allowance remaining before this logical request starts.
   * The adapter clamps its retry loop to this value. */
  remainingAttempts?: (() => number) | null;
  /** The legacy endpoint pauses (`dm_messages`, `dm_conversations`,
   * `followers_page`), reserved per egress before the send guard is captured. */
  rateLimitWaiter?: ((scopes: Array<{
    provider: "fansly" | "onlyfans";
    scope: string;
  }>) => Promise<number>) | null;
  /** The page's send guard (plan §2.5). Mandatory: every physical attempt,
   * SDK retries included, is captured through it and journaled. */
  sendGuard: FanslySendGuard;
  /** Per-request timeout override (default 30 s); the fetch is aborted. */
  requestTimeoutMs?: number | null;
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

/**
 * The earnings overview currently exposes only the pending balance in the
 * observed Fansly corpus. Keep the raw provider object alongside the parsed
 * value so a later additive contract can be captured before it is modeled.
 */
export interface FanslyEarningsOverview {
  pendingBalance: number;
  [key: string]: unknown;
}

export interface FanslyEarningsOverviewResponse {
  pendingBalanceMills: Mills | null;
  contractAccepted: boolean;
  raw: unknown;
}

/** Stable fields observed on GET /trackinglinks. Additive provider fields are
 * retained in each record and in the raw response. */
export interface FanslyTrackingLink {
  id: string;
  accountId?: string | null;
  internalId?: string | null;
  type?: number | null;
  status?: number | null;
  label?: string | null;
  description?: string | null;
  metadata?: string | null;
  createdAt?: number | null;
  clicks?: number | null;
  claims?: number | null;
  follows?: number | null;
  subscriptions?: number | null;
  totalNet?: number | null;
  totalGross?: number | null;
  [key: string]: unknown;
}

/** Stable fields observed on GET /lists/itemsnew. */
export interface FanslyListItem {
  id: string;
  sortId?: string | null;
  listId?: string | null;
  type?: number | null;
  metadata?: string | null;
  [key: string]: unknown;
}

/** Stable fields observed on GET /lists/account. An item-filtered response may
 * include matching list items; the all-lists response need not. */
export interface FanslyAccountList {
  id: string;
  accountId?: string | null;
  pos?: number | null;
  type?: number | null;
  label?: string | null;
  itemCount?: number | null;
  items?: FanslyListItem[];
  [key: string]: unknown;
}

export interface FanslyTrackingLinksResponse {
  items: FanslyTrackingLink[];
  contractAccepted: boolean;
  raw: unknown;
}

export interface FanslyAccountListsResponse {
  items: FanslyAccountList[];
  itemId: string | null;
  contractAccepted: boolean;
  raw: unknown;
}

export interface FanslyListItemsPageResponse {
  items: FanslyListItem[];
  listId: string;
  after: string | null;
  contractAccepted: boolean;
  raw: unknown;
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

/** The first item of a transactions page that failed the item contract. */
export interface FanslyTransactionItemViolation {
  /** Position in the page's `data`. */
  index: number;
  transactionId: string | null;
  /** The first failing field, or "item" when the entry is not an object. */
  field: string;
}

export interface FanslyTransactionsPage {
  total: number;
  data: FanslyEarningsTransaction[];
  /** Set when an item failed the contract; `data` is then empty. */
  itemViolation: FanslyTransactionItemViolation | null;
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
  /** False means the successful envelope drifted from `{data: [...]}` or a
   * row/group/account lost its id. Callers must capture raw before refusing
   * the page. */
  contractAccepted?: boolean;
  raw: FanslyMessagingGroupsPage | unknown;
}

export interface FanslyMessagesPageResponse {
  items: FanslyMessage[];
  groupId: string;
  before: string | null;
  done: boolean;
  /** False means the successful envelope drifted from `{messages: [...]}`.
   * Callers must capture raw before refusing the page. */
  contractAccepted?: boolean;
  raw: FanslyMessagesPage | unknown;
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

/** Stable fields observed on GET /tips?targetIds=... . The endpoint may add
 * fields (including tipGoalId), so accepted items and targets retain additive
 * provider properties for capture-first consumers. */
export interface FanslyTipTarget {
  id: string;
  type: number;
  [key: string]: unknown;
}

interface FanslyPostTipCommon {
  id: string;
  senderId: string;
  receiverId: string;
  amount: number;
  message?: string | null;
  senderTransactionId?: string | null;
  receiverTransactionId?: string | null;
  createdAt: number;
  tipGoalId?: string | null;
  [key: string]: unknown;
}

/** Shape observed live in August 2026. targetId is exact post attribution,
 * but carries no evidence about whether the tip funded a linked goal. */
export interface FanslyFlatPostTip extends FanslyPostTipCommon {
  targetId: string;
  targets?: never;
}

/** Older/richer shape where typed targets distinguish the post from a goal. */
export interface FanslyNestedPostTip extends FanslyPostTipCommon {
  targets: FanslyTipTarget[];
  targetId?: string;
}

export type FanslyPostTip = FanslyFlatPostTip | FanslyNestedPostTip;

export interface FanslyPostTipsResponse {
  items: FanslyPostTip[];
  targetIds: string[];
  /** False means the successful provider envelope drifted away from an array.
   * Callers must capture raw before rejecting the response. */
  contractAccepted: boolean;
  raw: FanslyPostTip[] | unknown;
}

export interface FanslyEarningsAccountsPageResponse {
  items: FanslyEarningsAccount[];
  after: Date | null;
  before: Date | null;
  done: boolean;
  raw: FanslyEarningsAccount[];
}
