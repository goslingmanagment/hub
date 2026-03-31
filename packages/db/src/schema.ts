import {
  bigserial,
  bigint,
  boolean,
  check,
  date,
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
import { fanFlagTypes, userRoles } from "@agency_hub_core/shared";

export const platformEnum = pgEnum("platform", ["fansly", "onlyfans"]);
export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "running",
  "success",
  "partial",
  "failed",
  "skipped",
]);
export const syncStreamEnum = pgEnum("sync_stream", [
  "light",
  "followers",
  "transactions",
  "top_spenders",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "cleanup",
  "followers_reconcile",
]);
export const syncTaskEnum = pgEnum("sync_task", [
  "light",
  "followers",
  "transactions",
  "top_spenders",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "followers_reconcile",
]);
export const syncTargetStatusEnum = pgEnum("sync_target_status", [
  "active",
  "paused",
  "auth_failed",
  "disabled",
]);
export const syncTaskStatusEnum = pgEnum("sync_task_status", [
  "idle",
  "queued",
  "running",
  "retry_wait",
  "blocked",
  "paused",
]);
export const syncRequestReasonEnum = pgEnum("sync_request_reason", [
  "scheduled",
  "manual",
  "onboarding",
  "recovery",
  "anomaly",
]);
export const syncOperationSourceEnum = pgEnum("sync_operation_source", [
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
export const syncRequestAttemptStateEnum = pgEnum("sync_request_attempt_state", [
  "started",
  "success",
  "retry",
  "failed",
]);
export const syncRequestFailureKindEnum = pgEnum("sync_request_failure_kind", [
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
  "auth_failed",
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

export const platformAccounts = pgTable(
  "platform_accounts",
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
    platformAccountId: text("platform_account_id"),
    username: text("username"),
    displayName: text("display_name"),
    followerCount: integer("follower_count"),
    subscriberCount: integer("subscriber_count"),
    earningsBalanceMills: bigint("earnings_balance_mills", {
      mode: "bigint",
    }).default(0n).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastLightSyncAt: timestamp("last_light_sync_at", { withTimezone: true }),
    lastFollowerSyncAt: timestamp("last_follower_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    modelIdx: index("platform_accounts_model_idx").on(table.modelId),
    platformAccountUniq: unique("platform_accounts_platform_account_uniq").on(
      table.platform,
      table.platformAccountId,
    ),
  }),
);

export const platformAccountCredentials = pgTable("platform_account_credentials", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  platformAccountId: bigint("platform_account_id", { mode: "number" })
    .references(() => platformAccounts.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  encryptedSession: text("encrypted_session").notNull(),
  keyVersion: integer("key_version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const platformAccountProxies = pgTable("platform_account_proxies", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  platformAccountId: bigint("platform_account_id", { mode: "number" })
    .references(() => platformAccounts.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  url: text("url").notNull(),
  encryptedAuth: text("encrypted_auth"),
  keyVersion: integer("key_version"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notificationIncidents = pgTable(
  "notification_incidents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    incidentKey: text("incident_key").notNull().unique(),
    kind: notificationIncidentKindEnum("kind").notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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

export const syncOperations = pgTable(
  "sync_operations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    task: syncTaskEnum("task").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    source: syncOperationSourceEnum("source").notNull(),
    requestedByActor: text("requested_by_actor"),
    requestedByUserId: bigint("requested_by_user_id", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown>>().default({}).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountRequestedIdx: index("sync_operations_account_requested_idx").on(
      table.platformAccountId,
      table.requestedAt,
    ),
    generationUniq: unique("sync_operations_account_task_generation_uniq").on(
      table.platformAccountId,
      table.task,
      table.generation,
    ),
  }),
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    operationId: bigint("operation_id", { mode: "number" }).references(() => syncOperations.id, {
      onDelete: "set null",
    }),
    task: syncTaskEnum("task"),
    generation: bigint("generation", { mode: "number" }),
    leaseToken: text("lease_token"),
    stream: syncStreamEnum("stream").notNull(),
    trigger: text("trigger").notNull(),
    status: syncRunStatusEnum("status").notNull(),
    errorSummary: text("error_summary"),
    stats: jsonb("stats").$type<Record<string, unknown>>().default({}).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    accountStreamIdx: index("sync_runs_account_stream_idx").on(
      table.platformAccountId,
      table.stream,
      table.startedAt,
    ),
  }),
);

export const syncRequestAttempts = pgTable(
  "sync_request_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    syncRunId: bigint("sync_run_id", { mode: "number" })
      .references(() => syncRuns.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    operationId: bigint("operation_id", { mode: "number" }).references(() => syncOperations.id, {
      onDelete: "set null",
    }),
    task: syncTaskEnum("task"),
    generation: bigint("generation", { mode: "number" }),
    provider: platformEnum("provider").notNull(),
    stream: syncStreamEnum("stream").notNull(),
    operation: text("operation").notNull(),
    logicalRequestId: text("logical_request_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    state: syncRequestAttemptStateEnum("state").notNull(),
    failureKind: syncRequestFailureKindEnum("failure_kind"),
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
    runStartedIdx: index("sync_request_attempts_run_started_idx").on(
      table.syncRunId,
      table.startedAt,
    ),
    logicalIdx: index("sync_request_attempts_logical_idx").on(
      table.syncRunId,
      table.logicalRequestId,
      table.attemptNumber,
    ),
    retentionIdx: index("sync_request_attempts_retention_idx").on(table.startedAt),
  }),
);

export const syncRunEvents = pgTable(
  "sync_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    syncRunId: bigint("sync_run_id", { mode: "number" })
      .references(() => syncRuns.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    operationId: bigint("operation_id", { mode: "number" }).references(() => syncOperations.id, {
      onDelete: "set null",
    }),
    task: syncTaskEnum("task"),
    generation: bigint("generation", { mode: "number" }),
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
  }),
);

export const syncCheckpoints = pgTable(
  "sync_checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    stream: syncStreamEnum("stream").notNull(),
    cursorText: text("cursor_text"),
    cursorTimestamp: timestamp("cursor_timestamp", { withTimezone: true }),
    state: jsonb("state").$type<Record<string, unknown>>().default({}).notNull(),
    lastSuccessfulRunId: bigint("last_successful_run_id", { mode: "number" }).references(
      () => syncRuns.id,
      { onDelete: "set null" },
    ),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("sync_checkpoints_account_stream_uniq").on(
      table.platformAccountId,
      table.stream,
    ),
  }),
);

export const syncTasks = pgTable(
  "sync_tasks",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    task: syncTaskEnum("task").notNull(),
    status: syncTaskStatusEnum("status").default("idle").notNull(),
    desiredGeneration: bigint("desired_generation", { mode: "number" }).default(0).notNull(),
    runningGeneration: bigint("running_generation", { mode: "number" }),
    appliedGeneration: bigint("applied_generation", { mode: "number" }).default(0).notNull(),
    scheduleIntervalSeconds: integer("schedule_interval_seconds").notNull(),
    slotOffsetSeconds: integer("slot_offset_seconds").notNull(),
    lastScheduledSlot: bigint("last_scheduled_slot", { mode: "number" }).default(-1).notNull(),
    lastRequestedAt: timestamp("last_requested_at", { withTimezone: true }),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
    lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    retryClass: text("retry_class"),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    blockerType: text("blocker_type"),
    blockerCode: text("blocker_code"),
    blockerReason: text("blocker_reason"),
    blockedSince: timestamp("blocked_since", { withTimezone: true }),
    currentPhase: text("current_phase"),
    currentWorkClass: syncWorkClassEnum("current_work_class"),
    progressPayload: jsonb("progress_payload").$type<Record<string, unknown>>().default({}).notNull(),
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
      name: "sync_tasks_pkey",
      columns: [table.platformAccountId, table.task],
    }),
    freshnessIdx: index("sync_tasks_freshness_idx").on(table.task, table.lastSuccessAt),
    leaseIdx: index("sync_tasks_lease_idx").on(table.status, table.leaseExpiresAt),
    runnableIdx: index("sync_tasks_runnable_idx").on(
      table.status,
      table.retryAt,
      table.platformAccountId,
      table.task,
    ),
    scheduleIdx: index("sync_tasks_schedule_idx").on(
      table.status,
      table.lastScheduledSlot,
      table.platformAccountId,
      table.task,
    ),
  }),
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    task: syncTaskEnum("task").notNull(),
    cursorText: text("cursor_text"),
    cursorTimestamp: timestamp("cursor_timestamp", { withTimezone: true }),
    cursorGeneration: bigint("cursor_generation", { mode: "number" }),
    state: jsonb("state").$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastSuccessfulRunId: bigint("last_successful_run_id", { mode: "number" }).references(
      () => syncRuns.id,
      { onDelete: "set null" },
    ),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: "sync_cursors_pkey",
      columns: [table.platformAccountId, table.task],
    }),
  }),
);

