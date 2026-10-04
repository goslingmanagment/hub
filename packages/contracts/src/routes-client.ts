/**
 * Routes of the chat extension (`chat-extension`), the hub's third client.
 *
 * WHY A SEPARATE MODULE: every route the new client gets lands here (group
 * `clientRouteSchemas`), so its PRs touch one new file instead of `routes.ts`,
 * which the Sync Engine changes almost daily. `routes.ts` spreads the group into
 * `routeSchemas`, behind its own name in `RouteSchemas` (TS7056, see there).
 *
 * Imports come only from `zod`, `./primitives.ts` and the vendored part of
 * `@agency_hub_core/shared`. Never from `./routes.ts`: it imports this module,
 * so the reverse import is a cycle.
 *
 * Shape law for every client route (chat-extension docs/hub-pr-plan.md §4.0):
 * - bodies and query strings are `.strict()`;
 * - response objects are NOT strict: an SDK frozen in a shipped client strips a
 *   key it does not know instead of failing the whole response, so a new field
 *   is always optional and never breaks an installed client;
 * - a vocabulary that grows (flags, capabilities, reasons, platforms, roles) is
 *   an open string on the wire. `z.enum`, `z.record(z.enum…)` and
 *   `z.array(z.enum…)` refuse an unknown member, so one new platform or flag
 *   would break the parse of the whole bootstrap in every installed client. The
 *   known members are the exported constants below; a client narrows to them
 *   itself and reads an unknown member as "off" / "unknown".
 */

import { platforms, userRoles } from "@agency_hub_core/shared";
import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";

/** Open token: the wire form of every growing vocabulary (reason, flag, capability, platform, role…). */
export const clientOpenToken = z.string().min(1).max(64);

/**
 * The ONE shape of a platform numeric id a client sends: an OnlyFans fan id
 * (== chat id) or message id. No leading zero, at most 30 digits. Every client
 * field that carries such an id (fanRef, the feed, fresh text, known message
 * ids) uses this schema, so the hub never holds two spellings of one id.
 */
export const CLIENT_NUMERIC_ID_PATTERN = /^[1-9]\d{0,29}$/;
export const clientNumericIdSchema = z.string().regex(CLIENT_NUMERIC_ID_PATTERN);
/** OnlyFans fan id (== chat_id). */
export const clientFanRefSchema = clientNumericIdSchema;

const pageLabelSchema = z.string().min(1).max(120);
export const clientPageParamsSchema = z.object({ pageLabel: pageLabelSchema });
export const clientPageFanParamsSchema = z.object({ pageLabel: pageLabelSchema, fanRef: clientFanRefSchema });
export const clientCursorSchema = z.string().min(1).max(2048);

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();

/** Known names: documentation and the client's narrowing. On the wire they are open strings. */
export const CLIENT_FEATURE_FLAG_NAMES = [
  "insertion", "freshText", "newcomers", "spenders", "stats", "preview", "previewSend",
  "previewSendMarkAiGenerated", "fanPanel", "navigation", "wsTap", "sound",
  "coach", "recap", "review", "splitAll",
] as const;
export const CLIENT_HUB_CAPABILITY_NAMES = [
  "context-v1", "live-text-v1", "split-all-v1", "shared-recaps-v1", "recap-profile-v1",
  "archive-feed-v1", "spenders-stats-v1", "awaiting-reply-v1", "audience-new-v1",
  "preview-send-custody-v1", "client-health-perf-v1", "ai-usage-v1",
] as const;
/**
 * Append-only. `client_outdated` (the caller's `x-client-version` is below the
 * owner's minimum, or unreadable) is answered by the server-side check of
 * client routes and AI calls (H-2b/H-3), never by the bootstrap; it is listed
 * from the first vendored SDK on so a client never meets it as unknown.
 */
