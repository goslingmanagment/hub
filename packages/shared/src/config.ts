import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

import { FANSLY_PAUSE_MAX_MS, FANSLY_PAUSE_MIN_MS } from "./fansly-pause.ts";
import { assertProxyTargetAllowed } from "./proxy.ts";
import { agentExportPolicyValues, type AgentExportPolicyValue } from "./types.ts";
import {
  buildProxyConfig,
  getServiceEgressProxyUrlError,
} from "./proxy-string.ts";

export const OFAPI_MIRROR_BUDGET_DEFAULTS = {
  globalDailyCreditBudget: 7_000,
  principalDailyCallCap: 4_000,
  principalDailyCreditCap: 4_000,
} as const;

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}, z.string().min(1).optional());

const optionalPositiveIntSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}, z.coerce.number().int().positive().optional());

const optionalTelegramHourSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return value;
}, z.coerce.number().int().min(0).max(23).optional());

const booleanSchema = z.preprocess((value) => {
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

// `true` trusts the whole x-forwarded-for chain, which lets a client spoof
// `request.ip` whenever any hop forwards client-supplied XFF (audit P-9).
// A hop count (e.g. "1" for the single TLS proxy) or an IP/CIDR allowlist
// narrows trust to the proxies actually in front of the API.
const trustProxySchema = z
  .string()
  .trim()
  .default("false")
  .transform((value) => {
    const normalized = value.toLowerCase();
    if (normalized === "" || normalized === "false") {
      return false;
    }
    if (normalized === "true") {
      return true;
    }
    if (/^\d+$/.test(normalized)) {
      return Number.parseInt(normalized, 10);
    }
    return value;
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1),
  APP_ENCRYPTION_KEY_RING: optionalTrimmedStringSchema,
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.string().default("info"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: trustProxySchema,
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  FANSLY_BASE_URL: z.string().url().default("https://apiv3.fansly.com/api/v1"),
  SYNC_HTTP_TRACE_FILE: optionalTrimmedStringSchema,
  SYNC_HTTP_ATTEMPT_TRACE_STDOUT: booleanSchema.default(false),
  FANSLY_DEFAULT_DELAY_MS: optionalPositiveIntSchema,
  ONLYFANS_DEFAULT_DELAY_MS: z.coerce.number().int().positive().default(1000),
  // On-box lake root for tiered Parquet exports (Q3 declined).
  LAKE_DIR: z.string().min(1).default("lake"),
  SYNC_PAGE_EXECUTOR_CONCURRENCY: z.coerce.number().int().positive().default(4),
  SYNC_OBSERVABILITY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(180),
  HEALTH_SYNC_MONITORING_TOKEN: optionalTrimmedStringSchema,
  TELEGRAM_BOT_TOKEN: optionalTrimmedStringSchema,
  TELEGRAM_CHAT_ID: optionalTrimmedStringSchema,
  TELEGRAM_REPORT_HOUR: optionalTelegramHourSchema,
  TELEGRAM_PROXY_PAGE_LABEL: optionalTrimmedStringSchema,
  SERVICE_EGRESS_PROXY_URL: optionalTrimmedStringSchema,
  SERVICE_EGRESS_PROXY_USERNAME: optionalTrimmedStringSchema,
  SERVICE_EGRESS_PROXY_PASSWORD: optionalTrimmedStringSchema,
  OFAPI_BASE_URL: z.string().url().default("https://app.onlyfansapi.com/api"),
  OFAPI_API_KEY: optionalTrimmedStringSchema,
  OFAPI_EXPECTED_TEAM_SLUG: optionalTrimmedStringSchema,
  OFAPI_WEBHOOK_MANAGEMENT_SCOPE: z.enum(["unknown", "team"]).default("unknown"),
  OFAPI_EVENT_WORKER_REPLICAS: z.coerce.number().int().positive().default(1),
  FANSLY_REPLIES_REWALK_CYCLE_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  // Arena "vanished chat" R5: the session-less public account reader (off at
  // rest) and the ids it asks for per request.
  FANSLY_PUBLIC_LOOKUP_ENABLED: booleanSchema.default(false),
  FANSLY_PUBLIC_LOOKUP_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  OFAPI_REST_DELAY_MS: z.coerce.number().int().min(0).default(500),
  OFAPI_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET: z.coerce.number().int().min(1)
    .default(OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget),
  OFAPI_MIRROR_PRINCIPAL_DAILY_CALL_CAP: z.coerce.number().int().min(1)
    .default(OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCallCap),
  OFAPI_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP: z.coerce.number().int().min(1)
    .default(OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCreditCap),
  OFAPI_CREDIT_FLOOR: z.coerce.number().int().min(0).default(500),
  OFAPI_DM_RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(360),
  OFAPI_CREDIT_ALERT_THRESHOLD: z.coerce.number().int().min(0).default(1000),
  OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(720),
  // Desktop media images: agency-wide paid-download budget per UTC day. Auto
  // previews pass only while used + price <= cap; an explicit click always
  // passes and is flagged over_cap. Env-only by owner decision (redeploy).
  OFAPI_MEDIA_DAILY_CAP_CREDITS: z.coerce.number().int().min(0).max(100000).default(100),
  OFAPI_BURN_ALERT_CREDITS_PER_HOUR: z.coerce.number().int().min(0).default(300),
  OFAPI_CREDIT_MICRO_USD_PRICE: z.coerce.number().int().min(0).default(0),
  OFAPI_FAN_IDENTITIES_FINISHED_LINK_INTERVAL_HOURS: z.coerce.number().int().min(0).max(720).default(0),
  OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
  OFAPI_EXPORT_ARTIFACT_DIR: z.string().min(1)
    .default("/var/lib/agency-hub/ofapi-export-artifacts"),
  // W3.2: queued-only outbox rows older than this expire to
  // cancelled. Floor 60s so a typo can't cancel the whole queue instantly.
  OFAPI_QUEUED_COMMAND_TTL_MS: z.coerce.number().int().min(60_000).default(600_000),
  // Containment for forever-growing fact tables: the worker pages the
  // owner when server disk usage crosses this percentage.
  DISK_USAGE_ALERT_PERCENT: z.coerce.number().int().min(1).max(100).default(80),
  // Account-links kill switch: false makes the PUBLIC link routes
  // (inspect / redeem) answer 404; owners can still mint links. Live-wired:
  // read per request via loadEffectiveConfig — a flip needs no restart.
  ACCOUNT_LINKS_ENABLED: booleanSchema.default(true),
  CHATMUSE_AI_GATEWAY_ENABLED: booleanSchema.default(false),
  CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT: z.coerce.number().int().min(0).default(10_000_000),
  CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT: z.coerce.number().int().min(0).default(5_000_000),
  CHATMUSE_AI_GATEWAY_FEATURE_DAILY_MICRO_USD_LIMITS: z.string().default("{}"),
  // Fan-dossier context: which AI features read the stored fan profile into
  // their prompt. "none" = off (the SAFE default — enabling is a deliberate
  // post-deploy flip); "all" = trust the per-feature policy flag; otherwise a
  // CSV of feature keys narrows the policy set (staged rollout: fast-reply →
  // fast-reply,ping → all). LIVE-wired: read per generation.
  CHATMUSE_AI_FAN_PROFILE_CONTEXT_FEATURES: z.string().default("none"),
  // DP 6-A prompt declassification, fleet-wide: the
  // owner does not withhold the assembled prompt from the agency's own chatters,
  // so this is a plain live-config kill-switch, not a timed per-user allowlist.
  // Env may only ever be false: a deploy must be inert, so enabling goes
  // EXCLUSIVELY through the audited owner PATCH (the dashboard on/off switch),
  // whose override wins at runtime. A non-boolean effective value fails closed.
  CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: booleanSchema
    .refine((value) => value === false, {
      message: "prompt debug echo may be enabled only through the audited live-config API",
    })
    .default(false),
  // Voice notes (ElevenLabs TTS): ships inert behind kill switches. ELEVENLABS_API_KEY
  // is the vendor secret; the rest are live-wired kill switches + budgets read per
  // request. VOICE_NOTES_PAGE_ALLOWLIST FAILS CLOSED — empty = NO pages enabled.
  ELEVENLABS_API_KEY: optionalTrimmedStringSchema,
  VOICE_NOTES_ENABLED: booleanSchema.default(false),
  VOICE_NOTES_RETRIEVAL_ENABLED: booleanSchema.default(true),
  VOICE_NOTES_PAGE_ALLOWLIST: z.string().default(""),
  VOICE_NOTES_DAILY_CHAR_BUDGET: optionalPositiveIntSchema.default(5000),
  VOICE_NOTES_GLOBAL_DAILY_CHAR_BUDGET: optionalPositiveIntSchema.default(20000),
  VOICE_NOTES_SCRIPT_MAX_CHARS: optionalPositiveIntSchema.default(600),
  VOICE_NOTES_MAX_CONCURRENT_SYNTHESES: optionalPositiveIntSchema.default(2),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: optionalTrimmedStringSchema,
  // Several Anthropic accounts, in the order they are spent: "main=sk-...,
  // second=sk-...". Set, it replaces ANTHROPIC_API_KEY (parseAnthropicApiKeys).
  ANTHROPIC_API_KEYS: optionalTrimmedStringSchema,
  // AI media describer (docs/runbooks/ai-media-describe.md): ships inert. Every
  // knob is live-wired (read per sweep / per generation). The page policies
  // FAIL CLOSED: "{}" grants no page; a page describes only messages newer than
  // its policy `since` and only until its optional `until`.
  ANTHROPIC_MEDIA_API_KEY: optionalTrimmedStringSchema,
  AI_MEDIA_DESCRIBE_ENABLED: booleanSchema.default(false),
  // The questionnaire fill's cut-only second pass (owner 2026-10-17).
  AI_NOTES_TRIM_ENABLED: booleanSchema.default(false),
  // Wall posts through Hub (docs/plans/2026-10-23-wall-posts): the global switch.
  PUBLISHING_ENABLED: booleanSchema.default(false),
  PUBLISHING_ONLYFANS_ENABLED: booleanSchema.default(false),
  PUBLISHING_ONLYFANS_DAILY_CREDITS: z.coerce.number().int().min(0).max(10000).default(50),
  AI_MEDIA_DESCRIBE_PAGE_POLICIES: z.string().default("{}"),
  AI_MEDIA_DESCRIBE_MODEL: z.enum(["anthropic:claude-sonnet-5", "anthropic:claude-haiku-4-5"])
    .default("anthropic:claude-sonnet-5"),
  AI_MEDIA_DESCRIBE_DAILY_IMAGE_LIMIT: z.coerce.number().int().min(0).default(150),
  AI_MEDIA_DESCRIBE_DAILY_MICRO_USD_LIMIT: z.coerce.number().int().min(0).default(1_000_000),
  AI_MEDIA_DESCRIBE_LIVE_CHAT_ONLY: booleanSchema.default(true),
  AI_MEDIA_DESCRIBE_MODEL_MEDIA: z.enum(["teasers", "teasers+free"]).default("teasers"),
  // Describe within seconds: the worker's 1 s loop over due rows (default off).
  AI_MEDIA_DESCRIBE_LOOP_ENABLED: booleanSchema.default(false),
  AI_LIVE_IMAGES_ENABLED: booleanSchema.default(true),
  // Agent Read Plane. The plane itself is always on; these are LIVE-wired.
  // off = search answers 503; fts = Postgres FTS over the GIN expression that
  // already exists on message_archive; fts_trgm additionally needs the pg_trgm
  // extension, which is a MANUAL owner DBA step outside the migration chain —
  // absent at runtime the plane falls back to `fts` and says so in a caveat.
  AGENT_SEARCH_BACKEND: z.enum(["off", "fts", "fts_trgm"]).default("fts"),
  // The value served in `exportPolicy`. Widening the wire literal to this enum is a
  // CODE deploy (clients validate successful responses against a vendored schema);
  // only the VALUE flip is config, and only after the fleet has re-vendored.
  AGENT_EXPORT_POLICY_VALUE: z
    .enum(agentExportPolicyValues)
    .default("no_raw_transcript_export_endpoint_yet"),
  // Chat extension (chat-extension docs/hub-pr-plan.md H-2b): the owner's
  // switches for the hub's third client, live and audited. Every one rests OFF.
  // The JSON and version values are parsed where they are read
  // (chat-extension-settings.ts), never here: a bad value must turn the
  // extension off, not stop the hub from booting.
  CHAT_EXTENSION_ENABLED: booleanSchema.default(false),
  CHAT_EXTENSION_FEATURES: z.string().default("{}"),
  CHAT_EXTENSION_MIN_VERSION: z.string().default("0.0.0"),
  CHAT_EXTENSION_HOST_BINDINGS: z.string().default("{}"),
  CHAT_EXTENSION_PREVIEW_SEND_RECEIPT_PROFILES: z.string().default("[]"),
  // chat-extension H-6, R20 HF-6: how many messages the full Recap may read, on
  // OnlyFans and Fansly alike: 1500 (the AI readers' cap for everyone), 3000 or
  // 5000. Steps, not a range: 5000 is the readers' hard ceiling. Keep the env at
  // 1500; the owner raises it in the console.
  AI_TRANSCRIPT_DEEP_MAX_ROWS: z.enum(["1500", "3000", "5000"]).default("1500"),
  // H-11b: keep the extension's client_health reports as hourly rollups with
  // no user. Off = reports are accepted and dropped.
  CHAT_EXTENSION_HEALTH_INGEST_ENABLED: booleanSchema.default(false),
});

// Machine-readable list of every env var the schema understands. Exported so the
// config registry (config-registry.ts) can be parity-tested against the schema
// without reaching into Zod internals (see config-registry parity test).
export const ENV_CONFIG_KEYS = Object.keys(envSchema.shape) as Array<
  keyof typeof envSchema.shape
>;

/** One Anthropic account's key: `label` names the account in Hub (ledger,
 * usage screen, alerts); the key itself never leaves the config. */
export interface AnthropicApiKeyEntry {
  label: string;
  apiKey: string;
}

const ANTHROPIC_ACCOUNT_LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * ANTHROPIC_API_KEYS: `label=key` pairs separated by commas or whitespace, in
 * the order the accounts are spent. A label is lowercase latin, digits, `_`
 * or `-` (up to 32); a key holds none of `,` `=` or whitespace. Malformed
 * input refuses to boot rather than silently dropping an account.
 */
export function parseAnthropicApiKeys(raw: string | undefined | null): AnthropicApiKeyEntry[] {
  if (!raw) {
    return [];
  }
  const entries: AnthropicApiKeyEntry[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const separator = part.indexOf("=");
    const label = separator > 0 ? part.slice(0, separator) : "";
    const apiKey = separator > 0 ? part.slice(separator + 1) : "";
    if (!ANTHROPIC_ACCOUNT_LABEL.test(label) || apiKey.length === 0 || apiKey.includes("=")) {
      throw new Error("ANTHROPIC_API_KEYS entries must use the format label=key (label: a-z, 0-9, _ or -)");
    }
    if (entries.some((entry) => entry.label === label)) {
      throw new Error(`ANTHROPIC_API_KEYS repeats the label ${label}`);
    }
    if (entries.some((entry) => entry.apiKey === apiKey)) {
      throw new Error(`ANTHROPIC_API_KEYS gives the key of ${label} to another label too`);
    }
    entries.push({ label, apiKey });
  }
  return entries;
}

/** The accounts Hub spends: ANTHROPIC_API_KEYS, else the single
 * ANTHROPIC_API_KEY as the account `default`, else none. */
export function anthropicKeyPoolEntries(
  config: Pick<AppConfig, "anthropicApiKeys" | "anthropicApiKey">,
): AnthropicApiKeyEntry[] {
  if (config.anthropicApiKeys && config.anthropicApiKeys.length > 0) {
    return config.anthropicApiKeys;
  }
  return config.anthropicApiKey ? [{ label: "default", apiKey: config.anthropicApiKey }] : [];
}

export interface AppConfig {
  databaseUrl: string;
  encryptionKey: Buffer;
  encryptionKeyVersion: number;
  encryptionKeysByVersion: ReadonlyMap<number, Buffer>;
  logLevel: string;
  apiHost: string;
  apiPort: number;
  isProduction: boolean;
  trustProxy: boolean | number | string;
  sessionTtlDays: number;
  fanslyBaseUrl: string;
  syncHttpTraceFile: string | null;
  /** Verbose per-attempt sync HTTP traces on stdout. Off by default: only retries,
   *  failures, and attempts whose DB telemetry row was lost are printed. */
  syncHttpAttemptTraceStdout?: boolean;
  fanslyDefaultDelayMs: number;
  onlyFansDefaultDelayMs: number;
  lakeDir: string;
  syncPageExecutorConcurrency: number;
  syncObservabilityRetentionDays: number;
  healthSyncLightMaxAgeMinutes: number;
  healthSyncMonitoringToken: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramEnabled: boolean;
  telegramReportHourUtc: number;
  // Optional so existing AppConfig literals (tests, codegen) need not enumerate them;
  // loadConfig always populates them, so production behavior is exact.
  telegramProxyPageLabel?: string | null;
  serviceEgressProxyUrl: string | null;
  serviceEgressProxyUsername: string | null;
  serviceEgressProxyPassword: string | null;
  ofapiBaseUrl?: string;
  ofapiApiKey?: string | null;
  ofapiExpectedTeamSlug?: string | null;
  ofapiWebhookManagementScope?: "unknown" | "team";
  ofapiEventWorkerReplicas?: number;
  /** How stale a post's last walk must be before the round-robin re-reads it. */
  fanslyRepliesRewalkCycleDays?: number;
  /** Arena R5: the session-less public account reader runs (off by default). */
  fanslyPublicLookupEnabled?: boolean;
  /** Arena R5: ids per session-less lookup, 1–100. */
  fanslyPublicLookupBatchSize?: number;
  ofapiRestDelayMs?: number;
  ofapiQueuedCommandTtlMs?: number;
  /** Requests per sync chunk of the OFAPI DM / audience streams: a chunk,
   *  not a ceiling (the next one is scheduled right away). Not an env setting;
   *  tests shrink it. Unset = 25. */
  ofapiDmBootstrapMaxRequestsPerRun?: number;
  ofapiAudienceMaxRequestsPerRun?: number;
  ofapiMirrorGlobalDailyCreditBudget?: number;
  ofapiMirrorPrincipalDailyCallCap?: number;
  ofapiMirrorPrincipalDailyCreditCap?: number;
  ofapiCreditFloor?: number;
  ofapiDmReconcileIntervalMinutes?: number;
  ofapiCreditAlertThreshold?: number;
  ofapiWebhookSilenceThresholdMinutes?: number;
  ofapiMediaDailyCapCredits?: number;
  ofapiBurnAlertCreditsPerHour?: number;
  ofapiCreditMicroUsdPrice?: number;
  /** A finished trial link's subscriber list is re-read at most once in this
   *  many hours by the fan sweep; 0 = every sweep (traffic plan PR 10). */
  ofapiFanIdentitiesFinishedLinkIntervalHours?: number;
  ofapiAudienceSweepIntervalMinutes?: number;
  ofapiExportArtifactDir?: string;
  diskUsageAlertPercent?: number;
  /** Public invite / reset link routes (live-wired kill switch). */
  accountLinksEnabled?: boolean;
  chatMuseAiGatewayEnabled?: boolean;
  chatMuseAiGatewayDailyMicroUsdLimit?: number;
  chatMuseAiGatewayRequestMicroUsdLimit?: number;
  /** JSON object mapping feature -> daily micro-USD ceiling (global,
   * all principals). Absent feature = no per-feature ceiling. */
  chatMuseAiGatewayFeatureDailyMicroUsdLimits?: string;
  /** Fan-dossier context allowlist: "all" (policy decides) | "none" | CSV of features (live-wired). */
  chatMuseAiFanProfileContextFeatures?: string;
  /** Fleet-wide prompt-echo kill-switch (live-wired); default false, audited enable. */
  chatMuseAiPromptDebugEchoEnabled?: boolean;
  // Voice notes (ElevenLabs TTS) — ships inert behind kill switches (live-wired).
  /** ElevenLabs vendor TTS key; unset ships the feature implemented-but-unkeyed. */
  elevenLabsApiKey?: string | undefined;
  /** Dispatch kill switch for voice-note synthesis; default off (deploy inert). */
  voiceNotesEnabled?: boolean;
  /** Retrieval kill switch (retrieval is free); default on, off only for incidents. */
  voiceNotesRetrievalEnabled?: boolean;
  /** CSV of page labels allowed to synthesize; empty = NONE (fails closed). */
  voiceNotesPageAllowlist?: string;
  /** Per-page/day character budget ceiling. */
  voiceNotesDailyCharBudget?: number;
  /** Fleet-wide per-day character budget ceiling. */
  voiceNotesGlobalDailyCharBudget?: number;
  /** Per-synthesis script length cap. */
  voiceNotesScriptMaxChars?: number;
  /** Ceiling on in-flight ElevenLabs syntheses. */
  voiceNotesMaxConcurrentSyntheses?: number;
  anthropicApiKey?: string | null;
  /** ANTHROPIC_API_KEYS: the Anthropic accounts in their spending order. Empty
   * = the single ANTHROPIC_API_KEY (anthropicKeyPoolEntries). */
  anthropicApiKeys?: AnthropicApiKeyEntry[];
  // AI media describer — ships inert; every knob live-wired.
  /** Optional separate Anthropic key/workspace for the describer (spend
   * accounting and a provider-side limit). Unset = the main key. */
  anthropicMediaApiKey?: string | null;
  aiMediaDescribeEnabled?: boolean;
  /** fan-notes-fill: a second Opus pass cuts the water out of the finished fill. */
  aiNotesTrimEnabled?: boolean;
  /** Wall posts through Hub: the global switch above every page's own (off by default). */
  publishingEnabled?: boolean;
  /** OnlyFans posts and stories through OnlyFansAPI, under the global switch (off by default). */
  publishingOnlyfansEnabled?: boolean;
  /** OnlyFansAPI credits publications may spend per UTC day, inside the global daily budget. */
  publishingOnlyfansDailyCredits?: number;
  /** JSON keyed by exact page label: {"since": ISO, "until"?: ISO}. "{}" = none. */
  aiMediaDescribePagePolicies?: string;
  aiMediaDescribeModel?: "anthropic:claude-sonnet-5" | "anthropic:claude-haiku-4-5";
  /** Agency-wide images per UTC day (0 blocks all sends). */
  aiMediaDescribeDailyImageLimit?: number;
  /** Agency-wide micro-USD per UTC day (0 blocks all sends). */
  aiMediaDescribeDailyMicroUsdLimit?: number;
  /** Describe fan media on arrival only in chats with an AI generation in the
   * last 7 days; other chats get it at their first generation. */
  aiMediaDescribeLiveChatOnly?: boolean;
  /** Creator media: PPV teasers only, or teasers plus free (non-PPV) media. */
  aiMediaDescribeModelMedia?: "teasers" | "teasers+free";
  /** The worker describes due rows within seconds (1 s loop), not per minute. */
  aiMediaDescribeLoopEnabled?: boolean;
  /** The AI stream attaches the fan's newest photos the chat extension sends
   * (`liveImages`) to Reply, Fix and Coach, and the bootstrap lists
   * `live-images-v1`. */
  aiLiveImagesEnabled?: boolean;
  openrouterApiKey?: string | null;
  // Agent Read Plane (slice 0a) — all live-wired, all inert by default.
  /** off = search 503; fts; fts_trgm (falls back to fts when pg_trgm is absent). */
  agentSearchBackend?: "off" | "fts" | "fts_trgm";
  /** The value served in `exportPolicy`; flipped only after the fleet re-vendors. */
  agentExportPolicyValue?: AgentExportPolicyValue;
  /** Chat extension master switch; off = every feature off (H-2b). */
  chatExtensionEnabled?: boolean;
  /** JSON: scope ("*" or a page label) → flag → on. */
  chatExtensionFeatures?: string;
  /** MAJOR.MINOR.PATCH: the lowest extension version the client routes serve. */
  chatExtensionMinVersion?: string;
  /** JSON: host account ("onlymonster:36408") → page label. */
  chatExtensionHostBindings?: string;
  /** JSON array: the admitted preview-send receipt profiles (X8); [] = none. */
  chatExtensionPreviewSendReceiptProfiles?: string;
  /** chat-extension H-6, R20 HF-6: the row cap of the full Recap's transcript read (live-wired). */
  aiTranscriptDeepMaxRows?: "1500" | "3000" | "5000";
  /** Keep client_health reports as hourly rollups with no user (H-11b); default false. */
  chatExtensionHealthIngestEnabled?: boolean;
}

function hasConfiguredValue(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveServiceEgressProxyTuple(input: {
  SERVICE_EGRESS_PROXY_URL?: string | undefined;
  SERVICE_EGRESS_PROXY_USERNAME?: string | undefined;
  SERVICE_EGRESS_PROXY_PASSWORD?: string | undefined;
}) {
  const url = input.SERVICE_EGRESS_PROXY_URL ?? null;
  const username = input.SERVICE_EGRESS_PROXY_USERNAME ?? null;
  const password = input.SERVICE_EGRESS_PROXY_PASSWORD ?? null;
  const configuredCount = [url, username, password].filter((value) => value !== null).length;

  if (configuredCount === 0) {
    return { url: null, username: null, password: null };
  }
  if (configuredCount !== 3) {
    throw new Error(
      "SERVICE_EGRESS_PROXY_URL, SERVICE_EGRESS_PROXY_USERNAME, and "
        + "SERVICE_EGRESS_PROXY_PASSWORD must be configured together",
    );
  }

  const urlError = getServiceEgressProxyUrlError(url!);
  if (urlError) {
    throw new Error(urlError);
  }
  const proxy = buildProxyConfig(url!);
  if (!proxy) {
    throw new Error("SERVICE_EGRESS_PROXY_URL must be a valid SOCKS5 URL");
  }
  try {
    assertProxyTargetAllowed(proxy);
  } catch {
    throw new Error(
      "SERVICE_EGRESS_PROXY_URL must not target a local or private address",
    );
  }

  return { url: url!, username: username!, password: password! };
}

/** The pause aliases retired with the legacy Fansly engine (step 4). They fed
 *  `fanslyDefaultDelayMs` while `FANSLY_DEFAULT_DELAY_MS` was unset, so an
 *  environment that still sets the pause only through one of them fails the
 *  boot (see `loadConfig`) rather than have the owner's pause become the
 *  default behind their back. */
const RETIRED_FANSLY_PAUSE_ALIAS_ENV_KEYS = [
  "FANSLY_GLOBAL_DELAY_MS",
  "FANSLY_ACCOUNT_LOOKUP_DELAY_MS",
] as const;

/** Env vars of the config keys removed with the legacy Fansly engine (step 4,
 *  plan §14). The schema no longer names them, so a value an environment still
 *  sets is dropped unparsed and the process boots (the two pause aliases above
 *  apart); the api, the worker and the scheduler name the ones they find once
 *  at start (`createAppContext`), until the line leaves the env. Nothing else
 *  reads this list: every Fansly request is the Sync Engine's, paced by
 *  `FANSLY_DEFAULT_DELAY_MS` and budgeted by the route table in code. */
export const RETIRED_FANSLY_ENV_KEYS = [
  // The pause aliases and the endpoint pauses (plan §2.3).
  ...RETIRED_FANSLY_PAUSE_ALIAS_ENV_KEYS,
  "FOLLOWER_PAGE_DELAY_MS",
  "FANSLY_DM_CONVERSATIONS_DELAY_MS",
  "FANSLY_DM_MESSAGES_DELAY_MS",
  // The legacy executor's pacing and windows.
  "SYNC_SHARED_RATE_LIMIT_ENABLED",
  "FANSLY_BACKFILL_CONTINUATION_DELAY_MS",
  "TRANSACTION_LOOKBACK_DAYS",
  "TRANSACTION_RESCAN_CAP_DAYS",
  "HEALTH_SYNC_FOLLOWER_MAX_AGE_MINUTES",
  // The legacy WebSocket receiver and its hints.
  "FANSLY_WS_CAPTURE_ENABLED",
  "FANSLY_WS_CAPTURE_PAGE_ALLOWLIST",
  "FANSLY_WS_HINTS_ENABLED",
  "FANSLY_WS_HINTS_PAGE_ALLOWLIST",
  "FANSLY_WS_HINTS_TYPE_ALLOWLIST",
  "FANSLY_WS_HINTS_POLICIES",
  // The legacy DM lanes.
  "FANSLY_DM_HEAD_CATCHUP_PAGE_ALLOWLIST",
  "FANSLY_DM_SHADOW_PAGE_ALLOWLIST",
  "FANSLY_DM_BOUNDED_ENABLED",
  "FANSLY_DM_BOUNDED_PAGE_ALLOWLIST",
  "FANSLY_DM_BOUNDED_POLICIES",
  "FANSLY_DM_DEEP_BACKFILL_ENABLED",
  "FANSLY_DM_DEEP_BACKFILL_MAX_REQUESTS_PER_RUN",
  "FANSLY_DM_DEEP_BACKFILL_LIVE_REQUESTS_PER_DEEP",
  "FANSLY_DM_DEEP_BACKFILL_CONTINUATION_DELAY_MS",
  "FANSLY_DM_DEEP_BACKFILL_CONTINUATION_JITTER_MS",
  "FANSLY_DEEP_BACKFILL_IGNORE_RETENTION_LIMIT",
  // The legacy money and audience lanes.
  "FANSLY_FAN_EARNINGS_SYNC_ENABLED",
  "FANSLY_FAN_EARNINGS_SHADOW_PAGE_ALLOWLIST",
  "FANSLY_FAN_EARNINGS_RECOVERY_ENABLED",
  "FANSLY_FAN_EARNINGS_RECOVERY_PAGE_ALLOWLIST",
  "FANSLY_FAN_EARNINGS_TARGETS_ENABLED",
  "FANSLY_FAN_EARNINGS_TARGETS_PAGE_ALLOWLIST",
  "FANSLY_FAN_EARNINGS_TARGETS_DAILY_ATTEMPT_LIMIT",
  "FANSLY_FAN_EARNINGS_ROSTER_MAX_AGE_HOURS",
  "FANSLY_PURCHASE_HISTORY_SYNC_ENABLED",
  "FANSLY_NEW_STREAM_PAGE_ALLOWLIST",
  "FANSLY_FOLLOWERS_SETTLEMENT_REUSE_ENABLED",
  "FANSLY_FOLLOWERS_SETTLEMENT_REUSE_PAGE_ALLOWLIST",
  // The legacy content lanes: their flags, page allowlists and daily budgets.
  "FANSLY_STATS_SNAPSHOT_SYNC_ENABLED",
  "FANSLY_STATS_SNAPSHOT_PAGE_ALLOWLIST",
  "FANSLY_STATS_SNAPSHOT_DAILY_CALL_BUDGET",
  "FANSLY_STATS_HOURLY_ENABLED",
  "FANSLY_STATS_HOURLY_BACKFILL_MAX_DAYS",
  "FANSLY_NOTIFICATIONS_SYNC_ENABLED",
  "FANSLY_NOTIFICATIONS_PAGE_ALLOWLIST",
  "FANSLY_NOTIFICATIONS_DAILY_CALL_BUDGET",
  "FANSLY_CATALOG_SYNC_ENABLED",
  "FANSLY_CATALOG_PAGE_ALLOWLIST",
  "FANSLY_CATALOG_DAILY_CALL_BUDGET",
  "FANSLY_POST_REPLIES_SYNC_ENABLED",
  "FANSLY_POST_REPLIES_PAGE_ALLOWLIST",
  "FANSLY_REPLIES_DAILY_CALL_BUDGET",
  "FANSLY_PAYOUTS_SYNC_ENABLED",
  "FANSLY_PAYOUTS_PAGE_ALLOWLIST",
  "FANSLY_PAYOUTS_DAILY_CALL_BUDGET",
  "FANSLY_MEDIA_STATS_SYNC_ENABLED",
  "FANSLY_MEDIA_STATS_PAGE_ALLOWLIST",
  "FANSLY_MEDIA_STATS_DAILY_CALL_BUDGET",
  "FANSLY_MEDIA_STATS_LONG_TAIL_CYCLE_DAYS",
  "FANSLY_POST_ENGAGEMENT_REFRESH_ENABLED",
  "FANSLY_POST_ENGAGEMENT_DAILY_CALL_BUDGET",
  // The AI media describer's Fansly accelerator and fast lane.
  "AI_MEDIA_DESCRIBE_FANSLY_ACCELERATOR_ENABLED",
  "AI_MEDIA_DESCRIBE_FANSLY_ACCELERATOR_DAILY_LIMIT",
  "AI_MEDIA_DESCRIBE_FANSLY_FAST_LANE_MODE",
  "AI_MEDIA_DESCRIBE_FANSLY_FAST_LANE_PAGES",
  // The Fansly hydration autopilot.
  "AGENT_HYDRATION_AUTO_APPROVE_MODE",
  "AGENT_HYDRATION_AUTO_DAILY_CALL_BUDGET",
] as const;

/** The retired Fansly env vars this environment still sets (boot warning). */
export function listRetiredFanslyEnv(env: NodeJS.ProcessEnv = process.env) {
  return RETIRED_FANSLY_ENV_KEYS.filter((key) => hasConfiguredValue(env[key]));
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { loadDotEnv?: boolean } = {},
): AppConfig {
  // Callers that pass an explicit env (tests, the registry parity check) can opt
  // out of merging the ambient .env file so the result is hermetic.
  if (options.loadDotEnv !== false) {
    loadDotEnv({
      processEnv: env,
      quiet: process.env.DOTENV_CONFIG_QUIET === "true",
    });
  }

  const parsed = envSchema.parse(env);
  const encryptionKey = parseEncryptionKey(parsed.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY");
  const encryptionKeysByVersion = parseEncryptionKeyRing(
    parsed.APP_ENCRYPTION_KEY_RING,
    parsed.APP_ENCRYPTION_KEY_VERSION,
    encryptionKey,
  );

  if (parsed.FANSLY_DEFAULT_DELAY_MS === undefined) {
    // The retired aliases set the pause while this name was unset. Dropping one
    // like any other retired name would move the page pause to the default
    // without the owner's act, so the boot stops and names the fix.
    const retiredAlias = RETIRED_FANSLY_PAUSE_ALIAS_ENV_KEYS.find((key) => hasConfiguredValue(env[key]));
    if (retiredAlias !== undefined) {
      throw new Error(
        `${retiredAlias} is retired and no longer sets the Fansly pause; `
          + `set FANSLY_DEFAULT_DELAY_MS=${env[retiredAlias]!.trim()} instead and remove ${retiredAlias}`,
      );
    }
  }
  const fanslyDefaultDelayMs = parsed.FANSLY_DEFAULT_DELAY_MS ?? 2500;
  if (fanslyDefaultDelayMs < FANSLY_PAUSE_MIN_MS || fanslyDefaultDelayMs > FANSLY_PAUSE_MAX_MS) {
    // Fail the boot loudly: a silently raised value would hide a wrong env, and a
    // lowered one would break the owner's pace rule for every Fansly page.
    throw new Error(
      `FANSLY_DEFAULT_DELAY_MS must be between ${FANSLY_PAUSE_MIN_MS} and ${FANSLY_PAUSE_MAX_MS} ms `
        + `(got ${fanslyDefaultDelayMs}); `
        + "the owner rule is at most one request of a Fansly page every 2 s, and going lower is a code change",
    );
  }
  const telegramBotToken = parsed.TELEGRAM_BOT_TOKEN ?? null;
  const telegramChatId = parsed.TELEGRAM_CHAT_ID ?? null;
  const telegramEnabled = telegramBotToken !== null && telegramChatId !== null;
  const serviceEgressProxy = resolveServiceEgressProxyTuple(parsed);

  return {
    databaseUrl: parsed.DATABASE_URL,
    encryptionKey,
    encryptionKeyVersion: parsed.APP_ENCRYPTION_KEY_VERSION,
    encryptionKeysByVersion,
    logLevel: parsed.LOG_LEVEL,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    isProduction: env.NODE_ENV === "production",
    trustProxy: parsed.TRUST_PROXY,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    fanslyBaseUrl: parsed.FANSLY_BASE_URL,
    syncHttpTraceFile: parsed.SYNC_HTTP_TRACE_FILE ?? null,
    syncHttpAttemptTraceStdout: parsed.SYNC_HTTP_ATTEMPT_TRACE_STDOUT,
    fanslyDefaultDelayMs,
    onlyFansDefaultDelayMs: parsed.ONLYFANS_DEFAULT_DELAY_MS,
    lakeDir: parsed.LAKE_DIR,
    syncPageExecutorConcurrency: parsed.SYNC_PAGE_EXECUTOR_CONCURRENCY,
    syncObservabilityRetentionDays: parsed.SYNC_OBSERVABILITY_RETENTION_DAYS,
    healthSyncLightMaxAgeMinutes: parsed.HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES,
    healthSyncMonitoringToken: parsed.HEALTH_SYNC_MONITORING_TOKEN ?? null,
    telegramBotToken,
    telegramChatId,
    telegramEnabled,
    telegramReportHourUtc: parsed.TELEGRAM_REPORT_HOUR ?? 9,
    telegramProxyPageLabel: parsed.TELEGRAM_PROXY_PAGE_LABEL ?? null,
    serviceEgressProxyUrl: serviceEgressProxy.url,
    serviceEgressProxyUsername: serviceEgressProxy.username,
    serviceEgressProxyPassword: serviceEgressProxy.password,
    ofapiBaseUrl: parsed.OFAPI_BASE_URL,
    ofapiApiKey: parsed.OFAPI_API_KEY ?? null,
    ofapiExpectedTeamSlug: parsed.OFAPI_EXPECTED_TEAM_SLUG ?? null,
    ofapiWebhookManagementScope: parsed.OFAPI_WEBHOOK_MANAGEMENT_SCOPE,
    ofapiEventWorkerReplicas: parsed.OFAPI_EVENT_WORKER_REPLICAS,
    fanslyRepliesRewalkCycleDays: parsed.FANSLY_REPLIES_REWALK_CYCLE_DAYS,
    fanslyPublicLookupEnabled: parsed.FANSLY_PUBLIC_LOOKUP_ENABLED,
    fanslyPublicLookupBatchSize: parsed.FANSLY_PUBLIC_LOOKUP_BATCH_SIZE,
    ofapiRestDelayMs: parsed.OFAPI_REST_DELAY_MS,
    ofapiQueuedCommandTtlMs: parsed.OFAPI_QUEUED_COMMAND_TTL_MS,
    ofapiMirrorGlobalDailyCreditBudget: parsed.OFAPI_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET,
    ofapiMirrorPrincipalDailyCallCap: parsed.OFAPI_MIRROR_PRINCIPAL_DAILY_CALL_CAP,
    ofapiMirrorPrincipalDailyCreditCap: parsed.OFAPI_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP,
    ofapiCreditFloor: parsed.OFAPI_CREDIT_FLOOR,
    ofapiDmReconcileIntervalMinutes: parsed.OFAPI_DM_RECONCILE_INTERVAL_MINUTES,
    ofapiCreditAlertThreshold: parsed.OFAPI_CREDIT_ALERT_THRESHOLD,
    ofapiWebhookSilenceThresholdMinutes: parsed.OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES,
    ofapiMediaDailyCapCredits: parsed.OFAPI_MEDIA_DAILY_CAP_CREDITS,
    ofapiBurnAlertCreditsPerHour: parsed.OFAPI_BURN_ALERT_CREDITS_PER_HOUR,
    ofapiCreditMicroUsdPrice: parsed.OFAPI_CREDIT_MICRO_USD_PRICE,
    ofapiFanIdentitiesFinishedLinkIntervalHours: parsed.OFAPI_FAN_IDENTITIES_FINISHED_LINK_INTERVAL_HOURS,
    ofapiAudienceSweepIntervalMinutes: parsed.OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES,
    ofapiExportArtifactDir: parsed.OFAPI_EXPORT_ARTIFACT_DIR,
    diskUsageAlertPercent: parsed.DISK_USAGE_ALERT_PERCENT,
    accountLinksEnabled: parsed.ACCOUNT_LINKS_ENABLED,
    chatMuseAiGatewayEnabled: parsed.CHATMUSE_AI_GATEWAY_ENABLED,
    chatMuseAiGatewayDailyMicroUsdLimit: parsed.CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT,
    chatMuseAiGatewayRequestMicroUsdLimit: parsed.CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT,
    chatMuseAiGatewayFeatureDailyMicroUsdLimits: parsed.CHATMUSE_AI_GATEWAY_FEATURE_DAILY_MICRO_USD_LIMITS,
    chatMuseAiFanProfileContextFeatures: parsed.CHATMUSE_AI_FAN_PROFILE_CONTEXT_FEATURES,
    chatMuseAiPromptDebugEchoEnabled: parsed.CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED,
    elevenLabsApiKey: parsed.ELEVENLABS_API_KEY,
    voiceNotesEnabled: parsed.VOICE_NOTES_ENABLED,
    voiceNotesRetrievalEnabled: parsed.VOICE_NOTES_RETRIEVAL_ENABLED,
    voiceNotesPageAllowlist: parsed.VOICE_NOTES_PAGE_ALLOWLIST,
    voiceNotesDailyCharBudget: parsed.VOICE_NOTES_DAILY_CHAR_BUDGET,
    voiceNotesGlobalDailyCharBudget: parsed.VOICE_NOTES_GLOBAL_DAILY_CHAR_BUDGET,
    voiceNotesScriptMaxChars: parsed.VOICE_NOTES_SCRIPT_MAX_CHARS,
    voiceNotesMaxConcurrentSyntheses: parsed.VOICE_NOTES_MAX_CONCURRENT_SYNTHESES,
    openrouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    anthropicApiKeys: parseAnthropicApiKeys(parsed.ANTHROPIC_API_KEYS),
    anthropicMediaApiKey: parsed.ANTHROPIC_MEDIA_API_KEY ?? null,
    aiMediaDescribeEnabled: parsed.AI_MEDIA_DESCRIBE_ENABLED,
    aiNotesTrimEnabled: parsed.AI_NOTES_TRIM_ENABLED,
    publishingEnabled: parsed.PUBLISHING_ENABLED,
    publishingOnlyfansEnabled: parsed.PUBLISHING_ONLYFANS_ENABLED,
    publishingOnlyfansDailyCredits: parsed.PUBLISHING_ONLYFANS_DAILY_CREDITS,
    aiMediaDescribePagePolicies: parsed.AI_MEDIA_DESCRIBE_PAGE_POLICIES,
    aiMediaDescribeModel: parsed.AI_MEDIA_DESCRIBE_MODEL,
    aiMediaDescribeDailyImageLimit: parsed.AI_MEDIA_DESCRIBE_DAILY_IMAGE_LIMIT,
    aiMediaDescribeDailyMicroUsdLimit: parsed.AI_MEDIA_DESCRIBE_DAILY_MICRO_USD_LIMIT,
    aiMediaDescribeLiveChatOnly: parsed.AI_MEDIA_DESCRIBE_LIVE_CHAT_ONLY,
    aiMediaDescribeModelMedia: parsed.AI_MEDIA_DESCRIBE_MODEL_MEDIA,
    aiMediaDescribeLoopEnabled: parsed.AI_MEDIA_DESCRIBE_LOOP_ENABLED,
    aiLiveImagesEnabled: parsed.AI_LIVE_IMAGES_ENABLED,
    agentSearchBackend: parsed.AGENT_SEARCH_BACKEND,
    agentExportPolicyValue: parsed.AGENT_EXPORT_POLICY_VALUE,
    chatExtensionEnabled: parsed.CHAT_EXTENSION_ENABLED,
    chatExtensionFeatures: parsed.CHAT_EXTENSION_FEATURES,
    chatExtensionMinVersion: parsed.CHAT_EXTENSION_MIN_VERSION,
    chatExtensionHostBindings: parsed.CHAT_EXTENSION_HOST_BINDINGS,
    chatExtensionPreviewSendReceiptProfiles: parsed.CHAT_EXTENSION_PREVIEW_SEND_RECEIPT_PROFILES,
    aiTranscriptDeepMaxRows: parsed.AI_TRANSCRIPT_DEEP_MAX_ROWS,
    chatExtensionHealthIngestEnabled: parsed.CHAT_EXTENSION_HEALTH_INGEST_ENABLED,
  };
}

function parseEncryptionKey(value: string, envVar: string): Buffer {
  const encryptionKey = Buffer.from(value, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error(`${envVar} must decode to exactly 32 bytes`);
  }

  return encryptionKey;
}

function parseEncryptionKeyRing(
  rawValue: string | undefined,
  writeKeyVersion: number,
  writeKey: Buffer,
): ReadonlyMap<number, Buffer> {
  const keysByVersion = new Map<number, Buffer>();

  if (rawValue) {
    for (const entry of rawValue.split(",")) {
      const trimmedEntry = entry.trim();
      if (trimmedEntry.length === 0) {
        continue;
      }

      const separatorIndex = trimmedEntry.indexOf(":");
      if (separatorIndex <= 0 || separatorIndex === trimmedEntry.length - 1) {
        throw new Error(
          "APP_ENCRYPTION_KEY_RING entries must use the format version:base64",
        );
      }

      const versionText = trimmedEntry.slice(0, separatorIndex).trim();
      const keyText = trimmedEntry.slice(separatorIndex + 1).trim();
      const keyVersion = z.coerce.number().int().positive().parse(versionText);

      if (keysByVersion.has(keyVersion)) {
        throw new Error(`APP_ENCRYPTION_KEY_RING repeats key version ${keyVersion}`);
      }

      keysByVersion.set(
        keyVersion,
        parseEncryptionKey(keyText, `APP_ENCRYPTION_KEY_RING version ${keyVersion}`),
      );
    }
  }

  const existingWriteKey = keysByVersion.get(writeKeyVersion);
  if (existingWriteKey && !existingWriteKey.equals(writeKey)) {
    throw new Error(
      `APP_ENCRYPTION_KEY_RING version ${writeKeyVersion} conflicts with APP_ENCRYPTION_KEY_VERSION`,
    );
  }

  keysByVersion.set(writeKeyVersion, writeKey);
  return keysByVersion;
}
