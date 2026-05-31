import {
  bigserial,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { aiUsageFeatures, fanFlagTypes, userRoles } from "@agency_hub_core/shared";

export const platformEnum = pgEnum("platform", ["fansly", "onlyfans"]);
export const syncRunOutcomeEnum = pgEnum("sync_run_outcome", [
  "running",
  "succeeded",
  "partial",
  "failed",
  "skipped",
]);
export const syncStreamEnum = pgEnum("sync_stream", [
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
export const pageSyncStatusEnum = pgEnum("page_sync_status", [
  "idle",
  "pending",
  "running",
  "retrying",
  "blocked",
  "paused",
]);
export const syncRequestSourceEnum = pgEnum("sync_request_source", [
  "scheduled",
  "manual",
  "onboarding",
  "recovery",
  "anomaly",
  "reset",
]);
export const syncWorkClassEnum = pgEnum("sync_work_class", [
  "live",
  "history",
  "maintenance",
]);
export const syncHttpAttemptStateEnum = pgEnum("sync_http_attempt_state", [
  "started",
  "success",
  "retry",
  "failed",
]);
export const syncHttpFailureKindEnum = pgEnum("sync_http_failure_kind", [
  "timeout",
  "transport",
  "http",
  "provider",
]);
export const syncEventSeverityEnum = pgEnum("sync_event_severity", [
  "info",
  "warn",
  "error",
]);
export const transactionTypeEnum = pgEnum("transaction_type", [
  "subscription",
  "tip",
  "message_purchase",
  "post_purchase",
  "stream_tip",
  "chargeback",
  "refund",
  "payout_reversal",
  "other",
]);
export const transactionStateEnum = pgEnum("transaction_state", [
  "pending",
  "posted",
  "unknown",
]);
export const userRoleEnum = pgEnum("user_role", userRoles);
export const fanFlagEnum = pgEnum("fan_flag", fanFlagTypes);
export const aiUsageFeatureEnum = pgEnum("ai_usage_feature", aiUsageFeatures);
export const dmSenderRoleEnum = pgEnum("dm_sender_role", ["fan", "model", "system", "unknown"]);
export const dmMessageCoverageStatusEnum = pgEnum("dm_message_coverage_status", [
  "pending_backfill",
  "partial_window",
  "complete",
]);
export const transactionInactiveReasonEnum = pgEnum("transaction_inactive_reason", [
  "missing_from_sync_window",
]);
export const notificationIncidentKindEnum = pgEnum("notification_incident_kind", [
  "auth_blocked",
  "proxy_failed",
  "stream_failed_threshold",
]);
export const notificationIncidentStatusEnum = pgEnum("notification_incident_status", [
  "open",
  "resolved",
]);

export const models = pgTable("models", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  username: text("username").notNull().unique(),
  role: userRoleEnum("role").notNull(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pages = pgTable(
  "pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modelId: bigint("model_id", { mode: "number" })
      .references(() => models.id, { onDelete: "cascade" })
      .notNull(),
    platform: platformEnum("platform").notNull(),
    commissionRate: numeric("commission_rate", {
      precision: 5,
      scale: 4,
      mode: "number",
    }).default(0).notNull(),
    label: text("label").notNull().unique(),
    platformAccountId: text("external_page_id"),
    username: text("username"),
    displayName: text("display_name"),
    followerCount: integer("follower_count"),
    subscriberCount: integer("subscriber_count"),
    egressEndpointId: bigint("egress_endpoint_id", { mode: "number" }),
    earningsBalanceMills: bigint("earnings_balance_mills", {
      mode: "bigint",
    }).default(sql`0`).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastLightSyncAt: timestamp("last_light_sync_at", { withTimezone: true }),
    lastFollowerSyncAt: timestamp("last_follower_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    modelIdx: index("pages_model_idx").on(table.modelId),
    platformAccountUniq: unique("pages_platform_external_id_uniq").on(
      table.platform,
      table.platformAccountId,
    ),
  }),
);

export const pageCredentials = pgTable("page_credentials", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  platformAccountId: bigint("platform_account_id", { mode: "number" })
    .references(() => pages.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  encryptedSession: text("encrypted_session").notNull(),
  keyVersion: integer("key_version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const egressEndpoints = pgTable("egress_endpoints", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  platformAccountId: bigint("platform_account_id", { mode: "number" })
    .references(() => pages.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  kind: text("kind").default("proxy").notNull(),
  url: text("url").notNull(),
  encryptedAuth: text("encrypted_auth"),
  keyVersion: integer("key_version"),
  rateLimitScopeKey: text("rate_limit_scope_key"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notificationIncidents = pgTable(
  "notification_incidents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    incidentKey: text("incident_key").notNull().unique(),
    kind: notificationIncidentKindEnum("kind").notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    stream: syncStreamEnum("stream"),
    status: notificationIncidentStatusEnum("status").default("open").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountStatusIdx: index("notification_incidents_account_status_idx").on(
      table.platformAccountId,
      table.status,
    ),
    statusSeenIdx: index("notification_incidents_status_seen_idx").on(
      table.status,
      table.lastSeenAt,
    ),
  }),
);

export const notificationIncidentRecoveries = pgTable("notification_incident_recoveries", {
  incidentKey: text("incident_key").primaryKey(),
  recoveredAt: timestamp("recovered_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const telegramSettings = pgTable("telegram_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").default(true).notNull(),
  dailyReportEnabled: boolean("daily_report_enabled").default(true).notNull(),
  syncFailureAlertsEnabled: boolean("sync_failure_alerts_enabled").default(true).notNull(),
  reportHourUtc: integer("report_hour_utc").default(9).notNull(),
  encryptedBotToken: text("encrypted_bot_token"),
  chatId: text("chat_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const telegramDeliveryAttempts = pgTable(
  "telegram_delivery_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    notificationIncidentId: bigint("notification_incident_id", { mode: "number" })
      .references(() => notificationIncidents.id, { onDelete: "set null" }),
    reportDate: text("report_date"),
    messageId: integer("message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    kindCreatedIdx: index("telegram_delivery_attempts_kind_created_idx").on(
      table.kind,
      table.createdAt,
    ),
  }),
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    requestSeq: bigint("request_seq", { mode: "number" }),
    leasedSeq: bigint("leased_seq", { mode: "number" }),
    source: syncRequestSourceEnum("source"),
    leaseToken: text("lease_token"),
    stream: syncStreamEnum("stream").notNull(),
    outcome: syncRunOutcomeEnum("outcome").notNull(),
    errorSummary: text("error_summary"),
    stats: jsonb("stats").$type<Record<string, unknown>>().default({}).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    idPageStreamUniq: unique("sync_runs_id_page_stream_uniq").on(
      table.id,
      table.pageId,
      table.stream,
    ),
    pageStreamIdx: index("sync_runs_page_stream_idx").on(
      table.pageId,
      table.stream,
      table.startedAt,
    ),
  }),
);

export const syncHttpAttempts = pgTable("sync_http_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    syncRunId: bigint("sync_run_id", { mode: "number" })
      .references(() => syncRuns.id, { onDelete: "cascade" })
      .notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    requestSeq: bigint("request_seq", { mode: "number" }),
    source: syncRequestSourceEnum("source"),
    provider: platformEnum("provider").notNull(),
    stream: syncStreamEnum("stream").notNull(),
    operation: text("operation").notNull(),
    logicalRequestId: text("logical_request_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    state: syncHttpAttemptStateEnum("state").notNull(),
    failureKind: syncHttpFailureKindEnum("failure_kind"),
    httpStatus: integer("http_status"),
    retryDelayMs: integer("retry_delay_ms"),
    durationMs: integer("duration_ms"),
    requestShape: jsonb("request_shape").$type<Record<string, unknown>>().default({}).notNull(),
    responseShape: jsonb("response_shape").$type<Record<string, unknown>>().default({}).notNull(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    runStartedIdx: index("sync_http_attempts_run_started_idx").on(
      table.syncRunId,
      table.startedAt,
    ),
    logicalIdx: index("sync_http_attempts_logical_idx").on(
      table.syncRunId,
      table.logicalRequestId,
      table.attemptNumber,
    ),
    retentionIdx: index("sync_http_attempts_retention_idx").on(table.startedAt),
    runPageStreamFk: foreignKey({
      name: "sync_http_attempts_run_page_stream_fk",
      columns: [table.syncRunId, table.pageId, table.stream],
      foreignColumns: [syncRuns.id, syncRuns.pageId, syncRuns.stream],
    }).onDelete("cascade"),
  }),
);

export const syncRunEvents = pgTable(
  "sync_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    syncRunId: bigint("sync_run_id", { mode: "number" })
      .references(() => syncRuns.id, { onDelete: "cascade" })
      .notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    requestSeq: bigint("request_seq", { mode: "number" }),
    source: syncRequestSourceEnum("source"),
    leaseToken: text("lease_token"),
    provider: platformEnum("provider").notNull(),
    stream: syncStreamEnum("stream").notNull(),
    eventType: text("event_type").notNull(),
    severity: syncEventSeverityEnum("severity").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    emittedAt: timestamp("emitted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    runEmittedIdx: index("sync_run_events_run_emitted_idx").on(table.syncRunId, table.emittedAt),
    emittedIdx: index("sync_run_events_emitted_idx").on(table.emittedAt),
    runPageStreamFk: foreignKey({
      name: "sync_run_events_run_page_stream_fk",
      columns: [table.syncRunId, table.pageId, table.stream],
      foreignColumns: [syncRuns.id, syncRuns.pageId, syncRuns.stream],
    }).onDelete("cascade"),
  }),
);

export const pageSyncStates = pgTable("page_sync_states",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    stream: syncStreamEnum("stream").notNull(),
    status: pageSyncStatusEnum("status").default("idle").notNull(),
    requestSeq: bigint("request_seq", { mode: "number" }).default(0).notNull(),
    leasedSeq: bigint("leased_seq", { mode: "number" }),
    appliedSeq: bigint("applied_seq", { mode: "number" }).default(0).notNull(),
    requestSource: syncRequestSourceEnum("request_source"),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown>>().default({}).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    progressedAt: timestamp("progressed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    retryKind: text("retry_kind"),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    blockerKind: text("blocker_kind"),
    blockerCode: text("blocker_code"),
    blockerMessage: text("blocker_message"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    phase: text("phase"),
    workClass: syncWorkClassEnum("work_class"),
    progress: jsonb("progress").$type<Record<string, unknown>>().default({}).notNull(),
    cadenceSeconds: integer("cadence_seconds").notNull(),
    slotOffsetSeconds: integer("slot_offset_seconds").notNull(),
    lastScheduledSlot: bigint("last_scheduled_slot", { mode: "number" }).default(-1).notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseHeartbeatAt: timestamp("lease_heartbeat_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_sync_states_pkey",
      columns: [table.pageId, table.stream],
    }),
    freshnessIdx: index("page_sync_states_freshness_idx").on(table.stream, table.succeededAt),
    leaseIdx: index("page_sync_states_lease_idx").on(table.status, table.leaseExpiresAt),
    runnableIdx: index("page_sync_states_runnable_idx").on(
      table.status,
      table.retryAt,
      table.pageId,
      table.stream,
    ),
    scheduleIdx: index("page_sync_states_schedule_idx").on(
      table.status,
      table.lastScheduledSlot,
      table.pageId,
      table.stream,
    ),
  }),
);

export const pageSyncCursors = pgTable(
  "page_sync_cursors",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    stream: syncStreamEnum("stream").notNull(),
    cursorText: text("cursor_text"),
    cursorTimestamp: timestamp("cursor_timestamp", { withTimezone: true }),
    cursorSeq: bigint("cursor_seq", { mode: "number" }),
    state: jsonb("state").$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    cursorLastSucceededRunId: bigint("last_succeeded_run_id", { mode: "number" }).references(
      () => syncRuns.id,
      { onDelete: "set null" },
    ),
    cursorLastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_sync_cursors_pkey",
      columns: [table.pageId, table.stream],
    }),
  }),
);
export const syncRateLimits = pgTable(
  "sync_rate_limits",
  {
    provider: platformEnum("provider").notNull(),
    scope: text("scope").notNull(),
    egressKey: text("egress_key").notNull(),
    minSpacingMs: integer("min_spacing_ms").notNull(),
    nextAvailableAt: timestamp("next_available_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "sync_rate_limits_pkey",
      columns: [table.provider, table.scope, table.egressKey],
    }),
  }),
);