export const CLIENT_FEATURE_UNAVAILABLE_REASONS = [
  "disabled", "flag_off", "platform_unsupported", "binding_missing", "hub_not_ready", "not_granted",
  "client_outdated",
] as const;
/** The platforms and roles this hub knows today (`pages[].platform`, `identity.role`). */
export const CLIENT_KNOWN_PLATFORMS = platforms;
export const CLIENT_KNOWN_ROLES = userRoles;
/**
 * How much of one conversation's history the hub can vouch for: the `coverage`
 * of the AI `context_v1` frame (routes.ts) and of the client reads built on the
 * same stores. `complete`: a standing proof that the hub holds the chat's whole
 * history up to the proof's head, served by the archive. `partial`: the hub
 * knows its copy has a hole. `unknown`: nothing proves either.
 */
export const CLIENT_COVERAGE_LEVELS = ["complete", "partial", "unknown"] as const;

export type ClientFeatureFlagName = (typeof CLIENT_FEATURE_FLAG_NAMES)[number];
export type ClientHubCapabilityName = (typeof CLIENT_HUB_CAPABILITY_NAMES)[number];
export type ClientFeatureUnavailableReason = (typeof CLIENT_FEATURE_UNAVAILABLE_REASONS)[number];
export type ClientCoverageLevel = (typeof CLIENT_COVERAGE_LEVELS)[number];

// ── bootstrap ────────────────────────────────────────────────────────────────

export const clientFeatureAvailabilitySchema = z.object({
  available: z.boolean(),
  /** Why not; absent when available. A known value is in CLIENT_FEATURE_UNAVAILABLE_REASONS. */
  reason: clientOpenToken.optional(),
});

/** An admitted send-path and receipt profile of the client (X8): adapter version
 *  plus module fingerprints. No code and no selectors. */
export const clientReceiptProfileSchema = z.object({
  id: z.string().min(1).max(64),
  adapterVersion: z.string().min(1).max(64),
  /** Module role → fingerprint. */
  modules: z.record(z.string().min(1).max(64), z.string().min(1).max(128)),
});

export const clientBootstrapPageSchema = z.object({
  pageId: intId,
  pageLabel: z.string(),
  /** The page's display name, else its model's name. */
  title: z.string(),
  /** Open token; known values: CLIENT_KNOWN_PLATFORMS. */
  platform: clientOpenToken,
  /** `pages.external_page_id`, the platform's own account id. Null for a page
   *  that has none (Fansly pages often do not). */
  platformAccountId: z.string().nullable(),
  /** Changes when the page is rebound upstream; the client drops what it bound
   *  under an older value. */
  bindingRevision: count,
  /** Flag name → availability on this page. */
  features: z.record(clientOpenToken, clientFeatureAvailabilitySchema),
});

export const clientBootstrapLimitsSchema = z.object({
  freshTextMaxItems: count,
  /** Per item. */
  freshTextMaxChars: count,
  feedMax: positive,
  deepMax: positive,
  audienceWindowHours: positive,
  claimLeaseSec: positive,
  claimRenewSec: positive,
  claimActivityWindowSec: positive,
  previewSendPerMinute: count,
  navInsertTimeoutSec: positive,
  dispatchTicketSec: positive,
  /** Empty: sending from the preview (X8) is off. */
  previewSendReceiptProfiles: z.array(clientReceiptProfileSchema).max(32),
});

