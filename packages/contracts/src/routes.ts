import {
  PERIOD_OPTIONS,
  SPENDER_PERIOD_OPTIONS,
  SPENDER_RETENTION_STATUSES,
  SPENDER_SERIES_GRANULARITIES,
  aiUsageFeatures,
  creatableUserRoles,
  fanFlagTypes,
  isValidBusinessDateString,
  platforms,
  transactionReportingBuckets,
  transactionStates,
  transactionTypes,
  userRoles,
} from "@agency_hub_core/shared";
import { z } from "zod";

const intId = z.number().int().positive();
const mills = z.number().int();
const isoTimestamp = z.string();
const businessDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isValidBusinessDateString(value), "Invalid business date");
const periodEnum = z.enum(PERIOD_OPTIONS);
const spenderPeriodEnum = z.enum(SPENDER_PERIOD_OPTIONS);
const spenderSeriesGranularityEnum = z.enum(SPENDER_SERIES_GRANULARITIES);
const nonCustomPeriodEnum = z.enum(["today", "7d", "30d", "all"]);
const platformEnum = z.enum(platforms);
const transactionReportingBucketEnum = z.enum(transactionReportingBuckets);
const transactionTypeEnum = z.enum(transactionTypes);
const transactionStateEnum = z.enum(transactionStates);
const userRoleEnum = z.enum(userRoles);
const creatableUserRoleEnum = z.enum(creatableUserRoles);
const fanFlagEnum = z.enum(fanFlagTypes);
const aiUsageFeatureEnum = z.enum(aiUsageFeatures);
const spenderScopeKindEnum = z.enum(["page", "model", "agency"]);
const sortDirEnum = z.enum(["asc", "desc"]);
const spenderSortByEnum = z.enum([
  "grossAmountMills",
  "creatorNetAmountMills",
  "postedGrossAmountMills",
  "pendingGrossAmountMills",
  "postedCreatorNetAmountMills",
  "pendingCreatorNetAmountMills",
  "lifetimeGrossAmountMills",
  "lifetimeCreatorNetAmountMills",
  "lastTransactionAt",
  "platformUserId",
  "username",
  "displayName",
]);
const spenderRetentionStatusEnum = z.enum(SPENDER_RETENTION_STATUSES);
const fanSearchMatchKindEnum = z.enum(["platformUserId", "username", "alias", "displayName"]);
const pageSpenderAutoListBucketKeyEnum = z.enum([
  "0-25",
  "25-50",
  "50-150",
  "150-350",
  "350-600",
  "600-plus",
]);
const workboardTouchpointEnum = z.enum(["21d", "14d", "7d", "5d", "3d", "1d"]);
const queryBooleanSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return value;
}, z.boolean());

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
});

export const pageRefSchema = z.object({
  id: intId,
  label: z.string(),
  platform: platformEnum,
  modelSlug: z.string(),
  modelName: z.string(),
});

export const authUserSchema = z.object({
  id: intId,
  username: z.string(),
  role: userRoleEnum,
  assignedPages: z.array(pageRefSchema),
});

export const adminUserApiKeyStatusSchema = z.object({
  activeKeyPrefix: z.string().nullable(),
  activeKeyCount: z.number().int().nonnegative(),
  activeKeyCreatedAt: isoTimestamp.nullable(),
  activeKeyLastUsedAt: isoTimestamp.nullable(),
});

export const adminUserSchema = authUserSchema.extend({
  apiKeyStatus: adminUserApiKeyStatusSchema.nullable(),
});

export const authStateSchema = z.object({
  authMethod: z.enum(["session", "api_key"]),
  user: authUserSchema,
});

const serviceHealthStatusEnum = z.enum(["ok", "degraded"]);
const systemCheckStatusEnum = z.enum(["ok", "error"]);
const healthConnectionStatusEnum = z.enum([
  "active",
  "stale",
  "error",
  "expired",
  "never_synced",
  "unverified",
]);
const syncUxStateEnum = z.enum([
  "healthy",
  "syncing",
  "catching_up",
  "retrying",
  "attention",
  "setup",
  "off",
]);

export const syncUxSummarySchema = z.object({
  state: syncUxStateEnum,
  label: z.string(),
  headline: z.string(),
  detail: z.string().nullable(),
  progressLabel: z.string().nullable(),
  nextRetryAt: isoTimestamp.nullable(),
  updatedAt: isoTimestamp.nullable(),
  requiresAction: z.boolean(),
});

export const systemCheckSchema = z.object({
  status: systemCheckStatusEnum,
  latencyMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});

export const healthResponseSchema = z.object({
  status: serviceHealthStatusEnum,
  timestamp: isoTimestamp,
  checks: z.object({
    api: z.object({
      status: z.literal("ok"),
    }),
    database: systemCheckSchema,
  }),
});

export const syncHealthPageSchema = z.object({
  pageId: intId,
  pageLabel: z.string(),
  platform: platformEnum,
  modelSlug: z.string(),
  modelName: z.string(),
  status: serviceHealthStatusEnum,
  connectionStatus: healthConnectionStatusEnum,
  lastLightSyncAt: isoTimestamp.nullable(),
  lightAgeMinutes: z.number().int().nonnegative().nullable(),
  lastFollowerSyncAt: isoTimestamp.nullable(),
  followerAgeMinutes: z.number().int().nonnegative().nullable(),
  failedStreams: z.number().int(),
  stalledStreams: z.number().int(),
  pendingStreams: z.number().int(),
  lastErrorSummary: z.string().nullable(),
  issues: z.array(z.string()),
});

export const syncHealthResponseSchema = z.object({
  status: serviceHealthStatusEnum,
  timestamp: isoTimestamp,
  thresholds: z.object({
    lightMaxAgeMinutes: z.number().int().positive(),
    followerMaxAgeMinutes: z.number().int().positive(),
  }),
  overall: z.object({
    pageCount: z.number().int(),
    unhealthyPageCount: z.number().int(),
    runningStreams: z.number().int(),
    failedStreams: z.number().int(),
    stalledStreams: z.number().int(),
    pendingStreams: z.number().int(),
    recentFailedRuns: z.number().int(),
    recent429s: z.number().int(),
    recent5xxs: z.number().int(),
  }),
  pages: z.array(syncHealthPageSchema),
});

export const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pageParamsSchema = z.object({
  pageLabel: z.string().min(1),
});

export const pageSpenderAutoListParamsSchema = pageParamsSchema.extend({
  bucketKey: pageSpenderAutoListBucketKeyEnum,
});

export const modelParamsSchema = z.object({
  modelSlug: z.string().min(1),
});

export const fanLookupParamsSchema = z.object({
  platform: platformEnum,
  platformUserId: z.string().min(1),
});

export const pageFanParamsSchema = pageParamsSchema.extend({
  platformUserId: z.string().min(1),
});

export const fanProfileVersionParamsSchema = pageFanParamsSchema.extend({
  version: z.coerce.number().int().min(1),
});

export const pageConversationProfileParamsSchema = pageParamsSchema.extend({
  conversationId: z.string().min(1),
});

const standardRevenueQuerySchema = z.object({
  period: nonCustomPeriodEnum,
  from: businessDate.optional(),
  to: businessDate.optional(),
});

const customRevenueQuerySchema = z.object({
  period: z.literal("custom"),
  from: businessDate,
  to: businessDate,
}).refine((value) => value.from <= value.to, {
  message: "`from` must be on or before `to`",
  path: ["to"],
});

export const revenueQuerySchema = z.union([
  standardRevenueQuerySchema,
  customRevenueQuerySchema,
]);

export const transactionListQuerySchema = paginationQuerySchema.extend({
  type: transactionTypeEnum.optional(),
  state: transactionStateEnum.optional(),
});

export const fanListQuerySchema = paginationQuerySchema.extend({
  query: z.string().min(1).optional(),
});

export const subscriberListQuerySchema = paginationQuerySchema.extend({
  query: z.string().min(1).optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(90).optional(),
  startedWithinHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  autoRenew: queryBooleanSchema.optional(),
});

export const followerListQuerySchema = paginationQuerySchema.extend({
  query: z.string().min(1).optional(),
  followedWithinHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  subscriber: queryBooleanSchema.optional(),
  dmStatus: z.enum(["none", "has_dm"]).optional(),
  activeWithinMinutes: z.coerce.number().int().min(1).max(24 * 60).optional(),
});

const spenderScopeFieldsSchema = z.object({
  scope: spenderScopeKindEnum,
  pageLabel: z.string().min(1).optional(),
  modelSlug: z.string().min(1).optional(),
  platform: platformEnum.optional(),
}).superRefine((value, context) => {
  if (value.scope === "page" && !value.pageLabel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pageLabel"],
      message: "`pageLabel` is required for page scope",
    });
  }

  if (value.scope === "model") {
    if (!value.modelSlug) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelSlug"],
        message: "`modelSlug` is required for model scope",
      });
    }
    if (!value.platform) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["platform"],
        message: "`platform` is required for model scope",
      });
    }
  }

  if (value.scope === "agency" && !value.platform) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["platform"],
      message: "`platform` is required for agency scope",
    });
  }
});

const spenderPeriodFieldsSchema = z.object({
  period: spenderPeriodEnum,
  from: businessDate.optional(),
  to: businessDate.optional(),
}).superRefine((value, context) => {
  if (value.period === "custom") {
    if (!value.from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "`from` is required when `period=custom`",
      });
    }
    if (!value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "`to` is required when `period=custom`",
      });
    }
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "`from` must be on or before `to`",
      });
    }
  }
});

const spenderOptionalPeriodFieldsSchema = z.object({
  period: spenderPeriodEnum.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
}).superRefine((value, context) => {
  if (value.period === "custom") {
    if (!value.from) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "`from` is required when `period=custom`",
      });
    }
    if (!value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "`to` is required when `period=custom`",
      });
    }
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "`from` must be on or before `to`",
      });
    }
  }

  if (value.period !== "custom" && (value.from || value.to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["period"],
      message: "`from` and `to` are only supported when `period=custom`",
    });
  }
});

export const spenderListQuerySchema = spenderScopeFieldsSchema
  .merge(spenderPeriodFieldsSchema)
  .merge(paginationQuerySchema)
  .extend({
    query: z.string().min(1).optional(),
    sortBy: spenderSortByEnum.optional(),
    sortDir: sortDirEnum.optional(),
    retentionStatus: spenderRetentionStatusEnum.optional(),
  });

export const spenderDetailQuerySchema = spenderScopeFieldsSchema.merge(spenderPeriodFieldsSchema);

export const spenderSeriesQuerySchema = spenderScopeFieldsSchema
  .merge(spenderPeriodFieldsSchema)
  .extend({
    granularity: spenderSeriesGranularityEnum.default("auto"),
  });

export const spenderBatchBodySchema = spenderScopeFieldsSchema
  .merge(spenderOptionalPeriodFieldsSchema)
  .extend({
    fans: z.array(fanLookupParamsSchema).min(1).max(200),
  });

export const pageSpenderAutoListsQuerySchema = spenderOptionalPeriodFieldsSchema;

export const pageSpenderAutoListQuerySchema = fanListQuerySchema
  .merge(spenderOptionalPeriodFieldsSchema)
  .extend({
    excludeNonFollowers: queryBooleanSchema.optional(),
  });

export const fansSearchQuerySchema = spenderScopeFieldsSchema
  .merge(paginationQuerySchema)
  .extend({
    query: z.string().min(1).optional(),
    q: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (!value.query && !value.q) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message: "`query` is required",
      });
    }
  });

export const pageConversationPreviewParamsSchema = pageParamsSchema.extend({
  platformConversationId: z.string().min(1),
});

export const pageConversationPreviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const pageConversationMessagesParamsSchema = pageParamsSchema.extend({
  conversationId: z.string().min(1),
});

export const pageConversationMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const pageMetricSchema = z.object({
  value: z.number().int().nullable(),
  available: z.boolean(),
});

const messageCoverageStatusSchema = z.enum(["pending_backfill", "partial_window", "complete"]);
const messageSyncEligibilitySchema = z.enum(["eligible", "excluded", "unresolved_identity"]);

export const assignedPageSchema = pageRefSchema.extend({
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  followerCount: pageMetricSchema,
  subscriberCount: pageMetricSchema,
  lastLightSyncAt: isoTimestamp.nullable(),
  lastFollowerSyncAt: isoTimestamp.nullable(),
});

export const modelListItemSchema = z.object({
  id: intId,
  slug: z.string(),
  name: z.string(),
  pageCount: z.number().int(),
});

export const adminModelListItemSchema = modelListItemSchema.extend({
  sortOrder: z.number().int(),
});

const revenueSummarySchema = z.object({
  revenueMills: mills,
  adjustmentMills: mills,
  unclassifiedMills: mills,
  netEarningsMills: mills,
  totalNetMills: mills,
});

export const revenueBreakdownItemSchema = z.object({
  canonicalType: transactionTypeEnum,
  bucket: transactionReportingBucketEnum,
  netAmountMills: mills,
});

export const revenueComparisonSchema = z.object({
  from: isoTimestamp.describe(
    "Comparison window start. For mixed-platform scopes, this is the earliest included platform-local start.",
  ),
  to: isoTimestamp.describe(
    "Comparison window end. For mixed-platform scopes, this is the latest included platform-local end.",
  ),
  netEarningsMills: mills,
  totalNetMills: mills,
  deltaNetMills: mills,
  deltaPct: z.number().nullable(),
});

