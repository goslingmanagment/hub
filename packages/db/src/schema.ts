import {
  bigserial,
  bigint,
  boolean,
  char,
  check,
  customType,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { aiUsageFeatures, fanFlagTypes, userRoles } from "@agency_hub_core/shared";
import type { ConfigOverrideValue, RunningSnapshot } from "@agency_hub_core/shared";

export type OfapiCommandKind =
  | "send_text_message_v1"
  | "send_media_message_v1"
  | "typing_active_v1"
  | "unsend_message_v1"
  | "mark_chat_read_v1";
export type OfapiCommandPayload =
  | { text: string }
  | {
    text: string;
    price: number;
    mediaFiles: string[];
    previews: string[];
  }
  | { messageId: string }
  | Record<string, never>;

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
  "ofapi_auth",
  "ofapi_low_credit",
  "ofapi_webhook_silence",
  "ofapi_burn_rate",
  "db_disk_usage",
  "observations_partitions",
  "wrong_transactions_writer",
]);
export const notificationIncidentStatusEnum = pgEnum("notification_incident_status", [
  "open",
  "resolved",
]);

export const models = pgTable("models", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
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
    // onlyfansapi.com account id ("acct_…") delivering webhook events for this
    // page; set by the OFAPI webhook admin flow. Distinct from external_page_id
    // (the OnlyMonster-sourced platform id).
    ofapiAccountId: text("ofapi_account_id"),
    // Latest accounts.* webhook state for the mapped OFAPI account (raw event
    // suffix, e.g. "connected" / "authentication_failed"); forward-only by
    // received_at. Null until the first accounts.* event is projected.
    ofapiAuthStatus: text("ofapi_auth_status"),
    ofapiAuthChangedAt: timestamp("ofapi_auth_changed_at", { withTimezone: true }),
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
    // Stage 13 soft-delete standard (formalizes Stage 2's interim column):
    // deletePageByLabel writes the tombstone; fact-table FKs are RESTRICT so a
    // hard DELETE on a fact-bearing page is structurally impossible.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    status: text("status").default("active").notNull(),
    // Stage 13 single-writer gate: which system may write transactions for
    // this page. NULL = no writer assigned yet (Stage 14 assigns per page).
    transactionsWriter: text("transactions_writer"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    modelIdx: index("pages_model_idx").on(table.modelId),
    platformAccountUniq: unique("pages_platform_external_id_uniq").on(
      table.platform,
      table.platformAccountId,
    ),
    ofapiAccountUniq: unique("pages_ofapi_account_uniq").on(table.ofapiAccountId),
    statusCheck: check("pages_status_check", sql`
      ${table.status} in ('active', 'deleted')
    `),
    transactionsWriterCheck: check("pages_transactions_writer_check", sql`
      ${table.transactionsWriter} in ('onlymonster', 'ofapi', 'fansly')
    `),
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
    // Null for account-global OFAPI incidents (low credit, webhook silence).
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" }),
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
  // Bumped only when the bot token / chat id change (not on flag edits), so the
  // connection status can ignore deliveries made with superseded credentials.
  credentialsUpdatedAt: timestamp("credentials_updated_at", { withTimezone: true }).defaultNow().notNull(),
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      sql`${table.storedMessageCount} between 0 and 1000`,
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
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platformMessageId: text("platform_message_id").notNull(),
    senderPlatformUserId: text("sender_platform_user_id"),
    senderRole: dmSenderRoleEnum("sender_role").default("unknown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    content: text("content").default("").notNull(),
    totalTipAmountCents: integer("total_tip_amount_cents").default(0).notNull(),
    inReplyToMessageId: text("in_reply_to_message_id"),
    inReplyToRootMessageId: text("in_reply_to_root_message_id"),
    // When the fan unlocked this message as PPV (OFAPI messages.ppv.unlocked).
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("page_dm_messages_conversation_message_uniq").on(
      table.conversationId,
      table.platformMessageId,
    ),
    accountMessageIdx: index("page_dm_messages_account_message_idx").on(
      table.platformAccountId,
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

export const dmMessageArchive = pgTable(
  "dm_message_archive",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: platformEnum("platform").notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    platformConversationId: text("platform_conversation_id"),
    fanPlatformUserId: text("fan_platform_user_id"),
    platformMessageId: text("platform_message_id").notNull(),
    senderPlatformUserId: text("sender_platform_user_id"),
    senderRole: dmSenderRoleEnum("sender_role").default("unknown").notNull(),
    isSentByMe: boolean("is_sent_by_me").default(false).notNull(),
    messageCreatedAt: timestamp("message_created_at", { withTimezone: true }),
    textPlain: text("text_plain").default("").notNull(),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    isOpened: boolean("is_opened"),
    isTip: boolean("is_tip").default(false).notNull(),
    tipAmountMills: bigint("tip_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    inReplyToMessageId: text("in_reply_to_message_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    source: text("source").$type<"webhook" | "command" | "rest_reconcile" | "rest_backfill">().notNull(),
    sourceEventType: text("source_event_type").$type<
      "messages.received" | "messages.sent" | "messages.deleted"
    >().notNull(),
    sourceIdempotencyKey: text("source_idempotency_key").notNull(),
    sourceJournalId: bigint("source_journal_id", { mode: "number" }).notNull(),
    sourceFanoutSeq: bigint("source_fanout_seq", { mode: "number" }),
    sourceReceivedAt: timestamp("source_received_at", { withTimezone: true }).notNull(),
    rawShapeVersion: text("raw_shape_version").default("ofapi-message-v1").notNull(),
    mediaMetadata: jsonb("media_metadata").$type<Array<Record<string, unknown>>>().default([]).notNull(),
    retentionPolicy: text("retention_policy").default("default").notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    platformAccountMessageUniq: uniqueIndex("dm_message_archive_platform_account_message_uniq")
      .on(table.platform, table.ofapiAccountId, table.platformMessageId),
    pageMessageCreatedIdx: index("dm_message_archive_page_message_created_idx")
      .on(table.platformAccountId, table.messageCreatedAt.desc(), table.id.desc()),
    pageConversationIdx: index("dm_message_archive_page_conversation_idx")
      .on(table.platformAccountId, table.platformConversationId, table.messageCreatedAt.desc()),
    retainUntilIdx: index("dm_message_archive_retain_until_idx").on(table.retainUntil),
    sourceJournalIdx: index("dm_message_archive_source_journal_idx").on(table.sourceJournalId),
    sourceCheck: check("dm_message_archive_source_check", sql`
      ${table.source} in ('webhook', 'command', 'rest_reconcile', 'rest_backfill')
    `),
    eventTypeCheck: check("dm_message_archive_event_type_check", sql`
      ${table.sourceEventType} in ('messages.received', 'messages.sent', 'messages.deleted')
    `),
    tipNonnegativeCheck: check("dm_message_archive_tip_nonnegative_check", sql`
      ${table.tipAmountMills} >= 0
    `),
    priceNonnegativeCheck: check("dm_message_archive_price_nonnegative_check", sql`
      ${table.priceMills} is null or ${table.priceMills} >= 0
    `),
  }),
);

// Replaceable aggregate-only facts derived from dm_message_archive. This table
// deliberately contains no transcript text, media metadata, or fan identifiers.
export const dmMessageDailyAggregates = pgTable(
  "dm_message_daily_aggregates",
  {
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    archiveRows: integer("archive_rows").default(0).notNull(),
    inboundMessages: integer("inbound_messages").default(0).notNull(),
    outboundMessages: integer("outbound_messages").default(0).notNull(),
    deletedMessages: integer("deleted_messages").default(0).notNull(),
    distinctConversations: integer("distinct_conversations").default(0).notNull(),
    paidOutboundMessages: integer("paid_outbound_messages").default(0).notNull(),
    paidOutboundPriceMills: bigint("paid_outbound_price_mills", { mode: "bigint" })
      .default(0n)
      .notNull(),
    tipMessages: integer("tip_messages").default(0).notNull(),
    tipAmountMills: bigint("tip_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    sourceMaxFanoutSeq: bigint("source_max_fanout_seq", { mode: "number" }),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "dm_message_daily_aggregates_pkey",
      columns: [table.platformAccountId, table.businessDate],
    }),
    dateIdx: index("dm_message_daily_aggregates_date_idx").on(
      table.businessDate.desc(),
      table.platformAccountId,
    ),
    countsNonnegativeCheck: check("dm_message_daily_aggregates_counts_nonnegative_check", sql`
      ${table.archiveRows} >= 0
      and ${table.inboundMessages} >= 0
      and ${table.outboundMessages} >= 0
      and ${table.deletedMessages} >= 0
      and ${table.distinctConversations} >= 0
      and ${table.paidOutboundMessages} >= 0
      and ${table.paidOutboundPriceMills} >= 0
      and ${table.tipMessages} >= 0
      and ${table.tipAmountMills} >= 0
    `),
  }),
);

export const ofapiCommands = pgTable(
  "ofapi_commands",
  {
    id: uuid("id").primaryKey(),
    clientCommandId: uuid("client_command_id").notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    chatterUserId: bigint("chatter_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").$type<OfapiCommandKind>().notNull(),
    payload: jsonb("payload").$type<OfapiCommandPayload>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    retryOfCommandId: uuid("retry_of_command_id"),
    state: text("state").$type<
      | "queued"
      | "in_flight"
      | "confirmed"
      | "failed_retryable"
      | "failed_terminal"
      | "indeterminate"
      | "cancelled"
    >().default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorClass: text("last_error_class"),
    verifierResult: jsonb("verifier_result").$type<Record<string, unknown>>(),
    platformMessageId: text("platform_message_id"),
    attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
    attemptFinishedAt: timestamp("attempt_finished_at", { withTimezone: true }),
    payloadRedactedAt: timestamp("payload_redacted_at", { withTimezone: true }),
    dedupeExpiresAt: timestamp("dedupe_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pageChatterClientUniq: uniqueIndex("ofapi_commands_page_chatter_client_uniq")
      .on(table.pageId, table.chatterUserId, table.clientCommandId),
    oneInFlightLaneUniq: uniqueIndex("ofapi_commands_one_in_flight_lane_uniq")
      .on(table.pageId, table.conversationId)
      .where(sql`${table.state} = 'in_flight'`),
    chatterCreatedIdx: index("ofapi_commands_chatter_created_idx")
      .on(table.chatterUserId, table.createdAt.desc()),
    pageLaneCreatedIdx: index("ofapi_commands_page_lane_created_idx")
      .on(table.pageId, table.conversationId, table.createdAt),
    dedupeExpiresIdx: index("ofapi_commands_dedupe_expires_idx").on(table.dedupeExpiresAt),
    queuedCreatedIdx: index("ofapi_commands_queued_created_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'queued'`),
    verifierCandidateIdx: index("ofapi_commands_verifier_candidate_idx")
      .on(table.ofapiAccountId, table.conversationId, table.attemptStartedAt)
      .where(sql`${table.state} in ('in_flight', 'indeterminate')`),
    payloadRedactionIdx: index("ofapi_commands_payload_redaction_idx")
      .on(table.updatedAt)
      .where(sql`
        ${table.payloadRedactedAt} is null
        and ${table.state} in ('confirmed', 'failed_retryable', 'failed_terminal', 'cancelled')
      `),
    retryCommandFk: foreignKey({
      name: "ofapi_commands_retry_of_command_id_fk",
      columns: [table.retryOfCommandId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    kindCheck: check("ofapi_commands_kind_check", sql`
      ${table.kind} in (
        'send_text_message_v1',
        'send_media_message_v1',
        'typing_active_v1',
        'unsend_message_v1',
        'mark_chat_read_v1'
      )
    `),
    stateCheck: check("ofapi_commands_state_check", sql`
      ${table.state} in (
        'queued',
        'in_flight',
        'confirmed',
        'failed_retryable',
        'failed_terminal',
        'indeterminate',
        'cancelled'
      )
    `),
    attemptNonnegativeCheck: check("ofapi_commands_attempt_count_nonnegative_check", sql`
      ${table.attemptCount} >= 0
    `),
    attemptMaxOneCheck: check("ofapi_commands_attempt_count_max_one_check", sql`
      ${table.attemptCount} <= 1
    `),
    accountIdCheck: check("ofapi_commands_account_id_check", sql`
      ${table.ofapiAccountId} ~ '^acct_[A-Za-z0-9]+$'
    `),
    conversationIdCheck: check("ofapi_commands_conversation_id_check", sql`
      ${table.conversationId} ~ '^[0-9]{1,30}$'
    `),
    payloadHashCheck: check("ofapi_commands_payload_hash_check", sql`
      ${table.payloadHash} ~ '^[0-9a-f]{64}$'
    `),
    dedupeHorizonCheck: check("ofapi_commands_dedupe_horizon_check", sql`
      ${table.dedupeExpiresAt} >= ${table.createdAt}
    `),
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
      .references(() => pages.id, { onDelete: "restrict" })
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
    // Stage 13 provenance: which system wrote this row. Open set (text +
    // CHECK, not pgEnum) so later producers extend without enum surgery.
    source: text("source").notNull(),
    // Plain bigint, NOT an FK: observations' PK is (id, received_at) because
    // of partitioning — PG cannot FK the partitioned table on id alone.
    sourceObservationId: bigint("source_observation_id", { mode: "number" }),
    currency: char("currency", { length: 3 }).default("USD").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("transactions_account_transaction_uniq").on(
      table.platformAccountId,
      table.transactionId,
    ),
    sourceIdx: index("transactions_source_idx").on(table.source),
    sourceCheck: check("transactions_source_check", sql`
      ${table.source} in ('onlymonster', 'ofapi:webhook', 'ofapi:rest', 'fansly:rest', 'harvest')
    `),
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
    pageId: bigint("page_id", { mode: "number" }).references(() => pages.id, {
      onDelete: "set null",
    }),
    clientEventId: text("client_event_id").notNull(),
    feature: aiUsageFeatureEnum("feature").notNull(),
    model: text("model").notNull(),
    provider: text("provider").$type<"anthropic" | "openrouter">(),
    providerResponseId: text("provider_response_id"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    costMicroUsd: integer("cost_micro_usd").default(0).notNull(),
    costApproximate: boolean("cost_approximate").default(false).notNull(),
    quotaAccepted: boolean("quota_accepted"),
    gatewayOutcome: text("gateway_outcome").$type<
      "completed" | "failed" | "cancelled" | "quota_denied"
    >(),
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
    pageCompletedIdx: index("ai_usage_events_page_completed_idx").on(
      table.pageId,
      table.completedAt,
    ),
    providerResponseIdx: index("ai_usage_events_provider_response_idx")
      .on(table.provider, table.providerResponseId)
      .where(sql`${table.providerResponseId} is not null`),
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
    costNonnegative: check(
      "ai_usage_events_cost_micro_usd_nonnegative",
      sql`${table.costMicroUsd} >= 0`,
    ),
    durationNonnegative: check(
      "ai_usage_events_duration_ms_nonnegative",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
    providerCheck: check("ai_usage_events_provider_check", sql`
      ${table.provider} is null or ${table.provider} in ('anthropic', 'openrouter')
    `),
    gatewayOutcomeCheck: check("ai_usage_events_gateway_outcome_check", sql`
      ${table.gatewayOutcome} is null or ${table.gatewayOutcome} in (
        'completed',
        'failed',
        'cancelled',
        'quota_denied'
      )
    `),
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
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
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "cascade" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    action: workboardContactActionEnum("action").notNull(),
    wasProductive: boolean("was_productive").default(false).notNull(),
    actedAt: timestamp("acted_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Stage 2: undo marks the row retracted instead of deleting it (interim
    // form of Stage 23's contact.retracted compensating event). NULL = active.
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
  },
  (table) => ({
    pageFanActedIdx: index("workboard_contact_log_page_fan_acted_idx").on(
      table.platformAccountId,
      table.fanId,
      table.actedAt.desc(),
    ),
    activeIdx: index("workboard_contact_log_active_idx")
      .on(table.platformAccountId, table.fanId)
      .where(sql`${table.retractedAt} is null`),
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
    // Stage 2: reclassify soft-supersedes verdicts (append log) instead of
    // wholesale delete. NULL = the active verdict for this message.
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => ({
    // Uniqueness applies to active rows only, so a fresh run can insert a new
    // verdict for a message whose prior verdict was superseded.
    activeUniq: uniqueIndex("wb_closing_cache_message_active_uniq")
      .on(table.platformAccountId, table.platformMessageId)
      .where(sql`${table.supersededAt} is null`),
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
      .references(() => pages.id, { onDelete: "restrict" })
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

// Singleton registration record for the onlyfansapi.com webhook (signing secret is
// an encryptJson envelope, same custody model as telegram_settings.encrypted_bot_token).
// The previous secret is kept so deliveries signed during a rotation keep verifying.
export const ofapiWebhookConfig = pgTable("ofapi_webhook_config", {
  id: integer("id").primaryKey().default(1),
  externalWebhookId: text("external_webhook_id"),
  endpointUrl: text("endpoint_url").notNull(),
  accountScope: text("account_scope").default("global").notNull(),
  events: jsonb("events").$type<string[]>().default([]).notNull(),
  encryptedSigningSecret: text("encrypted_signing_secret").notNull(),
  previousEncryptedSigningSecret: text("previous_encrypted_signing_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Singleton tracking the OFAPI credit budget across all pages: per-UTC-day REST
// spend (OFAPI_DM_DAILY_CREDIT_BUDGET) and the last _meta._credits.balance seen
// on any REST response (OFAPI_CREDIT_FLOOR + ops visibility). Credits are
// account-global at OFAPI, so this is deliberately not per page.
export const ofapiCreditState = pgTable("ofapi_credit_state", {
  id: integer("id").primaryKey().default(1).notNull(),
  spendDay: date("spend_day"),
  spentCredits: integer("spent_credits").default(0).notNull(),
  // The audience sweep's own day counter (audit F9): budget checks reserve
  // against it in one conditional update before each request, settled to
  // _meta actuals after — the ledger-attributed SUM it replaced could not see
  // in-flight spend, so concurrent streams near the cap could overspend.
  audienceSpendDay: date("audience_spend_day"),
  audienceSpentCredits: integer("audience_spent_credits").default(0).notNull(),
  lastBalance: integer("last_balance"),
  lastBalanceAt: timestamp("last_balance_at", { withTimezone: true }),
  // Reconciliation cursor (D5): the last balance-observation ledger row that
  // has been decomposed, plus the residual seen on the most recent pair.
  reconciledThroughLedgerId: bigint("reconciled_through_ledger_id", { mode: "number" }),
  lastReconcileAt: timestamp("last_reconcile_at", { withTimezone: true }),
  lastDriftCredits: integer("last_drift_credits"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const OFAPI_CREDIT_LEDGER_SOURCES = [
  "rest",
  "webhook_accrual",
  "external",
  "refill",
  "adjustment",
] as const;

// Append-only OFAPI credit movement (docs/ofapi-parity-plan.md D2-D5): the
// checkbook the bank-statement reconciliation balances against. 'rest' rows
// are written by the client's onCreditSpend sink (one per response that
// reached the server, retries included; estimated=true when a 2xx had no
// _meta); 'webhook_accrual' posts ceil(events/100) per UTC day from the
// journal; 'external'/'refill' are reconciliation residuals; 'adjustment' is
// manual. credits: positive = spent, negative = added.
export const ofapiCreditLedger = pgTable(
  "ofapi_credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    operation: text("operation"),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "set null" }),
    httpStatus: integer("http_status"),
    credits: integer("credits").notNull(),
    estimated: boolean("estimated").default(false).notNull(),
    balanceAfter: integer("balance_after"),
    requestId: text("request_id"),
    accrualDay: date("accrual_day"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (table) => ({
    occurredAtIdx: index("ofapi_credit_ledger_occurred_at_idx").on(table.occurredAt),
    sourceOccurredAtIdx: index("ofapi_credit_ledger_source_occurred_at_idx")
      .on(table.source, table.occurredAt),
    // A4: cover the owner ledger list's filtered + ordered + paginated paths
    // (ORDER BY occurred_at desc, id desc, filtered by page_id / operation).
    pageOccurredAtIdx: index("ofapi_credit_ledger_page_occurred_at_id_idx")
      .on(table.pageId, table.occurredAt.desc(), table.id.desc()),
    operationOccurredAtIdx: index("ofapi_credit_ledger_operation_occurred_at_id_idx")
      .on(table.operation, table.occurredAt.desc(), table.id.desc()),
    occurredAtIdIdx: index("ofapi_credit_ledger_occurred_at_id_idx")
      .on(table.occurredAt.desc(), table.id.desc()),
    balanceObservationIdx: index("ofapi_credit_ledger_balance_observation_idx")
      .on(table.id)
      .where(sql`${table.balanceAfter} is not null`),
    accrualDayUniq: uniqueIndex("ofapi_credit_ledger_accrual_day_uniq")
      .on(table.accrualDay)
      .where(sql`${table.source} = 'webhook_accrual'`),
  }),
);

// Shadow-only spend projection from OFAPI webhook journal rows (ChatGoose C3).
// This is not production revenue truth; it exists to compare webhook-derived
// spend signals against the existing transactions/desktop sweep before D6 can
// reduce polling. Tips remain "blocked" until a live fixture verifies shape.
export const ofapiSpendProjectionEvents = pgTable(
  "ofapi_spend_projection_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    domainKey: text("domain_key").notNull(),
    projectionStatus: text("projection_status").notNull(),
    blockedReason: text("blocked_reason"),
    sourceEventType: text("source_event_type").notNull(),
    sourceIdempotencyKey: text("source_idempotency_key").notNull(),
    journalId: bigint("journal_id", { mode: "number" }).notNull(),
    fanoutSeq: bigint("fanout_seq", { mode: "number" }),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "set null" }),
    fanPlatformUserId: text("fan_platform_user_id"),
    transactionId: text("transaction_id"),
    messageId: text("message_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    category: text("category"),
    currency: text("currency"),
    grossAmountMills: bigint("gross_amount_mills", { mode: "bigint" }),
    creatorNetAmountMills: bigint("creator_net_amount_mills", { mode: "bigint" }),
    eventStatus: text("event_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    domainKeyUniq: uniqueIndex("ofapi_spend_projection_events_domain_key_uniq")
      .on(table.domainKey),
    pageOccurredIdx: index("ofapi_spend_projection_events_page_occurred_idx")
      .on(table.pageId, table.occurredAt),
    statusIdx: index("ofapi_spend_projection_events_status_idx")
      .on(table.projectionStatus, table.sourceEventType),
    journalIdx: index("ofapi_spend_projection_events_journal_idx")
      .on(table.journalId),
    projectionStatusCheck: check("ofapi_spend_projection_status_check", sql`
      ${table.projectionStatus} in ('projected', 'blocked', 'skipped')
    `),
    sourceEventTypeCheck: check("ofapi_spend_projection_event_type_check", sql`
      ${table.sourceEventType} in ('transactions.new', 'tips.received', 'messages.ppv.unlocked')
    `),
    categoryCheck: check("ofapi_spend_projection_category_check", sql`
      ${table.category} is null
      or ${table.category} in ('message', 'tip', 'subscription', 'post', 'stream', 'other')
    `),
    currencyCheck: check("ofapi_spend_projection_currency_check", sql`
      ${table.currency} is null or ${table.currency} = 'USD'
    `),
    eventStatusCheck: check("ofapi_spend_projection_event_status_check", sql`
      ${table.eventStatus} is null
      or ${table.eventStatus} in ('pending', 'settled', 'reversed', 'estimated')
    `),
  }),
);

// Journal of received OFAPI webhook deliveries; sync_event/platform_account_id are
// filled in by the async pg-boss processor. fanout_seq (assigned in settle order from
// ofapi_webhook_events_fanout_seq) is the SSE event id for Last-Event-ID replay —
// receive-time ids would make late settles (retries, sweep) invisible to advanced
// cursors. Rows are pruned after OFAPI_EVENT_RETENTION_DAYS (~7d).
// status: 'pending' (acked, awaiting processing) | 'processed' (frame derived) |
// 'skipped' (no fanout: unmapped account or journal-only event type) | 'failed'.
export const ofapiWebhookEvents = pgTable(
  "ofapi_webhook_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    ofapiAccountId: text("ofapi_account_id"),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    syncEvent: jsonb("sync_event").$type<Record<string, unknown>>(),
    fanoutSeq: bigint("fanout_seq", { mode: "number" }),
    status: text("status").default("pending").notNull(),
    error: text("error"),
    // DM projection bookkeeping (decision #49), separate from the settle path on
    // purpose: settle/fanout never waits on or fails with the projection.
    // 'none' = event type is not projected; 'pending' = awaiting projection
    // (picked up post-settle or by the minutely sweep); 'projected' | 'skipped' |
    // 'failed' are terminal except that the sweep retries 'failed' rows while
    // projection_attempts stays under its cap.
    projectionStatus: text("projection_status").default("none").notNull(),
    projectionError: text("projection_error"),
    projectionAttempts: integer("projection_attempts").default(0).notNull(),
    projectedAt: timestamp("projected_at", { withTimezone: true }),
    archiveStatus: text("archive_status").default("none").notNull(),
    archiveError: text("archive_error"),
    archiveAttempts: integer("archive_attempts").default(0).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    idempotencyUniq: unique("ofapi_webhook_events_idempotency_uniq").on(table.idempotencyKey),
    receivedIdx: index("ofapi_webhook_events_received_idx").on(table.receivedAt),
    statusIdx: index("ofapi_webhook_events_status_idx").on(table.status, table.id),
    projectionIdx: index("ofapi_webhook_events_projection_idx")
      .on(table.projectionStatus, table.id)
      .where(sql`${table.projectionStatus} in ('pending', 'failed')`),
    archiveIdx: index("ofapi_webhook_events_archive_idx")
      .on(table.archiveStatus, table.id)
      .where(sql`${table.archiveStatus} in ('pending', 'failed')`),
    fanoutSeqUniq: uniqueIndex("ofapi_webhook_events_fanout_seq_uniq")
      .on(table.fanoutSeq)
      .where(sql`${table.fanoutSeq} is not null`),
    replayIdx: index("ofapi_webhook_events_replay_idx")
      .on(table.platformAccountId, table.fanoutSeq)
      .where(sql`${table.fanoutSeq} is not null`),
    archiveStatusCheck: check("ofapi_webhook_events_archive_status_check", sql`
      ${table.archiveStatus} in ('none', 'pending', 'archived', 'skipped', 'failed')
    `),
  }),
);

// Heartbeat table for the in-dashboard Configuration surface. Each running process
// (api, worker) upserts a row carrying the sanitized config values it is actually
// using (RunningSnapshot from the config registry), so the page can show per-instance
// running values and detect drift between the api and worker containers. No secret
// values are ever stored here — only set/unset state. Stale rows (last_seen_at past
// the TTL) are reaped; instance_id makes the PK survive multiple processes per role.
export const runtimeInstances = pgTable(
  "runtime_instances",
  {
    role: text("role").notNull(),
    instanceId: text("instance_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    imageTag: text("image_tag"),
    running: jsonb("running").$type<RunningSnapshot>().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "runtime_instances_pkey",
      columns: [table.role, table.instanceId],
    }),
    lastSeenIdx: index("runtime_instances_last_seen_idx").on(table.lastSeenAt),
  }),
);

// Per-key override overlay for the in-dashboard Configuration surface (Stage B0).
// Only the editable knobs in the descriptor registry are ever written here; the
// value is validated/clamped server-side before it lands. Scope columns are
// future-proofed for per-page overrides, but only the global scope (scope_type
// 'global', scope_id 0) is used today. scope_id is NOT NULL (0 = global) so the
// uniqueness constraint is reliable — Postgres treats NULLs as distinct.
export const configSettings = pgTable(
  "config_settings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scopeType: text("scope_type").notNull().default("global"),
    scopeId: bigint("scope_id", { mode: "number" }).notNull().default(0),
    key: text("key").notNull(),
    value: jsonb("value").$type<ConfigOverrideValue>().notNull(),
    version: integer("version").notNull().default(1),
    updatedByUserId: bigint("updated_by_user_id", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    scopeKeyUniq: unique("config_settings_scope_key_uniq").on(
      table.scopeType,
      table.scopeId,
      table.key,
    ),
  }),
);

// Append-only audit trail for config overrides. One multi-key patch shares a
// group_id; each row records the per-key old/new value and version so any change
// is reconstructible. A clear (revert to env) is recorded with new_value /
// new_version null.
export const configAuditLog = pgTable(
  "config_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    groupId: uuid("group_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    scopeType: text("scope_type").notNull(),
    scopeId: bigint("scope_id", { mode: "number" }).notNull(),
    key: text("key").notNull(),
    oldValue: jsonb("old_value").$type<ConfigOverrideValue>(),
    newValue: jsonb("new_value").$type<ConfigOverrideValue>(),
    oldVersion: integer("old_version"),
    newVersion: integer("new_version"),
    note: text("note"),
  },
  (table) => ({
    changedAtIdx: index("config_audit_log_changed_at_idx").on(table.changedAt),
    groupIdx: index("config_audit_log_group_idx").on(table.groupId),
  }),
);

// ── Observations journal (kernel Stage 7) ────────────────────────────────────
// The universal append-only capture spine: every server-side producer writes
// here unconditionally (no capture flags, by construction). Partitioned
// monthly by received_at; PG requires unique constraints on partitioned
// tables to include the partition key, so dedup lives in the unpartitioned
// companion observation_keys. account_id has NO FK by design — unmapped
// accounts are captured too; integrity is the insert protocol's job
// (repositories/observations.ts). Nothing consumes this until Stage 8.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const OBSERVATION_SOURCES = [
  "webhook",
  "pull",
  "client_capture",
  "readthrough",
  "command_result",
  "operator",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const observations = pgTable(
  "observations",
  {
    // GENERATED ALWAYS AS IDENTITY in the migration; inserts go through the
    // repository's pre-allocated-id protocol (OVERRIDING SYSTEM VALUE).
    id: bigint("id", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    producer: text("producer").notNull(),
    // FK -> platforms.key arrives with Stage 18; plain text until then.
    platform: text("platform"),
    accountId: bigint("account_id", { mode: "number" }),
    nativeAccountRef: text("native_account_ref"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: bytea("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    actorPrincipalId: bigint("actor_principal_id", { mode: "number" }),
    parseVersion: integer("parse_version").default(0).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.receivedAt] }),
    accountReceivedIdx: index("observations_account_received_idx").on(table.accountId, table.receivedAt),
    kindReceivedIdx: index("observations_kind_received_idx").on(table.kind, table.receivedAt),
    parseIdx: index("observations_parse_idx").on(table.parseVersion, table.receivedAt),
    sourceCheck: check("observations_source_check", sql`
      ${table.source} in ('webhook','pull','client_capture','readthrough','command_result','operator')
    `),
  }),
);

export const observationKeys = pgTable(
  "observation_keys",
  {
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    observationId: bigint("observation_id", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.idempotencyKey] }),
  }),
);

// Stage 8: canonical domain events derived from observations. Partitioned
// monthly by occurred_at (historical range — backfills reach 2024); the
// gapless per-account sequence and cross-producer dedup live in the
// unpartitioned companions (same PG limitation as observations).
export const domainEvents = pgTable(
  "domain_events",
  {
    // GENERATED ALWAYS AS IDENTITY in the migration; inserts go through the
    // append protocol's pre-allocated-id path (OVERRIDING SYSTEM VALUE).
    id: bigint("id", { mode: "number" }).notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountSeq: bigint("account_seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Platform-native fan id; platform_identities FK arrives with Stage 18+.
    fanIdentityRef: text("fan_identity_ref"),
    conversationRef: text("conversation_ref"),
    messageRef: text("message_ref"),
    transactionRef: text("transaction_ref"),
    data: jsonb("data").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    observationId: bigint("observation_id", { mode: "number" }).notNull(),
    dedupKey: text("dedup_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.occurredAt] }),
    accountSeqIdx: index("domain_events_account_seq_idx").on(table.accountId, table.accountSeq),
    typeOccurredIdx: index("domain_events_type_occurred_idx").on(table.type, table.occurredAt),
  }),
);

export const domainEventKeys = pgTable(
  "domain_event_keys",
  {
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    dedupKey: text("dedup_key").notNull(),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.accountId, table.dedupKey] }),
  }),
);

export const domainEventSeq = pgTable(
  "domain_event_seq",
  {
    accountId: bigint("account_id", { mode: "number" }).primaryKey(),
    nextSeq: bigint("next_seq", { mode: "number" }).default(1).notNull(),
  },
);