export const clientBootstrapResponseSchema = z.object({
  /** The bootstrap protocol; the client checks it itself (a newer one it does not speak = "update the client"). */
  protocol: positive,
  issuedAt: isoTimestamp,
  /** How long the client may serve this bootstrap from its cache. */
  ttlSec: positive,
  /** Grows with every owner change of a setting the bootstrap reflects. */
  configRevision: count,
  /** The lowest client version the hub serves. */
  minVersion: z.string().min(1).max(32),
  identity: z.object({
    userId: intId,
    username: z.string(),
    /** Open token; known values: CLIENT_KNOWN_ROLES. */
    role: clientOpenToken,
    /** "chat-extension" for a narrow token; null = a full device token. */
    tokenClient: clientOpenToken.nullable(),
  }),
  /** The caller's active pages: every page for the owner, the assigned ones otherwise. */
  pages: z.array(clientBootstrapPageSchema),
  /** Explicit owner binding of a host account ("onlymonster:36408") to a page id. */
  bindingsByHost: z.record(z.string().min(1).max(128), intId),
  /** Emergency switches, flag name → on. */
  flags: z.record(clientOpenToken, z.boolean()),
  limits: clientBootstrapLimitsSchema,
  /** What this hub serves to the client; known values: CLIENT_HUB_CAPABILITY_NAMES. */
  capabilities: z.array(clientOpenToken).max(64),
});

// ── shared recaps (H-13) ─────────────────────────────────────────────────────
//
// The freshest usable full and short recap of one fan on one page, WITH their
// text. A recap is shared: every chatter granted the page reads the same one,
// whoever generated it (chat-extension architecture §19, decision 1; there are
// no private recaps). `aiRecapStatus` (routes.ts) answers the same two slots
// as metadata only.

/** Known values of `coverage.transcriptCoverage`. On the wire an open token. */
export const CLIENT_RECAP_TRANSCRIPT_COVERAGES = ["full-history", "window"] as const;
export type ClientRecapTranscriptCoverage = (typeof CLIENT_RECAP_TRANSCRIPT_COVERAGES)[number];

export const clientConversationRecapsQuerySchema = z.object({
  /** The persona's opaque catalog identity (`aiPersonaCatalog.definitionId`).
   *  With it, only that persona's recaps are selected; without it, the freshest
   *  of any persona, as `aiRecapStatus` does. */
  personaDefinitionId: z.string().min(16).max(100).optional(),
}).strict();

export const clientRecapBodySchema = z.object({
  /** The generation's `meta.requestId`: the identity of this shared recap. */
  generationRef: z.string().min(1).max(100),
  generatedAt: isoTimestamp,
  /** The persona the recap was written for; null on a row that predates the field. */
  personaDefinitionId: z.string().nullable(),
  /** What the generation read. Null where the generation did not record it. */
  coverage: z.object({
    /** Open token; known values: CLIENT_RECAP_TRANSCRIPT_COVERAGES. */
    transcriptCoverage: clientOpenToken.nullable(),
    /** The window the request resolved to. */
    requestedCount: z.number().int().nullable(),
    /** The messages the generation actually read. */
    keptCount: z.number().int().nullable(),
  }),
  text: z.string(),
});

export const clientConversationRecapsResponseSchema = z.object({
  full: clientRecapBodySchema.nullable(),
  short: clientRecapBodySchema.nullable(),
  /** The fan's latest dossier on this page has exactly the full recap's text. */
  fullSavedToProfile: z.boolean(),
});

// ── dossier from a generation (H-5) ──────────────────────────────────────────
//
// Saves a finished full recap as the fan's dossier on the page. The client
// names the generation (`generationRef`, the `meta.requestId` of its own
// `fan-summary` request) and the hub copies the text from the record it stored:
// the text never travels back through the client, so the dossier is exactly
// what the model wrote.

/**
 * The client's own request id as it travels: 8-4-4-4-12 hex, any case and any
 * version nibble. Wider than `z.string().uuid()` on purpose: the chat extension
 * froze this form for the ids it mints, and the value is only compared with the
 * request id of an AI request the caller already made. Spelled without a flag,
 * so the OpenAPI document states the same pattern.
 */
