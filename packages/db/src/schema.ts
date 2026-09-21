import type { OfapiExtendedCommandKind, OfapiExtendedCommandPayload } from "@agency_hub_core/shared";
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
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  aiUsageFeatures,
  fanFlagTypes,
  userRoles,
} from "@agency_hub_core/shared";
import type {
  ConfigOverrideValue,
  ofapiCaptureJobStates,
  RunningSnapshot,
} from "@agency_hub_core/shared";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ── jsonb reads are SINGLE-parse (decision #216) ─────────────────────────────
// drizzle-orm 0.45.2's BUILTIN `jsonb` column double-parses on READ:
//
//   mapFromDriverValue(value) {
//     if (typeof value === "string") {
//       try { return JSON.parse(value); } catch { return value; }
//     }
//     return value;
//   }
//
// node-postgres has ALREADY run JSON.parse on the jsonb wire value by the time
// drizzle sees it. So a jsonb value that IS a JSON string arrives as a JS
// string and is parsed a SECOND time: stored `"4"` reads back as the NUMBER 4,
// stored `"true"` as the BOOLEAN true, stored `"{\"a\":1}"` as an OBJECT. Bare
// words like `"enforce"` survive only by accident — their second JSON.parse
// throws and the catch hands back the string. The corruption is silent and
// type-dependent, which is what makes it nasty.
//
// This bit production on 2026-08-16. The `config_settings` row
// `captureCasDualWritePages` was set to the string "4" (a CSV of canary page
// ids). It read back as the number 4; `validateConfigOverride` rejected it
// ("expects a string"); the live overlay silently dropped the override; the G5
// CAS dual-write canary never turned on — and nothing logged an error anywhere.
//
// `jsonbSafe` returns the driver value AS-IS on read and serializes exactly
// once on write — `JSON.stringify(value)`, byte-identical to what the builtin
// sends. THE WIRE/WRITE FORMAT IS UNCHANGED: this is a read-side fix only, and
// already-stored data is already correct (no migration).
//
// EVERY jsonb column in this schema uses it, not only the scalar-valued ones.
// Object/array columns are unaffected today (the driver hands drizzle an
// object, which both implementations pass through untouched) — but they sit one
// refactor away from the trap the moment a payload can be a bare JSON string,
// and "safe only because of what we happen to store" is not an invariant. So
// the safe type is the uniform default here and the builtin `jsonb` import is
// lint-banned repo-wide (eslint.config.mjs) to keep it that way.
const jsonbSafe = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value;
  },
});

export type OfapiCommandKind = OfapiExtendedCommandKind
  | "send_text_message_v1"
  | "send_media_message_v1"
  | "typing_active_v1"
  | "unsend_message_v1"
  | "mark_chat_read_v1";
export type OfapiCommandPayload = OfapiExtendedCommandPayload
  | { text: string }
  | {
    text: string;
    price: number;
    mediaFiles: string[];
    previews: string[];
  }
  | { messageId: string }
  | Record<string, never>;

// Kernel Stage 18: the platform vocabulary is a reference table (migration
// 0068), not a pg enum — adding platform #3 is an INSERT plus an adapter
// package, never an ALTER TYPE. The columns stay text with a FK to
// platforms.key; the TS union below keeps compile-time narrowing.
export const platforms = pgTable("platforms", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  adapterVersion: text("adapter_version").notNull().default("1"),
});

const PLATFORM_KEYS = ["fansly", "onlyfans"] as const;

function platformColumn(name: string) {
  return text(name, { enum: PLATFORM_KEYS });
}
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
  "fan_earnings",
  "purchase_history",
  "posts",
  // WP-F1 (migration 0131): the account-level statistics sweep.
  "stats_snapshot",
  // WP-F2 (migration 0133): the notification poll — the only permanently-lossy
  // lane, which is why it is `live` rather than maintenance.
  "notifications",
  // WP-F3 (migration 0135): the daily content-catalog sweep — the lane that
  // measures M, the media denominator WP-F4 is sized against.
  "catalog",
  // WP-F5 (migration 0137): the comment archive walk over
  // `/post/{postId}/replies`. History class — a big back-catalogue on a small
  // daily budget, and the ONLY lane whose existence had to be probed first
  // ([E1]: the bare GET works, so no POST is ever issued).
  "post_replies",
  // WP-F7 (migration 0140): the money-out lane — `/payments/payoutmethods` and
  // `/payments/payout/requests`, two routes, both GET. Maintenance class at
  // 86 400 s: a payout moves in days, and the whole steady state is two calls.
  "payouts",
  // WP-F4 (migration 0142): per-media statistics — `/it/moie/statsnew` over the
  // WHOLE catalogue at an age-decayed cadence. The highest fan-out lane here,
  // and the only one designed to run at 100 % of its own cap.
  "media_stats",
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
  "event",
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
  // A local collection-policy refusal before any fetch (0169); never a
  // vendor or transport failure.
  "policy",
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
  // W7.3 (A21+B4, decision #132): negation guards. Unlike
  // missing_from_sync_window (which a re-appearing row reactivates), these
  // two are STICKY — only the explicit late-original fixup may clear them.
  "superseded_duplicate_negation",
  "reversal_without_settled_original",
]);
export const notificationIncidentKindEnum = pgEnum("notification_incident_kind", [
  "auth_blocked",
  "proxy_failed",
  "proxy_missing",
  "stream_failed_threshold",
  "ofapi_auth",
  "ofapi_low_credit",
  "ofapi_webhook_silence",
  "ofapi_burn_rate",
  "db_disk_usage",
  "observations_partitions",
  "wrong_transactions_writer",
  "read_gateway_capture",
  "golden_signal_lag",
  "scheduler_silent",
  "ops_sampler_silent",
  "ofapi_chargebacks_reconcile_failed",
  "ofapi_link_stats_reconcile_failed",
  "ai_provider_billing",
  "ai_provider_failed",
  // G5 slice 1 (0124): the content-addressed capture copy disagrees with the
  // inline authority, or points at an object that is not there.
  "capture_payload_parity",
  "ofapi_binding_conflict",
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

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    username: text("username").notNull(),
    role: userRoleEnum("role").notNull(),
    passwordHash: text("password_hash"),
    mustChangePassword: boolean("must_change_password").default(false).notNull(),
    deviceTokenEpoch: bigint("device_token_epoch", { mode: "number" }).default(0).notNull(),
    // Deactivation tombstone (decision #126, mirrors the Stage 13 pages
    // standard): NULL = active. Set freezes every auth path; never hard-delete.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    // Permanent account deletion releases the login, never the immutable id
    // or historical attribution. A deleted row can never be restored.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Only living accounts reserve a case-insensitive login. Disabled accounts
    // still reserve it; permanent deletion permits a distinct new identity.
    usernameLowerUidx: uniqueIndex("users_username_lower_uidx")
      .on(sql`lower(${table.username})`)
      .where(sql`${table.deletedAt} is null`),
  }),
);

