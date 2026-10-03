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
export const CLIENT_FEATURE_UNAVAILABLE_REASONS = [
  "disabled", "flag_off", "platform_unsupported", "binding_missing", "hub_not_ready", "not_granted",
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