export const CLIENT_REQUEST_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Known `reason` values of 409 `generation_not_eligible`: why a stored
 * generation of the caller will never become the dossier. On the wire an open
 * token; append-only.
 * - `not_full_summary`: not a `fan-summary`, or not its full mode;
 * - `not_completed`: the generation failed or was cancelled;
 * - `stop_reason_missing`: it recorded no stop reason, so nothing proves it ended;
 * - `output_exhausted`: its output ran into the limit (`max_tokens`, `length`);
 * - `empty`: it has no text;
 * - `context_scope`: its context held something only its caller saw;
 * - `too_long`: its text is longer than a dossier may be;
 * - `superseded`: the fan's dossier already holds a text that is not older.
 *   The one reason that says nothing against the generation: a client may show
 *   it as information rather than as a failed save.
 */
export const CLIENT_GENERATION_NOT_ELIGIBLE_REASONS = [
  "not_full_summary", "not_completed", "stop_reason_missing", "output_exhausted", "empty",
  "context_scope", "too_long", "superseded",
] as const;
export type ClientGenerationNotEligibleReason = (typeof CLIENT_GENERATION_NOT_ELIGIBLE_REASONS)[number];

export const clientFanProfileFromGenerationBodySchema = z.object({
  /** The generation's `meta.requestId`. */
  generationRef: z.string().min(1).max(100),
  /** The `clientRequestId` of the AI request that made the generation. With it
   *  the hub tells a generation whose record has not appeared yet (409
   *  `generation_not_ready`) from one it does not know (404). */
  clientRequestId: z.string().regex(CLIENT_REQUEST_ID_PATTERN).optional(),
}).strict();

export const clientFanProfileFromGenerationResponseSchema = z.object({
  /** `created`: a new dossier version was written. `existing`: a version of
   *  the fan's dossier on this page already has exactly this text. */
  outcome: z.enum(["created", "existing"]),
  /** The dossier version that holds the generation's text. */
  profile: z.object({
    version: positive,
    createdAt: isoTimestamp,
    /** When the text was generated; null on a version an older client wrote without it. */
    sourceGeneratedAt: isoTimestamp.nullable(),
  }),
});