export const pages = pgTable(
  "pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modelId: bigint("model_id", { mode: "number" })
      .references(() => models.id, { onDelete: "cascade" })
      .notNull(),
    platform: platformColumn("platform").notNull(),
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
    ofapiBindingGeneration: integer("ofapi_binding_generation").notNull().default(1),
    ofapiAuthStatus: text("ofapi_auth_status"),
    // Verified apply stores null status with the authenticated roster receipt as the forward-only boundary.
    ofapiAuthChangedAt: timestamp("ofapi_auth_changed_at", { withTimezone: true }),
    username: text("username"),
    displayName: text("display_name"),
    followerCount: integer("follower_count"),
    subscriberCount: integer("subscriber_count"),
    egressEndpointId: bigint("egress_endpoint_id", { mode: "number" }),
    earningsBalanceMills: bigint("earnings_balance_mills", {
      mode: "bigint",
    }).default(sql`0`).notNull(),
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
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
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
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
  metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Decision 381: what the paging sweep has done about a latch. The latch row
// says whether the condition holds; this row says whether the owner has been
// told, for which episode, and whether the recovery was announced yet.
export const notificationIncidentPaging = pgTable(
  "notification_incident_paging",
  {
    notificationIncidentId: bigint("notification_incident_id", { mode: "number" })
      .primaryKey()
      .references(() => notificationIncidents.id, { onDelete: "cascade" }),
    observedOpenedAt: timestamp("observed_opened_at", { withTimezone: true }).notNull(),
    observedStatus: text("observed_status").$type<"open" | "resolved">().notNull(),
    pagedOpenedAt: timestamp("paged_opened_at", { withTimezone: true }),
    pagedAt: timestamp("paged_at", { withTimezone: true }),
    pagedMode: text("paged_mode").$type<"immediate" | "sustained" | "flapping">(),
    pagedResolvedAt: timestamp("paged_resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    statusCheck: check("notification_incident_paging_status_check", sql`
      ${table.observedStatus} in ('open', 'resolved')
    `),
    modeCheck: check("notification_incident_paging_mode_check", sql`
      ${table.pagedMode} is null or ${table.pagedMode} in ('immediate', 'sustained', 'flapping')
    `),
  }),
);

// Decision 381: one row per latch episode (open → resolved), including the
// episodes that healed before they ever paged. The latch row keeps only its
// newest episode; the daily digest and the flap detector need the history.
export const notificationIncidentCycles = pgTable(
  "notification_incident_cycles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    notificationIncidentId: bigint("notification_incident_id", { mode: "number" })
      .references(() => notificationIncidents.id, { onDelete: "cascade" })
      .notNull(),
    incidentKey: text("incident_key").notNull(),
    kind: notificationIncidentKindEnum("kind").notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "cascade" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    paged: boolean("paged").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    episodeUidx: uniqueIndex("notification_incident_cycles_episode_uidx").on(
      table.notificationIncidentId,
      table.openedAt,
    ),
    openedIdx: index("notification_incident_cycles_opened_idx").on(table.openedAt),
  }),
);

export const telegramSettings = pgTable("telegram_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").default(true).notNull(),
  dailyReportEnabled: boolean("daily_report_enabled").default(true).notNull(),
  syncFailureAlertsEnabled: boolean("sync_failure_alerts_enabled").default(true).notNull(),
  aiCriticalAlertsEnabled: boolean("ai_critical_alerts_enabled").default(false).notNull(),
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

export const notificationDeliveryOutbox = pgTable(
  "notification_delivery_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    notificationIncidentId: bigint("notification_incident_id", { mode: "number" })
      .references(() => notificationIncidents.id, { onDelete: "restrict" })
      .notNull(),
    transition: text("transition").$type<"opened" | "reopened" | "resolved">().notNull(),
    transitionAt: timestamp("transition_at", { withTimezone: true }).notNull(),
    channel: text("channel").$type<"telegram">().notNull(),
    pagingPolicy: text("paging_policy").$type<"sync_failure" | "ai_critical">().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    messageText: text("message_text").notNull(),
    state: text("state").$type<
      "pending" | "leased" | "delivered" | "suppressed" | "exhausted"
    >().default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    suppressionReason: text("suppression_reason"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    exhaustedAt: timestamp("exhausted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    transitionCheck: check("notification_delivery_outbox_transition_check", sql`
      ${table.transition} in ('opened', 'reopened', 'resolved')
    `),
    channelCheck: check("notification_delivery_outbox_channel_check", sql`
      ${table.channel} in ('telegram')
    `),
    pagingPolicyCheck: check("notification_delivery_outbox_paging_policy_check", sql`
      ${table.pagingPolicy} in ('sync_failure', 'ai_critical')
    `),
    stateCheck: check("notification_delivery_outbox_state_check", sql`
      ${table.state} in ('pending', 'leased', 'delivered', 'suppressed', 'exhausted')
    `),
    attemptCountCheck: check(
      "notification_delivery_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    maxAttemptsCheck: check(
      "notification_delivery_outbox_max_attempts_check",
      sql`${table.maxAttempts} > 0`,
    ),
    transitionChannelUniq: unique("notification_delivery_outbox_transition_channel_uniq").on(
      table.notificationIncidentId,
      table.transition,
      table.transitionAt,
      table.channel,
    ),
    readyIdx: index("notification_delivery_outbox_ready_idx")
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.state} = 'pending'`),
    expiredLeaseIdx: index("notification_delivery_outbox_expired_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'leased'`),
    // DESC matches migration 0114 and the newest-row-first correlated
    // subqueries in the incidents repository; declaring it ascending here made
    // every future schema diff want to drop and recreate the index.
    incidentIdx: index("notification_delivery_outbox_incident_idx").on(
      table.notificationIncidentId,
      table.createdAt.desc(),
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
    stats: jsonbSafe("stats").$type<Record<string, unknown>>().default({}).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    finishedIdx: index("sync_runs_finished_idx").on(table.finishedAt),
    // 0184: the planner and monitor read the few running runs out of ~190k.
    runningIdx: index("sync_runs_running_idx")
      .on(table.id)
      .where(sql`${table.outcome} = 'running'`),
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
    provider: platformColumn("provider").notNull(),
    stream: syncStreamEnum("stream").notNull(),
    operation: text("operation").notNull(),
    logicalRequestId: text("logical_request_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    state: syncHttpAttemptStateEnum("state").notNull(),
    failureKind: syncHttpFailureKindEnum("failure_kind"),
    httpStatus: integer("http_status"),
    retryDelayMs: integer("retry_delay_ms"),
    durationMs: integer("duration_ms"),
    requestShape: jsonbSafe("request_shape").$type<Record<string, unknown>>().default({}).notNull(),
    responseShape: jsonbSafe("response_shape").$type<Record<string, unknown>>().default({}).notNull(),
    /** [E2] instrumentation (migration 0130): UTF-8 byte length of the payload
     * OBJECT handed to capture — never Content-Length, which counts compressed
     * transport bytes and is absent on a replayed body. NULL when the attempt
     * journaled nothing. It gates NOTHING: [A20] deleted the byte ceiling and
     * no code path may defer a lane on a byte budget. */
    responseBodyBytes: bigint("response_body_bytes", { mode: "number" }),
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
    provider: platformColumn("provider").notNull(),
    stream: syncStreamEnum("stream").notNull(),
    eventType: text("event_type").notNull(),
    severity: syncEventSeverityEnum("severity").notNull(),
    message: text("message").notNull(),
    details: jsonbSafe("details").$type<Record<string, unknown>>().default({}).notNull(),
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
    dispatchSource: syncRequestSourceEnum("dispatch_source").default("scheduled").notNull(),
    requestPayload: jsonbSafe("request_payload").$type<Record<string, unknown>>().default({}).notNull(),
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
    progress: jsonbSafe("progress").$type<Record<string, unknown>>().default({}).notNull(),
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
    state: jsonbSafe("state").$type<Record<string, unknown>>().default({}).notNull(),
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
    provider: platformColumn("provider").notNull(),
    scope: text("scope").notNull(),
    egressKey: text("egress_key").notNull(),
    minSpacingMs: integer("min_spacing_ms").notNull(),
    // Stage 26: which egress priority class the row paces (vendor caps are
    // class-neutral shared rows and stay at the 'bulk' default).
    priorityClass: text("priority_class", { enum: ["interactive", "commands", "bulk"] })
      .notNull()
      .default("bulk"),
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

// A2b (decision #135): repair ledger for rebuildable projections — a
// dm_messages finalize/checkpoint failure records a row here instead of
// wedging the stream; the 5-minute sweep re-runs the recompute and resolves.
// Resolved rows are kept (DP 7 audit trail); the partial unique index keeps
// one LIVE row per (kind, conversation).
export const projectionDebt = pgTable(
  "projection_debt",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" }).notNull(),
    conversationId: bigint("conversation_id", { mode: "number" }).notNull(),
    errorSummary: text("error_summary"),
    attempts: integer("attempts").default(1).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    unresolvedUniq: uniqueIndex("projection_debt_unresolved_uniq")
      .on(table.kind, table.conversationId)
      .where(sql`${table.resolvedAt} is null`),
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
    requestParams: jsonbSafe("request_params").$type<Record<string, unknown>>().default({}).notNull(),
    // G5 slice 3c-1 (0128): NULLABLE, the twin of observations.payload — null
    // means "the body lives in the catalog", and the table CHECK
    // `response_payload IS NOT NULL OR payload_object_id IS NOT NULL` keeps a
    // row from addressing zero copies.
    responsePayload: jsonbSafe("response_payload").$type<unknown>(),
    mapperVersion: text("mapper_version").notNull(),
    payloadKind: text("payload_kind").notNull(),
    statusCode: integer("status_code"),
    errorMessage: text("error_message"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    // G5 slice 1 (0124): composite reference into capture_payload_objects.
    // Nullable and NOT an FK by design — see the migration's comment. Both set
    // or both null (CHECK); responsePayload above stays the authority.
    payloadBucketMonth: date("payload_bucket_month"),
    payloadObjectId: bigint("payload_object_id", { mode: "number" }),
    // G5 slice 3a (0125): the `{tips}` slice of a Fansly DM capture, written at
    // insert time so the tip-context replay keeps its server-side narrowing
    // after the inline body goes away. Null for every other endpoint and for
    // every row written before the slice — see capture-queryable-fields.ts.
    responseTips: jsonbSafe("response_tips").$type<{ tips: unknown }>(),
  },
  (table) => ({
    retainIdx: index("sync_raw_payloads_retain_idx").on(table.retainUntil),
    dmTipContextBackfillIdx: index("sync_raw_payloads_dm_tip_context_backfill_idx")
      .on(table.id)
      .where(sql`${table.endpoint} = 'dm_messages' and ${table.payloadKind} = 'dm_messages'`),
  }),
);

// Exact Fansly tip context found in the optional `/message` response sidecar.
// `platform_tip_id` joins to transactions.correlation_id inside one account;
// it is not a message ref. Raw payloads are the retained authority and this
// table is a replayable serving materialization.
export const transactionTipContexts = pgTable(
  "transaction_tip_contexts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: bigint("account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    platformTipId: text("platform_tip_id").notNull(),
    capturedConversationRef: text("captured_conversation_ref").notNull(),
    /** Provider-verbatim note; empty text is distinct from absent/null. */
    tipMessageText: text("tip_message_text"),
    /** Exact raw payload whose note won the material merge. Nullable after
     * retained-raw expiry; tipMessageCapturedAt keeps the durable lineage time. */
    tipMessageSourceRawPayloadId: bigint("tip_message_source_raw_payload_id", {
      mode: "number",
    }).references(() => syncRawPayloads.id, { onDelete: "set null" }),
    tipMessageCapturedAt: timestamp("tip_message_captured_at", { withTimezone: true }),
    /** Fansly-native mills, when the optional sidecar member is usable. */
    tipAmountMills: bigint("tip_amount_mills", { mode: "bigint" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    senderPlatformUserId: text("sender_platform_user_id").notNull(),
    receiverPlatformUserId: text("receiver_platform_user_id"),
    /** Identity + captured-conversation source. Optional enrichment never
     * advances it; a later identical capture may relink it after raw expiry. */
    sourceRawPayloadId: bigint("source_raw_payload_id", { mode: "number" })
      .references(() => syncRawPayloads.id, { onDelete: "set null" }),
    /** DB capture time of source_raw_payload_id, not provider event time. */
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    provenance: text("provenance")
      .$type<"fansly_dm_tip_sidecar">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountTipUniq: unique("transaction_tip_contexts_account_tip_uniq").on(
      table.accountId,
      table.platformTipId,
    ),
    refsCheck: check(
      "transaction_tip_contexts_refs_check",
      sql`length(${table.platformTipId}) > 0
        and length(${table.capturedConversationRef}) > 0
        and length(${table.senderPlatformUserId}) > 0
        and (${table.receiverPlatformUserId} is null or length(${table.receiverPlatformUserId}) > 0)`,
    ),
    amountCheck: check(
      "transaction_tip_contexts_amount_check",
      sql`${table.tipAmountMills} is null or ${table.tipAmountMills} >= 0`,
    ),
    tipMessageLineageCheck: check(
      "transaction_tip_contexts_tip_message_lineage_check",
      sql`(
          ${table.tipMessageText} is null
          and ${table.tipMessageSourceRawPayloadId} is null
          and ${table.tipMessageCapturedAt} is null
        ) or (
          ${table.tipMessageText} is not null
          and ${table.tipMessageCapturedAt} is not null
        )`,
    ),
    provenanceCheck: check(
      "transaction_tip_contexts_provenance_check",
      sql`${table.platform} = 'fansly'
        and ${table.provenance} = 'fansly_dm_tip_sidecar'`,
    ),
    accountOccurredIdx: index("transaction_tip_contexts_account_occurred_idx").on(
      table.accountId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    accountConversationOccurredIdx: index(
      "transaction_tip_contexts_account_conversation_occurred_idx",
    ).on(
      table.accountId,
      table.capturedConversationRef,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    sourceRawPayloadIdx: index("transaction_tip_contexts_source_raw_payload_idx").on(
      table.sourceRawPayloadId,
    ),
    tipMessageSourceRawPayloadIdx: index(
      "transaction_tip_contexts_tip_message_source_raw_payload_idx",
    ).on(table.tipMessageSourceRawPayloadId),
  }),
);

export const fans = pgTable(
  "fans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: platformColumn("platform").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    username: text("username"),
    displayName: text("display_name"),
    createdAtExternal: timestamp("created_at_external", { withTimezone: true }),
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
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
    provider: platformColumn("provider").notNull(),
    externalNoteId: text("external_note_id").notNull(),
    contentType: integer("content_type"),
    title: text("title"),
    body: text("body"),
    createdAtExternal: timestamp("created_at_external", { withTimezone: true }),
    updatedAtExternal: timestamp("updated_at_external", { withTimezone: true }),
    isActive: boolean("is_active").default(true).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    raw: jsonbSafe("raw").$type<Record<string, unknown>>().default({}).notNull(),
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
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
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
      // Floor only: the retention cap is selection policy (decision #135);
      // an upper bound here wedged whole dm_messages streams once the Stage 1
      // prune stand-down made per-conversation history nondecreasing.
      sql`${table.storedMessageCount} >= 0`,
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
    platform: platformColumn("platform").notNull(),
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
    // NULL for REST-readthrough-inserted rows (PR4) — those have no webhook
    // journal row; the webhook writers keep it required in their input types.
    sourceJournalId: bigint("source_journal_id", { mode: "number" }),
    sourceFanoutSeq: bigint("source_fanout_seq", { mode: "number" }),
    sourceReceivedAt: timestamp("source_received_at", { withTimezone: true }).notNull(),
    // PR4 REST provenance: the last readthrough observation that materially
    // advanced this row. Observation time, NOT platform edit time (Wave 2's
    // rest_platform_changed_at is a separate input). No FK to observations.
    restMaterialObservationId: bigint("rest_material_observation_id", { mode: "number" }),
    restMaterialObservedAt: timestamp("rest_material_observed_at", { withTimezone: true }),
    // Wave 2 corrections: sha256 over the reduced material tuple (bytea; hex
    // only in dedup keys); emitted_* = what the ledger last said about this
    // message; material != emitted is the queryable repair signal that
    // drives the bounded reconciler. revision_no counts ledger revisions.
    materialFingerprint: bytea("material_fingerprint"),
    emittedFingerprint: bytea("emitted_fingerprint"),
    emittedEventId: bigint("emitted_event_id", { mode: "number" }),
    revisionNo: integer("revision_no").default(1).notNull(),
    materialFieldProvenance: jsonbSafe("material_field_provenance")
      .$type<Record<string, string>>()
      .default({})
      .notNull(),
    // The platform's own edit time from REST payloads (changedAt) — the
    // future platform-change ordering input; never observation time.
    restPlatformChangedAt: timestamp("rest_platform_changed_at", { withTimezone: true }),
    rawShapeVersion: text("raw_shape_version").default("ofapi-message-v1").notNull(),
    mediaMetadata: jsonbSafe("media_metadata").$type<Array<Record<string, unknown>>>().default([]).notNull(),
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
    repairSignalIdx: index("dm_message_archive_repair_signal_idx")
      .on(table.platformAccountId, table.id)
      .where(sql`${table.materialFingerprint} is distinct from ${table.emittedFingerprint}`),
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
    bindingGeneration: integer("binding_generation").notNull().default(1),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    outreachPurpose: text("outreach_purpose").$type<"new-follower">(),
    kind: text("kind").$type<OfapiCommandKind>().notNull(),
    payload: jsonbSafe("payload").$type<OfapiCommandPayload>().notNull(),
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
    verifierResult: jsonbSafe("verifier_result").$type<Record<string, unknown>>(),
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
    followerOutreachUniq: uniqueIndex("ofapi_commands_follower_outreach_uniq")
      .on(table.pageId, table.conversationId)
      .where(sql`${table.outreachPurpose} = 'new-follower' and case
        when ${table.state} = 'cancelled' and ${table.attemptCount} = 0 then false
        when ${table.state} in ('failed_retryable', 'failed_terminal')
          and coalesce(${table.verifierResult}->>'source', '') in ('local_precondition', 'auth_gate') then false
        else true end`),
    outreachPurposeCheck: check("ofapi_commands_outreach_purpose_check", sql`
      ${table.outreachPurpose} is null or (
        ${table.outreachPurpose} = 'new-follower'
        and ${table.conversationId} ~ '^[1-9][0-9]{0,29}$'
        and ${table.kind} in ('send_text_message_v1', 'send_message_v2')
      )`),
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

// Kernel Stage 25: golden-signal samples (five lags, p50/p95, minutely).
export const opsMetricSamples = pgTable("ops_metric_samples", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  metric: text("metric").notNull(),
  valueMs: bigint("value_ms", { mode: "number" }).notNull(),
  quantile: text("quantile").notNull(),
  sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // Stage 14 explicit fee capture (target §3.5 door 4.8): nullable — only the
    // OFAPI writers populate them going forward; legacy rows keep NULL (fee is
    // derivable as gross − net where needed).
    platformFeeMills: bigint("platform_fee_mills", { mode: "bigint" }),
    vatAmountMills: bigint("vat_amount_mills", { mode: "bigint" }),
    taxAmountMills: bigint("tax_amount_mills", { mode: "bigint" }),
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

// OFAPI trial/tracking link statistics (2026-07-22): one run row per
// completed (page, link_kind) list walk; append-only per-link snapshots.
// Cumulative vendor counters stored as observed; deltas are query-time.
export const pageLinkStatRuns = pgTable(
  "page_link_stat_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    linkKind: text("link_kind").notNull(),
    status: text("status").notNull(),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull(),
    apiPages: integer("api_pages").default(0).notNull(),
    rawItems: integer("raw_items").default(0).notNull(),
    writtenRows: integer("written_rows").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pageKindPulledIdx: index("page_link_stat_runs_page_kind_pulled_idx").on(
      table.platformAccountId,
      table.linkKind,
      table.pulledAt,
    ),
  }),
);

export const pageLinkStatSnapshots = pgTable(
  "page_link_stat_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .references(() => pageLinkStatRuns.id, { onDelete: "restrict" })
      .notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    linkKind: text("link_kind").notNull(),
    platformLinkId: text("platform_link_id").notNull(),
    name: text("name"),
    url: text("url"),
    linkCreatedAt: timestamp("link_created_at", { withTimezone: true }),
    linkEndsAt: timestamp("link_ends_at", { withTimezone: true }),
    isFinished: boolean("is_finished"),
    clicksCount: integer("clicks_count").notNull(),
    claimsCount: integer("claims_count"),
    subscribersCount: integer("subscribers_count").notNull(),
    // NULL money/spenders = vendor value unknown (revenue block missing, still
    // computing, or unparseable) — deliberately distinct from a real zero.
    spendersCount: integer("spenders_count"),
    revenueGrossMills: bigint("revenue_gross_mills", { mode: "bigint" }),
    revenueIsLoading: boolean("revenue_is_loading"),
    revenueCalculatedAt: timestamp("revenue_calculated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    runLinkUniq: uniqueIndex("page_link_stat_snapshots_run_link_uniq").on(
      table.runId,
      table.platformLinkId,
    ),
    pageLinkIdx: index("page_link_stat_snapshots_page_link_idx").on(
      table.platformAccountId,
      table.linkKind,
      table.platformLinkId,
      table.id,
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

/**
 * TOMBSTONE (Decision 370). The api-key lane is retired: nothing issues, reads
 * or authenticates these rows any more. The TABLE stays — every row is a fact
 * about a credential that once existed, and DP 7 forbids deleting facts. The
 * mapping stays so a forensic read has a typed handle on it.
 */
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

// Kernel Stage 22: human-bound, expiring bearer credentials for machines.
// Nothing is ever attributed to a bare device — the token resolves the OWNING
// human's principal; the device id travels as metadata.
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    label: text("label").default("").notNull(),
    tokenDigest: text("token_digest").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    // Owner-bound capability for the one-time local DB harvest. The ingest
    // lane requires this exact machine id; a caller-controlled client-version
    // header alone never grants authority to mint canonical platform facts.
    harvestMachineId: uuid("harvest_machine_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Decision 349 (Р7, migration 0199): the x-client-version the token last
    // presented, stamped by the same UPDATE as last_used_at. Routing metadata,
    // never authority (#145).
    lastClientVersion: text("last_client_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    userIdx: index("device_tokens_user_idx").on(table.userId),
    expiryIdx: index("device_tokens_expiry_idx").on(table.expiresAt),
    harvestMachineUniq: uniqueIndex("device_tokens_harvest_machine_uidx")
      .on(table.harvestMachineId)
      .where(sql`${table.harvestMachineId} is not null`),
  }),
);

// Enrollment reservations never authenticate application traffic.  Desktop
// first persists the server-generated raw token in encrypted staging plus a
// non-secret local journal, then promotes this row into device_tokens through
// the explicit activation route.  The short TTL bounds abandoned custody.
export const pendingDeviceTokens = pgTable(
  "pending_device_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    label: text("label").default("").notNull(),
    tokenDigest: text("token_digest").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("pending_device_tokens_user_idx").on(table.userId),
    expiryIdx: index("pending_device_tokens_expiry_idx").on(table.expiresAt),
  }),
);

// Decision 349 (migration 0199): one-time invite / password-reset links. The
// raw token lives only in the creation response; the row keeps its sha256
// digest and a display prefix. Rows are never deleted — used, expired and
// revoked links stay as facts. The partial unique index holds "at most one
// active link per user"; writers take the user row lock first.
export const accountLinks = pgTable(
  "account_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<"invite" | "password_reset">().notNull(),
    tokenDigest: text("token_digest").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    createdBy: bigint("created_by", { mode: "number" })
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => ({
    userIdx: index("account_links_user_idx").on(table.userId),
    oneActiveUidx: uniqueIndex("account_links_one_active_uidx")
      .on(table.userId)
      .where(sql`${table.usedAt} is null and ${table.revokedAt} is null`),
    kindCheck: check("account_links_kind_check", sql`${table.kind} in ('invite', 'password_reset')`),
  }),
);

// Kernel Stage 22: the append-only access log replacing hard-deleted page
// assignments. scope_type 'org' is the future-proof label (single-tenant per
// DP 9-A: no org table, scope_id = 0); 'model' grants expand to the model's
// present AND future pages at read time.
export const accessGrants = pgTable(
  "access_grants",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    scopeType: text("scope_type").$type<"org" | "model" | "page">().notNull(),
    scopeId: bigint("scope_id", { mode: "number" }).default(0).notNull(),
    grantedBy: bigint("granted_by", { mode: "number" })
      .references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedBy: bigint("revoked_by", { mode: "number" })
      .references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    scopeIdx: index("access_grants_scope_idx").on(table.scopeType, table.scopeId),
  }),
);

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // NULL = system lane (internal gateway completions) — the Stage 9
    // credit-ledger precedent.
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" }),
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
    errorCode: text("error_code"),
    failurePhase: text("failure_phase").$type<
      "connect" | "provider_response" | "stream"
    >(),
    providerHttpStatus: integer("provider_http_status"),
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
    failureReasonWindowIdx: index("ai_usage_events_failure_reason_window_idx")
      .on(table.provider, table.errorCode, table.completedAt.desc())
      .where(sql`${table.gatewayOutcome} = 'failed'`),
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
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
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
    /** When the client's Scan actually RAN — created_at is only the hub
     * append time, and a delayed re-push (extension E22) must not reset the
     * dossier's age for the volatile-section policy (#136). Null on rows
     * written by clients that predate the field. */
    sourceGeneratedAt: timestamp("source_generated_at", { withTimezone: true }),
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
// Durable missing-head work; exact message receipts are independent of history coverage.
export const fanslyDmHeadDebt = pgTable("fansly_dm_head_debt", {
  conversationId: bigint("conversation_id", { mode: "number" })
    .references(() => pageDmThreads.id, { onDelete: "cascade" }).notNull(),
  messageId: text("message_id").notNull(),
  messageAt: timestamp("message_at", { withTimezone: true }),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).defaultNow().notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).defaultNow().notNull(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversationId, table.messageId] }),
  attemptsCheck: check("fansly_dm_head_debt_attempts_check", sql`${table.attempts} between 0 and 5`),
  pendingIdx: index("fansly_dm_head_debt_pending_idx")
    .on(table.conversationId, table.nextRetryAt)
    .where(sql`${table.capturedAt} is null and ${table.attempts} < 5`),
}));

export const pageDmConversations = pageDmThreads;
export const dailyRevenue = revenueDaily;
export const spenderDailyFacts = fanSpendDaily;
export const spenderLifetimePage = fanSpendLifetime;
export const spenderProjectionWatermarks = projectionWatermarks;
export const pageTopSpenders = pageFanIdentities;

// Singleton registration record for the onlyfansapi.com webhook (signing secret is
// an encryptJson envelope, same custody model as telegram_settings.encrypted_bot_token).
// The previous secret is kept so deliveries signed during a rotation keep verifying.
export interface OfapiWebhookPendingRegistration {
  operationId: string;
  operation: "create" | "update";
  externalWebhookId: string | null;
  endpointUrl: string;
  accountScope: "global";
  events: string[];
  preparedAt: string;
}