export const syncStreamState = pgTable(
  "sync_stream_state",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    stream: syncStreamEnum("stream").notNull(),
    status: syncTargetStatusEnum("status").default("active").notNull(),
    cadenceSeconds: integer("cadence_seconds").notNull(),
    slotOffsetSeconds: integer("slot_offset_seconds").notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    basePriority: integer("base_priority").notNull(),
    effectivePriority: integer("effective_priority").notNull(),
    pendingReason: syncRequestReasonEnum("pending_reason").default("scheduled").notNull(),
    desiredRevision: bigint("desired_revision", { mode: "number" }).default(0).notNull(),
    satisfiedRevision: bigint("satisfied_revision", { mode: "number" }).default(0).notNull(),
    desiredAt: timestamp("desired_at", { withTimezone: true }),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown> | null>(),
    backoffUntil: timestamp("backoff_until", { withTimezone: true })
      .default(sql`'-infinity'::timestamptz`)
      .notNull(),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "sync_stream_state_pkey",
      columns: [table.platformAccountId, table.stream],
    }),
    dueIdx: index("sync_stream_state_due_idx").on(table.nextDueAt, table.platformAccountId),
    pendingIdx: index("sync_stream_state_pending_idx").on(
      table.effectivePriority,
      table.desiredAt,
      table.platformAccountId,
      table.stream,
    ),
    backoffIdx: index("sync_stream_state_backoff_idx").on(
      table.backoffUntil,
      table.platformAccountId,
    ),
    freshnessIdx: index("sync_stream_state_freshness_idx").on(
      table.stream,
      table.lastSucceededAt,
    ),
  }),
);