export const clientRouteSchemas = {
  clientBootstrap: {
    auth: { kind: "apiKey" },
    tags: ["client"],
    summary: "Chat-extension bootstrap: who the caller is, their pages, switches, limits and the hub's capabilities",
    description: "Read-only and database-only: no platform request, no queued work. Answers 200 while every "
      + "feature is off; a feature the owner has not switched on reads `available: false` with a reason. "
      + "Flags, features, capabilities, reasons, platforms and roles are open strings: a client treats an "
      + "unknown one as off.",
    response: {
      200: clientBootstrapResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  clientConversationRecaps: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The shared full and short recap of one fan on one page, with their text",
    description: "Read-only and database-only: no platform request, no generation, no AI spend. Answers the "
      + "freshest usable full and short `fan-summary` recap of the fan (`fanRef` is the OnlyFans fan id, "
      + "which is the chat id), the same two rows `aiRecapStatus` describes, to every chatter granted the "
      + "page, whoever generated them. A recap generated from context only its caller saw is never "
      + "selected. `personaDefinitionId` narrows both slots to one persona. `fullSavedToProfile` tells "
      + "whether the fan's latest dossier on this page has exactly the full recap's text. Behind the "
      + "chat-extension `recap` switch: 409 `client_feature_disabled` with the reason.",
    params: clientPageFanParamsSchema,
    querystring: clientConversationRecapsQuerySchema,
    response: {
      200: clientConversationRecapsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanProfileFromGeneration: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Save a finished full recap as the fan's dossier, from the generation the hub stored",
    description: "Database-only: no platform request, no generation, no AI spend. The caller names one of its "
      + "own generations by `generationRef` (the `meta.requestId` of the AI request) and the hub writes "
      + "that generation's text as a new dossier version of the fan on the page (`fanRef` is the OnlyFans "
      + "fan id, which is the chat id). Only a generation of the same user, page and fan is found (404 "
      + "otherwise), and only a usable full `fan-summary` is saved: 409 `generation_not_eligible` with a "
      + "`reason` for any other. Idempotent: when a version of the fan's dossier already has exactly this "
      + "text, the answer is `existing` and nothing is written. The generation's record appears shortly "
      + "after the stream's `done` frame; until then, a request that names its `clientRequestId` is "
      + "answered 409 `generation_not_ready` and may be repeated. That answer can stay for good when the "
      + "record was never written, so a client bounds its repeats. Behind the chat-extension `recap` "
      + "switch: 409 `client_feature_disabled` with the reason.",
    params: clientPageFanParamsSchema,
    body: clientFanProfileFromGenerationBodySchema,
    response: {
      200: clientFanProfileFromGenerationResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
} as const;

export type ClientFeatureAvailability = z.infer<typeof clientFeatureAvailabilitySchema>;
export type ClientReceiptProfile = z.infer<typeof clientReceiptProfileSchema>;
export type ClientBootstrapPage = z.infer<typeof clientBootstrapPageSchema>;
export type ClientBootstrapLimits = z.infer<typeof clientBootstrapLimitsSchema>;
export type ClientBootstrapResponse = z.infer<typeof clientBootstrapResponseSchema>;
export type ClientConversationRecapsQuery = z.infer<typeof clientConversationRecapsQuerySchema>;
export type ClientRecapBody = z.infer<typeof clientRecapBodySchema>;
export type ClientConversationRecapsResponse = z.infer<typeof clientConversationRecapsResponseSchema>;
export type ClientFanProfileFromGenerationBody = z.infer<typeof clientFanProfileFromGenerationBodySchema>;
export type ClientFanProfileFromGenerationResponse = z.infer<typeof clientFanProfileFromGenerationResponseSchema>;

// ── client_health v1 (H-11a) ─────────────────────────────────────────────────
//
// The chat extension's health report: its version, the host build fingerprint,
// the host-contract verdict, what is switched off, counters by code, perf
// histograms and an estimate of its own storage. No text from a chat and no fan,
// chat, message or operation id.
//
// THE CLIENT'S SHAPE. The chat extension froze this report in its contracts
// v1.0.0 (`ClientHealthV1Schema` in its packages/contracts/src/telemetry.ts; its
// `kind` rides the ingest envelope, the rest is this body). The metric names and
// bounds, the field names and every limit below are the client's, and every
// report the client's schema accepts parses here: a report the hub refused would
// be lost with its P1 counters. The hub adds only checks such a report always
// meets: counts = bounds + 1 and count = Σcounts (the client's own), strictly
// increasing bounds (the client pins every histogram to this registry), an empty
// histogram with sum 0 and max 0, one histogram per metric.
//
// Codes, not free text: host anchors, switched-off features, counter keys, the
// host kind and metric names match CLIENT_HEALTH_CODE_PATTERN, ASCII without
// spaces, so a sentence, a fan's name with a space or a URL does not fit in one.
// Two fields are the client's bounded strings, not codes: the client version
// (its manifest version) and the host build (the hashed name of the host's entry
// module). And a code may name an inherited object property (`constructor`); a
// record drops an own `__proto__` key without a word, as on the client. The
// intake (H-11b) keys its user-free hourly rollups, kept forever, on these
// strings (client version, host kind and build, metric, anchor, counter code),
// so it files a version or build that is not a code under one placeholder, and
// merges codes into a Map, never into a plain object.
//
// No route carries it and nothing on the hub reads it yet, so the contract hash
// does not move: this is the shape the client and the hub agree on. The client
// sends a report as one `ingestObservations` event of kind
// CLIENT_HEALTH_INGEST_KIND, in a batch of its own, and ONLY once the bootstrap
// lists `client-health-perf-v1`; until then it keeps its reports to itself. A
// hub without that capability journals an unknown kind in `observations`
// (`desktop.unknown:<kind>`) with the user, forever and on into the lake, which
// is exactly what this report must never become. The intake behind the
// capability (H-11b) checks a report against this schema and the bounds
// registry, folds it into hourly rollups keyed without the user, and never
// journals it.
//
// A client→hub shape, so strict (§4.0): an unknown key is a malformed report,
// and a new field is a new report version. Growing names (metric, host kind)
// stay open, as codes: one the hub does not know it drops, and the rest of the
// report still counts. The checks below are cheap and local (no clock, no
// registry). The intake checks a known metric's bounds against the registry,
// drops a histogram whose max or sum its buckets cannot hold (the runtime's
// `clientHealthHistogramFits`), and files a report under the hour it received
// it, not the client's window.

/** The `ingestObservations` event kind of a health report. */
export const CLIENT_HEALTH_INGEST_KIND = "client_health";

/**
 * A code, never free text (the client's HEALTH_CODE_PATTERN): error and P1
 * codes, contract anchors, switched-off features, metric names, the host kind.
 */
export const CLIENT_HEALTH_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

const healthCode = z.string().regex(CLIENT_HEALTH_CODE_PATTERN);
/** A growing name (metric, host kind): a code within the open-token length. */
const healthName = healthCode.max(64);

/** One counter in one report (the client's cap). */
const healthCounterValue = z.number().int().min(0).max(1_000_000);

/**
 * An instant on the client's clock: ISO 8601 with `Z` or a `±HH:MM` offset,
 * checked by pattern only, as on the client (its IsoTimestampSchema).
 */
const CLIENT_HEALTH_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const healthInstant = z.string().max(40).regex(CLIENT_HEALTH_INSTANT_PATTERN);

/**
 * The perf metrics and the fixed upper bounds (ms) of their buckets, as the
 * client froze them (`PERF_METRICS`, contracts v1.0.0): the client builds every
 * histogram from these, and the hub checks a histogram against them before it
 * merges one.
 *
 * Buckets: a histogram with n bounds has n + 1 counts. counts[0] holds values
 * ≤ bounds[0]; counts[i] values in (bounds[i-1], bounds[i]]; counts[n] values
 * above bounds[n-1] (that bucket tops out at the histogram's `max`).
 *
 * The bounds and meaning of one (metric, schemaVersion) never change: new
 * bounds or a new meaning are a new schemaVersion, and the registry is
 * append-only.
 */
export const CLIENT_HEALTH_PERF_METRICS = {
  /** Route change → dock updated. */
  routeToDockMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000] },
  /** Hotkey or click → visible response. */
  panelOpenMs: { unit: "ms", schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500] },
  /** Click → request sent: the client's own overhead. */
  requestOverheadMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250, 500] },
  /** Click → first chunk, end to end (provider latency included). */
  ttfcMs: {
    unit: "ms", schemaVersion: 1,
    bounds: [250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 20000, 30000, 60000],
  },
  /** First chunk → painted. */
  firstChunkPaintMs: { unit: "ms", schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500] },
  /** Guarded insert with verification. */
  insertMs: { unit: "ms", schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000] },
  /** Board open from cache. */
  boardOpenMs: { unit: "ms", schemaVersion: 1, bounds: [8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500] },
  /** Search over up to 1000 rows. */
  searchMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250, 500] },
  /** The client's synchronous handlers, sampled 1 in 20. */
  handlerMs: { unit: "ms", schemaVersion: 1, bounds: [0.1, 0.5, 1, 2, 4, 8, 16, 50, 100] },
  /** Event Timing of the client's hotkeys and clicks → next paint. */
  eventLatencyMs: { unit: "ms", schemaVersion: 1, bounds: [8, 16, 24, 32, 50, 75, 100, 150, 250, 500, 1000] },
  /** Input delay in the host's composer with the extension on. */
  composerInputDelayMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250] },
} as const satisfies Record<string, { unit: "ms"; schemaVersion: number; bounds: readonly number[] }>;