export const canonicalizeSweepCursors = pgTable("canonicalize_sweep_cursors", {
  key: text("key").primaryKey(),
  afterId: bigint("after_id", { mode: "number" }),
  revision: bigint("revision", { mode: "number" }).default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ofapiWebhookConfig = pgTable("ofapi_webhook_config", {
  id: integer("id").primaryKey().default(1),
  externalWebhookId: text("external_webhook_id"),
  endpointUrl: text("endpoint_url").notNull(),
  accountScope: text("account_scope").default("global").notNull(),
  events: jsonbSafe("events").$type<string[]>().default([]).notNull(),
  encryptedSigningSecret: text("encrypted_signing_secret").notNull(),
  previousEncryptedSigningSecret: text("previous_encrypted_signing_secret"),
  registrationState: text("registration_state").default("stable").notNull(),
  pendingRegistration: jsonbSafe("pending_registration")
    .$type<OfapiWebhookPendingRegistration>(),
  pendingEncryptedSigningSecret: text("pending_encrypted_signing_secret"),
  registrationError: text("registration_error"),
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
  // Stage 14: the historical-backfill CLI's own day counter — DP 2's binding
  // condition that backfills run only under the day-budget reservation
  // machinery, without competing against the DM/audience ceilings.
  backfillSpendDay: date("backfill_spend_day"),
  backfillSpentCredits: integer("backfill_spent_credits").default(0).notNull(),
  // Link-stats reconcile's own day counter — isolated from the backfill lane
  // so neither job can starve the other (review round 3, PR #23).
  linkStatsSpendDay: date("link_stats_spend_day"),
  linkStatsSpentCredits: integer("link_stats_spent_credits").default(0).notNull(),
  governedScopeDay: date("governed_scope_day"),
  liveSpentCredits: integer("live_spent_credits").default(0).notNull(),
  interactiveSpentCredits: integer("interactive_spent_credits").default(0).notNull(),
  bulkSpentCredits: integer("bulk_spent_credits").default(0).notNull(),
  governedUnsettledCredits: integer("governed_unsettled_credits").default(0).notNull(),
  floorProbeNotBefore: timestamp("floor_probe_not_before", { withTimezone: true }),
  lastBalance: integer("last_balance"),
  lastBalanceAt: timestamp("last_balance_at", { withTimezone: true }),
  // Reconciliation cursor (D5): the last balance-observation ledger row that
  // has been decomposed, plus the residual seen on the most recent pair.
  reconciledThroughLedgerId: bigint("reconciled_through_ledger_id", { mode: "number" }),
  lastReconcileAt: timestamp("last_reconcile_at", { withTimezone: true }),
  lastDriftCredits: integer("last_drift_credits"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type OfapiCaptureJobKind =
  | "chat_paginate"
  | "campaign_snapshot"
  | "head_repair"
  | "account_export"
  | "export_import"
  | "post_paginate"
  | "collection_read"
  | "media_upload";
export type OfapiCaptureJobGoal =
  | "history_to_exhaustion"
  | "connect_to_anchor"
  | "bounded_tail";
export type OfapiCaptureJobState = (typeof ofapiCaptureJobStates)[number];
export type OfapiBudgetScope = "live" | "interactive" | "bulk";
export type OfapiCaptureCreatedBy =
  | "owner"
  | "cohort_seed"
  | "product_signal"
  | "interactive_open"
  | "verification_probe";

export const ofapiCaptureJobs = pgTable(
  "ofapi_capture_jobs",
  {
    id: uuid("id").primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    kind: text("kind").$type<OfapiCaptureJobKind>().notNull(),
    goal: text("goal").$type<OfapiCaptureJobGoal>(),
    state: text("state").$type<OfapiCaptureJobState>().default("ready").notNull(),
    activeSlotKey: text("active_slot_key").notNull(),
    target: jsonbSafe("target").$type<Record<string, unknown>>().notNull(),
    targetHash: char("target_hash", { length: 64 }).notNull(),
    targetGeneration: integer("target_generation").default(0).notNull(),
    manifest: jsonbSafe("manifest").$type<Record<string, unknown>>(),
    cursor: jsonbSafe("cursor").$type<Record<string, unknown>>(),
    cursorHash: char("cursor_hash", { length: 64 }),
    rowVersion: bigint("row_version", { mode: "number" }).default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    priority: integer("priority").default(0).notNull(),
    budgetScope: text("budget_scope").$type<OfapiBudgetScope>().notNull(),
    originPrincipalId: bigint("origin_principal_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    createdBy: text("created_by").$type<OfapiCaptureCreatedBy>().notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    pendingObservationId: bigint("pending_observation_id", { mode: "number" }),
    pendingObservationReceivedAt: timestamp("pending_observation_received_at", { withTimezone: true }),
    terminalObservationId: bigint("terminal_observation_id", { mode: "number" }),
    terminalObservationReceivedAt: timestamp("terminal_observation_received_at", { withTimezone: true }),
    reasonCode: text("reason_code"),
    reasonMessage: text("reason_message"),
    result: jsonbSafe("result").$type<Record<string, unknown>>(),
    maxCalls: integer("max_calls"),
    maxCredits: integer("max_credits"),
    maxPages: integer("max_pages"),
    maxItems: integer("max_items"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    spentCredits: integer("spent_credits").default(0).notNull(),
    acceptedItems: bigint("accepted_items", { mode: "number" }).default(0).notNull(),
    acceptedPages: bigint("accepted_pages", { mode: "number" }).default(0).notNull(),
    zeroProgressCount: integer("zero_progress_count").default(0).notNull(),
    consecutiveUncaptured: integer("consecutive_uncaptured").default(0).notNull(),
    sourceContractVersion: text("source_contract_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    proofPolicyVersion: text("proof_policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    activeSlotUniq: uniqueIndex("ofapi_capture_jobs_active_slot_uniq")
      .on(table.activeSlotKey)
      .where(sql`${table.state} in ('ready', 'leased', 'awaiting_parse', 'retry_wait', 'blocked')`),
    runnableIdx: index("ofapi_capture_jobs_runnable_idx")
      .on(table.nextAttemptAt, table.priority.desc(), table.createdAt)
      .where(sql`${table.state} in ('ready', 'retry_wait')`),
    pageStateIdx: index("ofapi_capture_jobs_page_state_idx").on(table.pageId, table.state),
    leaseUntilIdx: index("ofapi_capture_jobs_lease_until_idx")
      .on(table.leaseUntil)
      .where(sql`${table.state} = 'leased'`),
    awaitingParseIdx: index("ofapi_capture_jobs_awaiting_parse_idx")
      .on(table.updatedAt)
      .where(sql`${table.state} = 'awaiting_parse'`),
  }),
);

export type OfapiAttemptOwnerKind = "capture_job" | "interactive_request";
export type OfapiRequestAttemptState =
  | "reserved"
  | "released_pre_dispatch"
  | "dispatching"
  | "response_captured"
  | "indeterminate";
export type OfapiHttpOutcome =
  | "success"
  | "not_found"
  | "auth_confirmed"
  | "forbidden_unconfirmed"
  | "rate"
  | "vendor_5xx"
  | "request_rejected"
  | "unexpected_http"
  | "invalid_response";
export type OfapiParserOutcome =
  | "pending"
  | "accepted"
  | "intentional_noop"
  | "contract_rejected"
  | "failed";

export const ofapiInteractiveRequests = pgTable(
  "ofapi_interactive_requests",
  {
    id: uuid("id").primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    principalUserId: bigint("principal_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    operation: text("operation").notNull(),
    surface: text("surface").notNull(),
    target: jsonbSafe("target").$type<Record<string, unknown>>().notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    state: text("state").$type<
      "created" | "attempt_reserved" | "response_captured" | "served" | "failed" | "indeterminate"
    >().default("created").notNull(),
    rowVersion: bigint("row_version", { mode: "number" }).default(0).notNull(),
    responseObservationId: bigint("response_observation_id", { mode: "number" }),
    responseObservationReceivedAt: timestamp("response_observation_received_at", { withTimezone: true }),
    httpOutcome: text("http_outcome").$type<OfapiHttpOutcome>(),
    errorCode: text("error_code"),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    principalCreatedIdx: index("ofapi_interactive_requests_principal_created_idx")
      .on(table.principalUserId, table.createdAt.desc()),
    incompleteIdx: index("ofapi_interactive_requests_incomplete_idx")
      .on(table.updatedAt)
      .where(sql`${table.state} in ('created', 'attempt_reserved', 'response_captured')`),
  }),
);

export const ofapiRequestAttempts = pgTable(
  "ofapi_request_attempts",
  {
    id: uuid("id").primaryKey(),
    ownerKind: text("owner_kind").$type<OfapiAttemptOwnerKind>().notNull(),
    ownerId: uuid("owner_id").notNull(),
    captureJobId: uuid("capture_job_id")
      .references(() => ofapiCaptureJobs.id, { onDelete: "restrict" }),
    interactiveRequestId: uuid("interactive_request_id")
      .references(() => ofapiInteractiveRequests.id, { onDelete: "restrict" }),
    ownerAttemptNo: integer("owner_attempt_no").notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    ofapiAccountId: text("ofapi_account_id").notNull(),
    originPrincipalId: bigint("origin_principal_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    budgetScope: text("budget_scope").$type<OfapiBudgetScope>().notNull(),
    reservationDay: date("reservation_day").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    admissionSnapshot: jsonbSafe("admission_snapshot").$type<Record<string, unknown>>().notNull(),
    operation: text("operation").notNull(),
    endpointClass: text("endpoint_class").notNull(),
    egressKey: text("egress_key").notNull(),
    method: text("method").$type<"GET" | "POST" | "DELETE" | "PATCH">().notNull(),
    requestSemantics: text("request_semantics").$type<"safe_read" | "stateful">().notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    isFloorProbe: boolean("is_floor_probe").default(false).notNull(),
    principalWindowStartedAt: timestamp("principal_window_started_at", { withTimezone: true }),
    state: text("state").$type<OfapiRequestAttemptState>().default("reserved").notNull(),
    dispatchOutcome: text("dispatch_outcome").$type<
      "response_received" | "vendor_slow" | "transport" | "capture_uncommitted"
    >(),
    httpOutcome: text("http_outcome").$type<OfapiHttpOutcome>(),
    parserOutcome: text("parser_outcome").$type<OfapiParserOutcome>().default("pending").notNull(),
    rawCount: bigint("raw_count", { mode: "number" }).default(0).notNull(),
    acceptedCount: bigint("accepted_count", { mode: "number" }).default(0).notNull(),
    boundaryDuplicateCount: bigint("boundary_duplicate_count", { mode: "number" }).default(0).notNull(),
    explicitlyIrrelevantCount: bigint("explicitly_irrelevant_count", { mode: "number" }).default(0).notNull(),
    rejectedCount: bigint("rejected_count", { mode: "number" }).default(0).notNull(),
    creditState: text("credit_state").$type<"reserved" | "settled" | "released" | "indeterminate">()
      .default("reserved").notNull(),
    reservedCredits: integer("reserved_credits").notNull(),
    settledCredits: integer("settled_credits"),
    creditEstimated: boolean("credit_estimated"),
    balanceAfter: integer("balance_after"),
    responseObservationId: bigint("response_observation_id", { mode: "number" }),
    responseObservationReceivedAt: timestamp("response_observation_received_at", { withTimezone: true }),
    fenceToken: uuid("fence_token").notNull(),
    jobLeaseToken: uuid("job_lease_token"),
    surface: text("surface"),
    servingMode: text("serving_mode").$type<"vendor_only" | "shadow" | "db_fallback" | "db_only">(),
    fallbackReason: text("fallback_reason").$type<
      | "surface_not_cutover"
      | "no_certificate"
      | "stale_head"
      | "gap"
      | "projection_lag"
      | "shadow_probe"
    >(),
    policyVersion: text("policy_version").notNull(),
    sourceContractVersion: text("source_contract_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).defaultNow().notNull(),
    dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
    responseCapturedAt: timestamp("response_captured_at", { withTimezone: true }),
    responseObservedAt: timestamp("response_observed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    certaintyResolvedAt: timestamp("certainty_resolved_at", { withTimezone: true }),
    certaintyResolution: text("certainty_resolution"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ownerAttemptUniq: uniqueIndex("ofapi_request_attempts_owner_attempt_uniq")
      .on(table.ownerKind, table.ownerId, table.ownerAttemptNo),
    activeOwnerUniq: uniqueIndex("ofapi_request_attempts_active_owner_uniq")
      .on(table.ownerKind, table.ownerId)
      .where(sql`${table.state} in ('reserved', 'dispatching') or (${table.state} = 'indeterminate' and ${table.certaintyResolvedAt} is null)`),
    activeFloorProbeUniq: uniqueIndex("ofapi_request_attempts_active_floor_probe_uniq")
      .on(table.isFloorProbe)
      .where(sql`${table.isFloorProbe} = true and (${table.state} in ('reserved', 'dispatching') or (${table.state} = 'indeterminate' and ${table.certaintyResolvedAt} is null))`),
    observationUniq: uniqueIndex("ofapi_request_attempts_observation_uniq")
      .on(table.responseObservationId, table.responseObservationReceivedAt)
      .where(sql`${table.responseObservationId} is not null`),
    jobReservedIdx: index("ofapi_request_attempts_job_reserved_idx")
      .on(table.captureJobId, table.reservedAt),
    budgetIdx: index("ofapi_request_attempts_budget_idx")
      .on(table.reservationDay, table.budgetScope, table.pageId),
    endpointHealthIdx: index("ofapi_request_attempts_endpoint_health_idx")
      .on(table.pageId, table.endpointClass, table.finishedAt.desc()),
    principalIdx: index("ofapi_request_attempts_principal_idx")
      .on(table.originPrincipalId, table.reservedAt.desc())
      .where(sql`${table.originPrincipalId} is not null`),
    indeterminateIdx: index("ofapi_request_attempts_indeterminate_idx")
      .on(table.finishedAt)
      .where(sql`${table.state} = 'indeterminate' and ${table.certaintyResolvedAt} is null`),
  }),
);

export const ofapiBudgetDenialDaily = pgTable(
  "ofapi_budget_denial_daily",
  {
    day: date("day").notNull(),
    scope: text("scope").$type<OfapiBudgetScope>().notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    principalKey: text("principal_key").notNull(),
    principalUserId: bigint("principal_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    deniedCount: bigint("denied_count", { mode: "number" }).default(0).notNull(),
    thresholdCrossings: bigint("threshold_crossings", { mode: "number" }).default(0).notNull(),
    firstDeniedAt: timestamp("first_denied_at", { withTimezone: true }).notNull(),
    lastDeniedAt: timestamp("last_denied_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "ofapi_budget_denial_daily_pkey",
      columns: [table.day, table.scope, table.pageId, table.principalKey, table.reason],
    }),
  }),
);

export const ofapiPrincipalBudgetState = pgTable("ofapi_principal_budget_state", {
  principalUserId: bigint("principal_user_id", { mode: "number" })
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  usedCalls: integer("used_calls").default(0).notNull(),
  usedCredits: integer("used_credits").default(0).notNull(),
  consecutiveBudgetDenials: integer("consecutive_budget_denials").default(0).notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  lastDenialReason: text("last_denial_reason"),
  lastDenialAt: timestamp("last_denial_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ofapiStorageHealthState = pgTable(
  "ofapi_storage_health_state",
  {
    id: integer("id").primaryKey().default(1),
    healthy: boolean("healthy").notNull(),
    breached: boolean("breached").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    usedBytes: bigint("used_bytes", { mode: "number" }),
    freeBytes: bigint("free_bytes", { mode: "number" }),
    totalBytes: bigint("total_bytes", { mode: "number" }),
    error: text("error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    singletonCheck: check("ofapi_storage_health_state_singleton_check", sql`${table.id} = 1`),
    nonnegativeCheck: check(
      "ofapi_storage_health_state_nonnegative_check",
      sql`(${table.usedBytes} is null or ${table.usedBytes} >= 0)
        and (${table.freeBytes} is null or ${table.freeBytes} >= 0)
        and (${table.totalBytes} is null or ${table.totalBytes} >= 0)`,
    ),
    shapeCheck: check(
      "ofapi_storage_health_state_shape_check",
      sql`(
          ${table.error} is null
          and ${table.usedBytes} is not null
          and ${table.freeBytes} is not null
          and ${table.totalBytes} is not null
          and ${table.healthy} = (not ${table.breached})
        ) or (
          ${table.error} is not null
          and ${table.usedBytes} is null
          and ${table.freeBytes} is null
          and ${table.totalBytes} is null
          and not ${table.healthy}
          and not ${table.breached}
        )`,
    ),
  }),
);

export const ofapiCaptureControls = pgTable("ofapi_capture_controls", {
  controlKey: text("control_key").primaryKey(),
  paused: boolean("paused").default(false).notNull(),
  reason: text("reason"),
  version: bigint("version", { mode: "number" }).default(0).notNull(),
  actorUserId: bigint("actor_user_id", { mode: "number" })
    .references(() => users.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ofapiCaptureOperatorActions = pgTable(
  "ofapi_capture_operator_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetRef: text("target_ref").notNull(),
    expectedState: text("expected_state"),
    previousState: jsonbSafe("previous_state").$type<Record<string, unknown>>(),
    resultingState: jsonbSafe("resulting_state").$type<Record<string, unknown>>(),
    dryRun: boolean("dry_run").notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const OFAPI_CREDIT_LEDGER_SOURCES = [
  "rest",
  "webhook_accrual",
  "external",
  "refill",
  "adjustment",
] as const;

// Retained financial receipts for legacy HTTP responses. Only the accounting
// disposition changes; no response text, credentials or fan identities live here.
export const ofapiCreditReceipts = pgTable("ofapi_credit_receipts", {
  requestId: text("request_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  observation: jsonbSafe("observation").$type<Record<string, unknown>>().notNull(),
  accountedAt: timestamp("accounted_at", { withTimezone: true }),
  accountingPath: text("accounting_path").$type<"ledger" | "physical">(),
}, table => ({
  pk: primaryKey({ columns: [table.requestId, table.attemptNumber] }),
  pendingIdx: index("ofapi_credit_receipts_pending_idx")
    .on(table.receivedAt, table.requestId, table.attemptNumber).where(sql`${table.accountedAt} is null`),
}));

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
    details: jsonbSafe("details").$type<Record<string, unknown>>(),
    // Stage 9: acting principal for gateway reads; NULL = system spend.
    actorUserId: bigint("actor_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "set null" }),
    // OF mirror governed calls settle exactly once against their durable
    // physical attempt. Legacy lanes leave this null and keep their existing
    // best-effort sink until migrated.
    attemptId: uuid("attempt_id")
      .references(() => ofapiRequestAttempts.id, { onDelete: "restrict" }),
    attemptEntryPhase: text("attempt_entry_phase").$type<"settlement" | "certainty_adjustment">(),
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
    attemptPhaseUniq: uniqueIndex("ofapi_credit_ledger_attempt_phase_uniq")
      .on(table.attemptId, table.attemptEntryPhase)
      .where(sql`${table.attemptId} is not null`),
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
    // Stage 14: fee/VAT/tax carried from the webhook payload through the shadow
    // row into the truth ingest (all three are dollars-float in the payload).
    platformFeeMills: bigint("platform_fee_mills", { mode: "bigint" }),
    vatAmountMills: bigint("vat_amount_mills", { mode: "bigint" }),
    taxAmountMills: bigint("tax_amount_mills", { mode: "bigint" }),
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
// cursors. Retention is controlled by OFAPI_EVENT_RETENTION_DAYS; the production
// safety default is effectively-forever (36500d) because these rows are business facts.
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
    payload: jsonbSafe("payload").$type<Record<string, unknown>>().notNull(),
    rawBody: bytea("raw_body"),
    payloadHash: bytea("payload_hash"),
    captureHeaders: jsonbSafe("capture_headers")
      .$type<Record<string, string>>()
      .default({})
      .notNull(),
    captureState: text("capture_state").default("accepted").notNull(),
    syncEvent: jsonbSafe("sync_event").$type<Record<string, unknown>>(),
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
    // 0184: max(received_at) per page (admin status, event-type freshness).
    pageReceivedIdx: index("ofapi_webhook_events_page_received_idx")
      .on(table.platformAccountId, table.receivedAt),
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
    rawCaptureIdx: index("ofapi_webhook_events_raw_capture_idx")
      .on(table.id)
      .where(sql`${table.captureState} = 'raw_captured'`),
    lifecycleResourceIdx: index("ofapi_webhook_lifecycle_resource_idx")
      .on(sql`(${table.payload}->'payload'->>'id')`, table.eventType, table.id.desc())
      .where(sql`${table.captureState} = 'accepted' and ${table.projectionStatus} = 'projected'`),
    captureStateCheck: check("ofapi_webhook_events_capture_state_check", sql`
      ${table.captureState} in ('raw_captured', 'accepted', 'quarantined_malformed')
    `),
    rawCaptureCheck: check("ofapi_webhook_events_raw_capture_check", sql`
      ${table.captureState} = 'accepted'
      or (${table.rawBody} is not null and ${table.payloadHash} is not null)
    `),
    archiveStatusCheck: check("ofapi_webhook_events_archive_status_check", sql`
      ${table.archiveStatus} in ('none', 'pending', 'archived', 'skipped', 'failed')
    `),
  }),
);

// One global contiguous replay floor for v1 SSE rows removed from the webhook
// journal. Cleanup cannot advance it past a retained replayable blocker.
export const ofapiFanoutReplayState = pgTable(
  "ofapi_fanout_replay_state",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    replayFloor: bigint("replay_floor", { mode: "number" }).notNull().default(0),
    legacyHighWater: bigint("legacy_high_water", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    singletonCheck: check("ofapi_fanout_replay_state_singleton_check", sql`${table.singleton}`),
    floorCheck: check("ofapi_fanout_replay_state_floor_check", sql`${table.replayFloor} >= 0`),
    legacyHighWaterCheck: check(
      "ofapi_fanout_replay_state_legacy_high_water_check",
      sql`${table.legacyHighWater} >= 0`,
    ),
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
    running: jsonbSafe("running").$type<RunningSnapshot>().notNull(),
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
    value: jsonbSafe("value").$type<ConfigOverrideValue>().notNull(),
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
    oldValue: jsonbSafe("old_value").$type<ConfigOverrideValue>(),
    newValue: jsonbSafe("new_value").$type<ConfigOverrideValue>(),
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

export const OBSERVATION_SOURCES = [
  "webhook",
  "pull",
  "client_capture",
  "readthrough",
  "command_result",
  "operator",
  "ofapi_capture",
  "fansly_ws",
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
    // G5 slice 3c-1 (0128): NULLABLE. A row written pointer-only carries its
    // body only in the catalog and leaves this column SQL NULL; the table CHECK
    // `payload IS NOT NULL OR payload_object_id IS NOT NULL` is what guarantees
    // a row always addresses at least one copy. Reads go through the payload
    // seam, which resolves a null inline body from the catalog in EVERY mode.
    payload: jsonbSafe("payload"),
    // Computed by the producer from the payload OBJECT before the insert, so it
    // is set identically whether or not the body is stored inline.
    payloadHash: bytea("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    actorPrincipalId: bigint("actor_principal_id", { mode: "number" }),
    parseVersion: integer("parse_version").default(0).notNull(),
    // G5 slice 1 (0124): composite reference into capture_payload_objects.
    // Nullable and NOT an FK by design — see the migration's comment. Both set
    // or both null (CHECK); `payload` above stays the authority.
    payloadBucketMonth: date("payload_bucket_month"),
    payloadObjectId: bigint("payload_object_id", { mode: "number" }),
    // G5 slice 3a (0125): the Stage 12 harvest fields the reconciliation queries
    // used to extract from `payload` in SQL. text, not uuid/numeric/timestamptz:
    // a malformed captured fact must still journal (DP 7), and text is what
    // `->>` returns. Null for every non-harvest observation and for every row
    // written before the slice — see capture-queryable-fields.ts.
    harvestMachineId: text("harvest_machine_id"),
    harvestTxId: text("harvest_tx_id"),
    harvestTxAmount: text("harvest_tx_amount"),
    harvestTxCreatedAt: text("harvest_tx_created_at"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.receivedAt] }),
    accountReceivedIdx: index("observations_account_received_idx").on(table.accountId, table.receivedAt),
    kindReceivedIdx: index("observations_kind_received_idx").on(table.kind, table.receivedAt),
    parseIdx: index("observations_parse_idx").on(table.parseVersion, table.receivedAt),
    sourceCheck: check("observations_source_check", sql`
      ${table.source} in ('webhook','pull','client_capture','readthrough','command_result','operator','ofapi_capture','fansly_ws')
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
    postRef: text("post_ref"),
    data: jsonbSafe("data").notNull(),
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

// Stage 10: platform-neutral message archive — a rebuildable projection fed
// by message.* domain events (facts live upstream in observations/events).
export const messageArchive = pgTable(
  "message_archive",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: bigint("account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: text("platform").notNull(),
    nativeAccountRef: text("native_account_ref"),
    conversationRef: text("conversation_ref"),
    messageRef: text("message_ref").notNull(),
    fanNativeId: text("fan_native_id"),
    senderRole: text("sender_role").default("unknown").notNull(),
    isSentByMe: boolean("is_sent_by_me").default(false).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    textPlain: text("text_plain").default("").notNull(),
    nativeMessageId: bigint("native_message_id", { mode: "bigint" }),
    textHtml: text("text_html"),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    isOpened: boolean("is_opened"),
    isNew: boolean("is_new"),
    isTip: boolean("is_tip").default(false).notNull(),
    tipAmountMills: bigint("tip_amount_mills", { mode: "bigint" }).default(0n).notNull(),
    tipTextPlain: text("tip_text_plain"),
    inReplyToRef: text("in_reply_to_ref"),
    replyMetadata: jsonbSafe("reply_metadata").$type<Record<string, unknown>>(),
    mediaMetadata: jsonbSafe("media_metadata").$type<Array<Record<string, unknown>>>().default([]).notNull(),
    originClass: text("origin_class"),
    materialObservedAt: timestamp("material_observed_at", { withTimezone: true }),
    replyParentObservedAt: timestamp("reply_parent_observed_at", { withTimezone: true }),
    replyRootObservedAt: timestamp("reply_root_observed_at", { withTimezone: true }),
    vendorChangedAt: timestamp("vendor_changed_at", { withTimezone: true }),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }),
    servingContractVersion: integer("serving_contract_version").default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    sourceEventId: bigint("source_event_id", { mode: "number" }),
    backfillSource: text("backfill_source"),
    // Drift fix (Agent Read Plane 0a): present in the database since
    // migrations/0059. True while the row is a tombstone-first stub (a
    // message.deleted applied before its content event): the content is a
    // placeholder until the content event hydrates it, and content writers only
    // overwrite rows still flagged here.
    contentPending: boolean("content_pending").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniq: unique("message_archive_account_id_platform_message_ref_key").on(
      table.accountId,
      table.platform,
      table.messageRef,
    ),
    accountConvIdx: index("message_archive_account_conv_idx").on(
      table.accountId,
      table.conversationRef,
      table.occurredAt,
    ),
    accountOccurredIdx: index("message_archive_account_occurred_idx").on(
      table.accountId,
      table.occurredAt,
    ),
    // Drift fix (Agent Read Plane 0a): this index has existed in the database
    // since migrations/0059 and was simply missing from the model. The plane's
    // search operation serves from exactly this expression, and a model that
    // does not know the index exists invites a duplicate one in a later
    // migration. No new migration — the database is already correct.
    textSearchIdx: index("message_archive_text_search_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.textPlain})`,
    ),
  }),
);

// Creator-post current-head projection. Raw provider payloads remain in
// observations and every material version remains in post.observed events;
// this table is only the latest account/post view and is safe to rebuild.
export const creatorPosts = pgTable(
  "creator_posts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: bigint("account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    platformPostId: text("platform_post_id").notNull(),
    textPlain: text("text_plain").default("").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    attachmentCount: integer("attachment_count").default(0).notNull(),
    /** Fansly-native mills. `tipAmount` includes direct and goal-qualified
     * post targets; attachmentTipAmount is the tipped-reply component. */
    tipAmountMills: bigint("tip_amount_mills", { mode: "bigint" }),
    attachmentTipAmountMills: bigint("attachment_tip_amount_mills", { mode: "bigint" }),
    /** The exact counter rendered by Fansly: tipAmount + attachmentTipAmount. */
    postTipTotalMills: bigint("post_tip_total_mills", { mode: "bigint" }),
    /** Tri-state: Fansly true/false with attachment evidence, null otherwise. */
    tipGoalLinked: boolean("tip_goal_linked"),
    tipGoalRef: text("tip_goal_ref"),
    tipGoalLabel: text("tip_goal_label"),
    tipGoalTargetMills: bigint("tip_goal_target_mills", { mode: "bigint" }),
    tipGoalCurrentMills: bigint("tip_goal_current_mills", { mode: "bigint" }),
    tipGoalAmountsHidden: boolean("tip_goal_amounts_hidden"),
    // ── WP-F6 (migration 0139): the widened post head ───────────────────────
    /** Engagement counters as served. ABSENT IS NULL, NEVER 0 — `replyCount`
     * was absent on 6 of 15 timeline posts in the 2026-08-19 capture. */
    likeCount: bigint("like_count", { mode: "bigint" }),
    /** Likes on the post's ATTACHED MEDIA — a different number from
     * `likeCount` (30 vs 159 on the one post read through `GET /post?ids=`). */
    mediaLikeCount: bigint("media_like_count", { mode: "bigint" }),
    replyCount: bigint("reply_count", { mode: "bigint" }),
    /** The raw FYP bitfield; no label table exists and inventing one would
     * repeat A22-2. */
    fypFlags: integer("fyp_flags"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Thread position, kept apart even though both were null on every observed
     * creator post: the day a reply-post arrives the difference is the thread. */
    inReplyToRef: text("in_reply_to_ref"),
    inReplyToRootRef: text("in_reply_to_root_ref"),
    /** NULL = the response did not carry the field; `[]` = it carried it empty. */
    wallRefs: text("wall_refs").array(),
    /** Caption mentions — CREATOR refs, not fan refs (§9.3 does not reach it). */
    accountMentionRefs: text("account_mention_refs").array(),
    /** DERIVED from `textPlain` only (A8). Raw token, NFKC-lowercased form and
     * the parser version that produced both — one fact in three paired parts. */
    hashtags: text("hashtags").array(),
    hashtagsNormalized: text("hashtags_normalized").array(),
    hashtagParserVersion: integer("hashtag_parser_version"),
    /** The attachments' id-relations only: `{pos, contentType, contentId}`.
     * No URL, no CDN path — those stay in the raw journal. */
    attachmentRefs: jsonbSafe("attachment_refs").$type<
      Array<{ pos: number | null; contentType: number | null; contentId: string | null }>
    >(),
    /** When the counters were last observed. Written by the projector from the
     * event's own `observedAt`, so a rebuild reproduces it. */
    engagementObservedAt: timestamp("engagement_observed_at", { withTimezone: true }),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountPostUniq: unique("creator_posts_account_post_uniq").on(
      table.accountId,
      table.platformPostId,
    ),
    postIdCheck: check(
      "creator_posts_post_id_check",
      sql`length(${table.platformPostId}) > 0`,
    ),
    contentHashCheck: check(
      "creator_posts_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    attachmentCountCheck: check(
      "creator_posts_attachment_count_check",
      sql`${table.attachmentCount} >= 0`,
    ),
    tipAmountCheck: check(
      "creator_posts_tip_amount_check",
      sql`${table.tipAmountMills} is null or ${table.tipAmountMills} >= 0`,
    ),
    attachmentTipAmountCheck: check(
      "creator_posts_attachment_tip_amount_check",
      sql`${table.attachmentTipAmountMills} is null or ${table.attachmentTipAmountMills} >= 0`,
    ),
    tipTotalCheck: check(
      "creator_posts_tip_total_check",
      sql`${table.postTipTotalMills} is null or ${table.postTipTotalMills} >= 0`,
    ),
    tipTotalConsistencyCheck: check(
      "creator_posts_tip_total_consistency_check",
      sql`${table.postTipTotalMills} is not distinct from case
        when ${table.tipAmountMills} is null and ${table.attachmentTipAmountMills} is null then null
        else coalesce(${table.tipAmountMills}, 0) + coalesce(${table.attachmentTipAmountMills}, 0)
      end`,
    ),
    tipGoalRefCheck: check(
      "creator_posts_tip_goal_ref_check",
      sql`${table.tipGoalRef} is null or length(${table.tipGoalRef}) > 0`,
    ),
    tipGoalAmountCheck: check(
      "creator_posts_tip_goal_amount_check",
      sql`(${table.tipGoalTargetMills} is null or ${table.tipGoalTargetMills} >= 0)
        and (${table.tipGoalCurrentMills} is null or ${table.tipGoalCurrentMills} >= 0)`,
    ),
    tipGoalLinkCheck: check(
      "creator_posts_tip_goal_link_check",
      sql`case
        when ${table.tipGoalLinked} is true then ${table.tipGoalRef} is not null
        else ${table.tipGoalRef} is null
          and ${table.tipGoalLabel} is null
          and ${table.tipGoalTargetMills} is null
          and ${table.tipGoalCurrentMills} is null
          and ${table.tipGoalAmountsHidden} is null
      end`,
    ),
    sourceAccountSeqCheck: check(
      "creator_posts_source_account_seq_check",
      sql`${table.sourceAccountSeq} > 0`,
    ),
    observedOrderCheck: check(
      "creator_posts_observed_order_check",
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`,
    ),
    accountPublishedIdx: index("creator_posts_account_published_idx").on(
      table.accountId,
      table.publishedAt.desc(),
      table.id.desc(),
    ),
    accountObservedIdx: index("creator_posts_account_observed_idx").on(
      table.accountId,
      table.lastObservedAt.desc(),
      table.id.desc(),
    ),
    // ── WP-F6 (migration 0139) ──────────────────────────────────────────────
    engagementCountsCheck: check(
      "creator_posts_engagement_counts_check",
      sql`(${table.likeCount} is null or ${table.likeCount} >= 0)
        and (${table.mediaLikeCount} is null or ${table.mediaLikeCount} >= 0)
        and (${table.replyCount} is null or ${table.replyCount} >= 0)
        and (${table.fypFlags} is null or ${table.fypFlags} >= 0)`,
    ),
    threadRefsCheck: check(
      "creator_posts_thread_refs_check",
      sql`(${table.inReplyToRef} is null or length(${table.inReplyToRef}) > 0)
        and (${table.inReplyToRootRef} is null or length(${table.inReplyToRootRef}) > 0)`,
    ),
    refArraysCheck: check(
      "creator_posts_ref_arrays_check",
      sql`(${table.wallRefs} is null or array_position(${table.wallRefs}, null) is null)
        and (
          ${table.accountMentionRefs} is null
          or array_position(${table.accountMentionRefs}, null) is null
        )
        and (${table.hashtags} is null or array_position(${table.hashtags}, null) is null)
        and (
          ${table.hashtagsNormalized} is null
          or array_position(${table.hashtagsNormalized}, null) is null
        )`,
    ),
    hashtagPairingCheck: check(
      "creator_posts_hashtag_pairing_check",
      sql`(${table.hashtags} is null) = (${table.hashtagsNormalized} is null)
        and (${table.hashtags} is null) = (${table.hashtagParserVersion} is null)
        and (
          ${table.hashtags} is null
          or cardinality(${table.hashtags}) = cardinality(${table.hashtagsNormalized})
        )`,
    ),
    engagementObservedIdx: index("creator_posts_engagement_observed_idx").on(
      table.engagementObservedAt,
    ),
  }),
);

// Fansly individual tips returned by /tips?targetIds=<post ids>. Canonical
// acceptance requires one explicit post target; the key still includes both
// native ids so later provider evidence cannot create an accidental collision.
// Raw responses and every material version remain upstream in the journal and
// domain ledger; this table is rebuildable serving state.
export const creatorPostTips = pgTable(
  "creator_post_tips",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: bigint("account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    platformPostId: text("platform_post_id").notNull(),
    platformTipId: text("platform_tip_id").notNull(),
    tipSenderPlatformUserId: text("tip_sender_platform_user_id").notNull(),
    postTipAmountMills: bigint("post_tip_amount_mills", { mode: "bigint" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receiverTransactionRef: text("receiver_transaction_ref"),
    senderTransactionRef: text("sender_transaction_ref"),
    tipGoalRef: text("tip_goal_ref"),
    /** Provider-verbatim Fansly tip message; empty text is distinct from null. */
    tipMessageText: text("tip_message_text"),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountTipPostUniq: unique("creator_post_tips_account_tip_post_uniq").on(
      table.accountId,
      table.platformTipId,
      table.platformPostId,
    ),
    refsCheck: check(
      "creator_post_tips_refs_check",
      sql`length(${table.platformPostId}) > 0
        and length(${table.platformTipId}) > 0
        and length(${table.tipSenderPlatformUserId}) > 0
        and (${table.receiverTransactionRef} is null or length(${table.receiverTransactionRef}) > 0)
        and (${table.senderTransactionRef} is null or length(${table.senderTransactionRef}) > 0)
        and (${table.tipGoalRef} is null or length(${table.tipGoalRef}) > 0)`,
    ),
    amountCheck: check(
      "creator_post_tips_amount_check",
      sql`${table.postTipAmountMills} >= 0`,
    ),
    contentHashCheck: check(
      "creator_post_tips_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    sourceAccountSeqCheck: check(
      "creator_post_tips_source_account_seq_check",
      sql`${table.sourceAccountSeq} > 0`,
    ),
    observedOrderCheck: check(
      "creator_post_tips_observed_order_check",
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`,
    ),
    accountOccurredIdx: index("creator_post_tips_account_occurred_idx").on(
      table.accountId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    accountPostIdx: index("creator_post_tips_account_post_idx").on(
      table.accountId,
      table.platformPostId,
      table.occurredAt.desc(),
    ),
    accountSenderOccurredIdx: index("creator_post_tips_account_sender_occurred_idx").on(
      table.accountId,
      table.tipSenderPlatformUserId,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    receiverTransactionIdx: index("creator_post_tips_receiver_transaction_idx")
      .on(table.accountId, table.receiverTransactionRef)
      .where(sql`${table.receiverTransactionRef} is not null`),
  }),
);

// OF mirror S2: latest rebuildable view of append-only per-chat coverage
// proofs. Serving must additionally verify the message_archive watermark.
export const ofapiMessageCoverage = pgTable(
  "ofapi_message_coverage",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    chatId: text("chat_id").notNull(),
    classification: text("classification").notNull(),
    source: text("source").notNull(),
    frozenHeadId: text("frozen_head_id").notNull(),
    oldestMessageId: text("oldest_message_id"),
    target: jsonbSafe("target").$type<Record<string, unknown>>().notNull(),
    targetHash: char("target_hash", { length: 64 }).notNull(),
    pageChainHash: char("page_chain_hash", { length: 64 }).notNull(),
    rawCount: integer("raw_count").notNull(),
    acceptedCount: integer("accepted_count").notNull(),
    boundaryDuplicateCount: integer("boundary_duplicate_count").notNull(),
    explicitlyIrrelevantCount: integer("explicitly_irrelevant_count").notNull(),
    rejectedCount: integer("rejected_count").notNull(),
    parseDebt: integer("parse_debt").notNull(),
    requiredServingHighWater: bigint("required_serving_high_water", { mode: "number" }).notNull(),
    proofObservationId: bigint("proof_observation_id", { mode: "number" }).notNull(),
    proofObservationReceivedAt: timestamp("proof_observation_received_at", { withTimezone: true }).notNull(),
    proofPolicyVersion: text("proof_policy_version").notNull(),
    sourceContractVersion: text("source_contract_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pageId, table.chatId] }),
    classificationIdx: index("ofapi_message_coverage_classification_idx").on(
      table.classification,
      table.pageId,
    ),
  }),
);

// The standard per-account event high-water (spec name projection_watermarks
// was taken by the spender rebuild-timestamps table — recorded deviation).
export const projectionSeqWatermarks = pgTable(
  "projection_seq_watermarks",
  {
    projection: text("projection").notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    highSeq: bigint("high_seq", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projection, table.accountId] }),
  }),
);

// Stage 30: personas as kernel config (DP 9-A: single-tenant, global).
export const aiPersonas = pgTable(
  "ai_personas",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: text("key").notNull().unique(),
    displayName: text("display_name").notNull(),
    systemBlock: text("system_block").notNull(),
    featureOverrides: jsonbSafe("feature_overrides")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
  },
);

// Stage 29: the DP 6-A restricted capture class — every gateway generation's
// prompt blocks VERBATIM + completion + params, keyed by the gateway-issued
// generation ref. Owner-only reads; excluded from lake exports; inside the
// Stage 28 erasure reach.
export const aiGenerationContent = pgTable(
  "ai_generation_content",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    usageEventId: bigint("usage_event_id", { mode: "number" })
      .references(() => aiUsageEvents.id, { onDelete: "restrict" }),
    generationRef: text("generation_ref").notNull().unique(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    pageId: bigint("page_id", { mode: "number" }),
    conversationRef: text("conversation_ref"),
    // The fan this generation is ABOUT (spec §5): coach/recap requests send a
    // canonical conversation_ref (groupId) + separate fan_ref, so fan-scope
    // erasure matches on either. NULL for legacy/raw-gateway rows.
    fanRef: text("fan_ref"),
    promptBlocks: jsonbSafe("prompt_blocks").$type<unknown[]>().notNull(),
    completion: text("completion").notNull(),
    params: jsonbSafe("params").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    featureCreatedIdx: index("ai_generation_content_feature_created_idx").on(
      table.feature,
      table.createdAt,
    ),
    pageConversationIdx: index("ai_generation_content_page_conversation_idx").on(
      table.pageId,
      table.conversationRef,
    ),
    pageFanIdx: index("ai_generation_content_page_fan_idx")
      .on(table.pageId, table.fanRef)
      .where(sql`${table.fanRef} is not null`),
  }),
);

export const aiAcceptanceEvents = pgTable(
  "ai_acceptance_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    generationRef: text("generation_ref").notNull(),
    lifecycle: text("lifecycle").$type<"shown" | "copied" | "inserted" | "edited" | "sent">().notNull(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }),
  },
  (table) => ({
    uniq: unique("ai_acceptance_events_generation_ref_lifecycle_occurred_at_key").on(
      table.generationRef,
      table.lifecycle,
      table.occurredAt,
    ),
    generationIdx: index("ai_acceptance_events_generation_idx").on(table.generationRef),
  }),
);

// Stage 28: erasure tombstones — every break-glass erasure run (dry or
// executed) records its scope, initiator, per-plane plan, and (executions)
// the counts actually removed. An unresolved executed row died mid-flight and
// a successful same-scope re-run marks it superseded after convergence.
export const erasureLog = pgTable(
  "erasure_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scopeType: text("scope_type").notNull(),
    scopeRef: text("scope_ref").notNull(),
    initiatedBy: bigint("initiated_by", { mode: "number" })
      .references(() => users.id)
      .notNull(),
    dryRun: boolean("dry_run").notNull(),
    plan: jsonbSafe("plan").$type<Record<string, unknown>>().notNull(),
    executedCounts: jsonbSafe("executed_counts").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    resolutionKind: text("resolution_kind").$type<"completed" | "superseded">(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    supersededById: bigint("superseded_by_id", { mode: "number" }),
    executionProtocol: text("execution_protocol").$type<"global-erasure-lock-v1">(),
  },
  (table) => ({
    scopeIdx: index("erasure_log_scope_idx").on(
      table.scopeType,
      table.scopeRef,
      table.startedAt,
    ),
    unresolvedScopeIdx: index("erasure_log_unresolved_scope_idx")
      .on(table.scopeType, table.scopeRef, table.startedAt, table.id)
      .where(sql`${table.dryRun} = false and ${table.resolutionKind} is null`),
    supersededByFk: foreignKey({
      name: "erasure_log_superseded_by_fk",
      columns: [table.supersededById],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    resolutionKindCheck: check("erasure_log_resolution_kind_check", sql`
      ${table.resolutionKind} is null or ${table.resolutionKind} in ('completed', 'superseded')
    `),
    executionProtocolCheck: check("erasure_log_execution_protocol_check", sql`
      ${table.executionProtocol} is null or ${table.executionProtocol} = 'global-erasure-lock-v1'
    `),
    resolutionShapeCheck: check("erasure_log_resolution_shape_check", sql`
      (${table.resolutionKind} is null and ${table.resolvedAt} is null and ${table.supersededById} is null)
      or (${table.resolutionKind} = 'completed' and ${table.completedAt} is not null
          and ${table.resolvedAt} is not null and ${table.supersededById} is null)
      or (${table.resolutionKind} = 'superseded' and ${table.completedAt} is null
          and ${table.resolvedAt} is not null and ${table.supersededById} is not null)
    `),
  }),
);

// Per-conversation circuit breaker for the OFAPI dm_messages sync (0086):
// failure backoff / quarantine windows so one poison chat (vendor-side scrape
// timeout) cannot wedge a page's whole dm_messages stream. Operational sync
// state, not captured facts — cleared on successful sync, cascades with its
// thread.
export const pageDmMessageSyncHealth = pgTable(
  "page_dm_message_sync_health",
  {
    conversationId: bigint("conversation_id", { mode: "number" })
      .primaryKey()
      .references(() => pageDmThreads.id, { onDelete: "cascade" }),
    platformAccountId: bigint("platform_account_id", { mode: "number" }).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    errorClass: text("error_class"),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    quarantineUntil: timestamp("quarantine_until", { withTimezone: true }),
    // 0087: sticky working page limit learned by a successful adaptive probe
    // (giant chats time out at the default limit but serve smaller pages).
    preferredPageLimit: integer("preferred_page_limit"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountQuarantineIdx: index("page_dm_message_sync_health_account_quarantine_idx").on(
      table.platformAccountId,
      table.quarantineUntil,
    ),
  }),
);

// ── Voice notes (ElevenLabs TTS lane) ────────────────────────────────────────

// Free-form ElevenLabs voice_settings blob (stability/similarity/style/…);
// stored verbatim and echoed to the provider, never money-bearing.
export type VoiceProfileSettings = Record<string, unknown>;

// Terminal + in-flight states for a voice-note render job. TEXT + CHECK (not a
// pg enum) so the state set can evolve with a plain migration. Mirrors migration
// 0109's voice_notes_state_check verbatim.
export type VoiceNoteState =
  | "queued"
  | "dispatched"
  | "completed"
  | "failed_definite"
  | "failed_after_dispatch"
  | "indeterminate"
  | "quota_denied"
  | "artifact_expired";

// Per-page ElevenLabs voice binding, owner-editable. `version` bumps on every
// upsert so a render job can pin the exact profile it rendered against.
export const pageVoiceProfiles = pgTable("page_voice_profiles", {
  platformAccountId: bigint("platform_account_id", { mode: "number" })
    .primaryKey()
    .references(() => pages.id, { onDelete: "cascade" }),
  voiceId: text("voice_id").notNull(),
  model: text("model").default("eleven_v3").notNull(),
  settings: jsonbSafe("settings").$type<VoiceProfileSettings>().default({}).notNull(),
  outputFormat: text("output_format").default("mp3_44100_128").notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Durable state machine for a single voice-note render. The profile_* columns
// snapshot the page voice profile at request time; attempt_token + lease_until
// fence the single-dispatch CAS and the lease-expiry sweep. audio_bytes holds
// the rendered artifact until the retention purge nulls it (state →
// artifact_expired).
export const voiceNotes = pgTable(
  "voice_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id)
      .notNull(),
    conversationRef: text("conversation_ref").notNull(),
    sourceGenerationRef: text("source_generation_ref").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    scriptChars: integer("script_chars").notNull(),
    originalScriptSha256: text("original_script_sha256").notNull(),
    finalScriptSha256: text("final_script_sha256").notNull(),
    scriptEdited: boolean("script_edited").notNull(),
    profileVoiceId: text("profile_voice_id").notNull(),
    profileModel: text("profile_model").notNull(),
    profileSettings: jsonbSafe("profile_settings").$type<VoiceProfileSettings>().notNull(),
    profileOutputFormat: text("profile_output_format").notNull(),
    profileVersion: integer("profile_version").notNull(),
    state: text("state").$type<VoiceNoteState>().default("queued").notNull(),
    attemptToken: uuid("attempt_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    billed: boolean("billed"),
    billedChars: integer("billed_chars"),
    providerRequestId: text("provider_request_id"),
    providerTraceId: text("provider_trace_id"),
    providerRegion: text("provider_region"),
    durationMs: integer("duration_ms"),
    audioBytes: bytea("audio_bytes"),
    audioSha256: text("audio_sha256"),
    audioBytesLen: integer("audio_bytes_len"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userClientRequestUniq: uniqueIndex("voice_notes_user_client_request").on(
      table.userId,
      table.clientRequestId,
    ),
    leaseIdx: index("voice_notes_lease_idx").on(table.state, table.leaseUntil),
    purgeIdx: index("voice_notes_purge_idx")
      .on(table.state, table.createdAt)
      .where(sql`${table.audioBytes} is not null`),
    stateCheck: check("voice_notes_state_check", sql`
      ${table.state} in (
        'queued',
        'dispatched',
        'completed',
        'failed_definite',
        'failed_after_dispatch',
        'indeterminate',
        'quota_denied',
        'artifact_expired'
      )
    `),
    charsPositiveCheck: check("voice_notes_chars_positive", sql`${table.scriptChars} > 0`),
    audioCapCheck: check("voice_notes_audio_cap", sql`
      ${table.audioBytesLen} is null or ${table.audioBytesLen} <= 2097152
    `),
    audioBytesConsistentCheck: check("voice_notes_audio_bytes_consistent", sql`
      ${table.audioBytes} is null or (
        ${table.audioBytesLen} is not null
        and ${table.audioBytesLen} = octet_length(${table.audioBytes})
        and octet_length(${table.audioBytes}) <= 2097152
      )
    `),
  }),
);

// Per-(scope, UTC-day) character-spend counter for the atomic voice budget
// reservation. scope is 'global' or 'page:<id>'; the (scope, utc_day) PK lets a
// new day start a fresh row without a rollover reset.
export const voiceCharBudget = pgTable(
  "voice_char_budget",
  {
    scope: text("scope").notNull(),
    utcDay: date("utc_day").notNull(),
    spentChars: integer("spent_chars").default(0).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "voice_char_budget_pkey",
      columns: [table.scope, table.utcDay],
    }),
  }),
);

// ── Agent Read Plane (slice 0a) ─────────────────────────────────────────────
// A third class of machine principal, deliberately NOT a row in api_keys: the
// existing admin key routes must never be able to issue, list or revoke one.
// Nothing reads these tables yet — slice 0a ships the schema, the vocabulary
// and the flags, all of which rest at off/false.

export const agentKeys = pgTable(
  "agent_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    keyDigest: text("key_digest").notNull().unique(),
    /** Closed matrix; values come from AGENT_CAPABILITIES (@agency_hub_core/contracts).
     *  A DB CHECK repeats the list as defense in depth and a test pins the two together. */
    capabilities: text("capabilities").array().default([]).notNull(),
    /** Explicit page grant. NO wildcard: pages created after issuance are not granted. */
    pageIds: bigint("page_ids", { mode: "number" }).array().default([]).notNull(),
    dailyRequestBudget: integer("daily_request_budget").default(5000).notNull(),
    dailyRowBudget: integer("daily_row_budget").default(500000).notNull(),
    /** Mandatory, sliding (+90d on use) and capped at 365d from createdAt — the
     *  device-token precedent. Enforcement lives in the authenticator (slice 0b). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // `on delete restrict` mirrors 0115: the issuer of a live machine key cannot
    // be deleted out from under its audit trail.
    createdBy: bigint("created_by", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    expiryIdx: index("agent_keys_expiry_idx").on(table.expiresAt),
    capabilitiesCheck: check("agent_keys_capabilities_check", sql`
      ${table.capabilities} <@ ARRAY[
        'read:messages',
        'read:money',
        'read:observations_envelope',
        'read:datasets',
        'request:hydration'
      ]::text[]
    `),
    expiresAtCheck: check("agent_keys_expires_at_check", sql`
      ${table.expiresAt} > ${table.createdAt}
    `),
    // The hard ceiling is a constraint, not just repository logic: no path —
    // issuance, the sliding renewal, or a hand-run UPDATE — may mint a key that
    // outlives the cap the mandatory expiry exists to impose.
    maxLifetimeCheck: check("agent_keys_max_lifetime_check", sql`
      ${table.expiresAt} <= ${table.createdAt} + interval '365 days'
    `),
    requestBudgetCheck: check("agent_keys_daily_request_budget_check", sql`
      ${table.dailyRequestBudget} >= 0
    `),
    rowBudgetCheck: check("agent_keys_daily_row_budget_check", sql`
      ${table.dailyRowBudget} >= 0
    `),
  }),
);

// Per-key, per-UTC-day budget counter. Every write is a single
// insert .. on conflict do update .. returning: the first request of a day has
// no row to update, and two concurrent requests must SUM rather than race.
export const agentKeyUsageDaily = pgTable(
  "agent_key_usage_daily",
  {
    agentKeyId: bigint("agent_key_id", { mode: "number" })
      .references(() => agentKeys.id, { onDelete: "restrict" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    requests: integer("requests").default(0).notNull(),
    rowsReturned: bigint("rows_returned", { mode: "bigint" }).default(0n).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "agent_key_usage_daily_pkey",
      columns: [table.agentKeyId, table.businessDate],
    }),
    requestsCheck: check("agent_key_usage_daily_requests_check", sql`${table.requests} >= 0`),
    rowsCheck: check("agent_key_usage_daily_rows_returned_check", sql`${table.rowsReturned} >= 0`),
  }),
);

// Append-only record of what the plane served. `requestSummary` carries BOUNDED
// STRUCTURED FACTS ONLY (docs/error-handling.md sink allowlist): a search string
// enters as {qSha256, qLength}, a hydration reason likewise — never verbatim.
export const agentReadAudit = pgTable(
  "agent_read_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Agent-key operations carry a key and no human. */
    agentKeyId: bigint("agent_key_id", { mode: "number" })
      .references(() => agentKeys.id, { onDelete: "restrict" }),
    /** Owner-session operations (#9b, #13) carry a human and no key. */
    sessionUserId: bigint("session_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    operation: text("operation").notNull(),
    pageIds: bigint("page_ids", { mode: "number" }).array().default([]).notNull(),
    /** True when the response carried verbatim fan/model text. */
    verbatimText: boolean("verbatim_text").default(false).notNull(),
    requestSummary: jsonbSafe("request_summary")
      .$type<Record<string, string | number | boolean | null>>()
      .default({})
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The #9b owner-session daily cap counts rows through exactly this index.
    sessionOperationIdx: index("agent_read_audit_session_operation_idx").on(
      table.sessionUserId,
      table.operation,
      table.occurredAt,
    ),
    // EXACTLY ONE principal. "At least one" would admit a row claiming a machine
    // and a human authored the same read — never true, and it would make the
    // #9b per-session count over-report while attributing an agent read to a
    // person.
    principalCheck: check("agent_read_audit_principal_check", sql`
      num_nonnulls(${table.agentKeyId}, ${table.sessionUserId}) = 1
    `),
  }),
);

// Singleton counter bumped by the message_archive rebuild swap. A cursor minted
// before a swap must be refused after it: the table can be renamed under a
// reader (#134), and a resumed read would otherwise skip rows while reporting
// "the snapshot is exhausted" — a false "I read everything".
export const archiveGeneration = pgTable(
  "archive_generation",
  {
    id: integer("id").primaryKey(),
    generation: bigint("generation", { mode: "bigint" }).default(0n).notNull(),
    bumpedAt: timestamp("bumped_at", { withTimezone: true }).defaultNow().notNull(),
    reason: text("reason"),
  },
  (table) => ({
    singletonCheck: check("archive_generation_singleton_check", sql`${table.id} = 1`),
  }),
);

// ── Agent Read Plane (slice C): hydration requests ──────────────────────────
// An agent writes down an INTENT; the owner decides; the executor hands the
// approved work to machinery that already exists. Both tables are business
// facts (what was asked, what was allowed, what it cost) and nothing deletes
// from them on a schedule.

/** The eight wire states of MERGED 17.11. `requested` is the only entry. */
export type AgentHydrationState =
  | "requested"
  | "approved"
  | "dispatching"
  | "partially_completed"
  | "completed"
  | "rejected"
  | "expired"
  | "failed";

export type AgentHydrationLane = "free_local_replay" | "vendor_paid_low" | "vendor_paid_high";

export type AgentHydrationCostNote =
  | "no_direct_cost"
  | "egress_quota_and_ban_risk"
  | "ofapi_credits";

export type AgentHydrationLastError =
  | "none"
  | "vendor_unavailable"
  | "proxy_missing"
  | "budget_exhausted"
  | "retention_limit"
  | "quarantined"
  | "timeout";

export const agentHydrationRequests = pgTable(
  "agent_hydration_requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The wire identifier. Never the serial: that would leak volume and order. */
    requestRef: uuid("request_ref").notNull().unique(),
    agentKeyId: bigint("agent_key_id", { mode: "number" })
      .references(() => agentKeys.id, { onDelete: "restrict" })
      .notNull(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    conversationRef: text("conversation_ref").notNull(),
    threadId: bigint("thread_id", { mode: "number" }),
    state: text("state").$type<AgentHydrationState>().default("requested").notNull(),
    /** The DDL default (0117): the only kind a CHECK admits today. */
    targetKind: text("target_kind").default("thread_backfill_before").notNull(),
    /** A BOUNDARY, not a window: exactly one of the two is set. */
    targetBeforeAt: timestamp("target_before_at", { withTimezone: true }),
    targetBeforeMessageRef: text("target_before_message_ref"),
    /** Caller text never lands verbatim (sink allowlist). */
    reasonSha256: char("reason_sha256", { length: 64 }).notNull(),
    reasonLength: integer("reason_length").notNull(),
    requestedMaxCalls: integer("requested_max_calls"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    /** The approval is bound to the content hash of what the owner was shown. */
    coverageFingerprint: char("coverage_fingerprint", { length: 64 }).notNull(),
    laneOrderEvaluated: text("lane_order_evaluated").array().default([]).notNull(),
    laneSelected: text("lane_selected").$type<AgentHydrationLane>(),
    laneCostNote: text("lane_cost_note").$type<AgentHydrationCostNote>(),
    admissible: boolean("admissible").notNull(),
    admissibilityReason: text("admissibility_reason"),
    rowVersion: integer("row_version").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: bigint("decided_by_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    decisionApproved: boolean("decision_approved"),
    /** #158 consent: the vendor read mutates read state on the platform. */
    decisionAllowMarkRead: boolean("decision_allow_mark_read"),
    decisionMaxCalls: integer("decision_max_calls"),
    decisionMaxCredits: integer("decision_max_credits"),
    decisionMaxPages: integer("decision_max_pages"),
    decisionMaxItems: integer("decision_max_items"),
    decisionReasonSha256: char("decision_reason_sha256", { length: 64 }),
    decisionReasonLength: integer("decision_reason_length"),
    decisionIdempotencyKey: uuid("decision_idempotency_key"),
    decisionFingerprint: char("decision_fingerprint", { length: 64 }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchDeadlineAt: timestamp("dispatch_deadline_at", { withTimezone: true }),
    executionLane: text("execution_lane").$type<AgentHydrationLane>(),
    /** pg-boss job id (Fansly) or ofapi_capture_jobs uuid (OnlyFans). */
    executionRef: text("execution_ref"),
    dispatchCount: integer("dispatch_count").default(0).notNull(),
    acceptedItems: bigint("accepted_items", { mode: "number" }).default(0).notNull(),
    acceptedPages: bigint("accepted_pages", { mode: "number" }).default(0).notNull(),
    spentCredits: integer("spent_credits").default(0).notNull(),
    lastError: text("last_error").$type<AgentHydrationLastError>().default("none").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idempotencyUniq: uniqueIndex("agent_hydration_requests_idempotency_uniq")
      .on(table.agentKeyId, table.idempotencyKey),
    stateIdx: index("agent_hydration_requests_state_idx").on(table.state, table.createdAt),
    pageThreadIdx: index("agent_hydration_requests_page_thread_idx")
      .on(table.pageId, table.conversationRef, table.createdAt),
    stateCheck: check("agent_hydration_requests_state_check", sql`
      ${table.state} in ('requested', 'approved', 'dispatching', 'partially_completed',
                         'completed', 'rejected', 'expired', 'failed')
    `),
    targetKindCheck: check("agent_hydration_requests_target_kind_check", sql`
      ${table.targetKind} = 'thread_backfill_before'
    `),
    targetBoundCheck: check("agent_hydration_requests_target_bound_check", sql`
      num_nonnulls(${table.targetBeforeAt}, ${table.targetBeforeMessageRef}) = 1
    `),
    laneCheck: check("agent_hydration_requests_lane_check", sql`
      ${table.laneSelected} is null or ${table.laneSelected} in
        ('free_local_replay', 'vendor_paid_low', 'vendor_paid_high')
    `),
    costNoteCheck: check("agent_hydration_requests_cost_note_check", sql`
      ${table.laneCostNote} is null or ${table.laneCostNote} in
        ('no_direct_cost', 'egress_quota_and_ban_risk', 'ofapi_credits')
    `),
    lastErrorCheck: check("agent_hydration_requests_last_error_check", sql`
      ${table.lastError} in ('none', 'vendor_unavailable', 'proxy_missing',
                            'budget_exhausted', 'retention_limit', 'quarantined', 'timeout')
    `),
    approvalExpiryCheck: check("agent_hydration_requests_approval_expiry_check", sql`
      ${table.decisionApproved} is distinct from true
      or (${table.expiresAt} is not null and ${table.decisionAllowMarkRead} is not null)
    `),
    reasonLengthCheck: check("agent_hydration_requests_reason_length_check", sql`
      ${table.reasonLength} >= 0 and ${table.reasonLength} <= 1000
    `),
    countersCheck: check("agent_hydration_requests_counters_check", sql`
      ${table.dispatchCount} >= 0 and ${table.acceptedItems} >= 0
      and ${table.acceptedPages} >= 0 and ${table.spentCredits} >= 0
    `),
  }),
);

/** Append-only history of every transition. The request row is the CURRENT
 *  state; this is how it got there, and nothing updates or deletes a row. */
export const agentHydrationEvents = pgTable(
  "agent_hydration_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    requestId: bigint("request_id", { mode: "number" })
      .references(() => agentHydrationRequests.id, { onDelete: "restrict" })
      .notNull(),
    /** Gapless per request, allocated in the transition's own transaction. */
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    fromState: text("from_state").$type<AgentHydrationState>(),
    toState: text("to_state").$type<AgentHydrationState>().notNull(),
    rowVersion: integer("row_version").notNull(),
    actor: text("actor").$type<"agent_key" | "owner_session" | "executor" | "sweeper">().notNull(),
    agentKeyId: bigint("agent_key_id", { mode: "number" })
      .references(() => agentKeys.id, { onDelete: "restrict" }),
    sessionUserId: bigint("session_user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "restrict" }),
    /** Bounded structured facts only, same law as agent_read_audit. */
    detail: jsonbSafe("detail")
      .$type<Record<string, string | number | boolean | null>>()
      .default({})
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The constraint's own btree on (request_id, seq) IS the traversal index;
    // 0117 additionally created `agent_hydration_events_request_idx` on the same
    // pair, which 0118 drops. Do not re-add it.
    seqUniq: unique("agent_hydration_events_seq_uniq").on(table.requestId, table.seq),
    actorCheck: check("agent_hydration_events_actor_check", sql`
      ${table.actor} in ('agent_key', 'owner_session', 'executor', 'sweeper')
    `),
    kindCheck: check("agent_hydration_events_kind_check", sql`
      ${table.kind} in ('created', 'approved', 'rejected', 'dispatched',
                        'settled', 'expired', 'failed')
    `),
  }),
);

// ── Content-addressed capture payloads (G5 slice 0, migration 0123) ──────────
// The identity catalog plus its hot bodies. ADDITIVE and EMPTY today: no
// envelope table references these yet and no production writer exists — the
// repository (repositories/capture-payloads.ts) and the read seam
// (apps/runtime/src/services/payload-reader.ts) ship ahead of their call sites
// so the dual-write slice is a pure call-site change.
//
// All four tables are PARTITION BY RANGE (bucket_month) with monthly children
// plus a `*_future` catch-all, following the observations precedent (0054) and
// its far-future backstop (0082). The month is part of the identity on
// purpose: a closed capture month is a ref-closed cohort, so the same content
// in a new month is a NEW object and no cold segment ever holds a cross-month
// reference.

// The access-class / erasure-domain / representation vocabularies live in ONE
// place: repositories/capture-payloads.ts (mirrored by 0123's CHECKs below).
export const capturePayloadObjects = pgTable(
  "capture_payload_objects",
  {
    bucketMonth: date("bucket_month", { mode: "string" }).notNull(),
    // GENERATED ALWAYS AS IDENTITY in the migration; the repository lets
    // Postgres assign it and reads it back from RETURNING.
    objectId: bigint("object_id", { mode: "number" }).notNull(),
    // NULLABLE, and the identity unique below is NULLS NOT DISTINCT: unmapped
    // capture (ingest before the account is known, auth audit) is real, and
    // ordinary null semantics would give every such row its own object.
    platformAccountId: bigint("platform_account_id", { mode: "number" }),
    accessClass: text("access_class").notNull(),
    erasureDomain: text("erasure_domain").notNull(),
    representation: text("representation").notNull(),
    codecVersion: smallint("codec_version").notNull(),
    contentSha256: bytea("content_sha256").notNull(),
    // A digest is not proof of equality: a differing body under the same digest
    // takes the next ordinal and keeps its own body row.
    collisionOrdinal: integer("collision_ordinal").default(0).notNull(),
    logicalBytes: bigint("logical_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bucketMonth, table.objectId] }),
    identityUniq: unique("capture_payload_objects_identity_uniq")
      .on(
        table.bucketMonth, table.platformAccountId, table.accessClass, table.erasureDomain,
        table.representation, table.codecVersion, table.contentSha256, table.logicalBytes,
        table.collisionOrdinal,
      )
      .nullsNotDistinct(),
    bucketMonthCheck: check("capture_payload_objects_bucket_month_check", sql`
      extract(day from ${table.bucketMonth}) = 1
    `),
    accessClassCheck: check("capture_payload_objects_access_class_check", sql`
      ${table.accessClass} in ('ordinary_capture', 'restricted_ai', 'operator_audit')
    `),
    erasureDomainCheck: check("capture_payload_objects_erasure_domain_check", sql`
      ${table.erasureDomain} in ('platform_account', 'fan_subject', 'system')
    `),
    representationCheck: check("capture_payload_objects_representation_check", sql`
      ${table.representation} in ('canonical_json', 'exact_bytes')
    `),
    contentSha256Check: check("capture_payload_objects_content_sha256_check", sql`
      octet_length(${table.contentSha256}) = 32
    `),
    collisionOrdinalCheck: check("capture_payload_objects_collision_ordinal_check", sql`
      ${table.collisionOrdinal} >= 0
    `),
    logicalBytesCheck: check("capture_payload_objects_logical_bytes_check", sql`
      ${table.logicalBytes} >= 0
    `),
    codecVersionCheck: check("capture_payload_objects_codec_version_check", sql`
      ${table.codecVersion} >= 0
    `),
  }),
);

/** Semantic JSON bodies. Stays queryable `jsonb` in the hot tier; the canonical
 *  octets are deliberately NOT stored beside it — that would be a second copy
 *  of every body, which is the thing this whole model exists to remove. */
export const captureJsonHotBodies = pgTable(
  "capture_json_hot_bodies",
  {
    bucketMonth: date("bucket_month", { mode: "string" }).notNull(),
    objectId: bigint("object_id", { mode: "number" }).notNull(),
    body: jsonbSafe("body").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bucketMonth, table.objectId] }),
    objectFk: foreignKey({
      name: "capture_json_hot_bodies_object_fkey",
      columns: [table.bucketMonth, table.objectId],
      foreignColumns: [capturePayloadObjects.bucketMonth, capturePayloadObjects.objectId],
    }).onDelete("restrict"),
  }),
);

/** Exact wire octets (webhook raw bodies). Never JSON-reserialized, never
 *  mixed with the canonical-JSON representation. */
export const captureByteHotBodies = pgTable(
  "capture_byte_hot_bodies",
  {
    bucketMonth: date("bucket_month", { mode: "string" }).notNull(),
    objectId: bigint("object_id", { mode: "number" }).notNull(),
    body: bytea("body").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bucketMonth, table.objectId] }),
    objectFk: foreignKey({
      name: "capture_byte_hot_bodies_object_fkey",
      columns: [table.bucketMonth, table.objectId],
      foreignColumns: [capturePayloadObjects.bucketMonth, capturePayloadObjects.objectId],
    }).onDelete("restrict"),
  }),
);