export const syncRawPayloads = pgTable(
  "sync_raw_payloads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    syncRunId: bigint("sync_run_id", { mode: "number" }).references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    stream: syncStreamEnum("stream"),
    requestSeq: bigint("request_seq", { mode: "number" }),
    source: syncRequestSourceEnum("source"),
    endpoint: text("endpoint").notNull(),
    requestParams: jsonb("request_params").$type<Record<string, unknown>>().default({}).notNull(),
    responsePayload: jsonb("response_payload").$type<unknown>().notNull(),
    mapperVersion: text("mapper_version").notNull(),
    payloadKind: text("payload_kind").notNull(),
    statusCode: integer("status_code"),
    errorMessage: text("error_message"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  },
  (table) => ({
    retainIdx: index("sync_raw_payloads_retain_idx").on(table.retainUntil),
  }),
);

export const fans = pgTable(
  "fans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: platformEnum("platform").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    username: text("username"),
    displayName: text("display_name"),
    createdAtExternal: timestamp("created_at_external", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deletedDetectedAt: timestamp("deleted_detected_at", { withTimezone: true }),
    deletedLastDetectedAt: timestamp("deleted_last_detected_at", { withTimezone: true }),
  },
  (table) => ({
    uniq: unique("fans_platform_user_uniq").on(table.platform, table.platformUserId),
    deletedIdx: index("fans_deleted_detected_idx").on(table.platform, table.deletedDetectedAt),
  }),
);