export type ClientHealthPerfMetricName = keyof typeof CLIENT_HEALTH_PERF_METRICS;

/**
 * One perf metric over the report window. Percentiles are the hub's job: it
 * computes them from buckets merged across reports, never from the client's.
 */
export const clientHealthPerfHistogramSchema = z.object({
  /** Open name; known values: the keys of CLIENT_HEALTH_PERF_METRICS. */
  metric: healthName,
  unit: z.literal("ms"),
  schemaVersion: positive,
  bounds: z.array(z.number().nonnegative()).min(1).max(32),
  counts: z.array(count).min(2).max(33),
  count,
  sum: z.number().nonnegative(),
  max: z.number().nonnegative(),
}).strict().superRefine((histogram, ctx) => {
  const { bounds, counts, count: total, sum, max } = histogram;
  if (counts.length !== bounds.length + 1) {
    ctx.addIssue({ code: "custom", path: ["counts"], message: "counts must have one more entry than bounds" });
    return;
  }
  if (counts.reduce((acc, bucket) => acc + bucket, 0) !== total) {
    ctx.addIssue({ code: "custom", path: ["count"], message: "count must equal the sum of counts" });
  }
  for (let index = 1; index < bounds.length; index += 1) {
    if (!(bounds[index]! > bounds[index - 1]!)) {
      ctx.addIssue({ code: "custom", path: ["bounds", index], message: "bounds must strictly increase" });
    }
  }
  if (total === 0 && (sum !== 0 || max !== 0)) {
    ctx.addIssue({ code: "custom", path: ["sum"], message: "an empty histogram has sum 0 and max 0" });
  }
});