/** Where the body physically lives. `hot` means the matching *_hot_bodies row;
 *  `cold` means an S6 segment, and then the locator pair says which row of
 *  which segment. The locator CHECK is two-directional: a `cold` row with no
 *  locators is a body the system thinks it moved and cannot find, and a `hot`
 *  row with locators is two contradictory answers to "where is this body". */
export const capturePayloadLocations = pgTable(
  "capture_payload_locations",
  {
    bucketMonth: date("bucket_month", { mode: "string" }).notNull(),
    objectId: bigint("object_id", { mode: "number" }).notNull(),
    storageTier: text("storage_tier").notNull(),
    segmentId: bigint("segment_id", { mode: "number" }),
    rowLocator: bigint("row_locator", { mode: "number" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bucketMonth, table.objectId] }),
    objectFk: foreignKey({
      name: "capture_payload_locations_object_fkey",
      columns: [table.bucketMonth, table.objectId],
      foreignColumns: [capturePayloadObjects.bucketMonth, capturePayloadObjects.objectId],
    }).onDelete("restrict"),
    storageTierCheck: check("capture_payload_locations_storage_tier_check", sql`
      ${table.storageTier} in ('hot', 'cold')
    `),
    locatorCheck: check("capture_payload_locations_locator_check", sql`
      (${table.storageTier} = 'hot'
        and ${table.segmentId} is null and ${table.rowLocator} is null)
      or (${table.storageTier} = 'cold'
        and ${table.segmentId} is not null and ${table.rowLocator} is not null)
    `),
  }),
);