export const fanUsernameAliases = pgTable(
  "fan_username_aliases",
  {
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    username: text("username").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "fan_username_aliases_pkey",
      columns: [table.fanId, table.username],
    }),
    usernameIdx: index("fan_username_aliases_username_idx").on(table.username),
  }),
);

export const onlyFansPublicProfileResolutions = pgTable(
  "onlyfans_public_profile_resolutions",
  {
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .primaryKey()
      .notNull(),
    platformUserId: text("platform_user_id").notNull(),
    status: text("status").notNull(),
    username: text("username"),
    displayName: text("display_name"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    nextAttemptAfter: timestamp("next_attempt_after", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    platformUserIdx: unique("onlyfans_public_profile_resolutions_platform_user_uniq").on(
      table.platformUserId,
    ),
    nextAttemptIdx: index("onlyfans_public_profile_resolutions_next_attempt_idx").on(
      table.nextAttemptAfter,
    ),
    statusCheck: check(
      "onlyfans_public_profile_resolutions_status_check",
      sql`${table.status} in ('resolved', 'not_found', 'unavailable', 'failed', 'rate_limited')`,
    ),
  }),
);

export const pageFans = pgTable(
  "page_fans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    totalCreatorNetMills: bigint("total_creator_net_mills", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    currency: text("currency").default("USD").notNull(),
    isFollower: boolean("is_follower").default(false).notNull(),
    followerSince: timestamp("follower_since", { withTimezone: true }),
    isSubscriber: boolean("is_subscriber").default(false).notNull(),
    subscriberSince: timestamp("subscriber_since", { withTimezone: true }),
    subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
    autoRenew: boolean("auto_renew"),
    autoRenewOffDetectedAt: timestamp("auto_renew_off_detected_at", { withTimezone: true }),
    pageAlias: text("page_alias"),
    pageAliasSource: text("page_alias_source"),
    pageAliasSourceNoteId: text("page_alias_source_note_id"),
    pageAliasSyncedAt: timestamp("page_alias_synced_at", { withTimezone: true }),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    externalPresenceAt: timestamp("external_presence_at", { withTimezone: true }),
    externalPresenceObservedAt: timestamp("external_presence_observed_at", { withTimezone: true }),
    externalPresenceSource: text("external_presence_source"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("page_fans_fan_account_uniq").on(table.fanId, table.platformAccountId),
    platformAccountIdx: index("page_fans_platform_account_idx").on(table.platformAccountId),
    externalPresenceIdx: index("page_fans_external_presence_idx").on(
      table.platformAccountId,
      table.externalPresenceAt,
    ),
    pageAliasIdx: index("page_fans_platform_account_alias_idx").on(
      table.platformAccountId,
      table.pageAlias,
    ),
  }),
);