export const revenueWindowSchema = revenueSummarySchema.extend({
  period: periodEnum,
  from: isoTimestamp.nullable().describe(
    "Window start. For mixed-platform scopes, this is the earliest included platform-local start.",
  ),
  to: isoTimestamp.nullable().describe(
    "Window end. For mixed-platform scopes, this is the latest included platform-local end.",
  ),
  currency: z.literal("USD"),
  breakdown: z.array(revenueBreakdownItemSchema),
  comparison: revenueComparisonSchema.nullable(),
});

export const pageRevenueItemSchema = z.object({
  pageId: intId,
  pageLabel: z.string(),
  modelSlug: z.string(),
  modelName: z.string(),
  netEarningsMills: mills,
  totalNetMills: mills,
});

export const modelRevenueItemSchema = z.object({
  modelId: intId,
  modelSlug: z.string(),
  modelName: z.string(),
  pageCount: z.number().int(),
  netEarningsMills: mills,
  totalNetMills: mills,
});

export const overviewRevenueResponseSchema = revenueWindowSchema.extend({
  models: z.array(modelRevenueItemSchema),
  pages: z.array(pageRevenueItemSchema),
});

export const overviewGrowthResponseSchema = z.object({
  pages: z.array(z.object({
    pageId: intId,
    newFollowers: z.number().int(),
    newSubscribers: z.number().int(),
  })),
});

export const modelRevenueResponseSchema = revenueWindowSchema.extend({
  model: modelListItemSchema,
  pages: z.array(pageRevenueItemSchema),
});

export const pageRevenueResponseSchema = revenueWindowSchema.extend({
  page: assignedPageSchema,
});

export const transactionFanSchema = z.object({
  platformUserId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
}).nullable();

const pageTransactionFanSchema = z.object({
  platformUserId: z.string(),
  pageAlias: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
}).nullable();

export const transactionItemSchema = z.object({
  transactionId: z.string(),
  rawType: z.union([z.number().int(), z.string()]),
  canonicalType: transactionTypeEnum,
  transactionState: transactionStateEnum,
  amountMills: mills,
  destinationAmountMills: mills,
  netAmountMills: mills,
  walletId: z.string().nullable(),
  correlationId: z.string().nullable(),
  correlationAccountId: z.string().nullable(),
  occurredAt: isoTimestamp,
  sourceUpdatedAt: isoTimestamp.nullable(),
  fan: pageTransactionFanSchema,
});

export const transactionListResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(transactionItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const subscriberItemSchema = z.object({
  platformSubscriptionId: z.string(),
  platformUserId: z.string(),
  pageAlias: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  endsAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
  subscriptionTierName: z.string().nullable(),
  startedAt: isoTimestamp.nullable(),
  totalSpentCents: z.number().int(),
  lastTransactionAt: isoTimestamp.nullable(),
});

export const subscriberDailyItemSchema = z.object({
  businessDate: businessDate,
  newSubscribers: z.number().int(),
  activeSubscribers: z.number().int(),
});

export const subscriberListResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(subscriberItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const subscriberDailyResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(subscriberDailyItemSchema),
});

export const followerItemSchema = z.object({
  platformUserId: z.string(),
  pageAlias: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  followedAt: isoTimestamp,
  isSubscriber: z.boolean(),
  subscriberSince: isoTimestamp.nullable(),
  subscriptionExpiresAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
  totalSpentCents: z.number().int(),
  lastTransactionAt: isoTimestamp.nullable(),
  dm: z.object({
    hasConversation: z.boolean(),
    platformConversationId: z.string().nullable(),
    unreadCount: z.number().int(),
    lastMessageAt: isoTimestamp.nullable(),
    lastFanMessageAt: isoTimestamp.nullable(),
    lastModelMessageAt: isoTimestamp.nullable(),
    lastMessagePreview: z.string().nullable(),
  }),
  presence: z.object({
    status: z.enum(["active_now", "recently_active", "offline"]),
    lastSeenAt: isoTimestamp.nullable(),
    observedAt: isoTimestamp.nullable(),
  }),
});

export const followerDailyItemSchema = z.object({
  businessDate: businessDate,
  newFollowers: z.number().int(),
  knownTotalFollowers: z.number().int().nullable(),
});

export const followerListResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(followerItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const followerDailyResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(followerDailyItemSchema),
});

export const fanListItemSchema = z.object({
  platformUserId: z.string(),
  pageAlias: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  totalCreatorNetMills: mills,
  currency: z.literal("USD"),
  isFollower: z.boolean(),
  followerSince: isoTimestamp.nullable(),
  isSubscriber: z.boolean(),
  subscriberSince: isoTimestamp.nullable(),
  subscriptionExpiresAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
  lastTransactionAt: isoTimestamp.nullable(),
});

