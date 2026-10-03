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

export type ClientFeatureFlagName = (typeof CLIENT_FEATURE_FLAG_NAMES)[number];
export type ClientHubCapabilityName = (typeof CLIENT_HUB_CAPABILITY_NAMES)[number];
export type ClientFeatureUnavailableReason = (typeof CLIENT_FEATURE_UNAVAILABLE_REASONS)[number];

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
} as const;

export type ClientFeatureAvailability = z.infer<typeof clientFeatureAvailabilitySchema>;
export type ClientReceiptProfile = z.infer<typeof clientReceiptProfileSchema>;
export type ClientBootstrapPage = z.infer<typeof clientBootstrapPageSchema>;
export type ClientBootstrapLimits = z.infer<typeof clientBootstrapLimitsSchema>;
export type ClientBootstrapResponse = z.infer<typeof clientBootstrapResponseSchema>;

// ── client_health v1 (H-11a) ─────────────────────────────────────────────────
//
// The chat extension's health report: its version, the host build fingerprint,
// the host-contract verdict, what is switched off, counters by code, perf
// histograms and an estimate of its own storage. No text and no fan, chat,
// message or operation id: every name in it is a code (CLIENT_HEALTH_CODE_PATTERN).
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
// and a new field is a new report version. Growing names (metric, host kind,
// codes) stay open strings; one the hub does not know it drops, and the rest of
// the report still counts.

/** The `ingestObservations` event kind of a health report. */
export const CLIENT_HEALTH_INGEST_KIND = "client_health";

/** A code, never free text: error and P1 codes, contract anchors, switched-off features. */
export const CLIENT_HEALTH_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const healthCode = z.string().regex(CLIENT_HEALTH_CODE_PATTERN);

/**
 * The perf metrics and the fixed upper bounds (ms) of their buckets: the client
 * builds every histogram from these, and the hub checks a histogram against
 * them before it merges one.
 *
 * Buckets: a histogram with n bounds has n + 1 counts. counts[0] holds values
 * ≤ bounds[0]; counts[i] values in (bounds[i-1], bounds[i]]; counts[n] values
 * above bounds[n-1] (that bucket tops out at the histogram's `max`).
 *
 * The bounds of one (metric, schemaVersion) never change: new bounds are a new
 * schemaVersion. Names and bounds are a proposal until the client's R01 freezes
 * them; from then on the registry is append-only.
 */
export const CLIENT_HEALTH_PERF_METRICS = {
  routeToDockMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000] },
  panelOpenMs: { unit: "ms", schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500] },
  requestOverheadMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250, 500] },
  firstChunkPaintMs: { unit: "ms", schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500] },
  insertMs: { unit: "ms", schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000] },
  boardOpenMs: { unit: "ms", schemaVersion: 1, bounds: [8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500] },
  handlerMs: { unit: "ms", schemaVersion: 1, bounds: [0.1, 0.5, 1, 2, 4, 8, 16, 50, 100] },
  composerInputDelayMs: { unit: "ms", schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250] },
} as const satisfies Record<string, { unit: "ms"; schemaVersion: number; bounds: readonly number[] }>;

export type ClientHealthPerfMetricName = keyof typeof CLIENT_HEALTH_PERF_METRICS;

/** One perf metric over the report window. Percentiles are the hub's job: it
 *  computes them from buckets merged across reports, never from the client's. */
export const clientHealthPerfHistogramSchema = z.object({
  /** Open token; known values: the keys of CLIENT_HEALTH_PERF_METRICS. */
  metric: clientOpenToken,
  unit: z.literal("ms"),
  schemaVersion: positive,
  bounds: z.array(z.number().nonnegative()).min(1).max(32),
  counts: z.array(count).min(2).max(33),
  count,
  sum: z.number().nonnegative(),
  max: z.number().nonnegative(),
}).strict().superRefine((histogram, ctx) => {
  if (histogram.counts.length !== histogram.bounds.length + 1) {
    ctx.addIssue({ code: "custom", path: ["counts"], message: "counts must have one more entry than bounds" });
  }
  if (histogram.counts.reduce((total, bucket) => total + bucket, 0) !== histogram.count) {
    ctx.addIssue({ code: "custom", path: ["count"], message: "count must equal the sum of counts" });
  }
  for (let index = 1; index < histogram.bounds.length; index += 1) {
    if (!(histogram.bounds[index]! > histogram.bounds[index - 1]!)) {
      ctx.addIssue({ code: "custom", path: ["bounds", index], message: "bounds must strictly increase" });
    }
  }
});

/**
 * A real instant with an explicit offset. The house `isoTimestamp` is a bare
 * string; a report admits no free text, the window included.
 */
const healthInstant = z.iso.datetime({ offset: true });

export const clientHealthReportV1Schema = z.object({
  v: z.literal(1),
  /** The aggregation window on the client's clock. */
  window: z.object({ from: healthInstant, to: healthInstant }).strict()
    .refine((window) => Date.parse(window.from) <= Date.parse(window.to), {
      path: ["to"],
      message: "window.to must not precede window.from",
    }),
  client: z.object({
    name: z.literal("chat-extension"),
    version: z.string().min(1).max(32),
    browser: z.literal("firefox"),
    browserMajor: positive,
    os: z.enum(["windows", "macos", "linux", "other"]),
  }).strict(),
  host: z.object({
    /** Open token: the host page the client works over (`chatspace` today). */
    kind: clientOpenToken,
    /** The host's build fingerprint; null when it could not be read. */
    build: z.string().max(80).nullable(),
    /** Whether every anchor of the host contract was found. */
    contractOk: z.boolean(),
    /** Anchors of the host contract that were not found. */
    missing: z.array(healthCode).max(64),
  }).strict(),
  /** Features switched off by the owner's flags or by a broken host contract. */
  disabled: z.array(healthCode).max(64),
  perf: z.array(clientHealthPerfHistogramSchema).max(16),
  /** Code → occurrences in the window: errors by code, prevented inserts, P1s. */
  counters: z.record(healthCode, z.number().int().min(0).max(1_000_000))
    .refine((counters) => Object.keys(counters).length <= 200, { message: "at most 200 counters" }),
  /** The client's own caches and logs, not the heap (Firefox has no portable heap reading). */
  footprint: z.object({ kind: z.literal("owned-estimate"), cachesKB: count, logsKB: count }).strict(),
}).strict();

export type ClientHealthPerfHistogram = z.infer<typeof clientHealthPerfHistogramSchema>;
export type ClientHealthReportV1 = z.infer<typeof clientHealthReportV1Schema>;