export const pageFanExternalNotes = pgTable(
  "page_fan_external_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    provider: platformEnum("provider").notNull(),
    externalNoteId: text("external_note_id").notNull(),
    contentType: integer("content_type"),
    title: text("title"),
    body: text("body"),
    createdAtExternal: timestamp("created_at_external", { withTimezone: true }),
    updatedAtExternal: timestamp("updated_at_external", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => ({
    uniq: unique("page_fan_external_notes_account_provider_external_note_uniq").on(
      table.platformAccountId,
      table.provider,
      table.externalNoteId,
    ),
    pageFanProviderIdx: index("page_fan_external_notes_page_fan_provider_idx").on(
      table.platformAccountId,
      table.fanId,
      table.provider,
    ),
    pageFanProviderActiveIdx: index("page_fan_external_notes_page_fan_provider_active_idx").on(
      table.platformAccountId,
      table.fanId,
      table.provider,
      table.isActive,
    ),
  }),
);

export const pageFanAliases = pgTable(
  "page_fan_aliases",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    alias: text("alias").notNull(),
    sourceNoteId: text("source_note_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_fan_aliases_pkey",
      columns: [table.platformAccountId, table.fanId, table.alias],
    }),
    aliasIdx: index("page_fan_aliases_platform_account_alias_idx").on(
      table.platformAccountId,
      table.alias,
    ),
    fanIdx: index("page_fan_aliases_fan_idx").on(table.fanId),
  }),
);

export const pageFollows = pgTable(
  "page_follows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformFollowId: text("platform_follow_id").notNull(),
    followedAt: timestamp("followed_at", { withTimezone: true }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenGeneration: bigint("last_seen_generation", { mode: "number" }),
    isActive: boolean("is_active").default(true).notNull(),
  },
  (table) => ({
    uniq: unique("page_follows_account_follow_uniq").on(
      table.platformAccountId,
      table.platformFollowId,
    ),
    fanIdx: index("page_follows_fan_idx").on(table.fanId),
    generationIdx: index("page_follows_generation_idx").on(
      table.platformAccountId,
      table.lastSeenGeneration,
    ),
    activeFollowedIdx: index("page_follows_active_followed_idx").on(
      table.platformAccountId,
      table.isActive,
      table.followedAt,
      table.id,
    ),
  }),
);

export const pageSubscriptions = pgTable(
  "page_subscriptions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformSubscriptionId: text("platform_subscription_id").notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformHistoryId: text("platform_history_id"),
    subscriptionTierId: text("subscription_tier_id"),
    subscriptionTierName: text("subscription_tier_name"),
    subscriptionTierColor: text("subscription_tier_color"),
    planId: text("plan_id"),
    rawStatus: integer("raw_status").notNull(),
    canonicalStatus: text("canonical_status").notNull(),
    priceMills: bigint("price_mills", { mode: "bigint" }).notNull(),
    renewPriceMills: bigint("renew_price_mills", { mode: "bigint" }).notNull(),
    autoRenew: boolean("auto_renew"),
    autoRenewOffDetectedAt: timestamp("auto_renew_off_detected_at", { withTimezone: true }),
    billingCycleDays: integer("billing_cycle_days"),
    durationDays: integer("duration_days"),
    renewDate: timestamp("renew_date", { withTimezone: true }),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    isCurrent: boolean("is_current").default(true).notNull(),
    lastSeenGeneration: bigint("last_seen_generation", { mode: "number" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("page_subscriptions_account_subscription_uniq").on(
      table.platformAccountId,
      table.platformSubscriptionId,
    ),
    accountIdx: index("page_subscriptions_account_idx").on(table.platformAccountId, table.endsAt),
    generationIdx: index("page_subscriptions_generation_idx").on(
      table.platformAccountId,
      table.lastSeenGeneration,
    ),
    currentIdx: index("page_subscriptions_current_idx").on(
      table.platformAccountId,
      table.isCurrent,
      table.endsAt,
      table.id,
    ),
  }),
);