// ── WP-F0(b): the media plane ───────────────────────────────────────────────
// Four rebuildable projections over the sync-pull v5 projection-only events.
// Migration 0130 is the authority; these mirrors exist for typed reads/writes.
// NO url/location/variant column exists here BY DESIGN — those stay in the raw
// journal. Money is mills and NULL-or-non-negative: a sparse saleStats means
// "not served", never zero.

/** File metadata, independent of commerce offer ids and album membership. */
export const creatorRawMedia = pgTable(
  "creator_raw_media",
  {
    pageId: bigint("page_id", { mode: "number" }).references(() => pages.id, { onDelete: "restrict" }).notNull(),
    platform: platformColumn("platform").references(() => platforms.key, { onDelete: "restrict" }).notNull(),
    mediaRef: text("media_ref").notNull(),
    ownerAccountRef: text("owner_account_ref"),
    filename: text("filename"),
    mediaType: integer("media_type"),
    providerType: text("provider_type"),
    mimeType: text("mime_type"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    originalWidth: integer("original_width"),
    originalHeight: integer("original_height"),
    width: integer("width"),
    height: integer("height"),
    frameRateMilli: bigint("frame_rate_milli", { mode: "number" }),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    updatedAtPlatform: timestamp("updated_at_platform", { withTimezone: true }),
    sourceKind: text("source_kind").notNull(),
    firstOrigin: text("first_origin").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "creator_raw_media_pkey", columns: [table.pageId, table.mediaRef] }),
    pageObservedIdx: index("creator_raw_media_page_observed_idx").on(table.pageId, table.firstObservedAt, table.mediaRef),
    pageUpdatedIdx: index("creator_raw_media_page_updated_idx").on(table.pageId, table.updatedAt, table.mediaRef),
    firstOriginCheck: check("creator_raw_media_first_origin_check", sql`${table.firstOrigin} in ('vault', 'post')`),
    sourceKindCheck: check("creator_raw_media_source_kind_check", sql`${table.sourceKind} in ('vault_albums', 'uservault_albums', 'vault_media', 'account_media_batch', 'posts', 'ofapi.posts_page.v1')`),
  }),
);

