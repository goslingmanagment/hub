import {
  type AnyPgColumn,
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
  aiUsageLedgerFeatures,
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

// ── jsonb reads are SINGLE-parse ─────────────────────────────
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

const PLATFORM_KEYS = ["fansly", "onlyfans", "telegram"] as const;

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
// The DB enum carries the ledger-only system features too (0211).
export const aiUsageFeatureEnum = pgEnum("ai_usage_feature", aiUsageLedgerFeatures);
export const dmSenderRoleEnum = pgEnum("dm_sender_role", ["fan", "model", "system", "unknown"]);
export const dmMessageCoverageStatusEnum = pgEnum("dm_message_coverage_status", [
  "pending_backfill",
  "partial_window",
  "complete",
]);
export const transactionInactiveReasonEnum = pgEnum("transaction_inactive_reason", [
  "missing_from_sync_window",
  // W7.3 (A21+B4): negation guards. Unlike
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
  // 0218: the ops watchdog's Fansly sync deadman (planner or executor stalled).
  "sync_silent",
  // 0233: the Fansly Sync Engine's five alerts (plan §10), one subKey each.
  "fansly_sync_engine",
  // 0298: a page's wall-post publishing stopped itself (autostop, spec §8.3).
  "publishing_stopped",
  // 0301: a fresh read proved a publication of the page did not go out.
  "publication_not_published",
  // 0340: OnlyFans itself wrote to the page (its "OnlyFans" notifications tab).
  "ofapi_platform_notice",
  // 0343: the always-on ChatSpace tab went silent, signed out, lost an
  // account's socket or sits in a fan's chat (services/chatspace-tab-watch.ts).
  "chatspace_tab",
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
    // Deactivation tombstone (mirrors the pages
    // standard): NULL = active. Set freezes every auth path; never hard-delete.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    // Permanent account deletion releases the login, never the immutable id
    // or historical attribution. A deleted row can never be restored.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // The owner's personal daily AI limit, micro-USD per Moscow day over all
    // pages (0336). Null: no personal limit.
    aiDailyLimitMicroUsd: bigint("ai_daily_limit_micro_usd", { mode: "number" }),
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
    // Soft-delete standard:
    // deletePageByLabel writes the tombstone; fact-table FKs are RESTRICT so a
    // hard DELETE on a fact-bearing page is structurally impossible.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    status: text("status").default("active").notNull(),
    // Single-writer gate: which system may write transactions for
    // this page. NULL = no writer assigned yet.
    transactionsWriter: text("transactions_writer"),
    // The persona the page is meant to be worked with (0326): the client
    // bootstrap's `defaultPersonaKey`. A key of ai_personas, not a FK.
    defaultPersonaKey: text("default_persona_key"),
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
      ${table.transactionsWriter} in ('onlymonster', 'ofapi', 'fansly', 'chatspace')
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

// What the paging sweep has done about a latch. The latch row
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

// One row per latch episode (open → resolved), including the
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
    /** Д2 (0263): the missed-alerts summary that reports this retired opening. */
    reportedInOutboxId: bigint("reported_in_outbox_id", { mode: "number" })
      .references((): AnyPgColumn => notificationDeliveryOutbox.id),
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
    // 0223: the dm_messages 5xx breaker reads one thread's attempts.
    dmGroupIdx: index("sync_http_attempts_dm_group_idx")
      .on(table.pageId, sql`(${table.requestShape} ->> 'groupId')`)
      .where(sql`${table.stream} = 'dm_messages' and ${table.operation} = 'messages'`),
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

// 0228 (Fansly Sync Engine, plan §11): the new engine's per-page state. Mode,
// pauses, ownership (generation + the owner process's identity), the
// scheduler's cycle position and the pacer's facts. Written through
// repositories/sync/pages.ts only; `live` only at a page's birth
// (`createLiveSyncPage`), `handover` by nothing since step 4 (S4-21).
export const syncPages = pgTable(
  "sync_pages",
  {
    pageId: bigint("page_id", { mode: "number" }).primaryKey().references(() => pages.id, {
      onDelete: "restrict",
    }),
    mode: text("mode").$type<"off" | "shadow" | "handover" | "live">().notNull().default("off"),
    modeChangedAt: timestamp("mode_changed_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    modeChangedBy: text("mode_changed_by").notNull().default("migration"),
    requestsEnabledAt: timestamp("requests_enabled_at", { withTimezone: true }),
    legacyImportedAt: timestamp("legacy_imported_at", { withTimezone: true }),
    registryOverrides: jsonbSafe("registry_overrides").$type<Record<string, unknown>>().notNull().default({}),
    pausedAll: boolean("paused_all").notNull().default(false),
    pausedRequests: boolean("paused_requests").notNull().default(false),
    pausedResources: text("paused_resources").array().notNull().default(sql`'{}'::text[]`),
    pauseNote: text("pause_note"),
    // No hold is mapped here, and the table has no hold column: a page's
    // holds are its rows of `sync_holds` (0240). The hold slot and the
    // resource-hold map of 0228 were dropped, with the slot's two CHECKs
    // (step 4, S4-33; tests/sync-old-hold-columns.test.ts).
    networkFailureStreak: smallint("network_failure_streak").notNull().default(0),
    identityAccountId: text("identity_account_id"),
    identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true }),
    credentialsGeneration: text("credentials_generation"),
    ownerGeneration: bigint("owner_generation", { mode: "bigint" }).notNull().default(sql`0`),
    ownerInstance: uuid("owner_instance"),
    ownerHost: text("owner_host"),
    ownerPid: integer("owner_pid"),
    ownerPidStart: text("owner_pid_start"),
    ownerPidNs: text("owner_pid_ns"),
    ownerBootId: text("owner_boot_id"),
    ownerAcquiredAt: timestamp("owner_acquired_at", { withTimezone: true }),
    ownerHeartbeatAt: timestamp("owner_heartbeat_at", { withTimezone: true }),
    ownerReleasedAt: timestamp("owner_released_at", { withTimezone: true }),
    ownerReleaseGeneration: bigint("owner_release_generation", { mode: "bigint" }),
    ownerStopConfirmedAt: timestamp("owner_stop_confirmed_at", { withTimezone: true }),
    ownerStopConfirmedBy: text("owner_stop_confirmed_by"),
    cyclePos: smallint("cycle_pos").notNull().default(0),
    plannedRr: jsonbSafe("planned_rr").$type<Record<string, string>>().notNull().default({}),
    lastAdmittedAt: timestamp("last_admitted_at", { withTimezone: true }),
    lastSendAt: timestamp("last_send_at", { withTimezone: true }),
    lastSendAttemptId: bigint("last_send_attempt_id", { mode: "number" }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    // The shadow WS feed's cursor: unread and unwritten since step 4 (S4-23).
    wsRouterCursor: bigint("ws_router_cursor", { mode: "number" }).notNull().default(0),
    // 0235 (step 3, owner decision №8): DM exclusion reasons lifted on the page.
    liftedDmExclusions: text("lifted_dm_exclusions").array().notNull().default(sql`'{}'::text[]`),
    // 0277 (Project Browser PR 14): which sender the page's requests leave
    // through — undici from `sync`, or the page's own browser.
    transport: text("transport").$type<"browser">().notNull().default("browser"),
    // 0278: a pending leave of the page's browser, and the last confirmed one.
    // 0281 (Project Browser PR 17): the whole pause is the browser stop's.
    browserStopPaused: boolean("browser_stop_paused").notNull().default(false),
    browserLeaveGeneration: bigint("browser_leave_generation", { mode: "bigint" }),
    browserLeaveRequestedAt: timestamp("browser_leave_requested_at", { withTimezone: true }),
    browserLeftAt: timestamp("browser_left_at", { withTimezone: true }),
    browserLeftBy: text("browser_left_by").$type<"operator" | "owner">(),
    browserLeftGeneration: bigint("browser_left_generation", { mode: "bigint" }),
    // 0279 (Project Browser PR 15): the owner's login of the page's browser —
    // off, wanted (paused, its operator in the manual login), ending.
    manualLogin: text("manual_login").$type<"off" | "wanted" | "ending">().notNull().default("off"),
    manualLoginPaused: boolean("manual_login_paused").notNull().default(false),
    manualLoginChangedAt: timestamp("manual_login_changed_at", { withTimezone: true }),
    manualLoginChangedBy: text("manual_login_changed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (table) => ({
    modeCheck: check("sync_pages_mode_check", sql`${table.mode} in ('off', 'shadow', 'handover', 'live')`),
    cyclePosCheck: check("sync_pages_cycle_pos_check", sql`${table.cyclePos} between 0 and 9`),
    liftedDmExclusionsCheck: check(
      "sync_pages_lifted_dm_exclusions_check",
      sql`${table.liftedDmExclusions} <@ array['partner_missing_from_aggregation_accounts', 'partner_unresolvable_from_account_lookup']::text[]`,
    ),
    transportCheck: check("sync_pages_transport_check", sql`${table.transport} = 'browser'`),
    browserLeaveCheck: check("sync_pages_browser_leave_check", sql`
      (${table.browserLeaveGeneration} is null) = (${table.browserLeaveRequestedAt} is null)
      and (${table.browserLeftBy} is null or ${table.browserLeftBy} in ('operator', 'owner'))
      and (${table.browserLeftBy} is null) = (${table.browserLeftAt} is null)`),
    manualLoginCheck: check("sync_pages_manual_login_check", sql`${table.manualLogin} in ('off', 'wanted', 'ending')`),
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
    // Which egress priority class the row paces (vendor caps are
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
    dmTipContextBackfillIdx: index("sync_raw_payloads_dm_tip_context_backfill_idx")
      .on(table.id)
      .where(sql`${table.endpoint} = 'dm_messages' and ${table.payloadKind} = 'dm_messages'`),
    // 0223: the purchase-history capture, probe and storm reads. The list is
    // the endpoints the legacy lane journaled (deleted at step 4, S4-16); a
    // query only uses the index when its endpoint is one of them.
    purchaseHistoryIdx: index("sync_raw_payloads_purchase_history_idx")
      .on(table.pageId, table.endpoint, table.id)
      .where(sql`${table.endpoint} in ('purchase_history', 'purchase_history_contract_probe', 'purchase_history_contract_storm')`),
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
    // 0224: the Fansly account lookup through this page whose result Hub
    // stored, and the page's last answer for the fan — the DM partner probe's
    // or a lookup's, returned or omitted (fan-hydration.ts,
    // sync/fansly/resources/fan-profiles.ts). Neither is asked again within a
    // day. An answer is dated when it arrived and never replaces a newer one.
    accountLookupAt: timestamp("account_lookup_at", { withTimezone: true }),
    accountProbeAt: timestamp("account_probe_at", { withTimezone: true }),
    accountProbeResolved: boolean("account_probe_resolved"),
    // 0295: whether the page can message the fan, by the OnlyFans account
    // check (services/ofapi-fan-account-check.ts); null on every Fansly row.
    accountContactability: text("account_contactability")
      .$type<"contactable" | "unavailable" | "restricted" | "blocked" | "gone" | "unknown">(),
    // 0374: the start of the current «not seen» streak of the page's answer
    // (the trigger `page_fans_account_miss_since` is its one writer; null on a
    // «not seen» row: the start is unknown), and the latest chatter's browser
    // observation that disagreed with the page's answer and when Hub received
    // it (clientFanBadges `accountSeen`): a signal for `fan-profiles.recheck`,
    // never the page's answer (repositories/fan-account-state.ts).
    accountMissSince: timestamp("account_miss_since", { withTimezone: true }),
    accountClientSeen: boolean("account_client_seen"),
    accountClientSeenAt: timestamp("account_client_seen_at", { withTimezone: true }),
    // 0341: the fan's lifetime sums by type as OnlyFans counts them (gross
    // dollars: tips, subscriptions, messages, posts, streams, total), from the
    // page's own fan read in ChatSpace (services/client-onlyfans-feed.ts), and
    // when. Money stays transactions-based; this is the platform's own figure.
    platformSpend: jsonbSafe("platform_spend").$type<Record<string, number | null>>(),
    platformSpendObservedAt: timestamp("platform_spend_observed_at", { withTimezone: true }),
  },
  (table) => ({
    uniq: unique("page_fans_fan_account_uniq").on(table.fanId, table.platformAccountId),
    externalPresenceIdx: index("page_fans_external_presence_idx").on(
      table.platformAccountId,
      table.externalPresenceAt,
    ),
    pageAliasIdx: index("page_fans_platform_account_alias_idx").on(
      table.platformAccountId,
      table.pageAlias,
    ),
    // 0268: the public lookup's page_lookup_miss demand (fansly-public-lookup.ts).
    accountProbeUnresolvedIdx: index("page_fans_account_probe_unresolved_idx")
      .on(table.fanId)
      .where(sql`${table.accountProbeResolved} is false`),
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
    // Fansly Sync Engine chain coverage (0231, design §2.3). One writer:
    // repositories/sync/thread-chain.ts writeThreadChain.
    headConfirmedId: text("head_confirmed_id"),
    headConfirmedAt: timestamp("head_confirmed_at", { withTimezone: true }),
    contiguousOldestId: text("contiguous_oldest_id"),
    contiguousOldestAt: timestamp("contiguous_oldest_at", { withTimezone: true }),
    contiguousCount: integer("contiguous_count").default(0).notNull(),
    chainUpwardCount: bigint("chain_upward_count", { mode: "number" }).default(0).notNull(),
    chainEpoch: integer("chain_epoch").default(0).notNull(),
    historyState: text("history_state").$type<"none" | "unverified" | "partial" | "complete">()
      .default("none").notNull(),
    historyProof: text("history_proof").$type<"empty_page" | "first_second">(),
    historyProvenAt: timestamp("history_proven_at", { withTimezone: true }),
    historyProofObservationId: bigint("history_proof_observation_id", { mode: "number" }),
    historyProofObservationReceivedAt: timestamp("history_proof_observation_received_at", { withTimezone: true }),
    historyProofRawPayloadId: bigint("history_proof_raw_payload_id", { mode: "number" }),
    chainSource: text("chain_source").$type<"journal_rebuild" | "engine">(),
    chainJournalWatermark: bigint("chain_journal_watermark", { mode: "number" }).default(0).notNull(),
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
      // Floor only: the retention cap is selection policy;
      // an upper bound here wedged whole dm_messages streams once the prune
      // stand-down made per-conversation history nondecreasing.
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
    // 0266: the reconciler's work list in id order (listDmRepairSignalRows).
    repairSignalIdx: index("dm_message_archive_repair_signal_id_idx")
      .on(table.id)
      .where(sql`${table.materialFingerprint} is distinct from ${table.emittedFingerprint} and ${table.materialFingerprint} is not null`),
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
    // Explicit fee capture (target §3.5 door 4.8): nullable — only the
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
    // Provenance: which system wrote this row. Open set (text +
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
      ${table.source} in ('onlymonster', 'ofapi:webhook', 'ofapi:rest', 'fansly:rest', 'harvest', 'chatspace:ws', 'chatspace:ledger')
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

// OFAPI trial/tracking link statistics (2026-07-22): one run row per ATTEMPT
// to read a (page, link_kind) list — finished walks, and since migration 0255
// the failed and the skipped ones too; append-only per-link snapshots under
// the finished walks. Cumulative vendor counters stored as observed; deltas
// are query-time.
export const pageLinkStatRuns = pgTable(
  "page_link_stat_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platformAccountId: bigint("platform_account_id", { mode: "number" })
      .references(() => pages.id, { onDelete: "restrict" })
      .notNull(),
    linkKind: text("link_kind").notNull(),
    // complete | partial | truncated | failed | skipped (CHECK in 0255).
    status: text("status").notNull(),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull(),
    apiPages: integer("api_pages").default(0).notNull(),
    rawItems: integer("raw_items").default(0).notNull(),
    writtenRows: integer("written_rows").default(0).notNull(),
    // Why the row is not a clean 'complete'; see the column comment in 0255.
    reason: text("reason"),
    // The scheduled window the attempt belongs to; null on rows older than
    // 0255 and on rows written by an image that predates it.
    windowAt: timestamp("window_at", { withTimezone: true }),
    // Ordinal of the row within its (page, link_kind, window).
    attempt: smallint("attempt").default(1).notNull(),
    // The OFAPI account the page was bound to when the attempt was made.
    ofapiAccountId: text("ofapi_account_id"),
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
    // Deprecated name (0256): the value is the creator's NET after the
    // OnlyFans fee, refunds and chargebacks. Still written with the same value
    // as revenueNetMills — the previous image and traffic-control read it.
    revenueGrossMills: bigint("revenue_gross_mills", { mode: "bigint" }),
    revenueIsLoading: boolean("revenue_is_loading"),
    revenueCalculatedAt: timestamp("revenue_calculated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Vendor revenue.total: creator net after the OnlyFans fee and after
    // refunds and chargebacks. Null on rows an image older than 0256 wrote —
    // read coalesce(revenue_net_mills, revenue_gross_mills).
    revenueNetMills: bigint("revenue_net_mills", { mode: "bigint" }),
    // Vendor revenue.chargebacks: already excluded from revenueNetMills.
    revenueChargebacksMills: bigint("revenue_chargebacks_mills", { mode: "bigint" }),
    // Vendor subscribeDays of a trial link; null on tracking links.
    trialDays: integer("trial_days"),
    // Vendor tags as sent; [] = none, null = unknown.
    tags: text("tags").array(),
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
    /** 0388: a NARROW web session's device token (opened from the extension); null — a full session. */
    narrowDeviceTokenId: bigint("narrow_device_token_id", { mode: "number" })
      .references((): AnyPgColumn => deviceTokens.id, { onDelete: "cascade" }),
  },
  (table) => ({
    userIdx: index("auth_sessions_user_idx").on(table.userId),
    expiryIdx: index("auth_sessions_expiry_idx").on(table.expiresAt),
  }),
);

/**
 * TOMBSTONE. The api-key lane is retired: nothing issues, reads
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

// Human-bound, expiring bearer credentials for machines.
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
    // Migration 0199: the x-client-version the token last presented, stamped
    // by the same UPDATE as last_used_at. Routing metadata,
    // never authority (#145).
    lastClientVersion: text("last_client_version"),
    // chat-extension H-3 (*_device_token_client_profile.sql): the narrow
    // token's client profile (CLIENT_TOKEN_PROFILES), set once at issuance and
    // immutable (trigger).
    // NULL = a full token. Authority, unlike last_client_version.
    clientProfile: text("client_profile"),
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

// Migration 0199: one-time invite / password-reset links. The
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

// 0287: the Anthropic accounts Hub spends. Keys stay in ANTHROPIC_API_KEYS;
// a row is what Hub knows of an account by its label (order, on/off, credit
// or key status, the owner's balance reading in micro-USD).
export const aiProviderAccounts = pgTable(
  "ai_provider_accounts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: text("provider").$type<"anthropic">().default("anthropic").notNull(),
    label: text("label").notNull(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    status: text("status").$type<"active" | "exhausted" | "invalid">().default("active").notNull(),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
    keyFingerprint: text("key_fingerprint"),
    keyHint: text("key_hint"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    balanceSnapshotMicroUsd: bigint("balance_snapshot_micro_usd", { mode: "number" }),
    balanceSnapshotAt: timestamp("balance_snapshot_at", { withTimezone: true }),
    // 0358: reading (the owner typed it) or credit_refusal (Anthropic refused
    // for credit: $0). Null = reading.
    balanceSnapshotSource: text("balance_snapshot_source").$type<"reading" | "credit_refusal">(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerLabelUniq: unique("ai_provider_accounts_provider_label_uniq").on(table.provider, table.label),
    providerCheck: check("ai_provider_accounts_provider_check", sql`${table.provider} in ('anthropic')`),
    statusCheck: check(
      "ai_provider_accounts_status_check",
      sql`${table.status} in ('active', 'exhausted', 'invalid')`,
    ),
    balanceCheck: check("ai_provider_accounts_balance_check", sql`
      (${table.balanceSnapshotMicroUsd} is null) = (${table.balanceSnapshotAt} is null)
      and (${table.balanceSnapshotMicroUsd} is null or ${table.balanceSnapshotMicroUsd} >= 0)
    `),
  }),
);

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // NULL = system lane (internal gateway completions) — the credit-ledger
    // precedent.
    userId: bigint("user_id", { mode: "number" })
      .references(() => users.id, { onDelete: "cascade" }),
    pageId: bigint("page_id", { mode: "number" }).references(() => pages.id, {
      onDelete: "set null",
    }),
    clientEventId: text("client_event_id").notNull(),
    feature: aiUsageFeatureEnum("feature").notNull(),
    model: text("model").notNull(),
    provider: text("provider").$type<"anthropic" | "openrouter">(),
    providerAccountId: bigint("provider_account_id", { mode: "number" })
      .references(() => aiProviderAccounts.id, { onDelete: "set null" }),
    providerResponseId: text("provider_response_id"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    // The cache writes split by TTL (5m and 1h are priced apart); null where
    // the provider did not split them or the row predates 0329.
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    // The effort the provider ran the request at (`off` = no thinking); null
    // for a lane without one or a call no model answered.
    reasoningEffort: text("reasoning_effort"),
    // How many chat messages the prompt's transcript held (the window).
    contextMessages: integer("context_messages"),
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
    // The stale-reservation sweep (0355): provider attempts still without an outcome only.
    openReservationIdx: index("ai_usage_events_open_reservation_idx")
      .on(table.completedAt)
      .where(sql`${table.provider} is not null and ${table.quotaAccepted} = true and ${table.gatewayOutcome} is null`),
    inputNonnegative: check("ai_usage_events_input_tokens_nonnegative", sql`${table.inputTokens} >= 0`),
    outputNonnegative: check("ai_usage_events_output_tokens_nonnegative", sql`${table.outputTokens} >= 0`),
    cacheWriteNonnegative: check(
      "ai_usage_events_cache_write_tokens_nonnegative",
      sql`${table.cacheWriteTokens} >= 0`,
    ),
    cacheWrite5mNonnegative: check(
      "ai_usage_events_cache_write_5m_tokens_nonnegative",
      sql`${table.cacheWrite5mTokens} is null or ${table.cacheWrite5mTokens} >= 0`,
    ),
    cacheWrite1hNonnegative: check(
      "ai_usage_events_cache_write_1h_tokens_nonnegative",
      sql`${table.cacheWrite1hTokens} is null or ${table.cacheWrite1hTokens} >= 0`,
    ),
    contextMessagesNonnegative: check(
      "ai_usage_events_context_messages_nonnegative",
      sql`${table.contextMessages} is null or ${table.contextMessages} >= 0`,
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
// spend (OFAPI_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET) and the last _meta._credits.balance seen
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
  // The historical-backfill CLI's own day counter — DP 2's binding
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
  // OnlyFans vault albums' own day counter (scope `vault_album`): outside
  // spend_day/spent_credits and the per-user counters, so uploads never eat
  // the reads' daily limit and reads never eat the albums'.
  vaultAlbumSpendDay: date("vault_album_spend_day"),
  vaultAlbumSpentCredits: integer("vault_album_spent_credits").default(0).notNull(),
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
/**
 * `vault_album` — uploads of OnlyFans vault albums: their own day ceiling and
 * counter, outside the common day counter and the per-user counters.
 */
export type OfapiBudgetScope = "live" | "interactive" | "bulk" | "vault_album";
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
    details: jsonbSafe("details").$type<Record<string, unknown>>(),
    // Acting principal for gateway reads; NULL = system spend.
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
    // fee/VAT/tax carried from the webhook payload through the shadow
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
// cursors. Nothing purges it: these rows are business facts.
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
    // DM projection bookkeeping, separate from the settle path on
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
    // 0250: one page's transactions.new deliveries since an instant (the
    // Spenders money stamp, getOfapiMoneyStreamStates).
    transactionsPageReceivedIdx: index("ofapi_webhook_events_transactions_page_received_idx")
      .on(table.platformAccountId, table.receivedAt)
      .where(sql`${table.eventType} = 'transactions.new'`),
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

// ── Observations journal ────────────────────────────────────
// The universal append-only capture spine: every server-side producer writes
// here unconditionally (no capture flags, by construction). Partitioned
// monthly by received_at; PG requires unique constraints on partitioned
// tables to include the partition key, so dedup lives in the unpartitioned
// companion observation_keys. account_id has NO FK by design — unmapped
// accounts are captured too; integrity is the insert protocol's job
// (repositories/observations.ts).

export const OBSERVATION_SOURCES = [
  "webhook",
  "pull",
  "client_capture",
  "readthrough",
  "command_result",
  "operator",
  "ofapi_capture",
  "fansly_ws",
  // 0274 (Project Browser): an answer to the page's own site request.
  "browser_site",
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
    // Plain text: no FK to platforms.key.
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
    // G5 slice 3a (0125): the harvest fields the reconciliation queries
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

// Canonical domain events derived from observations. Partitioned
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
    // Platform-native fan id; plain text, no FK.
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

// Platform-neutral message archive — a rebuildable projection fed
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
    // R20 HF-7д0 (0270): Fansly's automation markers and which of them any
    // applied material head carried (FANSLY_WS_LIVE_FIELD bits, as
    // dm_live_messages.field_mask); null mask = unknown.
    messageType: integer("message_type"),
    correlationId: text("correlation_id"),
    markerFieldMask: integer("marker_field_mask"),
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

// Personas as kernel config (DP 9-A: single-tenant, global).
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

// The DP 6-A restricted capture class — every gateway generation's
// prompt blocks VERBATIM + completion + params, keyed by the gateway-issued
// generation ref. Owner-only reads; excluded from lake exports; inside the
// erasure reach.
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

// AI media describer (0212, docs/runbooks/ai-media-describe.md): restricted
// class like ai_generation_content — owner-only reads, lake-excluded, inside
// fan and page erasure. Text only; image bytes never rest on the hub.
export type AiMediaDescriptionStatus =
  | "pending"
  | "awaiting_source"
  | "dormant"
  | "described"
  | "refused"
  | "unavailable"
  | "failed"
  | "budget_deferred"
  | "outcome_unknown"
  | "skipped_policy";

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
    // The golden-signals acceptance gauge counts the last hour (0355).
    occurredAtIdx: index("ai_acceptance_events_occurred_at_idx").on(table.occurredAt),
  }),
);

// Erasure tombstones — every break-glass erasure run (dry or
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

/** What the ElevenLabs account check (voice-provider-health.ts) last saw. */
export type VoiceProviderHealthStateName =
  | "healthy"
  | "characters_low"
  | "characters_out"
  | "subscription_inactive"
  | "key_rejected"
  | "unreadable"
  | "check_failed";

// 0296: the latest answer of the ElevenLabs account check, one row. A failed
// check keeps the last reading (read_at and the counts) and says when it
// failed; the history of the readings is in ops_metric_samples.
export const voiceProviderHealthState = pgTable(
  "voice_provider_health_state",
  {
    id: integer("id").primaryKey().default(1),
    state: text("state").$type<VoiceProviderHealthStateName>().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    httpStatus: integer("http_status"),
    readAt: timestamp("read_at", { withTimezone: true }),
    tier: text("tier"),
    subscriptionStatus: text("subscription_status"),
    characterCount: bigint("character_count", { mode: "number" }),
    characterLimit: bigint("character_limit", { mode: "number" }),
    nextResetAt: timestamp("next_reset_at", { withTimezone: true }),
    lowThresholdChars: integer("low_threshold_chars"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    singletonCheck: check("voice_provider_health_state_singleton_check", sql`${table.id} = 1`),
    stateCheck: check(
      "voice_provider_health_state_state_check",
      sql`${table.state} in (
        'healthy', 'characters_low', 'characters_out', 'subscription_inactive',
        'key_rejected', 'unreadable', 'check_failed'
      )`,
    ),
    countsCheck: check(
      "voice_provider_health_state_counts_check",
      sql`(${table.characterCount} is null or ${table.characterCount} >= 0)
        and (${table.characterLimit} is null or ${table.characterLimit} >= 0)
        and (${table.lowThresholdChars} is null or ${table.lowThresholdChars} >= 0)`,
    ),
  }),
);

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
    // Did ElevenLabs charge this take? true: it synthesized (completed, and
    // artifact_expired after it). NULL: unknown — not settled yet,
    // failed_after_dispatch, or an indeterminate row from the lease sweep.
    // false has two meanings:
    //   - "certainly not charged": failed_definite (refused before billing, or
    //     never reached ElevenLabs), and an indeterminate row the queued sweep
    //     reclaimed before it was ever dispatched;
    //   - on an indeterminate row that WAS dispatched, only the nightly release
    //     fence (releaseStaleIndeterminateVoiceBudgets): the reservation is
    //     refunded once and `billed IS NULL` no longer selects the row. Whether
    //     ElevenLabs charged stays unknown.
    // lease_until tells them apart: only the dispatch CAS writes it (with
    // attempt_token, in the UPDATE that moves queued → dispatched) and nothing
    // clears it, so an indeterminate row without it never reached ElevenLabs.
    // Clients get the verdict alone: toStatusView
    // (apps/runtime/src/services/voice-notes.ts) reports the fence as null.
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
    /** When a replacement was issued for this key: `expiresAt` is final from then (the grace day) and use no
     *  longer slides it. Null: not replaced. Written only by `insertPersonAgentKey` (repositories/people.ts). */
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
  },
  (table) => ({
    expiryIdx: index("agent_keys_expiry_idx").on(table.expiresAt),
    capabilitiesCheck: check("agent_keys_capabilities_check", sql`
      ${table.capabilities} <@ ARRAY[
        'read:messages',
        'read:money',
        'read:observations_envelope',
        'read:datasets',
        'request:hydration',
        'write:publication_drafts',
        'approve:publications',
        'approve:vault_albums',
        'write:fan_queues',
        'read:content',
        'read:team',
        'withdraw:publications',
        'delete:posts',
        'look:media',
        'write:matters',
        'read:pay_terms',
        'propose:people',
        'signin:contentops',
        'signin:taskindex',
        'signin:monitor',
        'write:reports',
        'write:system_state',
        'introspect:agent_keys',
        'write:customs',
        'write:shift_reports'
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

export const publications = pgTable("publications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  pageId: bigint("page_id", { mode: "number" }).references(() => pages.id, { onDelete: "restrict" }).notNull(),
  kind: text("kind").notNull(),
  status: text("status").default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  text: text("text").default("").notNull(),
  publishAt: timestamp("publish_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  wallRefs: text("wall_refs").array().default([]).notNull(),
  tierRefs: text("tier_refs").array().default([]).notNull(),
  priceMills: bigint("price_mills", { mode: "bigint" }),
  repost: boolean("repost").default(false).notNull(),
  pinWallRefs: text("pin_wall_refs").array().default([]).notNull(),
  replyLock: text("reply_lock").array().default([]).notNull(),
  subscribersOnly: boolean("subscribers_only").default(false).notNull(),
  findings: jsonbSafe("findings").$type<unknown[]>().default([]).notNull(),
  authorKind: text("author_kind").notNull(),
  authorUserId: bigint("author_user_id", { mode: "number" }).references(() => users.id, { onDelete: "restrict" }),
  authorAgentKeyId: bigint("author_agent_key_id", { mode: "number" }).references(() => agentKeys.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key"),
  approvedRevisionId: bigint("approved_revision_id", { mode: "number" }),
  platformPostRef: text("platform_post_ref"),
  /** 0323: the vault album a `vault_album` fills (found by its title, or made by its create). */
  vaultAlbumRef: text("vault_album_ref"),
  statusReason: text("status_reason"),
  previousPublicationId: bigint("previous_publication_id", { mode: "number" }).references((): AnyPgColumn => publications.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pagePublishIdx: index("publications_page_publish_idx").on(table.pageId, table.publishAt, table.id),
  statusPublishIdx: index("publications_status_publish_idx").on(table.status, table.publishAt, table.id),
}));