export const pageDmThreads = pgTable(
  "page_dm_threads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" }).references(() => fans.id, {
      onDelete: "set null",
    }),
    platformConversationId: text("platform_conversation_id").notNull(),
    partnerPlatformUserId: text("partner_platform_user_id"),
    partnerUsername: text("partner_username"),
    partnerDisplayName: text("partner_display_name"),
    conversationFlags: integer("conversation_flags").default(0).notNull(),
    unreadCount: integer("unread_count").default(0).notNull(),
    subscriptionTierId: text("subscription_tier_id"),
    lastMessageId: text("last_message_id"),
    lastUnreadMessageId: text("last_unread_message_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessageSenderId: text("last_message_sender_id"),
    lastMessageSenderRole: dmSenderRoleEnum("last_message_sender_role")
      .default("unknown")
      .notNull(),
    lastMessagePreview: text("last_message_preview"),
    lastFanMessageAt: timestamp("last_fan_message_at", { withTimezone: true }),
    lastModelMessageAt: timestamp("last_model_message_at", { withTimezone: true }),
    storedMessageCount: integer("stored_message_count").default(0).notNull(),
    newestStoredMessageId: text("newest_stored_message_id"),
    oldestStoredMessageId: text("oldest_stored_message_id"),
    messageCoverageStatus: dmMessageCoverageStatusEnum("message_coverage_status")
      .default("pending_backfill")
      .notNull(),
    messageBackfillComplete: boolean("message_backfill_complete").default(false).notNull(),
    lastMessageSyncAt: timestamp("last_message_sync_at", { withTimezone: true }),
    isVisible: boolean("is_visible").default(true).notNull(),
    lastSeenGeneration: bigint("last_seen_generation", { mode: "number" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("page_dm_threads_account_conversation_uniq").on(
      table.platformAccountId,
      table.platformConversationId,
    ),
    idAccountUniq: unique("page_dm_threads_id_account_uniq").on(
      table.id,
      table.platformAccountId,
    ),
    fanIdx: index("page_dm_threads_account_fan_idx").on(
      table.platformAccountId,
      table.fanId,
    ),
    visibleMessageIdx: index("page_dm_threads_visible_message_idx").on(
      table.platformAccountId,
      table.isVisible,
      table.lastMessageAt.desc(),
      table.id.desc(),
    ),
    visibleUnreadIdx: index("page_dm_threads_visible_unread_idx").on(
      table.platformAccountId,
      table.isVisible,
      table.unreadCount.desc(),
      table.lastMessageAt.desc(),
      table.id.desc(),
    ),
    backfillIdx: index("page_dm_threads_backfill_idx").on(
      table.platformAccountId,
      table.isVisible,
      table.messageCoverageStatus,
      table.lastMessageSyncAt,
    ),
    generationIdx: index("page_dm_threads_generation_idx").on(
      table.platformAccountId,
      table.lastSeenGeneration,
    ),
    storedMessageCountCheck: check(
      "page_dm_threads_stored_message_count_check",
      sql`${table.storedMessageCount} between 0 and 25`,
    ),
  }),
);

export const pageDmMessages = pgTable(
  "page_dm_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: bigint("conversation_id", { mode: "number" })
      .references(() => pageDmThreads.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    platformMessageId: text("platform_message_id").notNull(),
    senderPlatformUserId: text("sender_platform_user_id"),
    senderRole: dmSenderRoleEnum("sender_role").default("unknown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    content: text("content").default("").notNull(),
    totalTipAmountCents: integer("total_tip_amount_cents").default(0).notNull(),
    inReplyToMessageId: text("in_reply_to_message_id"),
    inReplyToRootMessageId: text("in_reply_to_root_message_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("page_dm_messages_conversation_message_uniq").on(
      table.conversationId,
      table.platformMessageId,
    ),
    conversationIdx: index("page_dm_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    accountConversationIdx: index("page_dm_messages_account_conversation_created_idx").on(
      table.platformAccountId,
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    conversationAccountFk: foreignKey({
      name: "page_dm_messages_conversation_account_fk",
      columns: [table.conversationId, table.platformAccountId],
      foreignColumns: [pageDmThreads.id, pageDmThreads.platformAccountId],
    }).onDelete("cascade"),
  }),
);

export const workboardSnoozes = pgTable(
  "workboard_snoozes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    platformAccountFanUniq: unique("workboard_snoozes_platform_account_id_fan_id_key").on(
      table.platformAccountId,
      table.fanId,
    ),
    lookupIdx: index("workboard_snoozes_lookup_idx").on(
      table.platformAccountId,
      table.fanId,
      table.snoozedUntil,
    ),
  }),
);

