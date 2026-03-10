import {
  PERIOD_OPTIONS,
  SPENDER_PERIOD_OPTIONS,
  SPENDER_SERIES_GRANULARITIES,
  fanFlagTypes,
  isValidBusinessDateString,
  platforms,
  transactionReportingBuckets,
  transactionStates,
  transactionTypes,
  userRoles,
} from "@fansly-connect/shared";
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
const fanFlagEnum = z.enum(fanFlagTypes);
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
const fanSearchMatchKindEnum = z.enum(["platformUserId", "username", "alias", "displayName"]);

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

export const authStateSchema = z.object({
  authMethod: z.enum(["session", "api_key"]),
  user: authUserSchema,
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
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

export const fansSearchQuerySchema = spenderScopeFieldsSchema
  .merge(paginationQuerySchema)
  .extend({
    query: z.string().min(1),
  });

export const assignedPageSchema = pageRefSchema.extend({
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  followerCount: z.number().int(),
  subscriberCount: z.number().int(),
  lastLightSyncAt: isoTimestamp.nullable(),
  lastFollowerSyncAt: isoTimestamp.nullable(),
});

export const modelListItemSchema = z.object({
  id: intId,
  slug: z.string(),
  name: z.string(),
  pageCount: z.number().int(),
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
  from: isoTimestamp,
  to: isoTimestamp,
  netEarningsMills: mills,
  totalNetMills: mills,
  deltaNetMills: mills,
  deltaPct: z.number().nullable(),
});

export const revenueWindowSchema = revenueSummarySchema.extend({
  period: periodEnum,
  from: isoTimestamp.nullable(),
  to: isoTimestamp.nullable(),
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
  fan: transactionFanSchema,
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
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  endsAt: isoTimestamp.nullable(),
  autoRenew: z.boolean().nullable(),
  subscriptionTierName: z.string().nullable(),
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
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  followedAt: isoTimestamp,
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
  lastTransactionAt: isoTimestamp.nullable(),
});

export const fanListResponseSchema = z.object({
  page: assignedPageSchema,
  items: z.array(fanListItemSchema),
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
  lastTransactionAt: isoTimestamp.nullable(),
  notes: z.array(fanNoteSchema),
  summaries: z.array(fanSummarySchema),
});

export const pageFanDetailResponseSchema = z.object({
  fan: fanBaseSchema,
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

const spenderFanSchema = fanBaseSchema;

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

const spenderListItemSchema = z.object({
  fan: spenderFanSchema,
  metrics: spenderMetricsSchema,
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

export const spenderBatchItemSchema = z.object({
  requestedFan: fanLookupParamsSchema,
  found: z.boolean(),
  fan: spenderFanSchema.nullable(),
  metrics: spenderMetricsSchema.nullable(),
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

const cookieOnlySecurity: Array<Record<string, string[]>> = [{ cookieAuth: [] }];
const cookieOrBearerSecurity: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
];

export const routeSchemas = {
  health: {
    tags: ["system"],
    summary: "Health check",
    response: {
      200: healthResponseSchema,
    },
  },
  login: {
    tags: ["auth"],
    summary: "Log in with a dashboard account",
    body: loginBodySchema,
    response: {
      200: authStateSchema,
      401: errorResponseSchema,
    },
  },
  logout: {
    tags: ["auth"],
    summary: "Log out the current session",
    security: cookieOnlySecurity,
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
    querystring: paginationQuerySchema,
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
    querystring: paginationQuerySchema,
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
    security: cookieOnlySecurity,
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
} as const;

export type RouteSchemas = typeof routeSchemas;
export type AuthState = z.infer<typeof authStateSchema>;
export type AssignedPage = z.infer<typeof assignedPageSchema>;
export type CrossPageFanDetailResponse = z.infer<typeof crossPageFanDetailResponseSchema>;
export type FanListQuery = z.infer<typeof fanListQuerySchema>;
export type FanListResponse = z.infer<typeof fanListResponseSchema>;
export type FanLookupParams = z.infer<typeof fanLookupParamsSchema>;
export type FollowerDailyResponse = z.infer<typeof followerDailyResponseSchema>;
export type FollowerListResponse = z.infer<typeof followerListResponseSchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type ModelListItem = z.infer<typeof modelListItemSchema>;
export type ModelParams = z.infer<typeof modelParamsSchema>;
export type ModelRevenueResponse = z.infer<typeof modelRevenueResponseSchema>;
export type OverviewRevenueResponse = z.infer<typeof overviewRevenueResponseSchema>;
export type PageFanDetailResponse = z.infer<typeof pageFanDetailResponseSchema>;
export type PageFanParams = z.infer<typeof pageFanParamsSchema>;
export type PageParams = z.infer<typeof pageParamsSchema>;
export type PageRevenueResponse = z.infer<typeof pageRevenueResponseSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type RevenueQuery = z.infer<typeof revenueQuerySchema>;
export type SubscriberDailyResponse = z.infer<typeof subscriberDailyResponseSchema>;
export type SubscriberListResponse = z.infer<typeof subscriberListResponseSchema>;
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>;
export type FansSearchQuery = z.infer<typeof fansSearchQuerySchema>;
export type FansSearchResponse = z.infer<typeof fansSearchResponseSchema>;
export type SpenderBatchBody = z.infer<typeof spenderBatchBodySchema>;
export type SpenderBatchResponse = z.infer<typeof spenderBatchResponseSchema>;
export type SpenderDetailQuery = z.infer<typeof spenderDetailQuerySchema>;
export type SpenderDetailResponse = z.infer<typeof spenderDetailResponseSchema>;
export type SpenderListQuery = z.infer<typeof spenderListQuerySchema>;
export type SpenderListResponse = z.infer<typeof spenderListResponseSchema>;
export type SpenderSeriesQuery = z.infer<typeof spenderSeriesQuerySchema>;
export type SpenderSeriesResponse = z.infer<typeof spenderSeriesResponseSchema>;