export const creatorMedia = pgTable(
  "creator_media",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    /** accountMedia.id — the offer identity attachments and orders point at. */
    mediaOfferRef: text("media_offer_ref").notNull(),
    mediaRef: text("media_ref"),
    previewRef: text("preview_ref"),
    bundleRefs: text("bundle_refs").array().default([]).notNull(),
    mediaType: integer("media_type"),
    mimeType: text("mime_type"),
    width: integer("width"),
    height: integer("height"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    /** EVERY permissions.permissionFlags[] row, verbatim. */
    permissionEntries: jsonbSafe("permission_entries").$type<unknown[]>().default([]).notNull(),
    permissionFlags: integer("permission_flags"),
    likeCount: bigint("like_count", { mode: "number" }),
    salesCount: bigint("sales_count", { mode: "number" }),
    /** A12: saleStats.total is NET. */
    salesNetMills: bigint("sales_net_mills", { mode: "bigint" }),
    salesPendingMills: bigint("sales_pending_mills", { mode: "bigint" }),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    deletedAtPlatform: timestamp("deleted_at_platform", { withTimezone: true }),
    firstOrigin: text("first_origin").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pageOfferUniq: unique("creator_media_page_offer_uniq").on(
      table.pageId,
      table.platform,
      table.mediaOfferRef,
    ),
    pageObservedIdx: index("creator_media_page_observed_idx").on(
      table.pageId,
      table.lastObservedAt,
      table.id,
    ),
  }),
);

export const creatorMediaBundles = pgTable(
  "creator_media_bundles",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    bundleRef: text("bundle_ref").notNull(),
    previewRef: text("preview_ref"),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    permissionEntries: jsonbSafe("permission_entries").$type<unknown[]>().default([]).notNull(),
    permissionFlags: integer("permission_flags"),
    memberRefs: text("member_refs").array().default([]).notNull(),
    memberPositions: jsonbSafe("member_positions").$type<unknown[]>().default([]).notNull(),
    salesCount: bigint("sales_count", { mode: "number" }),
    salesNetMills: bigint("sales_net_mills", { mode: "bigint" }),
    salesPendingMills: bigint("sales_pending_mills", { mode: "bigint" }),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    deletedAtPlatform: timestamp("deleted_at_platform", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "creator_media_bundles_pkey",
      columns: [table.pageId, table.bundleRef],
    }),
    pageObservedIdx: index("creator_media_bundles_page_observed_idx").on(
      table.pageId,
      table.lastObservedAt,
    ),
  }),
);

export const mediaOrders = pgTable(
  "media_orders",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    mediaOfferRef: text("media_offer_ref").notNull(),
    /** Fan-scope erasure target (Stage 28.4) — a TEXT platform ref, no FK. */
    buyerPlatformUserId: text("buyer_platform_user_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Null until a response is observed carrying an order id (§2.3). */
    orderRef: text("order_ref"),
    bundleRef: text("bundle_ref"),
    orderType: integer("order_type"),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    conversationRef: text("conversation_ref"),
    messageRef: text("message_ref"),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "media_orders_pkey",
      columns: [table.pageId, table.mediaOfferRef, table.buyerPlatformUserId, table.occurredAt],
    }),
    pageOccurredIdx: index("media_orders_page_occurred_idx").on(
      table.pageId,
      table.occurredAt,
    ),
    pageBuyerOccurredIdx: index("media_orders_page_buyer_occurred_idx").on(
      table.pageId,
      table.buyerPlatformUserId,
      table.occurredAt,
    ),
  }),
);

export const messageMediaOffers = pgTable(
  "message_media_offers",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    messageRef: text("message_ref").notNull(),
    offerOrdinal: integer("offer_ordinal").notNull(),
    mediaOfferRef: text("media_offer_ref"),
    bundleRef: text("bundle_ref"),
    conversationRef: text("conversation_ref"),
    /** Fan-scope erasure target (Stage 28.4) — a TEXT platform ref, no FK. */
    fanPlatformUserId: text("fan_platform_user_id"),
    messageCreatedAt: timestamp("message_created_at", { withTimezone: true }),
    offerType: integer("offer_type"),
    mimeType: text("mime_type"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    permissionEntries: jsonbSafe("permission_entries").$type<unknown[]>().default([]).notNull(),
    /** A17-4 variant B: the archive joins THIS for purchase state. */
    purchaseState: text("purchase_state").default("unknown").notNull(),
    orderRef: text("order_ref"),
    salesCount: bigint("sales_count", { mode: "number" }),
    salesNetMills: bigint("sales_net_mills", { mode: "bigint" }),
    salesPendingMills: bigint("sales_pending_mills", { mode: "bigint" }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_media_offers_pkey",
      columns: [table.pageId, table.messageRef, table.offerOrdinal],
    }),
    pageMessageIdx: index("message_media_offers_page_message_idx").on(
      table.pageId,
      table.messageRef,
    ),
  }),
);

// ── WP-F1 (0132): the statistics core ────────────────────────────────────────
// Mirrors only. The migration is the authority on CHECK constraints and on the
// (status, acquisition_mode, proof) mapping comment; these definitions exist so
// the tables are visible to Drizzle-typed callers.

export const statsTrafficBuckets = pgTable(
  "stats_traffic_buckets",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectRef: text("subject_ref").notNull(),
    periodMs: bigint("period_ms", { mode: "number" }).notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    /** The RAW platform code as text — never a label (A22-2). */
    sourceCode: text("source_code").notNull(),
    mappingVersion: integer("mapping_version").notNull(),
    /** NULL = "the platform did not serve this", never zero. */
    views: bigint("views", { mode: "number" }),
    previewViews: bigint("preview_views", { mode: "number" }),
    uniqueViewers: bigint("unique_viewers", { mode: "number" }),
    previewUniqueViewers: bigint("preview_unique_viewers", { mode: "number" }),
    videoViews: bigint("video_views", { mode: "number" }),
    previewVideoViews: bigint("preview_video_views", { mode: "number" }),
    interactionTimeMs: bigint("interaction_time_ms", { mode: "number" }),
    previewInteractionTimeMs: bigint("preview_interaction_time_ms", { mode: "number" }),
    /** A SUM over views on the wire; divide at read time, never on write. */
    videoPercentWatchedSum: numeric("video_percent_watched_sum", { precision: 20, scale: 10 }),
    previewVideoPercentWatchedSum: numeric("preview_video_percent_watched_sum", {
      precision: 20,
      scale: 10,
    }),
    requestedStart: timestamp("requested_start", { withTimezone: true }),
    requestedEnd: timestamp("requested_end", { withTimezone: true }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    revisionCount: integer("revision_count").default(0).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "stats_traffic_buckets_pkey",
      columns: [
        table.pageId,
        table.subjectKind,
        table.subjectRef,
        table.periodMs,
        table.bucketStart,
        table.sourceCode,
      ],
    }),
    pagePeriodBucketIdx: index("stats_traffic_buckets_page_period_bucket_idx").on(
      table.pageId,
      table.periodMs,
      table.bucketStart,
      table.subjectKind,
    ),
  }),
);

export const statsTopMedia = pgTable(
  "stats_top_media",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    /** A21: the window IS the identity — inline, not a FK. */
    plane: text("plane").notNull(),
    periodMs: bigint("period_ms", { mode: "number" }).notNull(),
    requestedStart: timestamp("requested_start", { withTimezone: true }).notNull(),
    requestedEnd: timestamp("requested_end", { withTimezone: true }).notNull(),
    mediaOfferRef: text("media_offer_ref").notNull(),
    bundleRef: text("bundle_ref"),
    rank: integer("rank").notNull(),
    views: bigint("views", { mode: "number" }),
    previewViews: bigint("preview_views", { mode: "number" }),
    interactionTimeMs: bigint("interaction_time_ms", { mode: "number" }),
    previewInteractionTimeMs: bigint("preview_interaction_time_ms", { mode: "number" }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "stats_top_media_pkey",
      columns: [
        table.pageId,
        table.plane,
        table.periodMs,
        table.requestedStart,
        table.requestedEnd,
        table.mediaOfferRef,
      ],
    }),
    pageWindowRankIdx: index("stats_top_media_page_window_rank_idx").on(
      table.pageId,
      table.plane,
      table.requestedEnd,
      table.rank,
    ),
  }),
);

export const statsTopTags = pgTable(
  "stats_top_tags",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    plane: text("plane").notNull(),
    periodMs: bigint("period_ms", { mode: "number" }).notNull(),
    requestedStart: timestamp("requested_start", { withTimezone: true }).notNull(),
    requestedEnd: timestamp("requested_end", { withTimezone: true }).notNull(),
    tagRef: text("tag_ref").notNull(),
    /** NULL when the tags[] join misses — never fabricated from the id. */
    tagName: text("tag_name"),
    rank: integer("rank").notNull(),
    views: bigint("views", { mode: "number" }),
    previewViews: bigint("preview_views", { mode: "number" }),
    interactionTimeMs: bigint("interaction_time_ms", { mode: "number" }),
    previewInteractionTimeMs: bigint("preview_interaction_time_ms", { mode: "number" }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "stats_top_tags_pkey",
      columns: [
        table.pageId,
        table.plane,
        table.periodMs,
        table.requestedStart,
        table.requestedEnd,
        table.tagRef,
      ],
    }),
    pageWindowRankIdx: index("stats_top_tags_page_window_rank_idx").on(
      table.pageId,
      table.plane,
      table.requestedEnd,
      table.rank,
    ),
  }),
);

/** Per-media tag rankings. WP-F4 fills it; F1 only creates it. */
export const fanslyMediaTagStats = pgTable(
  "fansly_media_tag_stats",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    mediaOfferRef: text("media_offer_ref").notNull(),
    tagRef: text("tag_ref").notNull(),
    periodMs: bigint("period_ms", { mode: "number" }).notNull(),
    requestedStart: timestamp("requested_start", { withTimezone: true }).notNull(),
    requestedEnd: timestamp("requested_end", { withTimezone: true }).notNull(),
    tagName: text("tag_name"),
    rank: integer("rank"),
    views: bigint("views", { mode: "number" }),
    previewViews: bigint("preview_views", { mode: "number" }),
    interactionTimeMs: bigint("interaction_time_ms", { mode: "number" }),
    previewInteractionTimeMs: bigint("preview_interaction_time_ms", { mode: "number" }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "fansly_media_tag_stats_pkey",
      columns: [
        table.pageId,
        table.mediaOfferRef,
        table.tagRef,
        table.periodMs,
        table.requestedStart,
        table.requestedEnd,
      ],
    }),
    pageMediaIdx: index("fansly_media_tag_stats_page_media_idx").on(
      table.pageId,
      table.mediaOfferRef,
      table.requestedEnd,
    ),
  }),
);

/** Platform-GLOBAL tag counters, sampled per page (account_seq is incomparable
 *  across pages, so the PK is per page and the global value is derived at read
 *  time: latest captured_at wins, ties break on page_id ascending). */
export const platformTagDaily = pgTable(
  "platform_tag_daily",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    tagRef: text("tag_ref").notNull(),
    businessDate: date("business_date").notNull(),
    tagName: text("tag_name"),
    viewCount: bigint("view_count", { mode: "number" }),
    postCount: bigint("post_count", { mode: "number" }),
    tagCreatedAt: timestamp("tag_created_at", { withTimezone: true }),
    source: text("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "platform_tag_daily_pkey",
      columns: [table.pageId, table.platform, table.tagRef, table.businessDate],
    }),
    tagDateIdx: index("platform_tag_daily_tag_date_idx").on(
      table.platform,
      table.tagRef,
      table.businessDate,
    ),
  }),
);

/** A17-5: creatorMediaOfferLocations[] stored PARSED. Pure id-relations — no
 *  URLs, no CDN paths (those stay raw-journal-only). */