export const transactions = pgTable(
  "transactions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" }).references(() => fans.id, {
      onDelete: "set null",
    }),
    transactionId: text("transaction_id").notNull(),
    walletId: text("wallet_id"),
    accountId: text("account_id"),
    correlationId: text("correlation_id"),
    correlationAccountId: text("correlation_account_id"),
    rawType: text("raw_type").notNull(),
    canonicalType: transactionTypeEnum("canonical_type").notNull(),
    transactionState: transactionStateEnum("transaction_state").notNull(),
    destination: integer("destination"),
    rawStatus: text("raw_status").notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).notNull(),
    sourceDestinationAmountMills: bigint("source_destination_amount_mills", {
      mode: "bigint",
    }).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" }).notNull(),
    rawDestinationTax: integer("raw_destination_tax"),
    newBalanceMills: bigint("new_balance_mills", { mode: "bigint" }),
    senderId: text("sender_id"),
    receiverId: text("receiver_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    scanToken: text("scan_token"),
    isActive: boolean("is_active").default(true).notNull(),
    inactiveReason: transactionInactiveReasonEnum("inactive_reason"),
    inactivatedAt: timestamp("inactivated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("transactions_account_transaction_uniq").on(
      table.platformAccountId,
      table.transactionId,
    ),
    pendingBoundaryIdx: index("transactions_pending_boundary_idx").on(
      table.platformAccountId,
      table.transactionState,
      table.occurredAt,
    ),
    occurredIdx: index("transactions_account_occurred_idx").on(
      table.platformAccountId,
      table.occurredAt,
    ),
    activeOccurredIdx: index("transactions_account_active_occurred_idx").on(
      table.platformAccountId,
      table.isActive,
      table.occurredAt,
    ),
    fanIdx: index("transactions_fan_idx").on(table.fanId),
  }),
);

export const revenueDaily = pgTable(
  "revenue_daily",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    canonicalType: transactionTypeEnum("canonical_type").notNull(),
    transactionState: transactionStateEnum("transaction_state").notNull(),
    transactionCount: integer("transaction_count").default(0).notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(sql`0`).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("revenue_daily_account_date_type_state_uniq").on(
      table.platformAccountId,
      table.businessDate,
      table.canonicalType,
      table.transactionState,
    ),
    accountDateIdx: index("revenue_daily_account_date_idx").on(
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

export const fanSpendDaily = pgTable(
  "fan_spend_daily",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    canonicalType: transactionTypeEnum("canonical_type").notNull(),
    transactionState: transactionStateEnum("transaction_state").notNull(),
    transactionCount: integer("transaction_count").default(0).notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(sql`0`).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "fan_spend_daily_pkey",
      columns: [
        table.platformAccountId,
        table.fanId,
        table.businessDate,
        table.canonicalType,
        table.transactionState,
      ],
    }),
    accountDateFanIdx: index("fan_spend_daily_account_date_fan_idx").on(
      table.platformAccountId,
      table.businessDate,
      table.fanId,
    ),
    fanAccountDateIdx: index("fan_spend_daily_fan_account_date_idx").on(
      table.fanId,
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

export const fanSpendLifetime = pgTable(
  "fan_spend_lifetime",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(sql`0`).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "fan_spend_lifetime_pkey",
      columns: [table.platformAccountId, table.fanId],
    }),
    fanAccountIdx: index("fan_spend_lifetime_fan_account_idx").on(
      table.fanId,
      table.platformAccountId,
    ),
  }),
);

export const pageFanIdentities = pgTable("page_fan_identities",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    sourceIdentityKey: text("source_identity_key").notNull(),
    correlationAccountId: text("correlation_account_id"),
    accountId: text("account_id"),
    fanId: bigint("fan_id", { mode: "number" }).references(() => fans.id, {
      onDelete: "set null",
    }),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(sql`0`).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    sourceWindowStartedAt: timestamp("source_window_started_at", { withTimezone: true }).notNull(),
    sourceWindowEndedAt: timestamp("source_window_ended_at", { withTimezone: true }).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_fan_identities_pkey",
      columns: [table.platformAccountId, table.sourceIdentityKey],
    }),
    fanAccountIdx: index("page_fan_identities_fan_account_idx").on(
      table.fanId,
      table.platformAccountId,
    ),
  }),
);

export const projectionWatermarks = pgTable(
  "projection_watermarks",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull()
      .primaryKey(),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const dailyFollowers = pgTable(
  "daily_followers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    newFollowers: integer("new_followers").default(0).notNull(),
    knownTotalFollowers: integer("known_total_followers"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("daily_followers_account_date_uniq").on(
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

export const dailySubscribers = pgTable(
  "daily_subscribers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    newSubscribers: integer("new_subscribers").default(0).notNull(),
    activeSubscribers: integer("active_subscribers").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("daily_subscribers_account_date_uniq").on(
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

export const userPageAssignments = pgTable(
  "user_page_assignments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("user_page_assignments_user_page_uniq").on(table.userId, table.platformAccountId),
    pageIdx: index("user_page_assignments_page_idx").on(table.platformAccountId),
  }),
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tokenDigest: text("token_digest").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    userIdx: index("auth_sessions_user_idx").on(table.userId),
    expiryIdx: index("auth_sessions_expiry_idx").on(table.expiresAt),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    keyPrefix: text("key_prefix").notNull().unique(),
    tokenDigest: text("token_digest").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    userIdx: index("api_keys_user_idx").on(table.userId),
  }),
);

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    clientEventId: text("client_event_id").notNull(),
    feature: aiUsageFeatureEnum("feature").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    conversationId: text("conversation_id"),
    durationMs: integer("duration_ms"),
    isCacheHit: boolean("is_cache_hit").default(false).notNull(),
    isRegeneration: boolean("is_regeneration").default(false).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("ai_usage_events_user_client_event_uniq").on(table.userId, table.clientEventId),
    userCompletedIdx: index("ai_usage_events_user_completed_idx").on(
      table.userId,
      table.completedAt,
    ),
    completedIdx: index("ai_usage_events_completed_idx").on(table.completedAt),
    inputNonnegative: check("ai_usage_events_input_tokens_nonnegative", sql`${table.inputTokens} >= 0`),
    outputNonnegative: check("ai_usage_events_output_tokens_nonnegative", sql`${table.outputTokens} >= 0`),
    cacheWriteNonnegative: check(
      "ai_usage_events_cache_write_tokens_nonnegative",
      sql`${table.cacheWriteTokens} >= 0`,
    ),
    cacheReadNonnegative: check(
      "ai_usage_events_cache_read_tokens_nonnegative",
      sql`${table.cacheReadTokens} >= 0`,
    ),
    durationNonnegative: check(
      "ai_usage_events_duration_ms_nonnegative",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
  }),
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    targetUserId: bigint("target_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    platformAccountId: bigint("platform_account_id", { mode: "number" }).references(
      () => pages.id,
      { onDelete: "set null" },
    ),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    actorIdx: index("audit_events_actor_idx").on(table.actorUserId, table.createdAt),
    targetIdx: index("audit_events_target_idx").on(table.targetUserId, table.createdAt),
    pageIdx: index("audit_events_page_idx").on(table.platformAccountId, table.createdAt),
  }),
);