export const clientHealthReportV1Schema = z.object({
  v: z.literal(1),
  /** The aggregation window on the client's clock (15 minutes today); neither ordered nor capped, as on the client. */
  window: z.object({ from: healthInstant, to: healthInstant }).strict(),
  client: z.object({
    name: z.literal("chat-extension"),
    /** The add-on's version: the client's bounded string, not a code. */
    version: z.string().min(1).max(32),
    browser: z.literal("firefox"),
    browserMajor: positive,
    os: z.enum(["windows", "macos", "linux", "other"]),
  }).strict(),
  host: z.object({
    /** Open name: the host page the client works over (`chatspace` today). */
    kind: healthName,
    /**
     * The host's build fingerprint (the hashed name of its entry module, such as
     * `index-DEVowLko`); null when it could not be read. The client's bounded
     * string, not a code.
     */
    build: z.string().max(80).nullable(),
    /** Whether every anchor of the host contract was found. */
    contractOk: z.boolean(),
    /** Anchors of the host contract that were not found. */
    missing: z.array(healthCode).max(64),
  }).strict(),
  /** Features switched off by the owner's flags or by a broken host contract. */
  disabled: z.array(healthCode).max(64),
  /** At most one histogram per metric: a metric twice in one report would count twice. */
  perf: z.array(clientHealthPerfHistogramSchema).max(16)
    .superRefine((perf, ctx) => {
      const seen = new Set<string>();
      perf.forEach((histogram, index) => {
        if (seen.has(histogram.metric)) {
          ctx.addIssue({ code: "custom", path: [index, "metric"], message: "one histogram per metric" });
        }
        seen.add(histogram.metric);
      });
    }),
  /** Code → occurrences in the window: errors by code, prevented inserts, P1s. */
  counters: z.record(healthCode, healthCounterValue)
    .refine((counters) => Object.keys(counters).length <= 200, { message: "at most 200 counters" }),
  /** The client's own caches and logs, not the heap (Firefox has no portable heap reading). */
  footprint: z.object({ kind: z.literal("owned-estimate"), cachesKB: count, logsKB: count }).strict(),
}).strict();

export type ClientHealthPerfHistogram = z.infer<typeof clientHealthPerfHistogramSchema>;
export type ClientHealthReportV1 = z.infer<typeof clientHealthReportV1Schema>;