export const syncProviderRateLimits = pgTable(
  "sync_provider_rate_limits",
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
      name: "sync_provider_rate_limits_pkey",
      columns: [table.provider, table.scope, table.egressKey],
    }),
  }),
);

export const rawPayloads = pgTable(
  "raw_payloads",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    syncRunId: bigint("sync_run_id", { mode: "number" }).references(() => syncRuns.id, {
      onDelete: "set null",
    }),
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
    retainIdx: index("raw_payloads_retain_idx").on(table.retainUntil),
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
  },
  (table) => ({
    uniq: unique("fans_platform_user_uniq").on(table.platform, table.platformUserId),
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

export const fanPages = pgTable(
  "fan_pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    totalCreatorNetMills: bigint("total_creator_net_mills", { mode: "bigint" })
      .default(0n)
      .notNull(),
    currency: text("currency").default("USD").notNull(),
    isFollower: boolean("is_follower").default(false).notNull(),
    followerSince: timestamp("follower_since", { withTimezone: true }),
    isSubscriber: boolean("is_subscriber").default(false).notNull(),
    subscriberSince: timestamp("subscriber_since", { withTimezone: true }),
    subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
    autoRenew: boolean("auto_renew"),
    pageAlias: text("page_alias"),
    pageAliasSource: text("page_alias_source"),
    pageAliasSourceNoteId: text("page_alias_source_note_id"),
    pageAliasSyncedAt: timestamp("page_alias_synced_at", { withTimezone: true }),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("fan_pages_fan_account_uniq").on(table.fanId, table.platformAccountId),
    platformAccountIdx: index("fan_pages_platform_account_idx").on(table.platformAccountId),
    pageAliasIdx: index("fan_pages_platform_account_alias_idx").on(
      table.platformAccountId,
      table.pageAlias,
    ),
  }),
);

export const fanPageExternalNotes = pgTable(
  "fan_page_external_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
    uniq: unique("fan_page_external_notes_account_provider_external_note_uniq").on(
      table.platformAccountId,
      table.provider,
      table.externalNoteId,
    ),
    pageFanProviderIdx: index("fan_page_external_notes_page_fan_provider_idx").on(
      table.platformAccountId,
      table.fanId,
      table.provider,
    ),
    pageFanProviderActiveIdx: index("fan_page_external_notes_page_fan_provider_active_idx").on(
      table.platformAccountId,
      table.fanId,
      table.provider,
      table.isActive,
    ),
  }),
);

export const fanPageAliases = pgTable(
  "fan_page_aliases",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      name: "fan_page_aliases_pkey",
      columns: [table.platformAccountId, table.fanId, table.alias],
    }),
    aliasIdx: index("fan_page_aliases_platform_account_alias_idx").on(
      table.platformAccountId,
      table.alias,
    ),
    fanIdx: index("fan_page_aliases_fan_idx").on(table.fanId),
  }),
);