export const fanNotes = pgTable(
  "fan_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    authorUserId: bigint("author_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fanPageIdx: index("fan_notes_fan_page_idx").on(table.fanId, table.platformAccountId, table.createdAt),
  }),
);

export const fanSummaries = pgTable(
  "fan_summaries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    authorUserId: bigint("author_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fanPageIdx: index("fan_summaries_fan_page_idx").on(table.fanId, table.platformAccountId, table.createdAt),
  }),
);

export const fanProfiles = pgTable(
  "fan_profiles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    source: text("source").notNull(),
    createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    versionCheck: check("fan_profiles_version_check", sql`${table.version} > 0`),
    versionUniq: unique("fan_profiles_fan_page_version_uniq").on(
      table.fanId,
      table.platformAccountId,
      table.version,
    ),
    latestIdx: index("fan_profiles_latest_idx").on(
      table.platformAccountId,
      table.fanId,
      table.version.desc(),
    ),
    historyIdx: index("fan_profiles_history_idx").on(
      table.fanId,
      table.platformAccountId,
      table.createdAt.desc(),
    ),
  }),
);

export const fanFlags = pgTable(
  "fan_flags",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    flag: fanFlagEnum("flag").notNull(),
    createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("fan_flags_fan_flag_uniq").on(table.fanId, table.flag),
    fanIdx: index("fan_flags_fan_idx").on(table.fanId, table.createdAt),
  }),
);

export const fanPages = pageFans;
export const fanPageExternalNotes = pageFanExternalNotes;
export const fanPageAliases = pageFanAliases;
export const pageDmConversations = pageDmThreads;
export const dailyRevenue = revenueDaily;
export const spenderDailyFacts = fanSpendDaily;
export const spenderLifetimePage = fanSpendLifetime;
export const spenderProjectionWatermarks = projectionWatermarks;
export const pageTopSpenders = pageFanIdentities;

// ───────────────────────────────────────────────────────────────────────────
// Workboard v2 (priority engine). Additive and isolated: v1 (workboardSnoozes +
// its read queries) is untouched. See docs/workboard-v2-priority-design.md.
// ───────────────────────────────────────────────────────────────────────────

export const workboardTabEnum = pgEnum("workboard_tab", [
  "subscribers",
  "spenders",
  "fresh_mass",
  "old_mass",
  "service",
]);

export const workboardMassSubstateEnum = pgEnum("workboard_mass_substate", [
  "fresh",
  "gray",
  "active",
  "dead",
  "archived",
]);

export const workboardSecondaryStatusEnum = pgEnum("workboard_secondary_status", [
  "recent_purchase",
  "need_reply",
  "due_now",
  "later",
  "dont_touch_today",
]);

export const workboardFreeloaderStatusEnum = pgEnum("workboard_freeloader_status", [
  "none",
  "cooling",
  "freeloader",
  "ceiling",
]);

export const workboardContactActionEnum = pgEnum("workboard_contact_action", [
  "opened",
  "handled",
  "snoozed",
]);