export const mediaOfferLocations = pgTable(
  "media_offer_locations",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    locationRef: text("location_ref").notNull(),
    mediaOfferRef: text("media_offer_ref"),
    mediaOfferType: integer("media_offer_type"),
    bundleRef: text("bundle_ref"),
    mediaRef: text("media_ref"),
    mediaType: integer("media_type"),
    previewRef: text("preview_ref"),
    ownerAccountRef: text("owner_account_ref"),
    locationIdRef: text("location_id_ref"),
    correlationRef: text("correlation_ref"),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "media_offer_locations_pkey",
      columns: [table.pageId, table.platform, table.locationRef],
    }),
    pageOfferIdx: index("media_offer_locations_page_offer_idx").on(
      table.pageId,
      table.mediaOfferRef,
    ),
  }),
);

export const revenueMixDaily = pgTable(
  "revenue_mix_daily",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    businessDate: date("business_date").notNull(),
    /** The RAW revenue-type code. A22-2: one label maps to two live codes. */
    typeCode: integer("type_code").notNull(),
    grossMills: bigint("gross_mills", { mode: "bigint" }),
    netMills: bigint("net_mills", { mode: "bigint" }),
    correlationAccountRef: text("correlation_account_ref"),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "revenue_mix_daily_pkey",
      columns: [table.pageId, table.platform, table.businessDate, table.typeCode],
    }),
    pageDateIdx: index("revenue_mix_daily_page_date_idx").on(
      table.pageId,
      table.businessDate,
      table.typeCode,
    ),
  }),
);

/** `/monthlystats`, including the `year: 0, month: 0` rolling-rollup row —
 *  the creator's Statements header. It is never summed with the real months. */
export const revenueMonthTotals = pgTable(
  "revenue_month_totals",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    totalGrossMills: bigint("total_gross_mills", { mode: "bigint" }),
    totalNetMills: bigint("total_net_mills", { mode: "bigint" }),
    topPercent: numeric("top_percent", { precision: 12, scale: 8 }),
    maxTopPercent: numeric("max_top_percent", { precision: 12, scale: 8 }),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    servedExtras: jsonbSafe("served_extras").$type<Record<string, unknown>>().default({}).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "revenue_month_totals_pkey",
      columns: [table.pageId, table.platform, table.year, table.month],
    }),
  }),
);

/** Cumulative counters, snapshotted daily: consecutive-day diffs ARE the daily
 *  series. `totalNetMills` is NULL when the platform served 0-or-null. */
export const pagePromoLinks = pgTable(
  "page_promo_links",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    linkKind: text("link_kind").notNull(),
    linkRef: text("link_ref").notNull(),
    businessDate: date("business_date").notNull(),
    internalRef: text("internal_ref"),
    linkType: integer("link_type"),
    status: integer("status"),
    label: text("label"),
    description: text("description"),
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    clicks: bigint("clicks", { mode: "number" }),
    claims: bigint("claims", { mode: "number" }),
    follows: bigint("follows", { mode: "number" }),
    subscriptions: bigint("subscriptions", { mode: "number" }),
    totalGrossMills: bigint("total_gross_mills", { mode: "bigint" }),
    totalNetMills: bigint("total_net_mills", { mode: "bigint" }),
    // ── WP-F3 (0136): the GIFT-CODE half. Added rather than borrowed from the
    // tracking columns above — `total_gross_mills` is REVENUE and
    // `original_price_mills` is a LIST PRICE, and money of unknown basis is
    // never summed with money of known basis (§2.3), inside one table as much
    // as across two.
    uses: bigint("uses", { mode: "number" }),
    maxUses: bigint("max_uses", { mode: "number" }),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    /** `original_price` — snake_case on the wire amid camelCase keys. */
    originalPriceMills: bigint("original_price_mills", { mode: "bigint" }),
    startsAtPlatform: timestamp("starts_at_platform", { withTimezone: true }),
    endsAtPlatform: timestamp("ends_at_platform", { withTimezone: true }),
    /** Set when a later FULL listing stops naming this link. Never deleted. */
    missingSince: timestamp("missing_since", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_promo_links_pkey",
      columns: [table.pageId, table.platform, table.linkKind, table.linkRef, table.businessDate],
    }),
    pageLinkDateIdx: index("page_promo_links_page_link_date_idx").on(
      table.pageId,
      table.linkRef,
      table.businessDate,
    ),
  }),
);

/** Mass DM (A28-5). Rows carry a GROUP ref, never a fan ref — which is why
 *  nothing here is a fan-scope erasure target. */
export const pageBroadcasts = pgTable(
  "page_broadcasts",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    broadcastRef: text("broadcast_ref").notNull(),
    sourceList: text("source_list").notNull(),
    groupRef: text("group_ref"),
    senderRef: text("sender_ref"),
    content: text("content"),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    deletedAtPlatform: timestamp("deleted_at_platform", { withTimezone: true }),
    statsTotal: bigint("stats_total", { mode: "number" }),
    statsDelivered: bigint("stats_delivered", { mode: "number" }),
    statsRead: bigint("stats_read", { mode: "number" }),
    totalTipAmountMills: bigint("total_tip_amount_mills", { mode: "bigint" }),
    offeredMediaRefs: text("offered_media_refs").array().default([]).notNull(),
    offeredBundleRefs: text("offered_bundle_refs").array().default([]).notNull(),
    offerPrices: jsonbSafe("offer_prices").$type<unknown[]>().default([]).notNull(),
    salesCount: bigint("sales_count", { mode: "number" }),
    /** A12: saleStats.total is NET. */
    salesNetMills: bigint("sales_net_mills", { mode: "bigint" }),
    salesPendingMills: bigint("sales_pending_mills", { mode: "bigint" }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_broadcasts_pkey",
      columns: [table.pageId, table.platform, table.broadcastRef],
    }),
    pageCreatedIdx: index("page_broadcasts_page_created_idx").on(
      table.pageId,
      table.createdAtPlatform,
    ),
  }),
);

export const pagePolls = pgTable(
  "page_polls",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    pollRef: text("poll_ref").notNull(),
    title: text("title"),
    description: text("description"),
    status: integer("status"),
    pollVersion: integer("poll_version"),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_polls_pkey",
      columns: [table.pageId, table.platform, table.pollRef],
    }),
  }),
);

export const pagePollOptions = pgTable(
  "page_poll_options",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    pollRef: text("poll_ref").notNull(),
    optionRef: text("option_ref").notNull(),
    optionOrdinal: integer("option_ordinal").notNull(),
    title: text("title"),
    voteCount: bigint("vote_count", { mode: "number" }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_poll_options_pkey",
      columns: [table.pageId, table.platform, table.pollRef, table.optionRef],
    }),
    pagePollIdx: index("page_poll_options_page_poll_idx").on(
      table.pageId,
      table.pollRef,
      table.optionOrdinal,
    ),
  }),
);

/** `statValue` is a STRING on the wire and stays text — never coerced. */
export const pageRecapStats = pgTable(
  "page_recap_stats",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    recapYear: integer("recap_year").notNull(),
    statRef: text("stat_ref").notNull(),
    statName: text("stat_name"),
    statValue: text("stat_value"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_recap_stats_pkey",
      columns: [table.pageId, table.platform, table.recapYear, table.statRef],
    }),
  }),
);

/**
 * CAPTURE-PLANE OPERATIONAL STATE (§3.4, A17-6) — NOT a rebuildable projection.
 * `projection:rebuild` never truncates it: it holds cursors, floors and
 * blockers that no event carries, and resetting it would re-trigger every
 * first-sight backfill in the system. A gap here means "this capture did not do
 * that", NEVER "the platform cannot". The (status, acquisition_mode, proof)
 * mapping table lives beside the CHECKs in migration 0132.
 */
export const captureCoverage = pgTable(
  "capture_coverage",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    plane: text("plane").notNull(),
    scopeRef: text("scope_ref").notNull(),
    status: text("status").notNull(),
    acquisitionMode: text("acquisition_mode").notNull(),
    proof: text("proof").notNull(),
    oldestCapturedAt: timestamp("oldest_captured_at", { withTimezone: true }),
    newestCapturedAt: timestamp("newest_captured_at", { withTimezone: true }),
    cursor: jsonbSafe("cursor").$type<Record<string, unknown>>().default({}).notNull(),
    expectedCount: bigint("expected_count", { mode: "number" }),
    observedUniqueCount: bigint("observed_unique_count", { mode: "number" }),
    /** Points into the 100-year journal at the response that proves the claim. */
    proofObservationId: bigint("proof_observation_id", { mode: "number" }),
    reasonCode: text("reason_code"),
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "capture_coverage_pkey",
      columns: [table.pageId, table.platform, table.plane, table.scopeRef],
    }),
    pagePlaneIdx: index("capture_coverage_page_plane_idx").on(table.pageId, table.plane),
  }),
);

/**
 * §5 DRIVE-BY: the missing mirror for `fan_earnings_stats`, live since
 * migration 0061 with zero references in this file. MIRROR ONLY — the table is
 * not recreated or rewritten here, and the projector keeps writing it through
 * `upsertFanEarningsStat`.
 */
export const fanEarningsStats = pgTable(
  "fan_earnings_stats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: bigint("account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    fanId: bigint("fan_id", { mode: "number" })
      .references(() => fans.id, { onDelete: "restrict" })
      .notNull(),
    window: text("window").notNull(),
    grossMills: bigint("gross_mills", { mode: "bigint" }).notNull(),
    netMills: bigint("net_mills", { mode: "bigint" }),
    currency: char("currency", { length: 3 }).default("USD").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    accountFanWindowUniq: unique("fan_earnings_stats_account_id_fan_id_window_key").on(
      table.accountId,
      table.fanId,
      table.window,
    ),
    accountWindowIdx: index("fan_earnings_stats_account_window_idx").on(
      table.accountId,
      table.window,
    ),
  }),
);

// ── WP-F2, migration 0134: the engagement core ───────────────────────────────

/**
 * Every notification row, every code, verbatim — written from
 * `notification.observed`, which layer 1 of the `fansly-engagement` family
 * emits whether or not the label table can name the type. `type_code` is the
 * RAW integer (A22-2): the shipped spec was wrong on eight of sixteen codes,
 * including both purchase events, and label-keyed storage would have made that
 * unrecoverable.
 *
 * HEAD PRECEDENCE IS `occurred_at`, NEVER `account_seq` — the deep backfill
 * appends OLDER facts at HIGHER seq.
 */
export const platformNotifications = pgTable(
  "platform_notifications",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    notificationRef: text("notification_ref").notNull(),
    /** The RAW platform code. Never a label, never a closed set. */
    typeCode: integer("type_code").notNull(),
    /** Fan-ref-shaped for purchase/follow/subscription codes — declared in
     *  FAN_REF_ERASURE_COLUMNS with the predicate that reaches it. */
    correlationRef: text("correlation_ref"),
    correlationGroupRef: text("correlation_group_ref"),
    /** Parsed when the served string is valid JSON; `{"raw": "…"}` when not. */
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "platform_notifications_pkey",
      columns: [table.pageId, table.notificationRef],
    }),
    pageTypeOccurredIdx: index("platform_notifications_page_type_occurred_idx").on(
      table.pageId,
      table.typeCode,
      table.occurredAt,
    ),
    pageCorrelationIdx: index("platform_notifications_page_correlation_idx").on(
      table.pageId,
      table.correlationRef,
    ),
  }),
);

/**
 * Latest-known liker state. SHIPS EMPTY on Fansly: no like code is
 * live-confirmed ([E4]), layer 2 writes nothing here, and the OF `posts.liked`
 * webhook is what populates it independently. Head precedence: `occurred_at`
 * DESC with `notification_ref` as the tie-break — never `account_seq`.
 */
export const postLikes = pgTable(
  "post_likes",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    /** `post` | `media` | `message`. */
    subjectKind: text("subject_kind").notNull(),
    subjectRef: text("subject_ref").notNull(),
    /** A TEXT platform ref with NO FK to `fans`: only the explicit erasure
     *  predicate reaches it (FAN_REF_ERASURE_COLUMNS). */
    likerPlatformUserId: text("liker_platform_user_id").notNull(),
    /** `active` | `undone`. */
    state: text("state").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    notificationRef: text("notification_ref"),
    /** `notification` | `ofapi_webhook`. */
    discoveredVia: text("discovered_via").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "post_likes_pkey",
      columns: [table.pageId, table.subjectKind, table.subjectRef, table.likerPlatformUserId],
    }),
    pageSubjectOccurredIdx: index("post_likes_page_subject_occurred_idx").on(
      table.pageId,
      table.subjectKind,
      table.subjectRef,
      table.occurredAt,
    ),
    pageLikerIdx: index("post_likes_page_liker_idx").on(
      table.pageId,
      table.likerPlatformUserId,
    ),
  }),
);

/**
 * §3.4's third state class: CAPTURE-PLANE OPERATIONAL STATE. One shared refresh
 * queue for every per-subject lane (`media_stats`, `post_replies`,
 * `post_engagement`, `of_post_stats`). NEVER truncated by
 * `projection:rebuild` and excluded from the §9.1 checksum BY CLASSIFICATION —
 * `OPERATIONAL_STATE_TABLES` names it and a registry test asserts no
 * projection's `tables` list intersects that set.
 */
export const subjectRefreshState = pgTable(
  "subject_refresh_state",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    plane: text("plane").notNull(),
    subjectRef: text("subject_ref").notNull(),
    /** `fresh` | `mid` | `long_tail` | `dirty`. */
    refreshClass: text("refresh_class"),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    dirtyReason: text("dirty_reason"),
    knownCount: integer("known_count"),
    backfillCursor: jsonbSafe("backfill_cursor").$type<Record<string, unknown>>().default({})
      .notNull(),
    /** C2b: only earnings planes use claims and revision settlement. */
    requestedRevision: bigint("requested_revision", { mode: "number" }).default(0).notNull(),
    appliedRevision: bigint("applied_revision", { mode: "number" }).default(0).notNull(),
    /** Latest earnings signal that requires changed aggregate content. */
    earningsContentRevision: bigint("earnings_content_revision", { mode: "number" }).default(0).notNull(),
    claimedRevision: bigint("claimed_revision", { mode: "number" }),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    retryAfterAt: timestamp("retry_after_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    lastReceiptObservationId: bigint("last_receipt_observation_id", { mode: "number" }),
    lastCheckedObservationId: bigint("last_checked_observation_id", { mode: "number" }),
    lastContentFingerprint: text("last_content_fingerprint"),
    lastRefreshOutcome: text("last_refresh_outcome"),
    refreshVisits: bigint("refresh_visits", { mode: "number" }).default(0).notNull(),
    refreshReceipts: bigint("refresh_receipts", { mode: "number" }).default(0).notNull(),
    refreshChecks: bigint("refresh_checks", { mode: "number" }).default(0).notNull(),
    refreshChanges: bigint("refresh_changes", { mode: "number" }).default(0).notNull(),
    unsignaledChanges: bigint("unsignaled_changes", { mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "subject_refresh_state_pkey",
      columns: [table.pageId, table.plane, table.subjectRef],
    }),
    dueIdx: index("subject_refresh_state_due_idx").on(
      table.pageId,
      table.plane,
      table.nextDueAt,
    ),
  }),
);

// ── WP-F3, migration 0136: the content catalog ───────────────────────────────

/**
 * Both vaults, told apart by `vaultKind` — which is in the PRIMARY KEY, not a
 * nullable label. `/vault/albumsnew` is the creator's inventory;
 * `/uservault/albumsnew?accountId=` is the account's own Likes/Purchases and
 * holds OTHER creators' media, so merging the two would make purchases
 * indistinguishable from inventory.
 *
 * `itemCount` is stored AS SERVED and is NON-UNIQUE membership: the system
 * albums (type 38000 / 5000 / 1000) are views over the same media, so Σ over a
 * page double-counts. M is `count(distinct media_offer_ref)` over
 * `creator_media`, never a sum of this column.
 */
export const creatorVaultAlbumScans = pgTable("creator_vault_album_scans", {
  pageId: bigint("page_id", { mode: "number" }).references(() => pages.id, { onDelete: "restrict" }).notNull(),
  vaultKind: text("vault_kind").notNull(), albumRef: text("album_ref").notNull(),
  walkRef: text("walk_ref").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  seenMediaRefs: text("seen_media_refs").array().notNull(),
  expectedCount: integer("expected_count").notNull(), pages: integer("pages").notNull(),
  sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
  sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
  sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.pageId, table.vaultKind, table.albumRef] })]);

export const creatorVaultAlbums = pgTable(
  "creator_vault_albums",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    /** `creator` | `user`. */
    vaultKind: text("vault_kind").notNull(),
    albumRef: text("album_ref").notNull(),
    ownerAccountRef: text("owner_account_ref"),
    title: text("title"),
    description: text("description"),
    /** RAW platform integer; NULL on creator-made albums. */
    albumType: integer("album_type"),
    status: integer("status"),
    pos: integer("pos"),
    /** AS SERVED. Non-unique membership — see the note above. */
    itemCount: bigint("item_count", { mode: "number" }),
    lastItemRef: text("last_item_ref"),
    thumbnailRef: text("thumbnail_ref"),
    public: integer("public"),
    version: integer("version"),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    /** Set when a later FULL listing of the same vault stops naming this
     *  album. The row is never deleted (DP 7). */
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "creator_vault_albums_pkey",
      columns: [table.pageId, table.vaultKind, table.albumRef],
    }),
    pageKindPosIdx: index("creator_vault_albums_page_kind_pos_idx").on(
      table.pageId,
      table.vaultKind,
      table.pos,
    ),
  }),
);

/**
 * Album ↔ raw-media membership. Live creator-vault rows name `mediaId` and do
 * not carry a media-offer id; user-vault rows may carry both. `mediaRef` is the
 * identity and `mediaOfferRef` is optional metadata because one raw file can
 * back several offers.
 *
 * `memberRef` is the membership row's OWN id (`albumMedia[].id`) — the vault
 * walk's `before` cursor, and NOT the same value as `mediaOfferRef`.
 */
export const creatorVaultAlbumMembers = pgTable(
  "creator_vault_album_members",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    albumRef: text("album_ref").notNull(),
    mediaOfferRef: text("media_offer_ref"),
    memberRef: text("member_ref"),
    customFilename: text("custom_filename"),
    mediaOfferType: integer("media_offer_type"),
    bundleRef: text("bundle_ref"),
    mediaRef: text("media_ref").notNull(),
    mediaType: integer("media_type"),
    previewRef: text("preview_ref"),
    /** `creator` | `user` — part of membership identity and the discriminator
     *  that keeps the purchases shelf out of creator-vault counts. */
    vaultKind: text("vault_kind").notNull(),
    createdAtPlatform: timestamp("created_at_platform", { withTimezone: true }),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "creator_vault_album_members_pkey",
      columns: [table.pageId, table.vaultKind, table.albumRef, table.mediaRef],
    }),
    pageKindMediaIdx: index("creator_vault_album_members_page_kind_media_idx").on(
      table.pageId,
      table.vaultKind,
      table.mediaRef,
    ),
    pageOfferIdx: index("creator_vault_album_members_page_offer_idx").on(
      table.pageId,
      table.mediaOfferRef,
    ).where(sql`${table.mediaOfferRef} is not null`),
  }),
);

/**
 * The tier HEAD. `basePriceMills` is `tier.price` — a BASE, not a price: all
 * five observed tiers carried 5 000 while their plans ranged 10 000 … 499 990.
 * The queryable price truth is `pageSubscriptionTierPlans` (FEAT-002); `plans`
 * keeps the served array verbatim beside it as the proof nothing was dropped.
 */