export const pageFollows = pgTable(
  "page_follows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
    platformSubscriptionId: text("platform_subscription_id").notNull().unique(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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

export const pageDmConversations = pgTable(
  "page_dm_conversations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
    uniq: unique("page_dm_conversations_account_conversation_uniq").on(
      table.platformAccountId,
      table.platformConversationId,
    ),
    fanIdx: index("page_dm_conversations_account_fan_idx").on(
      table.platformAccountId,
      table.fanId,
    ),
    visibleMessageIdx: index("page_dm_conversations_visible_message_idx").on(
      table.platformAccountId,
      table.isVisible,
      table.lastMessageAt.desc(),
      table.id.desc(),
    ),
    visibleUnreadIdx: index("page_dm_conversations_visible_unread_idx").on(
      table.platformAccountId,
      table.isVisible,
      table.unreadCount.desc(),
      table.lastMessageAt.desc(),
      table.id.desc(),
    ),
    backfillIdx: index("page_dm_conversations_backfill_idx").on(
      table.platformAccountId,
      table.isVisible,
      table.messageCoverageStatus,
      table.lastMessageSyncAt,
    ),
    generationIdx: index("page_dm_conversations_generation_idx").on(
      table.platformAccountId,
      table.lastSeenGeneration,
    ),
    storedMessageCountCheck: check(
      "page_dm_conversations_stored_message_count_check",
      sql`${table.storedMessageCount} between 0 and 25`,
    ),
  }),
);

export const pageDmMessages = pgTable(
  "page_dm_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: bigint("conversation_id", { mode: "number" })
      .references(() => pageDmConversations.id, { onDelete: "cascade" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
  }),
);

export const workboardSnoozes = pgTable(
  "workboard_snoozes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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

export const dailyRevenue = pgTable(
  "daily_revenue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    canonicalType: transactionTypeEnum("canonical_type").notNull(),
    transactionState: transactionStateEnum("transaction_state").notNull(),
    transactionCount: integer("transaction_count").default(0).notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(0n)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("daily_revenue_account_date_type_state_uniq").on(
      table.platformAccountId,
      table.businessDate,
      table.canonicalType,
      table.transactionState,
    ),
    accountDateIdx: index("daily_revenue_account_date_idx").on(
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

export const spenderDailyFacts = pgTable(
  "spender_daily_facts",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    canonicalType: transactionTypeEnum("canonical_type").notNull(),
    transactionState: transactionStateEnum("transaction_state").notNull(),
    transactionCount: integer("transaction_count").default(0).notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(0n)
      .notNull(),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "spender_daily_facts_pkey",
      columns: [
        table.platformAccountId,
        table.fanId,
        table.businessDate,
        table.canonicalType,
        table.transactionState,
      ],
    }),
    accountDateFanIdx: index("spender_daily_facts_account_date_fan_idx").on(
      table.platformAccountId,
      table.businessDate,
      table.fanId,
    ),
    fanAccountDateIdx: index("spender_daily_facts_fan_account_date_idx").on(
      table.fanId,
      table.platformAccountId,
      table.businessDate,
    ),
  }),
);

export const spenderLifetimePage = pgTable(
  "spender_lifetime_page",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(0n)
      .notNull(),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "spender_lifetime_page_pkey",
      columns: [table.platformAccountId, table.fanId],
    }),
    fanAccountIdx: index("spender_lifetime_page_fan_account_idx").on(
      table.fanId,
      table.platformAccountId,
    ),
  }),
);

export const pageTopSpenders = pgTable(
  "page_top_spenders",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
      .notNull(),
    sourceIdentityKey: text("source_identity_key").notNull(),
    correlationAccountId: text("correlation_account_id"),
    accountId: text("account_id"),
    fanId: bigint("fan_id", { mode: "number" }).references(() => fans.id, {
      onDelete: "set null",
    }),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" })
      .default(0n)
      .notNull(),
    sourceWindowStartedAt: timestamp("source_window_started_at", { withTimezone: true }).notNull(),
    sourceWindowEndedAt: timestamp("source_window_ended_at", { withTimezone: true }).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_top_spenders_pkey",
      columns: [table.platformAccountId, table.sourceIdentityKey],
    }),
    fanAccountIdx: index("page_top_spenders_fan_account_idx").on(
      table.fanId,
      table.platformAccountId,
    ),
  }),
);

export const spenderProjectionWatermarks = pgTable(
  "spender_projection_watermarks",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      () => platformAccounts.id,
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
      .references(() => platformAccounts.id, { onDelete: "cascade" })
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