// Persisted FSM row: one per (page, fan). Recomputed nightly + event-patched.
// Value and Urgency are stored SEPARATELY; rankScore is the per-tab sort key.
export const workboardState = pgTable(
  "workboard_state",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    tab: workboardTabEnum("tab").notNull(),
    massSubstate: workboardMassSubstateEnum("mass_substate"),
    valueScore: numeric("value_score", { precision: 5, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    urgencyScore: numeric("urgency_score", { precision: 5, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    rankScore: numeric("rank_score", { precision: 8, scale: 3, mode: "number" })
      .default(0)
      .notNull(),
    secondaryStatus: workboardSecondaryStatusEnum("secondary_status")
      .default("later")
      .notNull(),
    valueTier: text("value_tier").default("new").notNull(),
    urgencySeverity: text("urgency_severity").default("normal").notNull(),
    needsReply: boolean("needs_reply").default(false).notNull(),
    needsHumanTriage: boolean("needs_human_triage").default(false).notNull(),
    isPurchaseFollowup: boolean("is_purchase_followup").default(false).notNull(),
    whyNowCode: text("why_now_code"),
    whyNowValue: numeric("why_now_value", { precision: 10, scale: 2, mode: "number" }),
    reasonChips: jsonb("reason_chips").$type<string[]>().default([]).notNull(),
    followupDueAt: timestamp("followup_due_at", { withTimezone: true }),
    // Stage 1+ conversation-quality / freeloader fields (nullable/defaulted for now).
    qScore: numeric("q_score", { precision: 4, scale: 3, mode: "number" }),
    qConfidence: text("q_confidence").default("low").notNull(),
    valueConfidence: text("value_confidence").default("low").notNull(),
    roleConfidence: numeric("role_confidence", { precision: 4, scale: 3, mode: "number" })
      .default(1)
      .notNull(),
    bestCoverageSeen: dmMessageCoverageStatusEnum("best_coverage_seen"),
    freeloaderStatus: workboardFreeloaderStatusEnum("freeloader_status")
      .default("none")
      .notNull(),
    freeloaderEpisodes: jsonb("freeloader_episodes").$type<string[]>().default([]).notNull(),
    lifetimeFreeEpisodes: integer("lifetime_free_episodes").default(0).notNull(),
    reactivationAttemptedAt: timestamp("reactivation_attempted_at", { withTimezone: true }),
    serviceReason: text("service_reason"),
    lastEvalAt: timestamp("last_eval_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "workboard_state_pkey",
      columns: [table.platformAccountId, table.fanId],
    }),
    tabRankIdx: index("workboard_state_tab_rank_idx").on(
      table.platformAccountId,
      table.tab,
      table.rankScore.desc(),
    ),
    statusIdx: index("workboard_state_status_idx").on(
      table.platformAccountId,
      table.tab,
      table.secondaryStatus,
    ),
    fanIdx: index("workboard_state_fan_idx").on(table.fanId, table.platformAccountId),
  }),
);

// Dashboard-written touch log — the authoritative "we contacted this fan" signal
// (the DM sync is lagged and stores only 25 msgs). Backs cadence floors, cooldowns,
// cross-page anti-spam, and Fresh->Gray attempt counting.
export const workboardContactLog = pgTable(
  "workboard_contact_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modelId: bigint("model_id", { mode: "number" })
      .references(() => models.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    action: workboardContactActionEnum("action").notNull(),
    wasProductive: boolean("was_productive").default(false).notNull(),
    actedAt: timestamp("acted_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pageFanActedIdx: index("workboard_contact_log_page_fan_acted_idx").on(
      table.platformAccountId,
      table.fanId,
      table.actedAt.desc(),
    ),
    crossPageIdx: index("workboard_contact_log_model_fan_date_idx").on(
      table.modelId,
      table.fanId,
      table.businessDate,
    ),
    pageDateIdx: index("workboard_contact_log_page_date_idx").on(
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

// Permanent per-message verdict cache for the L2 (Haiku) closing classifier.
// layer = 'l2' (classifier-confirmed) | 'over_cap' (fallback needs_reply, shown "unverified").
export const wbClosingCache = pgTable(
  "wb_closing_cache",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    platformMessageId: text("platform_message_id").notNull(),
    contentHash: text("content_hash").notNull(),
    needsReply: boolean("needs_reply").notNull(),
    layer: text("layer").notNull(),
    model: text("model"),
    // L2 semantic read (Haiku): conversation state + short rationale for the tail.
    state: text("state"),
    reason: text("reason"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("wb_closing_cache_message_uniq").on(table.platformAccountId, table.platformMessageId),
    pageIdx: index("wb_closing_cache_page_idx").on(table.platformAccountId, table.classifiedAt),
  }),
);

// Per-page runtime overrides for the L2 closing classifier (null column = inherit env).
// Owner-editable from the Workboard v2 AI panel: toggle, daily call cap, model.
export const wbClosingSettings = pgTable("wb_closing_settings", {
  platformAccountId: bigint("platform_account_id", { mode: "number" })
    .primaryKey()
    .references(() => pages.id, { onDelete: "cascade" }),
  enabled: boolean("enabled"),
  dailyCapMax: integer("daily_cap_max"),
  model: text("model"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Append-only activity log of classifier runs (one row per page per run). Powers the
// AI dashboard's run logger; trigger = 'cron' | 'manual' | 'reclassify'.
export const wbClassifierRuns = pgTable(
  "wb_classifier_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    trigger: text("trigger").notNull(),
    model: text("model"),
    classified: integer("classified").default(0).notNull(),
    calls: integer("calls").default(0).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    deferred: integer("deferred").default(0).notNull(),
    cleared: integer("cleared").default(0).notNull(),
    status: text("status").default("ok").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    createdIdx: index("wb_classifier_runs_created_idx").on(table.createdAt.desc()),
    pageIdx: index("wb_classifier_runs_page_idx").on(table.platformAccountId, table.createdAt.desc()),
  }),
);

// Per-(page, day) AI usage + cost counter — the per-page daily cap lives here
// (ai_usage_events is keyed to a human userId and has no platform_account_id).
export const wbLlmUsageDaily = pgTable(
  "wb_llm_usage_daily",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    feature: text("feature").notNull(),
    calls: integer("calls").default(0).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "wb_llm_usage_daily_pkey",
      columns: [table.platformAccountId, table.businessDate, table.feature],
    }),
  }),
);