export const pageSubscriptionTiers = pgTable(
  "page_subscription_tiers",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    tierRef: text("tier_ref").notNull(),
    name: text("name"),
    color: text("color"),
    pos: integer("pos"),
    /** `tier.price` — a BASE, never the price a subscriber pays. */
    basePriceMills: bigint("base_price_mills", { mode: "bigint" }),
    maxSubscribers: bigint("max_subscribers", { mode: "number" }),
    subscriptionBenefits: jsonbSafe("subscription_benefits").$type<unknown[]>().default([])
      .notNull(),
    includedTierRefs: jsonbSafe("included_tier_refs").$type<unknown[]>().default([]).notNull(),
    /** The served `plans[]` array, VERBATIM. */
    plans: jsonbSafe("plans").$type<unknown[]>().default([]).notNull(),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_subscription_tiers_pkey",
      columns: [table.pageId, table.tierRef],
    }),
    pagePosIdx: index("page_subscription_tiers_page_pos_idx").on(table.pageId, table.pos),
  }),
);

/**
 * THE PRICE TRUTH (FEAT-002). `durationDays` reads `plans[].billingCycle` —
 * verified on the live capture, where every plan carried `billingCycle` and no
 * `duration` key at all (`duration` exists one level down, on `promos[]`).
 * Maximum plan price observed live is 499 990.
 */
export const pageSubscriptionTierPlans = pgTable(
  "page_subscription_tier_plans",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    tierRef: text("tier_ref").notNull(),
    planRef: text("plan_ref").notNull(),
    status: integer("status"),
    durationDays: integer("duration_days"),
    priceMills: bigint("price_mills", { mode: "bigint" }),
    useAmounts: integer("use_amounts"),
    /** The nested promo array, verbatim: discounted price, window, max uses. */
    promos: jsonbSafe("promos").$type<unknown[]>().default([]).notNull(),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_subscription_tier_plans_pkey",
      columns: [table.pageId, table.tierRef, table.planRef],
    }),
    pagePriceIdx: index("page_subscription_tier_plans_page_price_idx").on(
      table.pageId,
      table.durationDays,
      table.priceMills,
    ),
  }),
);

/**
 * The profile's content sections. `pages.metadata.walls` already holds a
 * current-state hint from `/account`; this table is the LINEAGE — the first
 * captured `/account/walls` read is the projection baseline, and a renamed or
 * deleted wall keeps its row and gains `missingSince`.
 */
export const pageWalls = pgTable(
  "page_walls",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    wallRef: text("wall_ref").notNull(),
    name: text("name"),
    description: text("description"),
    pos: integer("pos"),
    /** Two independent flags on the wire; one wall can be neither. */
    mainWall: boolean("main_wall"),
    defaultWall: boolean("default_wall"),
    private: integer("private"),
    metadata: jsonbSafe("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "page_walls_pkey", columns: [table.pageId, table.wallRef] }),
    pagePosIdx: index("page_walls_page_pos_idx").on(table.pageId, table.pos),
  }),
);

/**
 * What the page says without a human. `messageTemplate` is a JSON OBJECT in
 * every live value (verified 2026-08-19); the tolerant fallback for the
 * March-corpus STRING shape sets `parseOk = false` and leaves the raw in the
 * journal, because an unparsed template and an automation with no text must
 * never look alike.
 */
export const pageAutomatedMessages = pgTable(
  "page_automated_messages",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    automationRef: text("automation_ref").notNull(),
    /** RAW platform code (3 and 15 observed live). Never a label. */
    triggerType: integer("trigger_type"),
    /** Served as a JSON STRING; parsed when it parses, `{"raw": …}` when not. */
    triggerMetadata: jsonbSafe("trigger_metadata").$type<Record<string, unknown>>().default({})
      .notNull(),
    delaySeconds: bigint("delay_seconds", { mode: "number" }),
    cooldownSeconds: bigint("cooldown_seconds", { mode: "number" }),
    templateType: integer("template_type"),
    senderRef: text("sender_ref"),
    messageText: text("message_text"),
    /** `[{contentType, contentId}]` — id-relations only, never a URL. */
    attachmentRefs: jsonbSafe("attachment_refs").$type<unknown[]>().default([]).notNull(),
    parseOk: boolean("parse_ok").default(true).notNull(),
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_automated_messages_pkey",
      columns: [table.pageId, table.automationRef],
    }),
    pageTriggerIdx: index("page_automated_messages_page_trigger_idx").on(
      table.pageId,
      table.triggerType,
    ),
  }),
);

// ── WP-F5, migration 0138: the comment archive ───────────────────────────────

/**
 * `post_comments` — full comment bodies, PLATFORM-NEUTRAL by construction.
 *
 * Fansly's `/post/{id}/replies` walk writes it today; a comment-signal
 * notification and the OnlyFans comment list are the other two declared
 * origins, and `discoveredVia` is what tells them apart. "Where did this row
 * come from" is the question a partial archive must be able to answer, and it
 * must never be guessable from the row's shape.
 *
 * `textPlain` defaults to `''` and EMPTY-CONTENT REPLIES ARE STORED: one of the
 * four replies in the 18 KB live capture has `content: ""`, and a fan who
 * replied with only an attachment still replied.
 *
 * `possiblyTruncated` is truthfulness about pagination. `/post/{id}/replies` has
 * NO established pagination — no observed response carried more than four
 * replies and no cursor form is proven — so a suspiciously full page marks its
 * rows and the lane's coverage reads `window_captured`, never complete. The
 * doubt belongs to the ROW, because it outlives the sweep that created it.
 */
export const postComments = pgTable(
  "post_comments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    commentRef: text("comment_ref").notNull(),
    /** `inReplyTo`. */
    parentPostRef: text("parent_post_ref").notNull(),
    /** `inReplyToRoot`. Stored separately even though it equalled
     *  `parentPostRef` in every observed reply: the day a nested reply arrives,
     *  the difference is what reconstructs the thread. */
    rootPostRef: text("root_post_ref"),
    /** The author. A TEXT platform ref with NO FK to `fans`, so only the
     *  explicit erasure predicate reaches it (FAN_REF_ERASURE_COLUMNS). */
    authorRef: text("author_ref").notNull(),
    /** From the `accounts[]` sidecar — EMPTY in 2 of 5 captured responses,
     *  which is why these are nullable and why the hydration fallback exists. */
    authorUsername: text("author_username"),
    authorDisplayName: text("author_display_name"),
    textPlain: text("text_plain").default("").notNull(),
    likeCount: integer("like_count"),
    mediaLikeCount: integer("media_like_count"),
    /** MILLS, two bases, never summed (§2.3). */
    tipTotalMills: bigint("tip_total_mills", { mode: "bigint" }),
    attachmentTipMills: bigint("attachment_tip_mills", { mode: "bigint" }),
    attachmentCount: integer("attachment_count"),
    pinned: boolean("pinned"),
    /** The provider instant (SECONDS on the wire for this route). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** When the stored content last CHANGED — an edit moves it, a
     *  re-observation of the same bytes does not. */
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    /** `replies_walk` | `notification` | `ofapi_list`. */
    discoveredVia: text("discovered_via").notNull(),
    possiblyTruncated: boolean("possibly_truncated").default(false).notNull(),
    /** Set when a later FULL walk of the parent stops naming this comment.
     *  NEVER a delete (DP 7). */
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pageCommentUniq: unique("post_comments_page_comment_uniq").on(
      table.pageId,
      table.commentRef,
    ),
    pageParentOccurredIdx: index("post_comments_page_parent_occurred_idx").on(
      table.pageId,
      table.parentPostRef,
      table.occurredAt.desc(),
    ),
    pageAuthorIdx: index("post_comments_page_author_idx").on(table.pageId, table.authorRef),
  }),
);

// ── WP-F7, migration 0141: the money-out head ────────────────────────────────

/**
 * `page_payout_methods` — the creator's own payout methods, MASKED.
 *
 * `metadata` arrives as a JSON-ENCODED STRING and the two live providers are
 * asymmetric in the one way that matters: provider 2 (Paxum — NOT PayPal;
 * A22-4) returns the FULL email address, provider 30 (USDT) returns a field set
 * whose `field1` is already server-masked. So the masking is OURS.
 * `maskedLabel` is the ONLY value derived from `metadata` that ever reaches a
 * projection, the full processor payload stays raw-journal-only under the
 * restricted class, and the migration's CHECK enforces the pinned mask shape at
 * the INSERT rather than trusting the parser.
 *
 * `providerLabel` is derived from `providerId` ALONE — never from `metadata` —
 * so an unknown provider decodes to nothing and still lands a truthful row.
 */
export const pagePayoutMethods = pgTable(
  "page_payout_methods",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    methodRef: text("method_ref").notNull(),
    /** RAW platform code. NULL when the served value was not an integer. */
    providerId: integer("provider_id"),
    /** `paxum` | `usdt` | `unmapped:<id>`. Derived from `providerId` alone. */
    providerLabel: text("provider_label").notNull(),
    /** Observed live as 1 / 0 / 3 with NO rendered label anywhere in the UI.
     *  RAW integers; naming them would be guesswork. */
    type: integer("type"),
    flags: integer("flags"),
    status: integer("status"),
    /** OURS, never the provider's. */
    maskedLabel: text("masked_label"),
    /** FALSE when `metadata` was a string that did not parse as JSON. */
    metadataParseOk: boolean("metadata_parse_ok").default(true).notNull(),
    /** Set when a later FULL listing stops naming this method. NEVER a delete
     *  (DP 7). */
    missingSince: timestamp("missing_since", { withTimezone: true }),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_payout_methods_pkey",
      columns: [table.pageId, table.methodRef],
    }),
  }),
);

/**
 * `page_payout_requests` — the payout-request history.
 *
 * `amountMills` is MILLS with no scaling: the wire unit IS the kernel unit,
 * proved against the rendered UI on seven independent fields.
 *
 * THE STATUS MAP IS ONE CODE DEEP. All 83 requests on the walked page carried
 * `status = 8` = `Processed`; every other code is unknown. The integer and the
 * label are projected together with `statusConfidence`, 8 is never treated as
 * "the success code" in a conditional, and the capture handler raises one
 * anomaly the first time it sees a code nobody has mapped.
 *
 * `methodRef` has NO foreign key to `page_payout_methods`: a payout can name a
 * method the creator has since removed, and an FK would make the honest history
 * unstorable.
 */
export const pagePayoutRequests = pgTable(
  "page_payout_requests",
  {
    pageId: bigint("page_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    platform: platformColumn("platform")
      .references(() => platforms.key, { onDelete: "restrict" })
      .notNull(),
    payoutRef: text("payout_ref").notNull(),
    /** MILLS (Stage 27), through the shared constructors. */
    amountMills: bigint("amount_mills", { mode: "bigint" }),
    methodRef: text("method_ref"),
    /** RAW. 8 is the only code ever observed. */
    statusCode: integer("status_code"),
    /** `Processed` for 8, `unmapped:<code>` otherwise. */
    statusLabel: text("status_label"),
    /** `mapped` | `unmapped`. */
    statusConfidence: text("status_confidence").notNull(),
    /** Provider instants — Unix ms on the wire. */
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    updatedAtPlatform: timestamp("updated_at_platform", { withTimezone: true }),
    version: integer("version"),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }).notNull(),
    sourceObservationId: bigint("source_observation_id", { mode: "number" }).notNull(),
    sourceAccountSeq: bigint("source_account_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "page_payout_requests_pkey",
      columns: [table.pageId, table.payoutRef],
    }),
    pageRequestedIdx: index("page_payout_requests_page_requested_idx").on(
      table.pageId,
      table.requestedAt.desc(),
    ),
  }),
);

// OFAPI provider delivery metadata; nested business bodies remain observations.
export const ofapiWebhookDeliveryAttempts = pgTable("ofapi_webhook_delivery_attempts", {
  webhookId: text("webhook_id").notNull(), attemptId: bigint("attempt_id", { mode: "number" }).notNull(),
  deliveryUuid: text("delivery_uuid").notNull(), eventType: text("event_type").notNull(),
  attemptNumber: integer("attempt_number").notNull(), succeeded: boolean("succeeded").notNull(),
  statusCode: integer("status_code"), errorType: text("error_type"), idempotencyKey: text("idempotency_key"),
  ofapiAccountId: text("ofapi_account_id"), redeliveredFrom: text("redelivered_from"),
  accountRefs: jsonbSafe("account_refs").$type<string[]>().default([]).notNull(),
  sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }).notNull(),
  observationId: bigint("observation_id", { mode: "number" }).notNull(),
  observationReceivedAt: timestamp("observation_received_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.webhookId, table.attemptId] }),
  groupIdx: index("ofapi_webhook_delivery_group_idx").on(table.webhookId, table.deliveryUuid),
  timeIdx: index("ofapi_webhook_delivery_time_idx").on(table.webhookId, table.sourceCreatedAt.desc(), table.attemptId.desc()),
}));

export const ofapiWebhookDeliveryScans = pgTable("ofapi_webhook_delivery_scans", {
  id: uuid("id").primaryKey(), webhookId: text("webhook_id").notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(), observedTeam: text("observed_team").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(), windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  state: text("state").notNull(), nextOffset: integer("next_offset").default(0).notNull(), capturedAttempts: integer("captured_attempts").default(0).notNull(),
  leaseToken: uuid("lease_token"), leaseUntil: timestamp("lease_until", { withTimezone: true }), errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => ({ stateIdx: index("ofapi_webhook_delivery_scan_state_idx").on(table.webhookId, table.state, table.createdAt.desc()) }));

export const ofapiWebhookRedeliveryIntents = pgTable("ofapi_webhook_redelivery_intents", {
  id: uuid("id").primaryKey(), webhookId: text("webhook_id").notNull(), attemptId: bigint("attempt_id", { mode: "number" }).notNull(),
  actorUserId: bigint("actor_user_id", { mode: "number" }).notNull().references(() => users.id, { onDelete: "restrict" }),
  state: text("state").notNull(), redeliveryUuid: text("redelivery_uuid"), errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), settledAt: timestamp("settled_at", { withTimezone: true }),
}, table => ({
  attemptFk: foreignKey({ columns: [table.webhookId, table.attemptId], foreignColumns: [ofapiWebhookDeliveryAttempts.webhookId, ofapiWebhookDeliveryAttempts.attemptId] }).onDelete("restrict"),
  activeAttemptUniq: uniqueIndex("ofapi_webhook_redelivery_active_attempt_uniq").on(table.webhookId, table.attemptId).where(sql`${table.state} in ('dispatching','accepted','indeterminate')`),
}));

export const ofapiWebhookCollectionPolicy = pgTable("ofapi_webhook_collection_policy", {
  id: boolean("id").primaryKey().default(true), version: bigint("version", { mode: "number" }).default(0).notNull(),
  desiredGroups: jsonbSafe("desired_groups").$type<string[]>().default([]).notNull(), appliedGroups: jsonbSafe("applied_groups").$type<string[]>().default([]).notNull(),
  historyEnabled: boolean("history_enabled").default(false).notNull(), applyState: text("apply_state").default("pending").notNull(),
  applyToken: uuid("apply_token"), applyStartedAt: timestamp("apply_started_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }), errorCode: text("error_code"), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Owner marketing configuration; business analytics use canonical read snapshots.
export const ofapiMarketingResources = pgTable("ofapi_marketing_resources", {
  id: bigserial("id", {mode:"number"}).primaryKey(),
  pageId: bigint("page_id", {mode:"number"}).references(()=>pages.id,{onDelete:"restrict"}),
  kind:text("kind").notNull(),upstreamId:text("upstream_id").notNull(),parentId:text("parent_id").default("").notNull(),
  data:jsonbSafe("data").notNull(),deleted:boolean("deleted").default(false).notNull(),credentialFingerprint:text("credential_fingerprint"),observationId:bigint("observation_id",{mode:"number"}).notNull(),observedAt:timestamp("observed_at",{withTimezone:true}).notNull(),
}, table=>({identity:uniqueIndex("ofapi_marketing_resource_identity_idx").on(sql`coalesce(${table.pageId},0)`,table.kind,table.parentId,table.upstreamId)}));
export const ofapiMarketingIntents = pgTable("ofapi_marketing_intents", {
  id:uuid("id").primaryKey(),pageId:bigint("page_id",{mode:"number"}).references(()=>pages.id,{onDelete:"restrict"}),
  actorUserId:bigint("actor_user_id",{mode:"number"}).notNull().references(()=>users.id,{onDelete:"restrict"}),
  action:text("action").notNull(),bodyEncrypted:text("body_encrypted").notNull(),bodyHash:text("body_hash").notNull(),preview:jsonbSafe("preview").notNull(),
  state:text("state").notNull(),responseObservationId:bigint("response_observation_id",{mode:"number"}),errorCode:text("error_code"),
  remoteId:text("remote_id"),accountingState:text("accounting_state").default("pending").notNull(),projectionState:text("projection_state").default("pending").notNull(),
  createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),dispatchedAt:timestamp("dispatched_at",{withTimezone:true}),settledAt:timestamp("settled_at",{withTimezone:true}),
});
export const ofapiActionIdentities = pgTable("ofapi_action_identities", { id: uuid("id").primaryKey() });
export const ofapiMediaTokenFences = pgTable("ofapi_media_token_fences", {
  tokenHash: text("token_hash").primaryKey(), operationId: uuid("operation_id").notNull(),
});

export const ofapiActionIntents = pgTable("ofapi_action_intents", {
  id: uuid("id").primaryKey(),
  mediaOperationId: uuid("media_operation_id").defaultRandom().notNull(),
  pageId: bigint("page_id", { mode: "number" }).notNull().references(() => pages.id, { onDelete: "restrict" }),
  actorUserId: bigint("actor_user_id", { mode: "number" }).notNull().references(() => users.id, { onDelete: "restrict" }),
  action: text("action").notNull(), bodyHash: text("body_hash").notNull(), bodyEncrypted: text("body_encrypted").notNull(),
  subjectRefs: text("subject_refs").array().notNull().default(sql`'{}'::text[]`), state: text("state").notNull(),
  estimatedCredits: integer("estimated_credits").notNull(), actualCredits: integer("actual_credits"), reservedDay: date("reserved_day"),
  reservationSettled: boolean("reservation_settled").notNull().default(false), ledgerEnabled: boolean("ledger_enabled").notNull().default(false),
  responseObservationId: bigint("response_observation_id", { mode: "number" }), resultEncrypted: text("result_encrypted"), remoteId: text("remote_id"), errorCode: text("error_code"),
  accountingState: text("accounting_state").notNull().default("pending"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }), settledAt: timestamp("settled_at", { withTimezone: true }),
}, table => ({ pageCreated: index("ofapi_action_page_created_idx").on(table.pageId, table.createdAt.desc()) }));

export const ofapiMarketingProjectionReceipts = pgTable("ofapi_marketing_projection_receipts", {
  observationId:bigint("observation_id",{mode:"number"}).primaryKey(),
  pageId:bigint("page_id",{mode:"number"}).references(()=>pages.id,{onDelete:"restrict"}),
  version:integer("version").default(1).notNull(),projectionState:text("projection_state").default("pending").notNull(),
  accountingState:text("accounting_state").default("pending").notNull(),errorCode:text("error_code"),
  checkedAt:timestamp("checked_at",{withTimezone:true}).defaultNow().notNull(),
});
/** S11a vendor queue evidence; no fan, command, delivery or revenue inference. */
export const ofapiChatQueueState = pgTable('ofapi_chat_queue_state', {
  pageId: bigint('page_id',{mode:'number'}).references(()=>pages.id,{onDelete:'restrict'}).notNull(),
  queueId: text('queue_id').notNull(),
  phase: text('phase').notNull(),
  queueDate: timestamp('queue_date',{withTimezone:true}),
  state: jsonbSafe('state').$type<Record<string,unknown>>().notNull(),
  observedAt: timestamp('observed_at',{withTimezone:true}).notNull(),
  sourceEventId: bigint('source_event_id',{mode:'number'}).notNull(),
  sourceObservationId: bigint('source_observation_id',{mode:'number'}).notNull(),
},table=>({pk:primaryKey({columns:[table.pageId,table.queueId]}),pageObservedIdx:index('ofapi_chat_queue_state_page_observed_idx').on(table.pageId,table.observedAt)}));