export const fanListResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(fanListItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

const deletedFanItemSchema = z.object({
  platformUserId: z.string(),
  latestKnownLabel: z.string().nullable(),
  pageAlias: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  latestHistoricalPageAlias: z.string().nullable(),
  latestHistoricalUsername: z.string().nullable(),
  deletedDetectedAt: isoTimestamp,
  deletedLastDetectedAt: isoTimestamp.nullable(),
  lastSeenAt: isoTimestamp,
});

export const pageDeletedFansResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(deletedFanItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

const fanBaseSchema = z.object({
  platform: platformEnum,
  platformUserId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAtExternal: isoTimestamp.nullable(),
});

const pageScopedFanBaseSchema = fanBaseSchema.extend({
  pageAlias: z.string().nullable(),
});

const fanNoteSchema = z.object({
  id: intId,
  authorUserId: intId.nullable(),
  body: z.string(),
  createdAt: isoTimestamp,
});

const fanSummarySchema = z.object({
  id: intId,
  authorUserId: intId.nullable(),
  body: z.string(),
  createdAt: isoTimestamp,
});

const fanFlagSchema = z.object({
  flag: fanFlagEnum,
  createdAt: isoTimestamp,
  createdByUserId: intId.nullable(),
});

const fanPageContextSchema = z.object({
  pageId: intId,
  pageLabel: z.string(),
  modelSlug: z.string(),
  modelName: z.string(),
  totalCreatorNetMills: mills,
  currency: z.literal("USD"),
  isFollower: z.boolean(),
  followerSince: isoTimestamp.nullable(),
  isSubscriber: z.boolean(),
  subscriberSince: isoTimestamp.nullable(),
  subscriptionExpiresAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
  lastTransactionAt: isoTimestamp.nullable(),
  notes: z.array(fanNoteSchema),
  summaries: z.array(fanSummarySchema),
});

export const pageFanDetailResponseSchema = z.object({
  fan: pageScopedFanBaseSchema,
  platformTotalSpendMills: mills,
  page: fanPageContextSchema,
  flags: z.array(fanFlagSchema),
});

export const crossPageFanDetailResponseSchema = z.object({
  fan: fanBaseSchema,
  platformTotalSpendMills: mills,
  pages: z.array(fanPageContextSchema),
  flags: z.array(fanFlagSchema),
});

const spenderFanSchema = fanBaseSchema.extend({
  pageAlias: z.string().nullable(),
});

const spenderPeriodMetadataSchema = z.object({
  timeZone: z.string(),
  fromBusinessDate: businessDate.nullable(),
  toBusinessDateInclusive: businessDate.nullable(),
  asOf: isoTimestamp.nullable(),
});

const spenderWindowMetricsSchema = z.object({
  grossAmountMills: mills,
  creatorNetAmountMills: mills,
  postedGrossAmountMills: mills,
  pendingGrossAmountMills: mills,
  unknownGrossAmountMills: mills,
  postedCreatorNetAmountMills: mills,
  pendingCreatorNetAmountMills: mills,
  unknownCreatorNetAmountMills: mills,
  transactionCount: z.number().int(),
  lastTransactionAt: isoTimestamp.nullable(),
});

const spenderLifetimeMetricsSchema = z.object({
  scopeGrossAmountMills: mills,
  scopeCreatorNetAmountMills: mills,
  platformGrossAmountMills: mills,
  platformCreatorNetAmountMills: mills,
});

const spenderComparisonSchema = z.object({
  previousGrossAmountMills: mills,
  previousCreatorNetAmountMills: mills,
  deltaGrossAmountMills: mills,
  deltaCreatorNetAmountMills: mills,
  deltaPct: z.number().nullable(),
});

const spenderMetricsSchema = z.object({
  window: spenderWindowMetricsSchema.nullable(),
  lifetime: spenderLifetimeMetricsSchema,
  comparison: spenderComparisonSchema.nullable(),
});

const spenderScopeModelSchema = z.object({
  slug: z.string(),
  name: z.string(),
});

const spenderScopeResponseSchema = z.object({
  kind: spenderScopeKindEnum,
  platform: platformEnum,
  pageCount: z.number().int(),
  page: pageRefSchema.nullable(),
  model: spenderScopeModelSchema.nullable(),
});

const spenderDiagnosticsSchema = z.object({
  totalGrossAmountMills: mills,
  totalCreatorNetAmountMills: mills,
  attributedGrossAmountMills: mills,
  attributedCreatorNetAmountMills: mills,
  unattributedGrossAmountMills: mills,
  unattributedCreatorNetAmountMills: mills,
});

const spenderConversationSchema = z.object({
  platformConversationId: z.string().nullable(),
  unreadCount: z.number().int(),
  lastMessageAt: isoTimestamp.nullable(),
  lastFanMessageAt: isoTimestamp.nullable(),
  lastModelMessageAt: isoTimestamp.nullable(),
  lastMessagePreview: z.string().nullable(),
  storedMessageCount: z.number().int(),
  messageCoverageStatus: messageCoverageStatusSchema,
  messageBackfillComplete: z.boolean(),
});

const spenderLastTransactionSchema = z.object({
  canonicalType: transactionTypeEnum,
  transactionState: transactionStateEnum,
  grossAmountMills: mills,
  creatorNetAmountMills: mills,
  occurredAt: isoTimestamp,
}).nullable();

const spenderListItemSchema = z.object({
  fan: spenderFanSchema,
  metrics: spenderMetricsSchema,
  lifetimeLastTransactionAt: isoTimestamp.nullable(),
  lastFanMessageAt: isoTimestamp.nullable(),
  conversation: spenderConversationSchema,
  lastTransaction: spenderLastTransactionSchema,
  retentionStatus: spenderRetentionStatusEnum.exclude(["all"]),
});

export const spenderListResponseSchema = z.object({
  scope: spenderScopeResponseSchema,
  period: spenderPeriodMetadataSchema,
  diagnostics: spenderDiagnosticsSchema,
  items: z.array(spenderListItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

const pageSpenderAutoListItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  minAmountMills: mills.nonnegative(),
  maxAmountMillsExclusive: mills.positive().nullable(),
  entryCount: z.number().int().nonnegative(),
});

export const pageSpenderAutoListsResponseSchema = z.object({
  page: pageRefSchema,
  currency: z.literal("USD"),
  metric: z.enum(["grossAmountMills", "lifetimeGrossAmountMills"]),
  period: spenderPeriodMetadataSchema,
  asOf: isoTimestamp.nullable(),
  totalEntries: z.number().int().nonnegative(),
  lists: z.array(pageSpenderAutoListItemSchema),
});

const pageSpenderAutoListFanSchema = z.object({
  fan: spenderFanSchema,
  isFollower: z.boolean(),
  isSubscriber: z.boolean(),
  subscriptionStatus: z.enum(["active", "expired", "never"]),
  subscriptionExpiresAt: isoTimestamp.nullable(),
  lastSubscriptionEndedAt: isoTimestamp.nullable(),
  grossAmountMills: mills,
  creatorNetAmountMills: mills,
  lifetimeGrossAmountMills: mills,
  lifetimeCreatorNetAmountMills: mills,
  lastTransactionAt: isoTimestamp.nullable(),
});

export const pageSpenderAutoListDetailResponseSchema = z.object({
  page: pageRefSchema,
  currency: z.literal("USD"),
  metric: z.enum(["grossAmountMills", "lifetimeGrossAmountMills"]),
  period: spenderPeriodMetadataSchema,
  bucket: pageSpenderAutoListItemSchema,
  items: z.array(pageSpenderAutoListFanSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

const spenderPageBreakdownSchema = z.object({
  pageId: intId,
  pageLabel: z.string(),
  modelSlug: z.string(),
  modelName: z.string(),
  inScope: z.boolean(),
  grossAmountMills: mills,
  creatorNetAmountMills: mills,
  lastTransactionAt: isoTimestamp.nullable(),
  isFollower: z.boolean(),
  followerSince: isoTimestamp.nullable(),
  isSubscriber: z.boolean(),
  subscriberSince: isoTimestamp.nullable(),
  subscriptionExpiresAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
});

const spenderTypeBreakdownItemSchema = z.object({
  canonicalType: transactionTypeEnum,
  grossAmountMills: mills,
  creatorNetAmountMills: mills,
  transactionCount: z.number().int(),
});

export const spenderDetailResponseSchema = z.object({
  scope: spenderScopeResponseSchema,
  fan: spenderFanSchema,
  period: spenderPeriodMetadataSchema,
  metrics: spenderMetricsSchema,
  typeBreakdown: z.array(spenderTypeBreakdownItemSchema),
  pages: z.array(spenderPageBreakdownSchema),
});

export const spenderSeriesBucketSchema = z.object({
  fromBusinessDate: businessDate,
  toBusinessDateInclusive: businessDate,
  metrics: spenderWindowMetricsSchema,
});

export const spenderSeriesResponseSchema = z.object({
  scope: spenderScopeResponseSchema,
  fan: spenderFanSchema,
  period: spenderPeriodMetadataSchema,
  granularity: spenderSeriesGranularityEnum.exclude(["auto"]),
  items: z.array(spenderSeriesBucketSchema),
});

const spenderSubscriptionSchema = z.object({
  status: z.enum(["active", "expired", "never"]),
  expiresAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
});

export const spenderBatchItemSchema = z.object({
  requestedFan: fanLookupParamsSchema,
  found: z.boolean(),
  fan: spenderFanSchema.nullable(),
  metrics: spenderMetricsSchema.nullable(),
  typeBreakdown: z.array(spenderTypeBreakdownItemSchema).nullable(),
  lifetimeLastTransactionAt: isoTimestamp.nullable(),
  subscription: spenderSubscriptionSchema.nullable(),
});

export const spenderBatchResponseSchema = z.object({
  scope: spenderScopeResponseSchema,
  period: spenderPeriodMetadataSchema,
  items: z.array(spenderBatchItemSchema),
});

const fanSearchPageMembershipSchema = z.object({
  pageId: intId,
  pageLabel: z.string(),
  modelSlug: z.string(),
  modelName: z.string(),
  isFollower: z.boolean(),
  followerSince: isoTimestamp.nullable(),
  isSubscriber: z.boolean(),
  subscriberSince: isoTimestamp.nullable(),
  subscriptionExpiresAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  autoRenewOffDetectedAt: isoTimestamp.nullable(),
});

export const fansSearchItemSchema = z.object({
  fan: spenderFanSchema,
  matchKind: fanSearchMatchKindEnum,
  matchedValue: z.string().nullable(),
  pages: z.array(fanSearchPageMembershipSchema),
});

export const fansSearchResponseSchema = z.object({
  scope: spenderScopeResponseSchema,
  items: z.array(fansSearchItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

const pageConversationFanSchema = z.object({
  fanId: intId,
  platform: platformEnum,
  platformUserId: z.string(),
  pageAlias: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});

const pageConversationStateSchema = z.object({
  platformConversationId: z.string(),
  storedMessageCount: z.number().int(),
  messageCoverageStatus: messageCoverageStatusSchema,
  messageBackfillComplete: z.boolean(),
  messageSyncEligibility: messageSyncEligibilitySchema,
  messageSyncExcludedReason: z.string().nullable(),
  lastMessageSyncAt: isoTimestamp.nullable(),
  unreadCount: z.number().int(),
  lastMessageAt: isoTimestamp.nullable(),
});

const pageConversationPreviewMessageSchema = z.object({
  platformMessageId: z.string(),
  senderPlatformUserId: z.string().nullable(),
  senderRole: z.enum(["fan", "model", "system", "unknown"]),
  createdAt: isoTimestamp,
  content: z.string(),
  totalTipAmountCents: z.number().int(),
});

export const pageConversationPreviewResponseSchema = z.object({
  page: assignedPageSchema,
  fan: pageConversationFanSchema.nullable(),
  conversation: pageConversationStateSchema,
  messageSyncUx: syncUxSummarySchema,
  messages: z.array(pageConversationPreviewMessageSchema),
});

// --- Workboard schemas ---

const workboardConversationSchema = z.object({
  platformConversationId: z.string().nullable(),
  lastFanMessageAt: isoTimestamp.nullable(),
  lastModelMessageAt: isoTimestamp.nullable(),
  lastMessagePreview: z.string().nullable(),
  storedMessageCount: z.number().int(),
  messageCoverageStatus: messageCoverageStatusSchema,
  messageBackfillComplete: z.boolean(),
  messageSyncEligibility: messageSyncEligibilitySchema,
});

const workboardPresenceItemSchema = z.object({
  fanId: intId,
  fan: z.object({
    platformUserId: z.string(),
    pageAlias: z.string().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  presence: z.object({
    lastSeenAt: isoTimestamp,
    observedAt: isoTimestamp,
    source: z.literal("fansly_followers_last_seen"),
  }),
  ltv: z.object({ creatorNetAmountMills: mills }),
  isSubscriber: z.boolean(),
  platformConversationId: z.string().nullable(),
  lastTransactionAt: isoTimestamp.nullable(),
});

const workboardPresenceBucketSchema = z.object({
  total: z.number().int(),
  items: z.array(workboardPresenceItemSchema),
});

const workboardSubscriberItemSchema = z.object({
  fanId: intId,
  fan: z.object({
    platformUserId: z.string(),
    pageAlias: z.string().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  ltv: z.object({ creatorNetAmountMills: mills }),
  touchpoint: z.object({
    code: workboardTouchpointEnum,
    label: z.string(),
    isSoft: z.boolean(),
    dueAt: isoTimestamp,
  }),
  overdueDays: z.number().int(),
  conversation: workboardConversationSchema,
  subscription: z.object({
    expiresAt: isoTimestamp,
    autoRenew: z.boolean().nullable(),
    autoRenewOffDetectedAt: isoTimestamp.nullable(),
    tierName: z.string().nullable(),
    subscriberSince: isoTimestamp.nullable(),
  }),
  lastTransactionAt: isoTimestamp.nullable(),
});

const workboardSpenderItemSchema = z.object({
  fanId: intId,
  fan: z.object({
    platformUserId: z.string(),
    pageAlias: z.string().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  ltv: z.object({ creatorNetAmountMills: mills }),
  segment: z.enum(["active", "inactive"]),
  overdueDays: z.number().int(),
  silenceDays: z.number().int(),
  conversation: workboardConversationSchema,
  subscription: z.object({
    status: z.enum(["active", "expired", "never"]),
    expiresAt: isoTimestamp.nullable(),
  }),
  lastTransactionAt: isoTimestamp.nullable(),
});

const workboardSnoozedItemSchema = z.object({
  fanId: intId,
  fan: z.object({
    platformUserId: z.string(),
    pageAlias: z.string().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  ltv: z.object({ creatorNetAmountMills: mills }),
  snoozedUntil: isoTimestamp,
});

export const workboardResponseSchema = z.object({
  subscribers: z.object({
    total: z.number().int(),
    items: z.array(workboardSubscriberItemSchema),
  }),
  activeSpenders: z.object({
    total: z.number().int(),
    items: z.array(workboardSpenderItemSchema),
  }),
  inactiveSpenders: z.object({
    total: z.number().int(),
    items: z.array(workboardSpenderItemSchema),
  }),
  snoozed: z.object({
    total: z.number().int(),
    items: z.array(workboardSnoozedItemSchema),
  }),
});

export const workboardPresenceResponseSchema = z.object({
  updatedAt: isoTimestamp,
  bestEffort: z.literal(true),
  activeNow: workboardPresenceBucketSchema,
  recentlyActive: workboardPresenceBucketSchema,
});

export const workboardSnoozeBodySchema = z.object({
  fanId: intId,
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
});

export const workboardSnoozeResponseSchema = z.object({
  fanId: intId,
  snoozedUntil: isoTimestamp,
});

export const workboardUnsnoozeParamsSchema = pageParamsSchema.extend({
  fanId: z.coerce.number().int().positive(),
});

// --- Workboard v2 schemas ---

const workboardV2TabEnum = z.enum(["subscribers", "spenders", "fresh_mass", "old_mass", "service"]);
const workboardV2SecondaryStatusEnum = z.enum([
  "recent_purchase",
  "need_reply",
  "due_now",
  "later",
  "dont_touch_today",
]);

export const workboardV2QuerySchema = z.object({
  tab: workboardV2TabEnum,
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const workboardV2ItemSchema = z.object({
  fanId: intId,
  fan: z.object({
    platformUserId: z.string().nullable(),
    pageAlias: z.string().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  tab: workboardV2TabEnum,
  massSubstate: z.enum(["fresh", "gray", "active", "dead", "archived"]).nullable(),
  value: z.object({
    score: z.number(),
    tier: z.enum(["whale", "vip", "payer", "new"]),
    confidence: z.enum(["high", "low"]),
  }),
  urgency: z.object({
    score: z.number(),
    severity: z.enum(["critical", "high", "medium", "normal", "muted"]),
  }),
  rankScore: z.number(),
  secondaryStatus: workboardV2SecondaryStatusEnum,
  needsReply: z.boolean(),
  needsHumanTriage: z.boolean(),
  isPurchaseFollowup: z.boolean(),
  whyNow: z.object({ code: z.string().nullable(), value: z.number().nullable() }),
  reasonChips: z.array(z.string()),
  quality: z.object({
    qScore: z.number().nullable(),
    qConfidence: z.enum(["high", "medium", "low"]),
  }),
  closingVerdict: z
    .object({
      layer: z.enum(["l1", "l2", "fresh", "unverified", "model_last", "unknown"]),
      needsReply: z.boolean(),
      state: z
        .enum(["question", "buy_signal", "smalltalk", "closing", "cold", "complaint"])
        .nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  online: z.boolean(),
  ltv: z.object({ creatorNetAmountMills: mills }),
  subscription: z.object({
    expiresAt: isoTimestamp.nullable(),
    autoRenew: z.boolean().nullable(),
  }),
  conversation: z.object({
    lastFanMessageAt: isoTimestamp.nullable(),
    lastModelMessageAt: isoTimestamp.nullable(),
    preview: z.string().nullable(),
    coverageStatus: z.enum(["pending_backfill", "partial_window", "complete"]),
  }),
  serviceReason: z.string().nullable(),
});

export const workboardV2CountSchema = z.object({
  tab: workboardV2TabEnum,
  secondaryStatus: workboardV2SecondaryStatusEnum,
  count: z.number().int(),
});

export const workboardV2OldMassBudgetSchema = z.object({
  used: z.number().int(),
  total: z.number().int(),
  resetsAt: isoTimestamp,
});

export const workboardV2ResponseSchema = z.object({
  tab: workboardV2TabEnum,
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(workboardV2ItemSchema),
  counts: z.array(workboardV2CountSchema),
  oldMassBudget: workboardV2OldMassBudgetSchema.nullable(),
  aiCoverage: z.object({
    enabled: z.boolean(),
    classified: z.number().int(),
    closingsFound: z.number().int(),
    callsToday: z.number().int(),
  }),
});

export const workboardV2ContactBodySchema = z.object({
  fanId: intId,
  action: z.enum(["opened", "handled", "snoozed"]).default("handled"),
  wasProductive: z.boolean().default(true),
});

export const workboardV2ContactResponseSchema = z.object({
  ok: z.literal(true),
  fanId: intId,
});

export const workboardV2RecomputeResponseSchema = z.object({
  ok: z.literal(true),
  evaluated: z.number().int(),
});

export const workboardV2SnoozeBodySchema = z.object({
  fanId: intId,
  days: z.number().int().min(1).max(120),
});

export const workboardV2SnoozeResponseSchema = z.object({
  ok: z.literal(true),
  fanId: intId,
  snoozedUntil: isoTimestamp.nullable(),
});

export const workboardV2FanParamsSchema = pageParamsSchema.extend({
  fanId: z.coerce.number().int().positive(),
});

export const workboardV2OkResponseSchema = z.object({
  ok: z.literal(true),
  fanId: intId,
});

// ── Workboard v2 AI analytics (L2 closing classifier) panel ───────────────────

const workboardV2ConversationStateEnum = z.enum([
  "question",
  "buy_signal",
  "smalltalk",
  "closing",
  "cold",
  "complaint",
]);

const aiSettingsSourceSchema = z.enum(["override", "env"]);

export const workboardV2AiSettingsSchema = z.object({
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  model: z.string(),
  dailyCapMin: z.number().int(),
  dailyCapMax: z.number().int(),
  envEnabled: z.boolean(),
  source: z.object({
    enabled: aiSettingsSourceSchema,
    dailyCapMax: aiSettingsSourceSchema,
    model: aiSettingsSourceSchema,
  }),
  override: z.object({
    enabled: z.boolean().nullable(),
    dailyCapMax: z.number().int().nullable(),
    model: z.string().nullable(),
  }),
});

const aiUsageBucketSchema = z.object({
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});

export const workboardV2AiReportSchema = z.object({
  settings: workboardV2AiSettingsSchema,
  usage: z.object({
    today: aiUsageBucketSchema,
    last30d: aiUsageBucketSchema,
    daily: z.array(aiUsageBucketSchema.extend({ date: z.string() })),
  }),
  coverage: z.object({
    tails: z.number().int(),
    classified: z.number().int(),
    closings: z.number().int(),
    pending: z.number().int(),
  }),
  states: z.array(z.object({ state: z.string(), count: z.number().int() })),
  recent: z.array(
    z.object({
      messageId: z.string(),
      tail: z.string(),
      state: workboardV2ConversationStateEnum.nullable(),
      needsReply: z.boolean(),
      reason: z.string().nullable(),
      model: z.string().nullable(),
      classifiedAt: isoTimestamp,
    }),
  ),
});

export const workboardV2AiSettingsBodySchema = z.object({
  enabled: z.boolean().nullable(),
  dailyCapMax: z.number().int().min(1).max(5000).nullable(),
  model: z.string().trim().min(1).max(120).nullable(),
});

export const workboardV2AiClassifyBodySchema = z.object({
  reclassify: z.boolean().default(false),
});

export const workboardV2AiClassifyResponseSchema = z.object({
  ok: z.literal(true),
  // The run is async: it returns immediately with a 'running' run-log row id; the
  // dashboard polls the run log for completion. alreadyRunning = a run was in flight.
  runId: z.number().int(),
  status: z.string(),
  alreadyRunning: z.boolean(),
});

export const workboardV2AiRunSchema = z.object({
  id: z.number().int(),
  pageLabel: z.string().nullable(),
  trigger: z.enum(["cron", "manual", "reclassify"]),
  model: z.string().nullable(),
  classified: z.number().int(),
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  deferred: z.number().int(),
  cleared: z.number().int(),
  costUsd: z.number(),
  status: z.string(),
  error: z.string().nullable(),
  createdAt: isoTimestamp,
});

export const workboardV2AiRunsResponseSchema = z.object({
  runs: z.array(workboardV2AiRunSchema),
});

export const pageConversationMessageItemSchema = z.object({
  messageId: z.string(),
  senderRole: z.enum(["fan", "model", "system", "unknown"]),
  content: z.string(),
  createdAt: isoTimestamp,
  tipAmountCents: z.number().int(),
});

export const pageConversationMessagesResponseSchema = z.object({
  page: assignedPageSchema,
  conversationId: z.string(),
  conversation: pageConversationStateSchema,
  messages: z.array(pageConversationMessageItemSchema),
});

const fanProfileSourceEnum = z.enum(["chatmuse"]);

export const fanProfileDocumentSchema = z.object({
  version: z.number().int().positive(),
  body: z.string(),
  source: fanProfileSourceEnum,
  createdAt: isoTimestamp,
  createdByUserId: intId.nullable(),
});

export const fanProfileResponseSchema = z.object({
  fan: pageScopedFanBaseSchema,
  profile: fanProfileDocumentSchema.nullable(),
});

export const fanProfileVersionListItemSchema = z.object({
  version: z.number().int().positive(),
  createdAt: isoTimestamp,
  isCurrent: z.boolean(),
});

export const fanProfileVersionListResponseSchema = z.object({
  items: z.array(fanProfileVersionListItemSchema),
});

// --- Phase 4: Dashboard schemas ---

const connectionStatusEnum = z.enum([
  "active", "stale", "error", "expired", "never_synced", "unverified",
]);

const syncTriggerScopeEnum = z.enum(["light", "followers", "all", "data", "messages"]);

const transactionSortByEnum = z.enum(["occurredAt", "grossAmountMills", "netAmountMills"]);

export const connectionItemSchema = z.object({
  id: intId,
  label: z.string(),
  platform: platformEnum,
  modelSlug: z.string(),
  modelName: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  connectionStatus: connectionStatusEnum,
  lastLightSyncAt: isoTimestamp.nullable(),
  lastFollowerSyncAt: isoTimestamp.nullable(),
  lastSyncError: z.string().nullable(),
  subscriberCount: pageMetricSchema,
  followerCount: pageMetricSchema,
  proxyUrl: z.string().nullable(),
  proxyHasAuth: z.boolean(),
  syncUx: syncUxSummarySchema,
});

export const overviewResponseSchema = z.object({
  counts: z.object({
    models: z.number().int(),
    pages: z.number().int(),
    fans: z.number().int(),
  }),
  revenue: z.object({
    "7d": z.object({
      revenueMills: mills,
      adjustmentMills: mills,
      unclassifiedMills: mills,
      netEarningsMills: mills,
      previousNetEarningsMills: mills,
      deltaPct: z.number().nullable(),
    }),
    "30d": z.object({
      revenueMills: mills,
      adjustmentMills: mills,
      unclassifiedMills: mills,
      netEarningsMills: mills,
      previousNetEarningsMills: mills,
      deltaPct: z.number().nullable(),
    }),
  }),
  overall: z.object({
    syncUx: syncUxSummarySchema,
  }),
  pages: z.array(z.object({
    id: intId,
    label: z.string(),
    platform: platformEnum,
    modelSlug: z.string(),
    modelName: z.string(),
    username: z.string().nullable(),
    subscriberCount: pageMetricSchema,
    followerCount: pageMetricSchema,
    revenueTodayMills: mills,
    revenue7dMills: mills,
    revenue30dMills: mills,
    newSubscribersToday: z.number().int(),
    newFollowersToday: z.number().int(),
    connectionStatus: connectionStatusEnum,
    lastLightSyncAt: isoTimestamp.nullable(),
    lastFollowerSyncAt: isoTimestamp.nullable(),
    lastSyncError: z.string().nullable(),
    syncUx: syncUxSummarySchema,
  })),
  setup: z.object({
    hasPages: z.boolean(),
    hasFanslyPages: z.boolean(),
    hasOnlyFansPages: z.boolean(),
  }),
});

export const revenueDailyQuerySchema = z.object({
  period: periodEnum.default("30d"),
  from: businessDate.optional(),
  to: businessDate.optional(),
  groupByType: queryBooleanSchema.default(false),
});

export const revenueDailyItemSchema = z.object({
  businessDate: businessDate,
  netAmountMills: mills,
  transactionCount: z.number().int(),
});

export const revenueDailyTypedItemSchema = z.object({
  businessDate: businessDate,
  canonicalType: transactionTypeEnum,
  netAmountMills: mills,
  transactionCount: z.number().int(),
});

export const revenueDailyResponseSchema = z.object({
  series: z.array(revenueDailyItemSchema.extend({
    canonicalType: transactionTypeEnum.optional(),
  })),
});

export const crossPageTransactionItemSchema = z.object({
  transactionId: z.string(),
  rawType: z.union([z.number().int(), z.string()]),
  canonicalType: transactionTypeEnum,
  transactionState: transactionStateEnum,
  amountMills: mills,
  destinationAmountMills: mills,
  netAmountMills: mills,
  occurredAt: isoTimestamp,
  sourceUpdatedAt: isoTimestamp.nullable(),
  fan: transactionFanSchema,
  pageLabel: z.string(),
  platform: platformEnum,
});

export const crossPageTransactionListQuerySchema = paginationQuerySchema.extend({
  pageLabel: z.string().min(1).optional(),
  type: transactionTypeEnum.optional(),
  state: transactionStateEnum.optional(),
  sortBy: transactionSortByEnum.default("occurredAt"),
  sortDir: sortDirEnum.default("desc"),
});

export const crossPageTransactionListResponseSchema = z.object({
  items: z.array(crossPageTransactionItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const fanTransactionItemSchema = z.object({
  transactionId: z.string(),
  rawType: z.union([z.number().int(), z.string()]),
  canonicalType: transactionTypeEnum,
  transactionState: transactionStateEnum,
  amountMills: mills,
  destinationAmountMills: mills,
  netAmountMills: mills,
  occurredAt: isoTimestamp,
  sourceUpdatedAt: isoTimestamp.nullable(),
});

export const fanTransactionListResponseSchema = z.object({
  items: z.array(fanTransactionItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const crossPageFanTransactionItemSchema = fanTransactionItemSchema.extend({
  pageLabel: z.string(),
  platform: platformEnum,
});

export const crossPageFanTransactionListResponseSchema = z.object({
  items: z.array(crossPageFanTransactionItemSchema),
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});

export const upsertFanProfileBodySchema = z.object({
  body: z.string().min(1).max(50_000),
});

export const createFanNoteBodySchema = z.object({
  body: z.string().min(1).max(10000),
});

export const fanNoteResponseSchema = z.object({
  id: intId,
  fanId: z.number().int(),
  platformAccountId: z.number().int(),
  authorUserId: intId,
  body: z.string(),
  createdAt: isoTimestamp,
});

export const setFanFlagsBodySchema = z.object({
  flags: z.array(fanFlagEnum),
});

export const fanFlagsResponseSchema = z.object({
  flags: z.array(fanFlagSchema),
});

export const aiUsageEventInputSchema = z.object({
  clientEventId: z.string().min(1).max(255),
  feature: aiUsageFeatureEnum,
  model: z.string().min(1).max(100),
  inputTokens: z.number().int().nonnegative().max(100_000_000),
  outputTokens: z.number().int().nonnegative().max(100_000_000),
  cacheWriteTokens: z.number().int().nonnegative().max(100_000_000),
  cacheReadTokens: z.number().int().nonnegative().max(100_000_000),
  conversationId: z.string().min(1).max(255).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  isCacheHit: z.boolean(),
  isRegeneration: z.boolean(),
  completedAt: z.string().min(1),
});

export const aiUsageBatchBodySchema = z.object({
  events: z.array(aiUsageEventInputSchema).min(1).max(100),
});

export const aiUsageBatchResponseSchema = z.object({
  receivedCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  dedupedCount: z.number().int().nonnegative(),
});

export const adminChatterUsageQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
}).superRefine((value, ctx) => {
  const hasFrom = value.from !== undefined;
  const hasTo = value.to !== undefined;

  if (hasFrom !== hasTo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`from` and `to` must be provided together",
      path: [hasFrom ? "to" : "from"],
    });
  }

  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`from` must be on or before `to`",
      path: ["to"],
    });
  }
});

export const aiUsageTokenCountsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheTotal: z.number().int().nonnegative(),
});

export const aiUsageTopFeatureSchema = z.object({
  feature: aiUsageFeatureEnum,
  requestCount: z.number().int().nonnegative(),
  sharePct: z.number().nonnegative(),
});

export const aiUsageFeatureBreakdownSchema = z.object({
  feature: aiUsageFeatureEnum,
  requestCount: z.number().int().nonnegative(),
  sharePct: z.number().nonnegative(),
  tokenCounts: aiUsageTokenCountsSchema,
  regenerateRatePct: z.number().nonnegative(),
});

export const adminChatterUsageRowSchema = z.object({
  userId: intId,
  username: z.string(),
  totalGenerations: z.number().int().nonnegative(),
  tokenCounts: aiUsageTokenCountsSchema,
  topFeature: aiUsageTopFeatureSchema.nullable(),
  featureBreakdown: z.array(aiUsageFeatureBreakdownSchema),
  regenerateRatePct: z.number().nonnegative(),
  warning: z.boolean(),
});

export const adminChatterUsageResponseSchema = z.object({
  range: z.object({
    from: businessDate,
    to: businessDate,
    timeZone: z.string().min(1),
  }),
  rows: z.array(adminChatterUsageRowSchema),
});

// Admin schemas
export const adminCreateUserBodySchema = z.object({
  username: z.string().min(1).max(100),
  role: creatableUserRoleEnum,
  password: z.string().min(8).max(256).optional(),
});

export const adminSetPasswordBodySchema = z.object({
  password: z.string().min(8).max(256),
});

export const adminAssignPageBodySchema = z.object({
  pageLabel: z.string().min(1),
});

export const adminIssueApiKeyBodySchema = z.object({
  pageLabel: z.string().min(1).optional(),
});

export const apiKeyItemSchema = z.object({
  id: intId,
  keyPrefix: z.string(),
  userId: z.number().int(),
  isActive: z.boolean(),
  revokedAt: isoTimestamp.nullable(),
  revokedReason: z.string().nullable(),
  createdAt: isoTimestamp,
  lastUsedAt: isoTimestamp.nullable(),
});

export const issuedApiKeyResponseSchema = z.object({
  key: z.string(),
  keyPrefix: z.string(),
  assignedPages: z.array(pageRefSchema),
});

export const syncRunItemSchema = z.object({
  runId: z.number().int(),
  platformAccountId: z.number().int(),
  pageLabel: z.string(),
  platform: platformEnum,
  stream: z.string(),
  trigger: z.string(),
  status: z.string(),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.nullable(),
  errorSummary: z.string().nullable(),
  stats: z.record(z.string(), z.unknown()),
});

export const syncRunDetailResponseSchema = z.object({
  run: syncRunItemSchema,
  events: z.array(z.object({
    id: z.number().int(),
    runId: z.number().int(),
    platformAccountId: z.number().int(),
    pageLabel: z.string(),
    provider: platformEnum,
    stream: z.string(),
    eventType: z.string(),
    severity: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
    emittedAt: isoTimestamp,
  })),
  attempts: z.array(z.object({
    attemptId: z.number().int(),
    runId: z.number().int(),
    platformAccountId: z.number().int(),
    pageLabel: z.string(),
    provider: platformEnum,
    stream: z.string(),
    operation: z.string(),
    logicalRequestId: z.string(),
    attemptNumber: z.number().int(),
    state: z.string(),
    failureKind: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    retryDelayMs: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    requestShape: z.record(z.string(), z.unknown()),
    responseShape: z.record(z.string(), z.unknown()),
    errorMessage: z.string().nullable(),
    startedAt: isoTimestamp,
    finishedAt: isoTimestamp.nullable(),
  })),
});

const syncMonitorStatusEnum = z.enum([
  "idle",
  "pending",
  "running",
  "retrying",
  "blocked",
  "paused",
]);
const syncMonitorRateHealthEnum = z.enum(["healthy", "warning", "limited"]);

export const syncMonitorProgressSchema = z.object({
  label: z.string(),
  current: z.number().int(),
  total: z.number().int().nullable(),
  unit: z.string(),
  percent: z.number().nullable(),
});

export const syncMonitorRateHealthSchema = z.object({
  state: syncMonitorRateHealthEnum,
  last429At: isoTimestamp.nullable(),
  nextAvailableAt: isoTimestamp.nullable(),
});

export const syncMonitorRecentRunsSchema = z.object({
  running: z.number().int(),
  success: z.number().int(),
  partial: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

export const syncMonitorRecentErrorsSchema = z.object({
  total429s: z.number().int(),
  total5xxs: z.number().int(),
  failedRuns: z.number().int(),
  failedAttempts: z.number().int(),
  retryAttempts: z.number().int(),
  last429At: isoTimestamp.nullable(),
  last5xxAt: isoTimestamp.nullable(),
});

export const syncMonitorLastCompletionSchema = z.object({
  runId: z.number().int(),
  trigger: z.string(),
  status: z.enum(["success", "partial", "failed", "skipped"]),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  durationMs: z.number().int().nullable(),
  errorSummary: z.string().nullable(),
});

export const syncMonitorActiveRunSchema = z.object({
  runId: z.number().int(),
  trigger: z.string(),
  startedAt: isoTimestamp,
  lastActivityAt: isoTimestamp,
});

const extendedSyncStreamEnum = z.enum([
  "light",
  "fan_identities",
  "followers",
  "transactions",
  "top_spenders",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "followers_reconcile",
]);

export const syncMonitorStreamItemSchema = z.object({
  stream: extendedSyncStreamEnum,
  status: syncMonitorStatusEnum,
  stalled: z.boolean(),
  pending: z.boolean(),
  retryAt: isoTimestamp.nullable(),
  progress: syncMonitorProgressSchema.nullable(),
  recentRuns: syncMonitorRecentRunsSchema,
  recentErrors: syncMonitorRecentErrorsSchema,
  rateHealth: syncMonitorRateHealthSchema,
  activeRun: syncMonitorActiveRunSchema.nullable(),
  lastCompletion: syncMonitorLastCompletionSchema.nullable(),
  succeededAt: isoTimestamp.nullable(),
  failedAt: isoTimestamp.nullable(),
  lastErrorSummary: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  syncUx: syncUxSummarySchema,
});

export const syncMonitorPageCountsSchema = z.object({
  fans: z.number().int(),
  followers: z.number().int(),
  subscribers: z.number().int(),
  transactions: z.number().int(),
  conversations: z.number().int(),
  messages: z.number().int(),
});

export const syncMonitorPageSummarySchema = z.object({
  runningStreams: z.number().int(),
  blockedStreams: z.number().int(),
  stalledStreams: z.number().int(),
  pendingStreams: z.number().int(),
  retryingStreams: z.number().int(),
});

export const syncMonitorPageItemSchema = z.object({
  pageId: z.number().int(),
  pageLabel: z.string(),
  platform: platformEnum,
  modelSlug: z.string(),
  modelName: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  counts: syncMonitorPageCountsSchema,
  summary: syncMonitorPageSummarySchema,
  streams: z.array(syncMonitorStreamItemSchema),
  syncUx: syncUxSummarySchema,
});

export const syncMonitorProviderSummarySchema = z.object({
  platform: platformEnum,
  rateHealth: syncMonitorRateHealthSchema,
  recent429s: z.number().int(),
  recent5xxs: z.number().int(),
});

export const syncMonitorOverallSchema = z.object({
  pages: z.number().int(),
  streams: z.number().int(),
  runningStreams: z.number().int(),
  blockedStreams: z.number().int(),
  stalledStreams: z.number().int(),
  pendingStreams: z.number().int(),
  retryingStreams: z.number().int(),
  counts: syncMonitorPageCountsSchema,
  recentRuns: syncMonitorRecentRunsSchema,
  recentErrors: syncMonitorRecentErrorsSchema,
  providers: z.array(syncMonitorProviderSummarySchema),
  syncUx: syncUxSummarySchema,
});

export const syncMonitorRecentEventSchema = z.object({
  id: z.number().int(),
  runId: z.number().int(),
  pageId: z.number().int(),
  pageLabel: z.string(),
  platform: platformEnum,
  stream: extendedSyncStreamEnum,
  eventType: z.string(),
  severity: z.enum(["info", "warn", "error"]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
  emittedAt: isoTimestamp,
});

export const syncStatusQuerySchema = z.object({
  pageLabel: z.string().min(1).optional(),
  windowHours: z.coerce.number().int().min(1).max(24 * 14).default(24),
  eventLimit: z.coerce.number().int().min(1).max(200).default(50),
});

export const syncStatusResponseSchema = z.object({
  generatedAt: isoTimestamp,
  window: z.object({
    hours: z.number().int(),
    startedAt: isoTimestamp,
  }),
  overall: syncMonitorOverallSchema,
  pages: z.array(syncMonitorPageItemSchema),
  recentEvents: z.array(syncMonitorRecentEventSchema),
});

export const syncRequestsQuerySchema = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).default(100),
});

export const syncRequestItemSchema = z.object({
  timestamp: isoTimestamp,
  pageLabel: z.string(),
  platform: platformEnum,
  stream: extendedSyncStreamEnum,
  operation: z.string(),
  endpoint: z.string(),
  method: z.string(),
  attemptNumber: z.number().int(),
  status: z.enum(["started", "success", "retry", "failed"]),
  httpStatusCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  rateLimitWaitMs: z.number().int().nullable(),
  groupId: z.string().nullable(),
  partnerUsername: z.string().nullable(),
  returnedItems: z.number().int().nullable(),
  syncDone: z.boolean().nullable(),
  proxyGapMs: z.number().int().nullable(),
});

export const syncRequestsResponseSchema = z.array(syncRequestItemSchema);

const syncBlockKeyEnum = z.enum([
  "connection",
  "financials",
  "audience",
  "messages_live",
  "messages_history",
]);

const syncBlockStateEnum = z.enum([
  "not_started",
  "scheduled",
  "backfilling",
  "up_to_date",
  "syncing",
  "retrying",
  "delayed",
  "failed",
  "paused",
  "not_available",
]);

const simpleConnectionStatusEnum = z.enum(["connected", "not_connected", "error"]);

export const syncBlockProgressSchema = z.object({
  label: z.string(),
  current: z.number().int(),
  total: z.number().int().nullable(),
  unit: z.string(),
  percent: z.number().nullable(),
  details: z.record(z.string(), z.unknown()),
});

export const syncBlockErrorSchema = z.object({
  stream: z.string().nullable(),
  code: z.string().nullable(),
  summary: z.string().nullable(),
  failedAt: isoTimestamp.nullable(),
  consecutiveFailures: z.number().int(),
});

export const syncStatusReasonSchema = z.object({
  code: z.string().nullable(),
  summary: z.string().nullable(),
  waitingFor: z.array(z.string()).nullable(),
});

const syncStreamRoleEnum = z.enum(["primary", "supporting"]);

export const syncBlockIntervalSchema = z.object({
  stream: extendedSyncStreamEnum,
  cadenceSeconds: z.number().int(),
});

export const syncBlockSubstreamSchema = z.object({
  stream: extendedSyncStreamEnum,
  role: syncStreamRoleEnum,
  state: syncBlockStateEnum.exclude(["not_available"]),
  succeededAt: isoTimestamp.nullable(),
  nextDueAt: isoTimestamp.nullable(),
  nextRetryAt: isoTimestamp.nullable(),
  cadenceSeconds: z.number().int(),
  isFresh: z.boolean(),
  needsAttention: z.boolean(),
  statusReason: syncStatusReasonSchema.nullable(),
  error: syncBlockErrorSchema.nullable(),
});

export const syncBlockStatusSchema = z.object({
  block: syncBlockKeyEnum,
  state: syncBlockStateEnum,
  succeededAt: isoTimestamp.nullable(),
  progress: syncBlockProgressSchema.nullable(),
  progressStream: z.string().nullable(),
  progressRole: syncStreamRoleEnum.nullable(),
  error: syncBlockErrorSchema.nullable(),
  statusReason: syncStatusReasonSchema.nullable(),
  primaryFresh: z.boolean(),
  needsAttention: z.boolean(),
  nextDueAt: isoTimestamp.nullable(),
  nextRetryAt: isoTimestamp.nullable(),
  intervals: z.array(syncBlockIntervalSchema),
  metrics: z.record(z.string(), z.unknown()),
  connectionStatus: simpleConnectionStatusEnum.nullable(),
  substreams: z.array(syncBlockSubstreamSchema),
});

const syncDiagnosisCodeEnum = z.enum([
  "worker_offline",
  "stalled_run",
  "auth_blocked",
]);

const syncDiagnosisSeverityEnum = z.enum(["warning", "error"]);

const syncDiagnosisActionKindEnum = z.enum([
  "worker",
  "credentials",
  "sync_settings",
]);

export const syncDiagnosisSchema = z.object({
  code: syncDiagnosisCodeEnum,
  severity: syncDiagnosisSeverityEnum,
  headline: z.string(),
  detail: z.string(),
  actionKind: syncDiagnosisActionKindEnum.nullable(),
});

export const syncBlocksPageSchema = z.object({
  pageId: z.number().int(),
  pageLabel: z.string(),
  platform: platformEnum,
  modelSlug: z.string(),
  modelName: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  diagnosis: syncDiagnosisSchema.nullable(),
  blocks: z.object({
    connection: syncBlockStatusSchema,
    financials: syncBlockStatusSchema,
    audience: syncBlockStatusSchema,
    messages_live: syncBlockStatusSchema,
    messages_history: syncBlockStatusSchema,
  }),
});

export const syncOverviewResponseSchema = z.object({
  generatedAt: isoTimestamp,
  diagnosis: syncDiagnosisSchema.nullable(),
  pages: z.array(syncBlocksPageSchema),
});

export const pageSyncBlocksParamsSchema = pageParamsSchema;

export const pageSyncBlocksResponseSchema = z.object({
  generatedAt: isoTimestamp,
  page: syncBlocksPageSchema,
});

export const pageMessagesBlockResponseSchema = z.object({
  generatedAt: isoTimestamp,
  page: z.object({
    pageId: z.number().int(),
    pageLabel: z.string(),
    platform: platformEnum,
    modelSlug: z.string(),
    modelName: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    diagnosis: syncDiagnosisSchema.nullable(),
  }),
  block: syncBlockStatusSchema,
});

export const adminSyncBlockBodySchema = z.object({
  pageLabel: z.string().min(1),
  block: syncBlockKeyEnum,
});

export const adminSyncBlockRequestSchema = z.object({
  stream: extendedSyncStreamEnum,
  requestedSeq: z.number().int(),
});

export const adminSyncBlockResponseSchema = z.object({
  accepted: z.literal(true),
  action: z.enum(["trigger", "pause", "resume", "reset"]),
  pageLabel: z.string(),
  block: syncBlockKeyEnum,
  requests: z.array(adminSyncBlockRequestSchema).optional(),
});

export const syncTriggerBodySchema = z.object({
  pageLabel: z.string().min(1),
  scope: syncTriggerScopeEnum,
});

export const syncTriggerResponseSchema = z.object({
  accepted: z.literal(true),
  pageLabel: z.string(),
  scope: syncTriggerScopeEnum,
});

export const syncTriggerAllResponseSchema = z.object({
  accepted: z.literal(true),
  pagesQueued: z.number().int(),
});

export const syncRunsQuerySchema = z.object({
  pageLabel: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  since: z.string().optional(),
});

export const adminLogsQuerySchema = z.object({
  severity: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const adminLogItemSchema = z.object({
  id: intId,
  syncRunId: intId,
  provider: platformEnum,
  stream: z.string(),
  eventType: z.string(),
  severity: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
  emittedAt: isoTimestamp,
  pageLabel: z.string(),
});

export const adminQueueJobsQuerySchema = z.object({
  state: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const adminQueueJobItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  data: z.unknown().nullable(),
  createdOn: isoTimestamp,
  startedOn: isoTimestamp.nullable(),
  completedOn: isoTimestamp.nullable(),
  output: z.unknown().nullable(),
  retryLimit: z.number().int(),
  retryCount: z.number().int(),
});

export const adminDbTableStatSchema = z.object({
  schema: z.string(),
  table: z.string(),
  rowEstimate: z.number().int(),
  totalBytes: z.number().int(),
  indexBytes: z.number().int(),
});

export const adminDbMigrationSchema = z.object({
  name: z.string(),
  appliedAt: isoTimestamp,
});

export const adminDbStatsResponseSchema = z.object({
  tables: z.array(adminDbTableStatSchema),
  migrations: z.array(adminDbMigrationSchema),
});

export const adminIncidentsQuerySchema = z.object({
  severity: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const adminIncidentItemSchema = adminLogItemSchema;

export const adminIncidentSummaryItemSchema = z.object({
  code: z.string().nullable(),
  severity: z.string(),
  count: z.number().int(),
});

export const adminIncidentsResponseSchema = z.object({
  summary: z.array(adminIncidentSummaryItemSchema),
  items: z.array(adminIncidentItemSchema),
});

// --- Notifications dashboard schemas ---
const notificationConnectionStatusEnum = z.enum(["not_configured", "connected", "last_message_failed"]);
const notificationIncidentKindEnum = z.enum(["auth_blocked", "proxy_failed", "stream_failed_threshold"]);
const notificationIncidentStatusEnum = z.enum(["open", "resolved"]);
const deliveryKindEnum = z.enum([
  "test",
  "daily_report_scheduled",
  "daily_report_manual",
  "incident_opened",
  "incident_resolved",
  "incident_manually_resolved",
]);

export const notificationsSettingsResponseSchema = z.object({
  configured: z.boolean(),
  botTokenSet: z.boolean(),
  chatId: z.string().nullable(),
  enabled: z.boolean(),
  dailyReportEnabled: z.boolean(),
  syncFailureAlertsEnabled: z.boolean(),
  reportHourUtc: z.number().int().min(0).max(23),
  connectionStatus: notificationConnectionStatusEnum,
  lastMessageAt: isoTimestamp.nullable(),
  lastMessageError: z.string().nullable(),
});

export const notificationsSettingsUpdateBodySchema = z.object({
  enabled: z.boolean().optional(),
  dailyReportEnabled: z.boolean().optional(),
  syncFailureAlertsEnabled: z.boolean().optional(),
  reportHourUtc: z.number().int().min(0).max(23).optional(),
  botToken: z.string().min(1).nullable().optional(),
  chatId: z.string().min(1).nullable().optional(),
});

export const notificationsTestMessageResponseSchema = z.object({
  status: z.string(),
  error: z.string().nullable(),
});

export const notificationsIncidentItemSchema = z.object({
  id: intId,
  incidentKey: z.string(),
  kind: notificationIncidentKindEnum,
  pageLabel: z.string(),
  platform: platformEnum,
  stream: z.string().nullable(),
  status: notificationIncidentStatusEnum,
  openedAt: isoTimestamp,
  lastSeenAt: isoTimestamp,
  resolvedAt: isoTimestamp.nullable(),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  notificationCount: z.number().int(),
});

export const notificationsIncidentsQuerySchema = z.object({
  status: notificationIncidentStatusEnum.optional(),
  kind: notificationIncidentKindEnum.optional(),
  pageLabel: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const notificationsIncidentsResponseSchema = z.object({
  items: z.array(notificationsIncidentItemSchema),
  total: z.number().int(),
});

export const notificationsResolveIncidentResponseSchema = z.object({
  ok: z.literal(true),
});

export const notificationsReportPreviewResponseSchema = z.object({
  text: z.string(),
  reportDate: z.string(),
});

export const notificationsReportSendResponseSchema = z.object({
  status: z.string(),
  error: z.string().nullable(),
  reportDate: z.string().nullable(),
});

export const notificationsDeliveryAttemptItemSchema = z.object({
  id: intId,
  kind: deliveryKindEnum,
  status: z.string(),
  reportDate: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: isoTimestamp,
});

export const notificationsReportHistoryResponseSchema = z.object({
  items: z.array(notificationsDeliveryAttemptItemSchema),
});

const fanslyCredentialsSchema = z.object({
  platform: z.literal("fansly"),
  session: z.object({
    authorization: z.string().min(1),
    fanslyClientId: z.string().optional(),
    fanslyClientCheck: z.string().optional(),
    fanslySessionId: z.string().optional(),
  }),
  proxy: z.object({
    url: z.string().min(1),
    username: z.string().nullable().optional(),
    password: z.string().nullable().optional(),
  }).nullable().optional(),
});

const onlyfansCredentialsSchema = z.object({
  platform: z.literal("onlyfans"),
  auth: z.object({
    token: z.string().min(1),
  }),
  username: z.string().min(1),
  proxy: z.object({
    url: z.string().min(1),
    username: z.string().nullable().optional(),
    password: z.string().nullable().optional(),
  }).nullable().optional(),
});

const credentialProxySchema = z.object({
  url: z.string().min(1),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
}).nullable().optional();

export const verifyCredentialsBodySchema = z.discriminatedUnion("platform", [
  fanslyCredentialsSchema,
  onlyfansCredentialsSchema,
]);

export const verifyCredentialsResponseSchema = z.object({
  valid: z.literal(true),
  platform: platformEnum,
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});

export const createPageBodySchema = z.discriminatedUnion("platform", [
  fanslyCredentialsSchema.extend({
    modelSlug: z.string().min(1),
    label: z.string().min(1),
  }),
  onlyfansCredentialsSchema.extend({
    modelSlug: z.string().min(1),
    label: z.string().min(1),
  }),
]);

export const testProxyBodySchema = z.object({
  proxy: z.object({
    url: z.string().min(1),
    username: z.string().nullable().optional(),
    password: z.string().nullable().optional(),
  }),
});

export const testProxyResponseSchema = z.object({
  ip: z.string(),
});

export const createModelBodySchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
});

export const updateModelBodySchema = z.object({
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  sortOrder: z.number().int().min(0).optional(),
}).refine(
  (value) =>
    value.slug !== undefined || value.name !== undefined || value.sortOrder !== undefined,
  {
    message: "At least one field is required",
  },
);

export const createModelResponseSchema = z.object({
  id: intId,
  slug: z.string(),
  name: z.string(),
});

export const updatePageBodySchema = z.object({
  label: z.string().min(1).optional(),
  modelSlug: z.string().min(1).optional(),
}).refine((value) => value.label !== undefined || value.modelSlug !== undefined, {
  message: "At least one field is required",
});

export const updateCredentialsBodySchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("fansly"),
    session: fanslyCredentialsSchema.shape.session.optional(),
    proxy: credentialProxySchema,
  }),
  z.object({
    platform: z.literal("onlyfans"),
    auth: onlyfansCredentialsSchema.shape.auth.optional(),
    username: z.string().min(1).optional(),
    proxy: credentialProxySchema,
  }),
]);

export const verifyPageResponseSchema = z.object({
  verified: z.boolean(),
  username: z.string().nullable(),
  platform: platformEnum,
});

export const adminCreatePageResponseSchema = z.object({
  page: assignedPageSchema,
  verified: z.boolean(),
  syncQueued: z.boolean(),
  syncWarning: z.object({
    code: z.literal("initial_sync_enqueue_failed"),
    message: z.string(),
  }).nullable(),
  syncRetry: z.object({
    method: z.literal("POST"),
    path: z.literal("/api/v1/admin/sync/trigger"),
    body: syncTriggerBodySchema,
  }).nullable(),
});

export const adminUpdatePageResponseSchema = z.object({
  page: assignedPageSchema,
});

export const updateCredentialsResponseSchema = z.object({
  updated: z.boolean(),
  verified: z.boolean(),
});

export const deletedResponseSchema = z.object({
  deleted: z.literal(true),
});

const cookieOnlySecurity: Array<Record<string, string[]>> = [{ cookieAuth: [] }];
const bearerOnlySecurity: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const cookieOrBearerSecurity: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];
const dashboardOrMonitoringTokenSecurity: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { monitoringTokenAuth: [] },
];

export const routeSchemas = {
  health: {
    tags: ["system"],
    summary: "Health check",
    response: {
      200: healthResponseSchema,
      503: healthResponseSchema,
    },
  },
  healthSync: {
    tags: ["system"],
    summary: "Detailed sync health",
    security: dashboardOrMonitoringTokenSecurity,
    response: {
      200: syncHealthResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: syncHealthResponseSchema,
    },
  },
  login: {
    tags: ["auth"],
    summary: "Log in with a dashboard account",
    body: loginBodySchema,
    response: {
      200: authStateSchema,
      401: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  logout: {
    tags: ["auth"],
    summary: "Clear the current session cookie if one is present",
    response: {
      200: z.object({ ok: z.literal(true) }),
    },
  },
  me: {
    tags: ["auth"],
    summary: "Get the current authenticated principal",
    security: cookieOrBearerSecurity,
    response: {
      200: authStateSchema,
      401: errorResponseSchema,
    },
  },
  aiUsageBatch: {
    tags: ["usage"],
    summary: "Ingest a batch of chatter AI usage events",
    security: bearerOnlySecurity,
    body: aiUsageBatchBodySchema,
    response: {
      200: aiUsageBatchResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  pages: {
    tags: ["pages"],
    summary: "List visible pages",
    security: cookieOrBearerSecurity,
    response: {
      200: z.array(assignedPageSchema),
      401: errorResponseSchema,
    },
  },
  models: {
    tags: ["models"],
    summary: "List visible models",
    security: cookieOnlySecurity,
    response: {
      200: z.array(modelListItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  overviewRevenue: {
    tags: ["revenue"],
    summary: "Get agency or visible-scope revenue overview",
    security: cookieOnlySecurity,
    querystring: revenueQuerySchema,
    response: {
      200: overviewRevenueResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  overviewGrowth: {
    tags: ["dashboard"],
    summary: "Get period-aware follower and subscriber growth",
    security: cookieOnlySecurity,
    querystring: revenueQuerySchema,
    response: {
      200: overviewGrowthResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  modelRevenue: {
    tags: ["revenue"],
    summary: "Get revenue for one model",
    security: cookieOnlySecurity,
    params: modelParamsSchema,
    querystring: revenueQuerySchema,
    response: {
      200: modelRevenueResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageRevenue: {
    tags: ["revenue"],
    summary: "Get revenue for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: revenueQuerySchema,
    response: {
      200: pageRevenueResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageTransactions: {
    tags: ["transactions"],
    summary: "List transactions for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: transactionListQuerySchema,
    response: {
      200: transactionListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageSubscribers: {
    tags: ["subscribers"],
    summary: "List current subscribers for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: subscriberListQuerySchema,
    response: {
      200: subscriberListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageSubscribersDaily: {
    tags: ["subscribers"],
    summary: "List daily subscriber rollups for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: revenueQuerySchema,
    response: {
      200: subscriberDailyResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFollowers: {
    tags: ["followers"],
    summary: "List active followers for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: followerListQuerySchema,
    response: {
      200: followerListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFollowersDaily: {
    tags: ["followers"],
    summary: "List daily follower rollups for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: revenueQuerySchema,
    response: {
      200: followerDailyResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFans: {
    tags: ["fans"],
    summary: "List fans for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: fanListQuerySchema,
    response: {
      200: fanListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageDeletedFans: {
    tags: ["fans"],
    summary: "List deleted fans for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: paginationQuerySchema,
    response: {
      200: pageDeletedFansResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageSpenderAutoLists: {
    tags: ["spenders"],
    summary: "List spender auto-list buckets for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: pageSpenderAutoListsQuerySchema,
    response: {
      200: pageSpenderAutoListsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageSpenderAutoListDetail: {
    tags: ["spenders"],
    summary: "List fans inside one spender auto-list bucket",
    security: cookieOrBearerSecurity,
    params: pageSpenderAutoListParamsSchema,
    querystring: pageSpenderAutoListQuerySchema,
    response: {
      200: pageSpenderAutoListDetailResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFanDetail: {
    tags: ["fans"],
    summary: "Get one fan within one page",
    security: cookieOrBearerSecurity,
    params: pageFanParamsSchema,
    response: {
      200: pageFanDetailResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFanProfile: {
    tags: ["fans"],
    summary: "Get the latest intelligence profile for one fan on one page",
    security: cookieOrBearerSecurity,
    params: pageFanParamsSchema,
    response: {
      200: fanProfileResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageConversationProfile: {
    tags: ["fans"],
    summary: "Get the latest intelligence profile for the fan mapped to one page conversation",
    security: cookieOrBearerSecurity,
    params: pageConversationProfileParamsSchema,
    response: {
      200: fanProfileResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  upsertFanProfile: {
    tags: ["fans"],
    summary: "Append a new intelligence profile version for one fan on one page",
    security: bearerOnlySecurity,
    params: pageFanParamsSchema,
    body: upsertFanProfileBodySchema,
    response: {
      200: fanProfileDocumentSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFanProfileVersions: {
    tags: ["fans"],
    summary: "List intelligence profile versions for one fan on one page",
    security: cookieOnlySecurity,
    params: pageFanParamsSchema,
    response: {
      200: fanProfileVersionListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageFanProfileVersion: {
    tags: ["fans"],
    summary: "Get one intelligence profile version for one fan on one page",
    security: cookieOnlySecurity,
    params: fanProfileVersionParamsSchema,
    response: {
      200: fanProfileDocumentSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  crossPageFanDetail: {
    tags: ["fans"],
    summary: "Get one fan across visible pages",
    security: cookieOnlySecurity,
    params: fanLookupParamsSchema,
    response: {
      200: crossPageFanDetailResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  spenders: {
    tags: ["spenders"],
    summary: "List ranked spenders for a scoped platform view",
    security: cookieOrBearerSecurity,
    querystring: spenderListQuerySchema,
    response: {
      200: spenderListResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  spenderDetail: {
    tags: ["spenders"],
    summary: "Get one platform-scoped spender",
    security: cookieOrBearerSecurity,
    params: fanLookupParamsSchema,
    querystring: spenderDetailQuerySchema,
    response: {
      200: spenderDetailResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  spenderSeries: {
    tags: ["spenders"],
    summary: "Get zero-filled spender trend series",
    security: cookieOnlySecurity,
    params: fanLookupParamsSchema,
    querystring: spenderSeriesQuerySchema,
    response: {
      200: spenderSeriesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  spenderBatch: {
    tags: ["spenders"],
    summary: "Batch-resolve spender metrics for platform-scoped fan identities",
    security: cookieOrBearerSecurity,
    body: spenderBatchBodySchema,
    response: {
      200: spenderBatchResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  fansSearch: {
    tags: ["fans"],
    summary: "Search visible platform-scoped fan identities",
    security: cookieOrBearerSecurity,
    querystring: fansSearchQuerySchema,
    response: {
      200: fansSearchResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageConversationPreview: {
    tags: ["conversations"],
    summary: "Return locally cached DM preview rows for one conversation",
    security: cookieOnlySecurity,
    params: pageConversationPreviewParamsSchema,
    querystring: pageConversationPreviewQuerySchema,
    response: {
      200: pageConversationPreviewResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageConversationMessages: {
    tags: ["conversations"],
    summary: "Return cached DM messages for one conversation",
    security: cookieOnlySecurity,
    params: pageConversationMessagesParamsSchema,
    querystring: pageConversationMessagesQuerySchema,
    response: {
      200: pageConversationMessagesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  // --- Workboard ---
  workboard: {
    tags: ["workboard"],
    summary: "Get workboard queue for one Fansly page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    response: {
      200: workboardResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardPresence: {
    tags: ["workboard"],
    summary: "Get inferred Fansly presence for one workboard page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    response: {
      200: workboardPresenceResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardSnooze: {
    tags: ["workboard"],
    summary: "Snooze a fan on the workboard",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: workboardSnoozeBodySchema,
    response: {
      200: workboardSnoozeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardUnsnooze: {
    tags: ["workboard"],
    summary: "Unsnooze a fan on the workboard",
    security: cookieOnlySecurity,
    params: workboardUnsnoozeParamsSchema,
    response: {
      200: z.object({ ok: z.literal(true) }),
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2: {
    tags: ["workboard"],
    summary: "Get a Workboard v2 tab queue (priority engine) for one Fansly page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    querystring: workboardV2QuerySchema,
    response: {
      200: workboardV2ResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2Contact: {
    tags: ["workboard"],
    summary: "Record a chatter touch (Готово) on a Workboard v2 fan",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: workboardV2ContactBodySchema,
    response: {
      200: workboardV2ContactResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2Recompute: {
    tags: ["workboard"],
    summary: "Recompute the Workboard v2 queue for one Fansly page (on-demand)",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    response: {
      200: workboardV2RecomputeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2Snooze: {
    tags: ["workboard"],
    summary: "Snooze a fan on Workboard v2 (moves to Service; re-evaluates instantly)",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: workboardV2SnoozeBodySchema,
    response: {
      200: workboardV2SnoozeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2Unsnooze: {
    tags: ["workboard"],
    summary: "Unsnooze a fan on Workboard v2 (re-evaluates instantly)",
    security: cookieOnlySecurity,
    params: workboardV2FanParamsSchema,
    response: {
      200: workboardV2OkResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2UndoContact: {
    tags: ["workboard"],
    summary: "Undo the last Готово touch for a fan (re-evaluates instantly)",
    security: cookieOnlySecurity,
    params: workboardV2FanParamsSchema,
    response: {
      200: workboardV2OkResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2Ai: {
    tags: ["workboard"],
    summary: "AI (L2 closing classifier) analytics + settings for a page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    response: {
      200: workboardV2AiReportSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2AiSettings: {
    tags: ["workboard"],
    summary: "Update per-page AI classifier settings (owner only)",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: workboardV2AiSettingsBodySchema,
    response: {
      200: workboardV2AiReportSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2AiClassify: {
    tags: ["workboard"],
    summary: "Run (or re-run) the AI classifier for a page now (owner only)",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: workboardV2AiClassifyBodySchema,
    response: {
      200: workboardV2AiClassifyResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  workboardV2AiRuns: {
    tags: ["workboard"],
    summary: "Global AI classifier run log (owner only)",
    security: cookieOnlySecurity,
    response: {
      200: workboardV2AiRunsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  // --- Phase 4: Dashboard routes ---
  overview: {
    tags: ["dashboard"],
    summary: "Get agency overview dashboard data",
    security: cookieOnlySecurity,
    response: {
      200: overviewResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  syncStatus: {
    tags: ["dashboard"],
    summary: "Get aggregated sync monitor data for visible pages",
    security: cookieOnlySecurity,
    querystring: syncStatusQuerySchema,
    response: {
      200: syncStatusResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  syncRequests: {
    tags: ["dashboard"],
    summary: "Get recent visible sync worker HTTP requests",
    security: cookieOnlySecurity,
    querystring: syncRequestsQuerySchema,
    response: {
      200: syncRequestsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  syncOverview: {
    tags: ["dashboard"],
    summary: "Get the 6-block sync overview for visible pages",
    security: cookieOnlySecurity,
    response: {
      200: syncOverviewResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  pageSyncBlocks: {
    tags: ["dashboard"],
    summary: "Get all sync blocks for one visible page",
    security: cookieOrBearerSecurity,
    params: pageSyncBlocksParamsSchema,
    response: {
      200: pageSyncBlocksResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  pageMessagesBlock: {
    tags: ["dashboard"],
    summary: "Get the combined Messages sync block for one visible page",
    security: cookieOrBearerSecurity,
    params: pageSyncBlocksParamsSchema,
    response: {
      200: pageMessagesBlockResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  overviewRevenueDaily: {
    tags: ["dashboard"],
    summary: "Get agency-wide revenue daily series",
    security: cookieOnlySecurity,
    querystring: revenueDailyQuerySchema,
    response: {
      200: revenueDailyResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  pageRevenueDaily: {
    tags: ["dashboard"],
    summary: "Get daily revenue series for one page",
    security: cookieOrBearerSecurity,
    params: pageParamsSchema,
    querystring: revenueDailyQuerySchema,
    response: {
      200: revenueDailyResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  modelRevenueDaily: {
    tags: ["dashboard"],
    summary: "Get daily revenue series for one model",
    security: cookieOnlySecurity,
    params: modelParamsSchema,
    querystring: revenueDailyQuerySchema,
    response: {
      200: revenueDailyResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  crossPageTransactions: {
    tags: ["transactions"],
    summary: "List transactions across all visible pages",
    security: cookieOnlySecurity,
    querystring: crossPageTransactionListQuerySchema,
    response: {
      200: crossPageTransactionListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  pageFanTransactions: {
    tags: ["fans"],
    summary: "Get fan transaction history on a specific page",
    security: cookieOrBearerSecurity,
    params: pageFanParamsSchema,
    querystring: paginationQuerySchema,
    response: {
      200: fanTransactionListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  crossPageFanTransactions: {
    tags: ["fans"],
    summary: "Get cross-page fan transaction history",
    security: cookieOnlySecurity,
    params: fanLookupParamsSchema,
    querystring: paginationQuerySchema,
    response: {
      200: crossPageFanTransactionListResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  createFanNote: {
    tags: ["fans"],
    summary: "Create a note on a fan for a specific page",
    security: cookieOrBearerSecurity,
    params: pageFanParamsSchema,
    body: createFanNoteBodySchema,
    response: {
      200: fanNoteResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  setFanFlags: {
    tags: ["fans"],
    summary: "Set flags on a fan",
    security: cookieOnlySecurity,
    params: fanLookupParamsSchema,
    body: setFanFlagsBodySchema,
    response: {
      200: fanFlagsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  openApiJson: {
    tags: ["system"],
    summary: "Get the OpenAPI specification",
    security: cookieOnlySecurity,
    response: {
      200: z.any(),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  // Admin routes
  adminListUsers: {
    tags: ["admin"],
    summary: "List all users",
    security: cookieOnlySecurity,
    response: {
      200: z.array(adminUserSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminChatterUsage: {
    tags: ["admin"],
    summary: "Get aggregated AI usage per chatter",
    security: cookieOnlySecurity,
    querystring: adminChatterUsageQuerySchema,
    response: {
      200: adminChatterUsageResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminCreateUser: {
    tags: ["admin"],
    summary: "Create a new user",
    security: cookieOnlySecurity,
    body: adminCreateUserBodySchema,
    response: {
      200: authUserSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminSetPassword: {
    tags: ["admin"],
    summary: "Set a user password",
    security: cookieOnlySecurity,
    params: z.object({ username: z.string().min(1) }),
    body: adminSetPasswordBodySchema,
    response: {
      200: z.object({ ok: z.literal(true) }),
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminAssignPage: {
    tags: ["admin"],
    summary: "Assign a page to a user",
    security: cookieOnlySecurity,
    params: z.object({ username: z.string().min(1) }),
    body: adminAssignPageBodySchema,
    response: {
      200: authUserSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminUnassignPage: {
    tags: ["admin"],
    summary: "Unassign a page from a user",
    security: cookieOnlySecurity,
    params: z.object({ username: z.string().min(1), pageLabel: z.string().min(1) }),
    response: {
      200: z.object({ ok: z.literal(true) }),
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminListApiKeys: {
    tags: ["admin"],
    summary: "List API keys for a user",
    security: cookieOnlySecurity,
    params: z.object({ username: z.string().min(1) }),
    response: {
      200: z.array(apiKeyItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminIssueApiKey: {
    tags: ["admin"],
    summary: "Issue an API key for a user",
    security: cookieOnlySecurity,
    params: z.object({ username: z.string().min(1) }),
    body: adminIssueApiKeyBodySchema,
    response: {
      200: issuedApiKeyResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminRevokeApiKeys: {
    tags: ["admin"],
    summary: "Revoke all API keys for a user",
    security: cookieOnlySecurity,
    params: z.object({ username: z.string().min(1) }),
    response: {
      200: z.object({ revokedCount: z.number().int() }),
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminSyncRuns: {
    tags: ["admin"],
    summary: "List recent sync runs",
    security: cookieOnlySecurity,
    querystring: syncRunsQuerySchema,
    response: {
      200: z.array(syncRunItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminSyncRunDetail: {
    tags: ["admin"],
    summary: "Get sync run detail",
    security: cookieOnlySecurity,
    params: z.object({ runId: z.coerce.number().int().positive() }),
    response: {
      200: syncRunDetailResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminSyncTrigger: {
    tags: ["admin"],
    summary: "Trigger sync for a page",
    security: cookieOnlySecurity,
    body: syncTriggerBodySchema,
    response: {
      202: syncTriggerResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminSyncBlockTrigger: {
    tags: ["admin"],
    summary: "Trigger sync for a specific page block",
    security: cookieOnlySecurity,
    body: adminSyncBlockBodySchema,
    response: {
      200: adminSyncBlockResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  adminSyncBlockPause: {
    tags: ["admin"],
    summary: "Pause sync for a specific page block",
    security: cookieOnlySecurity,
    body: adminSyncBlockBodySchema,
    response: {
      200: adminSyncBlockResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminSyncBlockResume: {
    tags: ["admin"],
    summary: "Resume sync for a specific page block",
    security: cookieOnlySecurity,
    body: adminSyncBlockBodySchema,
    response: {
      200: adminSyncBlockResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminSyncBlockReset: {
    tags: ["admin"],
    summary: "Reset sync state for a specific page block",
    security: cookieOnlySecurity,
    body: adminSyncBlockBodySchema,
    response: {
      200: adminSyncBlockResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  adminSyncTriggerAll: {
    tags: ["admin"],
    summary: "Trigger sync for all pages",
    security: cookieOnlySecurity,
    response: {
      202: syncTriggerAllResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminConnections: {
    tags: ["admin"],
    summary: "List connection statuses",
    security: cookieOnlySecurity,
    response: {
      200: z.array(connectionItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminModels: {
    tags: ["admin"],
    summary: "List all models for admin management",
    security: cookieOnlySecurity,
    response: {
      200: z.array(adminModelListItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminCreateModel: {
    tags: ["admin"],
    summary: "Create a model",
    security: cookieOnlySecurity,
    body: createModelBodySchema,
    response: {
      200: createModelResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  adminUpdateModel: {
    tags: ["admin"],
    summary: "Update a model",
    security: cookieOnlySecurity,
    params: modelParamsSchema,
    body: updateModelBodySchema,
    response: {
      200: createModelResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  adminDeleteModel: {
    tags: ["admin"],
    summary: "Delete an empty model",
    security: cookieOnlySecurity,
    params: modelParamsSchema,
    response: {
      200: deletedResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  adminPages: {
    tags: ["admin"],
    summary: "List all pages for admin management",
    security: cookieOnlySecurity,
    response: {
      200: z.array(assignedPageSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminCreatePage: {
    tags: ["admin"],
    summary: "Onboard a new page",
    security: cookieOnlySecurity,
    body: createPageBodySchema,
    response: {
      200: adminCreatePageResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  adminUpdatePage: {
    tags: ["admin"],
    summary: "Update a page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: updatePageBodySchema,
    response: {
      200: adminUpdatePageResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  adminDeletePage: {
    tags: ["admin"],
    summary: "Delete a page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    response: {
      200: deletedResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminVerifyCredentials: {
    tags: ["admin"],
    summary: "Verify credentials without persisting",
    security: cookieOnlySecurity,
    body: verifyCredentialsBodySchema,
    response: {
      200: verifyCredentialsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminTestProxy: {
    tags: ["admin"],
    summary: "Test a proxy connection and return the exit IP",
    security: cookieOnlySecurity,
    body: testProxyBodySchema,
    response: {
      200: testProxyResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminVerifyPage: {
    tags: ["admin"],
    summary: "Verify stored credentials for a page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    response: {
      200: verifyPageResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminUpdateCredentials: {
    tags: ["admin"],
    summary: "Update credentials for an existing page",
    security: cookieOnlySecurity,
    params: pageParamsSchema,
    body: updateCredentialsBodySchema,
    response: {
      200: updateCredentialsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminLogs: {
    tags: ["admin"],
    summary: "List recent sync event logs",
    security: cookieOnlySecurity,
    querystring: adminLogsQuerySchema,
    response: {
      200: z.array(adminLogItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminQueueJobs: {
    tags: ["admin"],
    summary: "List pg-boss jobs",
    security: cookieOnlySecurity,
    querystring: adminQueueJobsQuerySchema,
    response: {
      200: z.array(adminQueueJobItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminDbStats: {
    tags: ["admin"],
    summary: "List database table sizes and migrations",
    security: cookieOnlySecurity,
    response: {
      200: adminDbStatsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  adminIncidents: {
    tags: ["admin"],
    summary: "List sync incidents and seven-day summary counts",
    security: cookieOnlySecurity,
    querystring: adminIncidentsQuerySchema,
    response: {
      200: adminIncidentsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  // --- Notifications dashboard ---
  notificationsSettings: {
    tags: ["notifications"],
    summary: "Get notification settings and connection status",
    security: cookieOnlySecurity,
    response: {
      200: notificationsSettingsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  notificationsSettingsUpdate: {
    tags: ["notifications"],
    summary: "Update notification settings",
    security: cookieOnlySecurity,
    body: notificationsSettingsUpdateBodySchema,
    response: {
      200: notificationsSettingsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  notificationsTestMessage: {
    tags: ["notifications"],
    summary: "Send a test Telegram message",
    security: cookieOnlySecurity,
    response: {
      200: notificationsTestMessageResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  notificationsIncidents: {
    tags: ["notifications"],
    summary: "List notification incidents with page context",
    security: cookieOnlySecurity,
    querystring: notificationsIncidentsQuerySchema,
    response: {
      200: notificationsIncidentsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  notificationsResolveIncident: {
    tags: ["notifications"],
    summary: "Manually resolve an incident",
    security: cookieOnlySecurity,
    params: z.object({ incidentId: z.coerce.number().int().positive() }),
    response: {
      200: notificationsResolveIncidentResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  notificationsReportPreview: {
    tags: ["notifications"],
    summary: "Preview the next daily report without sending",
    security: cookieOnlySecurity,
    response: {
      200: notificationsReportPreviewResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  notificationsReportSend: {
    tags: ["notifications"],
    summary: "Manually send a daily report",
    security: cookieOnlySecurity,
    response: {
      200: notificationsReportSendResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  notificationsReportHistory: {
    tags: ["notifications"],
    summary: "List daily report delivery history",
    security: cookieOnlySecurity,
    response: {
      200: notificationsReportHistoryResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
} as const;

export type RouteSchemas = typeof routeSchemas;
export type AuthState = z.infer<typeof authStateSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AssignedPage = z.infer<typeof assignedPageSchema>;
export type SyncUxSummary = z.infer<typeof syncUxSummarySchema>;
export type AiUsageEventInput = z.infer<typeof aiUsageEventInputSchema>;
export type AiUsageBatchBody = z.infer<typeof aiUsageBatchBodySchema>;
export type AiUsageBatchResponse = z.infer<typeof aiUsageBatchResponseSchema>;
export type AdminChatterUsageQuery = z.infer<typeof adminChatterUsageQuerySchema>;
export type AdminChatterUsageResponse = z.infer<typeof adminChatterUsageResponseSchema>;
export type CrossPageFanDetailResponse = z.infer<typeof crossPageFanDetailResponseSchema>;
export type FanListQuery = z.infer<typeof fanListQuerySchema>;
export type FanListResponse = z.infer<typeof fanListResponseSchema>;
export type FanLookupParams = z.infer<typeof fanLookupParamsSchema>;
export type FollowerDailyResponse = z.infer<typeof followerDailyResponseSchema>;
export type FollowerListQuery = z.infer<typeof followerListQuerySchema>;
export type FollowerListResponse = z.infer<typeof followerListResponseSchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type ModelListItem = z.infer<typeof modelListItemSchema>;
export type AdminModelListItem = z.infer<typeof adminModelListItemSchema>;
export type ModelParams = z.infer<typeof modelParamsSchema>;
export type ModelRevenueResponse = z.infer<typeof modelRevenueResponseSchema>;
export type OverviewGrowthResponse = z.infer<typeof overviewGrowthResponseSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type OverviewRevenueResponse = z.infer<typeof overviewRevenueResponseSchema>;
export type PageFanDetailResponse = z.infer<typeof pageFanDetailResponseSchema>;
export type FanProfileDocument = z.infer<typeof fanProfileDocumentSchema>;
export type FanProfileResponse = z.infer<typeof fanProfileResponseSchema>;
export type FanProfileVersionListResponse = z.infer<typeof fanProfileVersionListResponseSchema>;
export type PageFanParams = z.infer<typeof pageFanParamsSchema>;
export type FanProfileVersionParams = z.infer<typeof fanProfileVersionParamsSchema>;
export type PageParams = z.infer<typeof pageParamsSchema>;
export type PageConversationProfileParams = z.infer<typeof pageConversationProfileParamsSchema>;
export type PageRevenueResponse = z.infer<typeof pageRevenueResponseSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type RevenueQuery = z.infer<typeof revenueQuerySchema>;
export type RevenueDailyQuery = z.infer<typeof revenueDailyQuerySchema>;
export type RevenueDailyItem = z.infer<typeof revenueDailyItemSchema>;
export type RevenueDailyTypedItem = z.infer<typeof revenueDailyTypedItemSchema>;
export type RevenueDailyResponse = z.infer<typeof revenueDailyResponseSchema>;
export type SubscriberDailyResponse = z.infer<typeof subscriberDailyResponseSchema>;
export type SubscriberListQuery = z.infer<typeof subscriberListQuerySchema>;
export type SubscriberListResponse = z.infer<typeof subscriberListResponseSchema>;
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;
export type CrossPageTransactionItem = z.infer<typeof crossPageTransactionItemSchema>;
export type CrossPageTransactionListQuery = z.infer<typeof crossPageTransactionListQuerySchema>;
export type CrossPageTransactionListResponse = z.infer<typeof crossPageTransactionListResponseSchema>;
export type FanTransactionItem = z.infer<typeof fanTransactionItemSchema>;
export type FanTransactionListResponse = z.infer<typeof fanTransactionListResponseSchema>;
export type CrossPageFanTransactionItem = z.infer<typeof crossPageFanTransactionItemSchema>;
export type CrossPageFanTransactionListResponse = z.infer<typeof crossPageFanTransactionListResponseSchema>;
export type UpsertFanProfileBody = z.infer<typeof upsertFanProfileBodySchema>;
export type CreateFanNoteBody = z.infer<typeof createFanNoteBodySchema>;
export type FanNoteResponse = z.infer<typeof fanNoteResponseSchema>;
export type SetFanFlagsBody = z.infer<typeof setFanFlagsBodySchema>;
export type FanFlagsResponse = z.infer<typeof fanFlagsResponseSchema>;
export type FansSearchQuery = z.infer<typeof fansSearchQuerySchema>;
export type FansSearchResponse = z.infer<typeof fansSearchResponseSchema>;
export type PageDeletedFansResponse = z.infer<typeof pageDeletedFansResponseSchema>;
export type PageConversationPreviewParams = z.infer<typeof pageConversationPreviewParamsSchema>;
export type PageConversationPreviewQuery = z.infer<typeof pageConversationPreviewQuerySchema>;
export type PageConversationPreviewResponse = z.infer<typeof pageConversationPreviewResponseSchema>;
export type PageConversationMessagesParams = z.infer<typeof pageConversationMessagesParamsSchema>;
export type PageConversationMessagesQuery = z.infer<typeof pageConversationMessagesQuerySchema>;
export type PageConversationMessagesResponse = z.infer<typeof pageConversationMessagesResponseSchema>;
export type PageSpenderAutoListParams = z.infer<typeof pageSpenderAutoListParamsSchema>;
export type PageSpenderAutoListDetailResponse = z.infer<typeof pageSpenderAutoListDetailResponseSchema>;
export type PageSpenderAutoListsResponse = z.infer<typeof pageSpenderAutoListsResponseSchema>;
export type SpenderBatchBody = z.infer<typeof spenderBatchBodySchema>;
export type SpenderBatchResponse = z.infer<typeof spenderBatchResponseSchema>;
export type SpenderDetailQuery = z.infer<typeof spenderDetailQuerySchema>;
export type SpenderDetailResponse = z.infer<typeof spenderDetailResponseSchema>;
export type SpenderListQuery = z.infer<typeof spenderListQuerySchema>;
export type SpenderListResponse = z.infer<typeof spenderListResponseSchema>;
export type SpenderSeriesQuery = z.infer<typeof spenderSeriesQuerySchema>;
export type SpenderSeriesResponse = z.infer<typeof spenderSeriesResponseSchema>;
export type AdminCreateUserBody = z.infer<typeof adminCreateUserBodySchema>;
export type AdminSetPasswordBody = z.infer<typeof adminSetPasswordBodySchema>;
export type AdminAssignPageBody = z.infer<typeof adminAssignPageBodySchema>;
export type AdminIssueApiKeyBody = z.infer<typeof adminIssueApiKeyBodySchema>;
export type ApiKeyItem = z.infer<typeof apiKeyItemSchema>;
export type IssuedApiKeyResponse = z.infer<typeof issuedApiKeyResponseSchema>;
export type SyncRunItem = z.infer<typeof syncRunItemSchema>;
export type SyncRunDetailResponse = z.infer<typeof syncRunDetailResponseSchema>;
export type SyncStatusQuery = z.infer<typeof syncStatusQuerySchema>;
export type SyncMonitorResponse = z.infer<typeof syncStatusResponseSchema>;
export type SyncRequestsQuery = z.infer<typeof syncRequestsQuerySchema>;
export type SyncRequestItem = z.infer<typeof syncRequestItemSchema>;
export type SyncRequestsResponse = z.infer<typeof syncRequestsResponseSchema>;
export type SyncDiagnosis = z.infer<typeof syncDiagnosisSchema>;
export type SyncBlockStatus = z.infer<typeof syncBlockStatusSchema>;
export type SyncBlocksPage = z.infer<typeof syncBlocksPageSchema>;
export type SyncOverviewResponse = z.infer<typeof syncOverviewResponseSchema>;
export type PageSyncBlocksResponse = z.infer<typeof pageSyncBlocksResponseSchema>;
export type PageMessagesBlockResponse = z.infer<typeof pageMessagesBlockResponseSchema>;
export type AdminSyncBlockBody = z.infer<typeof adminSyncBlockBodySchema>;
export type AdminSyncBlockResponse = z.infer<typeof adminSyncBlockResponseSchema>;
export type SyncTriggerBody = z.infer<typeof syncTriggerBodySchema>;
export type SyncTriggerResponse = z.infer<typeof syncTriggerResponseSchema>;
export type SyncTriggerAllResponse = z.infer<typeof syncTriggerAllResponseSchema>;
export type SyncRunsQuery = z.infer<typeof syncRunsQuerySchema>;
export type ConnectionItem = z.infer<typeof connectionItemSchema>;
export type VerifyCredentialsBody = z.infer<typeof verifyCredentialsBodySchema>;
export type VerifyCredentialsResponse = z.infer<typeof verifyCredentialsResponseSchema>;
export type TestProxyBody = z.infer<typeof testProxyBodySchema>;
export type TestProxyResponse = z.infer<typeof testProxyResponseSchema>;
export type CreateModelBody = z.infer<typeof createModelBodySchema>;
export type UpdateModelBody = z.infer<typeof updateModelBodySchema>;
export type CreateModelResponse = z.infer<typeof createModelResponseSchema>;
export type CreatePageBody = z.infer<typeof createPageBodySchema>;
export type UpdatePageBody = z.infer<typeof updatePageBodySchema>;
export type AdminCreatePageResponse = z.infer<typeof adminCreatePageResponseSchema>;
export type AdminUpdatePageResponse = z.infer<typeof adminUpdatePageResponseSchema>;
export type UpdateCredentialsBody = z.infer<typeof updateCredentialsBodySchema>;
export type UpdateCredentialsResponse = z.infer<typeof updateCredentialsResponseSchema>;
export type VerifyPageResponse = z.infer<typeof verifyPageResponseSchema>;
export type DeletedResponse = z.infer<typeof deletedResponseSchema>;
export type NotificationsSettingsResponse = z.infer<typeof notificationsSettingsResponseSchema>;
export type NotificationsSettingsUpdateBody = z.infer<typeof notificationsSettingsUpdateBodySchema>;
export type NotificationsTestMessageResponse = z.infer<typeof notificationsTestMessageResponseSchema>;
export type NotificationsIncidentsQuery = z.infer<typeof notificationsIncidentsQuerySchema>;
export type NotificationsIncidentsResponse = z.infer<typeof notificationsIncidentsResponseSchema>;
export type NotificationsIncidentItem = z.infer<typeof notificationsIncidentItemSchema>;
export type NotificationsReportPreviewResponse = z.infer<typeof notificationsReportPreviewResponseSchema>;
export type NotificationsReportSendResponse = z.infer<typeof notificationsReportSendResponseSchema>;
export type NotificationsDeliveryAttemptItem = z.infer<typeof notificationsDeliveryAttemptItemSchema>;
export type NotificationsReportHistoryResponse = z.infer<typeof notificationsReportHistoryResponseSchema>;
export type WorkboardResponse = z.infer<typeof workboardResponseSchema>;
export type WorkboardPresenceResponse = z.infer<typeof workboardPresenceResponseSchema>;
export type WorkboardSnoozeBody = z.infer<typeof workboardSnoozeBodySchema>;
export type WorkboardSnoozeResponse = z.infer<typeof workboardSnoozeResponseSchema>;
export type WorkboardUnsnoozeParams = z.infer<typeof workboardUnsnoozeParamsSchema>;
export type WorkboardV2Query = z.infer<typeof workboardV2QuerySchema>;
export type WorkboardV2Item = z.infer<typeof workboardV2ItemSchema>;
export type WorkboardV2Response = z.infer<typeof workboardV2ResponseSchema>;
export type WorkboardV2ContactBody = z.infer<typeof workboardV2ContactBodySchema>;
export type WorkboardV2RecomputeResponse = z.infer<typeof workboardV2RecomputeResponseSchema>;
export type WorkboardV2SnoozeBody = z.infer<typeof workboardV2SnoozeBodySchema>;
export type WorkboardV2AiReport = z.infer<typeof workboardV2AiReportSchema>;
export type WorkboardV2AiSettings = z.infer<typeof workboardV2AiSettingsSchema>;
export type WorkboardV2AiSettingsBody = z.infer<typeof workboardV2AiSettingsBodySchema>;
export type WorkboardV2AiClassifyBody = z.infer<typeof workboardV2AiClassifyBodySchema>;
export type WorkboardV2AiClassifyResponse = z.infer<typeof workboardV2AiClassifyResponseSchema>;
export type WorkboardV2AiRun = z.infer<typeof workboardV2AiRunSchema>;
export type WorkboardV2AiRunsResponse = z.infer<typeof workboardV2AiRunsResponseSchema>;
