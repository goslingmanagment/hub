export interface ProviderResponse<TParsed, TRaw = unknown> {
  parsed: TParsed;
  raw: TRaw;
}

export interface ProviderPageResponse<TItem, TRaw = unknown> {
  total?: number | null;
  items: TItem[];
  offset: number;
  done: boolean;
  contractAccepted?: boolean;
  raw: TRaw;
}

export interface ProviderTransactionsPageResponse<TItem, TRaw = unknown>
  extends ProviderPageResponse<TItem, TRaw> {
  /** The first item that failed the adapter's item contract; `items` is then empty. */
  itemViolation?: { index: number; transactionId: string | null; field: string } | null;
}

export interface ProviderFollowersPageResponse<TAccount, TFollower, TRaw = unknown>
  extends ProviderPageResponse<TFollower, TRaw> {
  accounts: TAccount[];
}

export interface ProviderTransactionsPageParams {
  limit?: number;
  offset?: number;
}

export interface ProviderSubscribersPageParams {
  offset?: number;
  limit?: number;
  after?: Date | null;
  before?: Date | null;
  status?: string;
}

export interface ProviderFollowersPageParams {
  offset?: number;
  limit?: number;
  after?: string | null;
  before?: string | null;
  lastSeenAfter?: number | null;
  minDelayMs?: number;
}

export interface ProviderAdapter<
  TContext,
  TAccountMe,
  TAccount,
  TTransaction,
  TSubscriber,
  TFollower,
> {
  getAccountMe(context: TContext): Promise<ProviderResponse<TAccountMe>>;
  verifySession(context: TContext): Promise<ProviderResponse<TAccountMe>>;
  getAccountsByIdsPage(context: TContext, ids: string[]): Promise<ProviderResponse<TAccount[]>>;
  getTransactionsPage(
    context: TContext,
    params: ProviderTransactionsPageParams,
  ): Promise<ProviderTransactionsPageResponse<TTransaction>>;
  getSubscribersPage(
    context: TContext,
    params: ProviderSubscribersPageParams,
  ): Promise<ProviderPageResponse<TSubscriber>>;
  getFollowersPage(
    context: TContext,
    accountId: string,
    params: ProviderFollowersPageParams,
  ): Promise<ProviderFollowersPageResponse<TAccount, TFollower>>;
}
