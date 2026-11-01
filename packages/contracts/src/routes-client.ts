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

import {
  MOSCOW_TIME_ZONE, diffBusinessDays, isValidBusinessDateString, nextBusinessDate, platforms, userRoles,
} from "@agency_hub_core/shared";
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

/** Open token: the wire form of every growing vocabulary (reason, flag, capability, platform, role…). */
export const clientOpenToken = z.string().min(1).max(64);

/**
 * The ONE shape of a platform numeric id a client sends: an OnlyFans fan id
 * (== chat id) or message id, a Fansly account or group id. No leading zero, at
 * most 30 digits. Every client field that carries such an id (fanRef,
 * conversationRef, the feed, fresh text, known message ids) uses this schema,
 * so the hub never holds two spellings of one id.
 */
export const CLIENT_NUMERIC_ID_PATTERN = /^[1-9]\d{0,29}$/;
export const clientNumericIdSchema = z.string().regex(CLIENT_NUMERIC_ID_PATTERN);
/**
 * The order of two such ids where the platform's ids are snowflakes (Fansly:
 * a message id grows with the moment it was sent): negative when `a` is the
 * older. The shorter id is the older, then the string order. Never by number:
 * a double merges neighbours past 2^53.
 */
export function compareClientNumericIds(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
/** The platform's fan id: on OnlyFans the fan id (== chat_id), on Fansly the fan's account id. */
export const clientFanRefSchema = clientNumericIdSchema;
/**
 * R20 HF-10: the chat that a read by conversation names apart from its fan
 * (`conversation-recaps-v1`): on Fansly the group id; on OnlyFans the chat id
 * IS the fan id, so it equals `fanRef` or is left out. See "reads by
 * conversation" below.
 */
export const clientConversationRefSchema = clientNumericIdSchema;

const pageLabelSchema = z.string().min(1).max(120);
export const clientPageParamsSchema = z.object({ pageLabel: pageLabelSchema });
export const clientPageFanParamsSchema = z.object({ pageLabel: pageLabelSchema, fanRef: clientFanRefSchema });
export const clientCursorSchema = z.string().min(1).max(2048);
/**
 * The `reason` beside 400 `bad_request` on a client read that takes a cursor:
 * the cursor is not one this hub issued for this request (forged or cut,
 * issued for something else than the read binds its cursors to, or past the
 * read's lifetime). The answer never says which. Not retried as is: the client
 * reads the first page again. What each read binds a cursor to, and for how
 * long:
 * - the awaiting-reply queue (`clientSpenderAwaitingReply`): the page and the
 *   person; a cursor is good for an hour after the page that carried it.
 * - the archive feed (`clientConversationFeed`): the page, the fan, the person,
 *   the reader and the archive generation; a walk ends a day after its first
 *   page.
 */
export const CLIENT_CURSOR_REFUSAL_REASONS = ["cursor_invalid"] as const;
export type ClientCursorRefusalReason = (typeof CLIENT_CURSOR_REFUSAL_REASONS)[number];

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();

/**
 * Known names: documentation and the client's narrowing. On the wire they are open strings.
 *
 * Where each flag exists is the hub's (chat-extension R20 HF-2): a page of a
 * platform without the flag reads `platform_unsupported`. `drafts`, `vault`
 * and `registration` exist on Fansly only: the narrow token's Reply, Fix, Hi
 * and Ping on a Fansly page (R20 HF-12), and the extension's own vault and
 * «Регистрация». On OnlyFans those generations need no flag of their own.
 * `voice` (the voice script and the voice-note routes, `voice-notes-v1`,
 * HF-4б), `notes` and `notesFill` (the fan's notes and their fill; on
 * OnlyFans since 2026-10-28) exist on both. `previewSend`,
 * `previewSendMarkAiGenerated`, `navigation`, `wsTap`, `stats`,
 * `onlineProbe` (the page's one bounded probe of who is online,
 * `clientOnlineProbe`), `ofFeed` (the OnlyFans feed from ChatSpace,
 * `clientOnlyfansFeed`) and `ofPoll` (its light reads of ChatSpace,
 * `clientOnlyfansPoll`) exist on OnlyFans only; every other flag on both. A
 * Fansly page is switched on by its own row of the owner's switches alone,
 * never by the `"*"` row, so the top-level `flags` (the `"*"` row) say nothing
 * about a Fansly page.
 */
export const CLIENT_FEATURE_FLAG_NAMES = [
  "insertion", "freshText", "newcomers", "spenders", "stats", "preview", "previewSend",
  "previewSendMarkAiGenerated", "fanPanel", "navigation", "wsTap", "sound",
  "coach", "recap", "review", "splitAll",
  "drafts", "voice", "notesFill", "notes", "vault", "registration", "onlineProbe",
  // The extension on ChatSpace passes on to the hub what the page already
  // receives (`clientOnlyfansFeed`, onlyfans-feed-v1): the owner's off switch.
  "ofFeed",
  // The page's light reads of ChatSpace for the feed (`clientOnlyfansPoll`,
  // onlyfans-poll-v1): the new subscribers and the sales ledger, ChatSpace's own
  // requests at its own pace, lent to one tab of the team: the owner's off switch.
  "ofPoll",
] as const;
export const CLIENT_HUB_CAPABILITY_NAMES = [
  "context-v1", "live-text-v1", "split-all-v1", "shared-recaps-v1", "recap-profile-v1",
  "archive-feed-v1", "spenders-stats-v1", "awaiting-reply-v1", "audience-new-v1",
  "preview-send-custody-v1", "client-health-perf-v1", "ai-usage-v1", "manual-greeting-v1",
  "coverage-check-v1", "conversation-recaps-v1", "hi-start-proof-v1", "voice-notes-v1",
  "send-attribution-v1",
  // Who wrote each fan note: the extension reports its confirmed note writes
  // (Fansly notes; on OnlyFans, OnlyMonster's fan notes).
  "note-attribution-v1",
  // Who created each note of a fan and who edited it last, read back
  // (`clientFanNoteAttributions`).
  "note-attribution-read-v1",
  // chat-extension X54: the AI feature stream takes `livePpvContext`.
  "live-ppv-v1",
  "live-text-review-coach-v1",
  "live-text-recap-v1",
  "live-text-fansly-tools-v1",
  // The AI feature stream takes `livePpvContext` on a Fansly page too: one item
  // per paid attachment of the open chat, read from Fansly at the click.
  "live-ppv-fansly-v1",
  // The AI feature stream takes `liveImages`, the fan's newest photos of the
  // open chat as bytes; listed while the owner's `aiLiveImagesEnabled` is on.
  "live-images-v1",
  // The AI feature stream takes `draftMedia`, the media the chatter attached to
  // the message being written (its pictures as bytes); listed while the
  // owner's `aiDraftMediaEnabled` is on.
  "draft-media-v1",
  // The AI feature stream takes `recap: "off"`: this generation reads no Recap.
  "recap-off-v1",
  // Fix takes `draftPurpose: "outreach"`: a mass message rewritten for one fan.
  "outreach-fix-v1",
  // Chat Memory: the extension's beat (`clientActivity`) and «в разговоре» (`clientInConversation`).
  "chatter-activity-v1",
  "in-conversation-v1",
  // Chat Memory week 2: the fan's card across pages and the «same person» decision.
  "fan-card-v1",
  // Chat Memory week 3: the win-back list and the approach pick.
  "win-back-v1",
  // Chat Memory week 3: the shift handoff of a page.
  "handoff-v1",
  // Chat Memory week 4: customs in the fan's card.
  "fan-customs-v1",
  // «Онлайн»: the page's fans seen online, why to write now; Fansly presence reports; the window's rows.
  "online-v1",
  // Hi on Fansly takes `fanAccount`, the fan's Fansly account as the page loaded it.
  "hi-fan-account-v1",
  // Coach reads as deep as the chatter chooses and says when older history matters; the feed dates the depths.
  "coach-depth-v1",
  // Fan marks: «бомж» lists of the agency's Fansly pages and FANSLY BLOCKLIST posts about the fan.
  "fan-marks-v1",
  // Telegram as the extension's third site: pages of platform `telegram`, whose
  // Reply, Fix and Coach take the open chat in `clientContext`.
  "telegram-ai-v1",
  // Fan queues: the caller's queues of a page, a portion of up to 10 fans, each fan's outcome.
  "fan-queues-v1",
  // Reply, Fix, Hi and Ping on OnlyFans take `fanCustomName`, the chatter's own name for the fan in ChatSpace.
  "fan-custom-name-v1",
  // The caller's personal daily AI limit: `clientAiLimit`, `quota.personal` in the meta frame, the 429 reason.
  "ai-limit-v1",
  // The OnlyFans feed from ChatSpace: `clientOnlyfansFeed` takes what the page already received.
  "onlyfans-feed-v1",
  // The page's poll for the feed: `clientOnlyfansPoll` lends it to one tab at a time; the feed takes `subscriber`.
  "onlyfans-poll-v1",
  // The always-on ChatSpace tab's report: `clientChatspaceTabState`, once a minute from the server's tab.
  "chatspace-tab-state-v1",
  // The report takes `socket` (the socket's own state) and each account's `subscribed`.
  "chatspace-tab-state-v2",
  // «Рассылки» kept by Hub, shared by the page's team: the list, one outreach, its save, each fan's claimed send, touches.
  "outreach-store-v1",
] as const;
/**
 * Append-only. `client_outdated` (the caller's `x-client-version` is below the
 * owner's minimum, or unreadable) is answered by the server-side check of
 * client routes and AI calls (H-2b/H-3), never by the bootstrap; it is listed
 * from the first vendored SDK on so a client never meets it as unknown.
 *
 * `lane_off` (R20 HF-4б) is the other way round: the bootstrap's alone. The
 * feature runs on a lane of the hub with switches of its own, and that lane
 * does not serve the page right now (for `voice`, the voice-notes lane: its
 * live switch, its synthesis provider, its page allowlist and the page's voice
 * profile). A call is answered by the lane's own admission and its own codes
 * (`voice_disabled`, `voice_not_allowlisted`, ...), never by this reason.
 */
export const CLIENT_FEATURE_UNAVAILABLE_REASONS = [
  "disabled", "flag_off", "platform_unsupported", "binding_missing", "hub_not_ready", "not_granted",
  "client_outdated", "lane_off",
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
  /** The persona the page is meant to be worked with (an `ai_personas` key):
   *  the extension assigns it to a page the person has not assigned one to,
   *  and warns when someone picks another. Absent: none is meant. */
  defaultPersonaKey: z.string().min(1).max(200).optional(),
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
  /**
   * Sends from the preview per person per minute: on OnlyFans every dispatch,
   * a greeting or a reply, counts toward it.
   */
  previewSendPerMinute: count,
  /**
   * Greetings per person per minute where a greeting has a rate of its own
   * (`manual-greeting-v1`: Fansly's «Новые», which sends a greeting and nothing
   * else). Counted apart from `previewSendPerMinute`, per platform. Absent
   * from a hub without `manual-greeting-v1`.
   */
  greetingSendPerMinute: count.optional(),
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
  /** Explicit owner binding of a host account ("onlymonster:10001") to a page id. */
  bindingsByHost: z.record(z.string().min(1).max(128), intId),
  /** Emergency switches, flag name → on. */
  flags: z.record(clientOpenToken, z.boolean()),
  limits: clientBootstrapLimitsSchema,
  /** What this hub serves to the client; known values: CLIENT_HUB_CAPABILITY_NAMES. */
  capabilities: z.array(clientOpenToken).max(64),
});

// ── reads by conversation (R20 HF-10) ────────────────────────────────────────
//
// The shared recaps read, the dossier save from a generation and the archive
// feed are about one conversation of one fan; the fan is in the path. On
// OnlyFans the chat id IS the fan id, so the fan names the conversation. On
// Fansly a chat is a group with an id of its own, and the request names it as
// `conversationRef`. A client sends the field only to a hub that lists
// `conversation-recaps-v1`: the query strings and bodies are strict, so an
// older hub answers an unknown key 400.
//
// Before anything is read the hub checks the pair, as the AI lane does
// (chat-extension R20 HF-9):
// - on a page whose chats are their fans (OnlyFans), `conversationRef` equal
//   to the fan, or left out, changes nothing; any other is 409
//   `conversation_fan_mismatch`;
// - on a page whose chats have ids of their own (Fansly), it is required (400
//   `bad_request` without it), and the page's thread of the group decides:
//   another fan's thread is 409 `conversation_fan_mismatch`; this fan's
//   thread, no thread yet (a chat the hub has not captured) or a thread whose
//   fan the hub does not know is served.
// A read by conversation never returns what is stored about another fan.

// ── shared recaps (H-13) ─────────────────────────────────────────────────────
//
// The freshest usable full and short recap of one fan on one page, WITH their
// text. A recap is shared: every chatter granted the page reads the same one,
// whoever generated it (chat-extension architecture §19; there are
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
  /**
   * R20 HF-10 (`conversation-recaps-v1`): the conversation, apart from the fan
   * in the path ("reads by conversation"). With a conversation of its own, the
   * recaps are those of that conversation stored about this fan (`fanRef`),
   * and those stored in the fan's own form: keyed by the fan, naming no other
   * fan. A recap of the conversation that names no fan is not selected.
   */
  conversationRef: clientConversationRefSchema.optional(),
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
  /**
   * R20 HF-10 (`conversation-recaps-v1`): the conversation the generation was
   * made in, apart from the fan in the path ("reads by conversation"). With a
   * conversation of its own, a generation of that conversation that names this
   * fan (`fanRef`) is found too; one that names no fan is found only when it
   * is keyed by the fan, as without the field.
   */
  conversationRef: clientConversationRefSchema.optional(),
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

// ── archive feed (H-9c) ──────────────────────────────────────────────────────
//
// One conversation as the hub's own message stores hold it: newest first, a
// page at a time, with a Ping summary on the first page. Database only: no
// platform request, no refresh and no queued work, so reading the feed never
// marks the chat read on OnlyFans.
//
// THE READER is the one a generation uses: the archive ∪ webhook-store union
// on OnlyFans, the archive on Fansly, and `source` says which one served. A
// message deleted on the platform stays in the feed as a row with
// `deleted: true` and an empty `text` (a generation drops it): the row says a
// message was there and is gone, never what it said.
//
// ONE WALK, ONE SNAPSHOT. A request without a cursor starts a walk and freezes
// it: `snapshotRevision`, `asOf`, `coverage`, `head` and `newestKnownAt` are
// read once and every later page of the walk repeats them. A message that
// arrives during the walk is not in it; the next walk from the first page has
// it. `nextOlderCursor` is opaque (its state is sealed: its holder reads
// nothing from it) and signed, and it is valid only for the same page, fan and
// person, on the same reader, until the archive is rebuilt, and for a day after
// the walk's FIRST page (taking a page does not renew a walk): any other use is
// 400 `bad_request` with the reason `cursor_invalid`, and the client reads the
// first page again.

/** The most rows one page carries; the bootstrap announces it as `limits.feedMax`. */
export const CLIENT_FEED_MAX_LIMIT = 100;
export const CLIENT_FEED_DEFAULT_LIMIT = 50;
/** The first page's summary reads this many of the newest messages unless the query says otherwise: the Ping window. */
export const CLIENT_FEED_SUMMARY_WINDOW_DEFAULT = 100;
export const CLIENT_FEED_SUMMARY_WINDOW_MIN = 5;
/** The transcript readers' own cap. The deeper read (up to 5000) is the full Recap's and the notes fill's alone: a feed page never makes it. */
export const CLIENT_FEED_SUMMARY_WINDOW_MAX = 1500;

/** Known values of the feed's `source`. On the wire an open token. The AI
 *  context frame names the same readers (`AI_CONTEXT_SOURCES` in routes.ts). */
export const CLIENT_FEED_SOURCES = ["archive", "union"] as const;
/** Known values of `sender` (a row's and the head's). On the wire an open token. */
export const CLIENT_FEED_SENDERS = ["fan", "model", "system", "unknown"] as const;
/**
 * Known values of `summary.pingSegment`. On the wire an open token. This hub
 * answers the segment a Ping generation would be given for the same messages
 * (`active`, `segment-a`, `segment-b`); `unknown` is what a client reads any
 * other value as, and what it shows when `summary` is null.
 */
export const CLIENT_FEED_PING_SEGMENTS = ["active", "segment-a", "segment-b", "unknown"] as const;

export type ClientFeedSource = (typeof CLIENT_FEED_SOURCES)[number];
export type ClientFeedSender = (typeof CLIENT_FEED_SENDERS)[number];
export type ClientFeedPingSegment = (typeof CLIENT_FEED_PING_SEGMENTS)[number];

/** `depthMarks` names at most this many counts (`coach-depth-v1`). */
export const CLIENT_FEED_DEPTH_MARKS_MAX = 8;
/** The largest count `depthMarks` takes: the deepest AI transcript read. */
export const CLIENT_FEED_DEPTH_MARK_MAX = 5000;

/**
 * `coach-depth-v1`: the counts a client wants dated, as `300,1000,3000`. On the
 * wire one string of 1 to 8 whole numbers, each 1 to 5000, joined by commas;
 * read as the distinct counts, ascending.
 */
const clientFeedDepthMarksSchema = z.string()
  .regex(/^[1-9][0-9]{0,3}(,[1-9][0-9]{0,3}){0,7}$/)
  .transform((value) => [...new Set(value.split(",").map(Number))].sort((left, right) => left - right))
  .refine((marks) => marks.every((mark) => mark <= CLIENT_FEED_DEPTH_MARK_MAX), {
    message: `every depth mark is at most ${CLIENT_FEED_DEPTH_MARK_MAX}`,
  });

export const clientConversationFeedQuerySchema = z.object({
  /** `nextOlderCursor` of the page before; absent starts a new walk at the newest message. */
  cursor: clientCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(CLIENT_FEED_MAX_LIMIT).default(CLIENT_FEED_DEFAULT_LIMIT),
  /** How many of the newest messages the first page's summary reads. Not read on a later page, which has no summary. */
  summaryWindow: z.coerce.number().int()
    .min(CLIENT_FEED_SUMMARY_WINDOW_MIN).max(CLIENT_FEED_SUMMARY_WINDOW_MAX).optional(),
  /**
   * R20 HF-10 (`conversation-recaps-v1`): the conversation, apart from the fan
   * in the path ("reads by conversation"). The feed reads that conversation,
   * and a cursor is bound to it and to the fan.
   */
  conversationRef: clientConversationRefSchema.optional(),
  /**
   * `coach-depth-v1`: on the first page, the answer's `depth` dates these
   * counts of the newest messages (Coach's «300 сообщений · 2 недели»). Not
   * read on a later page.
   */
  depthMarks: clientFeedDepthMarksSchema.optional(),
}).strict();

export const clientFeedItemSchema = z.object({
  /** The platform's message id. */
  messageId: z.string(),
  /** Null for a message the stores hold without a time; such rows come last. */
  at: isoTimestamp.nullable(),
  /** Open token; known values: CLIENT_FEED_SENDERS. */
  sender: clientOpenToken,
  /** Plain text as stored. Always empty on a deleted message, whatever the store still holds of it. */
  text: z.string(),
  /** Whether the message was sent by an automation. The stores hold no such signal: always null today. */
  automatic: z.boolean().nullable(),
  /** The message was deleted on the platform. */
  deleted: z.boolean(),
  /** The tip the message carries; null when it carries none. */
  tipMills: mills.nullable(),
  /** The price of a paid message; null for a free one. Whether it was bought is not part of the feed. */
  priceMills: mills.nullable(),
  /** Captions of what is attached, as a generation reads them (`[Photo]`); never a media reference. */
  attachmentLabels: z.array(z.string().max(80)).max(50),
});

/** The newest message a generation would read from this reader: live, never a deleted one. */
export const clientFeedHeadSchema = z.object({
  messageRef: z.string(),
  at: isoTimestamp.nullable(),
  /**
   * Open token; known values: CLIENT_FEED_SENDERS. The head reads the sender
   * as a generation does (`servedHead.isFromFan`): `model` for the page's own
   * message and `fan` for every other one, a system line included. The row of
   * the same message in `items` carries its stored role.
   */
  sender: clientOpenToken,
});

export const clientFeedSummarySchema = z.object({
  /** Open token; known values: CLIENT_FEED_PING_SEGMENTS. */
  pingSegment: clientOpenToken,
  /** Whole days since the fan's last text message in the window; null when the window holds none. */
  fanSilenceDays: count.nullable(),
  /** The messages asked for and the messages the summary read. */
  window: z.object({ requested: count, served: count }),
  /** Open token; known values: CLIENT_COVERAGE_LEVELS. */
  coverage: clientOpenToken,
  /** The instant the segment and the silence were counted at. */
  asOf: isoTimestamp,
});

/**
 * `coach-depth-v1`: how deep the conversation's stored history goes, for the
 * chatter to choose how many messages Coach reads. The messages are the ones
 * an AI generation reads from the hub's stores, counted by its own reader
 * (`source`) and its filters: not deleted, with content and a time. Coach's
 * `messageCount: N` reads the N newest of them (the socket messages a Fansly
 * generation adds are the newest of a chat and not counted here).
 */
export const clientFeedDepthSchema = z.object({
  /** How many such messages the hub holds of this conversation; 0 for none. */
  storedCount: count,
  /** The time of the oldest of them; null when there is none. */
  oldestAt: isoTimestamp.nullable(),
  /** The hub holds the conversation from its first message (`coverage` is `complete`). */
  historyComplete: z.boolean(),
  /**
   * One per asked count up to `storedCount`, ascending: the time of the
   * count-th newest message (the newest is 1). A count above `storedCount` is
   * left out: the whole history is `oldestAt`.
   */
  marks: z.array(z.object({ count: positive, at: isoTimestamp.nullable() })).max(CLIENT_FEED_DEPTH_MARKS_MAX),
});

export const clientConversationFeedResponseSchema = z.object({
  target: z.object({
    pageLabel: z.string(),
    fanRef: clientFanRefSchema,
    /** R20 HF-10: the request's `conversationRef`; absent when it named none. */
    conversationRef: clientConversationRefSchema.optional(),
  }),
  /** The reader that served the walk. Open token; known values: CLIENT_FEED_SOURCES. */
  source: clientOpenToken,
  /** Names the walk's snapshot: the same on every page of one walk. Opaque. */
  snapshotRevision: z.string(),
  /** When the walk's snapshot was taken. */
  asOf: isoTimestamp,
  /** How much of the chat's history the hub can vouch for. Open token; known values: CLIENT_COVERAGE_LEVELS. */
  coverage: clientOpenToken,
  /**
   * The reader's newest live message at the snapshot, null when it holds none.
   * It is the `servedHead` the AI `context_v1` frame reports for a generation
   * served by the same reader from the same stored state (a generation that
   * was sent fresh text may read past it; the feed never holds fresh text).
   */
  head: clientFeedHeadSchema.nullable(),
  /**
   * The time of the newest message the hub has heard of in this chat: the
   * head's, or the chat list's last message when that is later than every
   * message the reader holds. Later than `head.at` means the reader has not
   * caught up with the chat yet. A newest message that was deleted does not
   * count as such: the reader holds its row, so nothing is behind and this is
   * the head's time. Null when the hub knows of no message.
   */
  newestKnownAt: isoTimestamp.nullable(),
  /** Continues the walk toward older messages; null at its end. */
  nextOlderCursor: clientCursorSchema.nullable(),
  /** Newest first. */
  items: z.array(clientFeedItemSchema).max(CLIENT_FEED_MAX_LIMIT),
  /** On the first page of a walk only; null on every later page. */
  summary: clientFeedSummarySchema.nullable(),
  /** `coach-depth-v1`: on a first page that asked for `depthMarks` only; absent on every other. */
  depth: clientFeedDepthSchema.optional(),
});

// ── own AI spend (H-15) ──────────────────────────────────────────────────────
//
// What the caller spent on AI on one page, day by day, for the extension's
// debug panel. Always the caller's own ledger rows: an owner too reads only the
// owner's own spend, never a chatter's.
//
// TWO DAY BOUNDARIES, and the answer states both:
// - a report day is a calendar day in `timeZone` (Europe/Moscow unless the
//   caller names another zone, as in the cabinet's reports). Every day carries
//   the two instants it was cut at (`from`, `toExclusive`);
// - the AI quota counts the UTC day (`quota.dayBoundary`). "Left today" is
//   therefore counted over a different window than today's report row, and the
//   two do not add up to the limit.

/** At most this many days in one answer. */
export const CLIENT_AI_USAGE_MAX_DAYS = 7;
/** `date` may lie this many days before today (today in `timeZone`), no further. */
export const CLIENT_AI_USAGE_MAX_AGE_DAYS = 8;
/** Known values of `days[].coverage`. On the wire an open token. */
export const CLIENT_AI_USAGE_COVERAGE = ["complete", "partial"] as const;
/** Known values of `days[].coverageReasons`: why a day's numbers may still change or are not exact. */
export const CLIENT_AI_USAGE_COVERAGE_REASONS = ["day_open", "open_reservations", "approximate_cost"] as const;
/** The `reason` beside this route's 400 `bad_request`. */
export const CLIENT_AI_USAGE_REFUSAL_REASONS = ["unknown_time_zone", "date_in_future", "date_too_old"] as const;

export type ClientAiUsageCoverage = (typeof CLIENT_AI_USAGE_COVERAGE)[number];
export type ClientAiUsageCoverageReason = (typeof CLIENT_AI_USAGE_COVERAGE_REASONS)[number];
export type ClientAiUsageRefusalReason = (typeof CLIENT_AI_USAGE_REFUSAL_REASONS)[number];

export const clientAiUsageQuerySchema = z.object({
  /** The LAST day of the range: a calendar day in `timeZone`. */
  date: businessDate,
  /** How many days, ending at `date`. */
  days: z.coerce.number().int().min(1).max(CLIENT_AI_USAGE_MAX_DAYS).default(1),
  /** The IANA zone the days are cut in. A zone the hub does not know is refused. */
  timeZone: z.string().min(1).max(64).default(MOSCOW_TIME_ZONE),
}).strict();

export const clientAiUsageTotalsSchema = z.object({
  /** Every ledger row of the window: finished, refused by the quota, or still open. */
  requestCount: count,
  costMicroUsd: count,
  /** At least one row's cost is the hub's estimate, not the provider's count. */
  costApproximate: z.boolean(),
  tokens: z.object({ input: count, output: count, cacheWrite: count, cacheRead: count }),
  completed: count,
  failed: count,
  cancelled: count,
  quotaDenied: count,
  /** Rows with no outcome yet: a generation still running, or one cut off and
   *  not swept yet. Their cost is not in the totals. */
  openReservations: count,
  regenerations: count,
});

export const clientAiUsageDaySchema = z.object({
  /** The calendar day in `timeZone`, YYYY-MM-DD. */
  date: z.string(),
  from: isoTimestamp,
  toExclusive: isoTimestamp,
  /** Open token; known values: CLIENT_AI_USAGE_COVERAGE. */
  coverage: clientOpenToken,
  /** Open tokens, empty when complete; known values: CLIENT_AI_USAGE_COVERAGE_REASONS. */
  coverageReasons: z.array(clientOpenToken),
  totals: clientAiUsageTotalsSchema,
  /** One row per AI feature used that day, by feature name. The feature is an open token. */
  features: z.array(clientAiUsageTotalsSchema.extend({ feature: clientOpenToken })),
});

export const clientAiUsageResponseSchema = z.object({
  /** Whose spend and where: always the caller, on the page of the path. */
  scope: z.object({ pageLabel: z.string(), userId: intId }),
  /** The zone the days were cut in. */
  timeZone: z.string(),
  asOf: isoTimestamp,
  moneyUnit: z.literal("micro-USD"),
  /** Oldest first; the last one is the requested `date`. A day without spend is listed with zeros. */
  days: z.array(clientAiUsageDaySchema),
  /**
   * What the caller may still spend on this page before the quota's day ends,
   * and that day is the UTC day, whatever `timeZone` is. Null when this hub's AI
   * gateway is off: nothing is generated, so there is no quota to report.
   */
  quota: z.object({
    dayBoundary: z.literal("UTC"),
    remainingRequestsToday: count.nullable(),
    remainingMicroUsdToday: count.nullable(),
  }).nullable(),
});

// ── Personal daily AI limit ──────────────────────────────────────────────────
//
// The caller's own limit, set by the owner: what their AI may cost in one
// Moscow day over all pages. At the limit every AI call of the caller is
// refused (429 `quota_denied`, reason `personal_daily_limit`) until `resetsAt`.

export const clientAiLimitResponseSchema = z.object({
  asOf: isoTimestamp,
  /** The Moscow day the spend is counted in, YYYY-MM-DD. */
  day: z.string(),
  /** 00:00 Moscow time of the next day: the limit starts over. */
  resetsAt: isoTimestamp,
  /** Null: the caller has no personal limit (the common per-page cap still applies). */
  dailyLimitMicroUsd: count.nullable(),
  /** The caller's AI spend today over all pages. */
  todayMicroUsd: count,
  /** What is left of the caller's own limit today; null when there is no limit. */
  remainingMicroUsd: count.nullable(),
  /**
   * Today's shared pool: yesterday's unspent limits of everyone with a limit.
   * Past their own limit a person spends from it; AI stops when both run out.
   * Null when the caller has no limit.
   */
  poolMicroUsd: count.nullable(),
  /** What is left of the shared pool now, all people together; null without a limit. */
  poolRemainingMicroUsd: count.nullable(),
});

// ── Spenders statistics (H-8b) ───────────────────────────────────────────────
//
// The numbers of one page's Spenders panel: 30 local days of money, tiers,
// silence, new payers and how many payers wait for a reply. The hub counts all
// of it (packages/shared/src/spender-stats.ts holds what each number means);
// the client shows what it is sent and never rebuilds a page total from the
// rows it happens to list.
//
// Money is integer mills, signed (a refund is negative). `null` is "unknown",
// never 0. What the hub cannot vouch for it says in `coverage`.

/** v1 serves one window length; another one is a new value of `windowDays`. */
export const CLIENT_SPENDER_STATS_WINDOW_DAYS = 30;
/**
 * Known values of `coverage.reasons`: why the answer is not `complete`. On the
 * wire open tokens; a client reads one it does not know as "partial".
 * - `no_revenue_history`: the page has no transaction and no spender
 *   projection, so nothing is known (`coverage.state` is `unknown`);
 * - `projection_missing`: the spender projection was never built; tiers,
 *   silence and the queue read it;
 * - `projection_behind`: a transaction is newer than the projection, so tier
 *   membership may lag the window totals;
 * - `history_starts_in_window`: the page's oldest transaction is inside the
 *   window; earlier days may be missing, and a new payer's first purchase is
 *   only the first one observed (`newPayers.firstPurchaseKnown` is false);
 * - `messages_missing`: the page has payers and no message at all, so every
 *   payer's silence is `unknown`.
 */
export const CLIENT_SPENDER_STATS_COVERAGE_REASONS = [
  "no_revenue_history", "projection_missing", "projection_behind", "history_starts_in_window", "messages_missing",
] as const;
/**
 * The two `tiers[].key` rows after the hub's spender buckets, both without
 * bounds: `untiered` is window spend by fans in no tier, `unattributed` is
 * window spend whose transaction names no fan. With them the tiers' window
 * gross sums to `totals.d30.grossMills`.
 */
export const CLIENT_SPENDER_STATS_REMAINDER_TIER_KEYS = ["untiered", "unattributed"] as const;
/** The `reason` beside this route's 400 `bad_request`. */
export const CLIENT_SPENDER_STATS_REFUSAL_REASONS = ["unknown_time_zone"] as const;

export type ClientSpenderStatsCoverageReason = (typeof CLIENT_SPENDER_STATS_COVERAGE_REASONS)[number];
export type ClientSpenderStatsRefusalReason = (typeof CLIENT_SPENDER_STATS_REFUSAL_REASONS)[number];

export const clientSpenderStatsQuerySchema = z.object({
  /** The window, in local dates ending today. v1: 30 only. */
  windowDays: z.coerce.number().int()
    .min(CLIENT_SPENDER_STATS_WINDOW_DAYS).max(CLIENT_SPENDER_STATS_WINDOW_DAYS)
    .default(CLIENT_SPENDER_STATS_WINDOW_DAYS),
  /** The IANA zone the dates are local to. A zone the hub does not know is refused. */
  timeZone: z.string().min(1).max(64),
}).strict();

/** Money of one calendar window. */
export const clientSpenderStatsMoneyWindowSchema = z.object({
  /** What fans paid, refunds and chargebacks already in it: purchases + adjustments. */
  grossMills: mills,
  purchasesGrossMills: mills,
  /** Refunds, chargebacks and every other row that is not a purchase. Zero or negative as a rule. */
  adjustmentsMills: mills,
  creatorNetMills: mills,
  purchaseCount: count,
  /** Distinct fans with a purchase in the window. */
  payerCount: count,
});

export const clientSpenderStatsDaySchema = z.object({
  /** A local date of `timeZone`, YYYY-MM-DD. */
  date: z.string(),
  grossMills: mills,
  purchasesGrossMills: mills,
  adjustmentsMills: mills,
  creatorNetMills: mills,
  purchaseCount: count,
  /** Gross by transaction state (an open token: `posted`, `pending`, `unknown`); the states sum to `grossMills`. */
  byState: z.record(clientOpenToken, mills),
});

export const clientSpenderStatsTierSchema = z.object({
  /** Open token: a hub spender bucket, or one of CLIENT_SPENDER_STATS_REMAINDER_TIER_KEYS. */
  key: clientOpenToken,
  label: z.string(),
  /** Inclusive lower bound of lifetime gross; null for the two remainders. */
  minMills: mills.nullable(),
  /** Exclusive upper bound; null for the top bucket and the two remainders. */
  maxMills: mills.nullable(),
  /** Fans whose lifetime gross is in the band (a remainder: fans with window spend). */
  members: count,
  /** Of the row's fans, those with a purchase in the window. */
  windowPayers: count,
  windowGrossMills: mills,
  /** The creator's share of `windowGrossMills` after the platform's fee; the rows sum to `totals.d30.creatorNetMills`. */
  windowNetMills: mills,
});

const clientSpenderStatsSilenceBucketSchema = z.object({
  fans: count,
  /** What those fans paid in all: context, not lost revenue and not a forecast. */
  lifetimeGrossMills: mills,
});

export const clientSpenderStatsResponseSchema = z.object({
  pageLabel: z.string(),
  /** Grows when a definition changes what a number means. */
  metricVersion: z.number().int().positive(),
  moneyUnit: z.literal("USD-mills"),
  basis: z.literal("gross"),
  /** The zone the dates are local to, as asked. */
  timeZone: z.string(),
  /** First and last local date of the window, YYYY-MM-DD; `to` is today in `timeZone`. */
  from: z.string(),
  to: z.string(),
  /** The instant the numbers are of; nothing after it is counted. An answer may be up to a minute old. */
  asOf: isoTimestamp,
  /** When the spender projection behind tiers, silence and the queue was last rebuilt; null when never. */
  projectionAsOf: isoTimestamp.nullable(),
  /** The transaction states the money counts (open tokens). */
  includedStates: z.array(clientOpenToken),
  coverage: z.object({
    /** Open token; known values: CLIENT_COVERAGE_LEVELS. */
    state: clientOpenToken,
    /** Open tokens, empty when complete; known values: CLIENT_SPENDER_STATS_COVERAGE_REASONS. */
    reasons: z.array(clientOpenToken),
  }),
  /** One entry per date of the window, oldest first; a date without a transaction is listed with zeros. */
  days: z.array(clientSpenderStatsDaySchema),
  totals: z.object({
    /** Today so far. */
    today: clientSpenderStatsMoneyWindowSchema,
    /** The last 7 dates, today included. */
    d7: clientSpenderStatsMoneyWindowSchema,
    /** The 7 dates before `d7`. */
    prev7: clientSpenderStatsMoneyWindowSchema,
    d30: clientSpenderStatsMoneyWindowSchema,
    /** `(d7 − prev7) / |prev7|` of gross, in percent; null when prev7 is zero. */
    d7DeltaPct: z.number().nullable(),
  }),
  /** Purchases gross over the number of purchases in the window; null without a purchase. */
  avgCheckMills: mills.nullable(),
  /** The hub's spender buckets in their order, then the two remainders. */
  tiers: z.array(clientSpenderStatsTierSchema),
  /**
   * Payers by how long ago the fan last wrote TEXT, in whole days: 8 to 21,
   * more than 21, and `unknown` for a payer with no text message the hub
   * holds. Fewer than 8 days is not silence and is not listed.
   */
  silence: z.object({
    d8to21: clientSpenderStatsSilenceBucketSchema,
    over21: clientSpenderStatsSilenceBucketSchema,
    unknown: clientSpenderStatsSilenceBucketSchema,
  }),
  /**
   * Fans whose first purchase on the page is in the window. With
   * `firstPurchaseKnown` false the page's history starts inside the window,
   * and "first" is only the first purchase the hub observed.
   */
  newPayers: z.object({ count, firstPurchaseKnown: z.boolean() }),
  /** Payers whose fan wrote after the page's last message; `unknown` of them have an unknown read state. */
  queueSummary: z.object({ total: count, unknown: count }),
});

// ── awaiting reply (H-8c) ────────────────────────────────────────────────────
//
// The queue behind the Spenders panel's "awaiting reply": the page's payers
// whose fan wrote after the page's last message, counted and ordered by the hub
// over the whole page, not over the rows a board happens to list. The same
// payers and the same rule as `queueSummary` of the statistics above.
//
// WHO WAITS. A payer (lifetime gross at or above the lowest spender bucket, as
// the statistics count payers) whose fan's last message in the chat is later
// than the page's last message there, or to whom the page never wrote. A fan
// with several chats is judged on the visible one with the newest message. A
// fan the page can no longer message (the page's own lookup does not find him:
// deleted or blocked the page; an OnlyFans closed chat) is not in the queue.
//
// ORDER. Lifetime gross, largest first; among equals the fan waiting longest
// first; then a fixed tie-breaker. The order is total, so a walk has no ties.
//
// A WALK IS NOT A SNAPSHOT. Every page is read at its own instant (`asOf`), with
// the queue's `total` and `unknown` of that instant: a queue of people waiting
// right now is not frozen for a reader. The cursor holds a position in the
// order, so a fan whose place does not change is served exactly once, and a fan
// answered meanwhile is simply not served. A fan whose place changed during the
// walk (wrote again, paid more) can be met a second time or not at all until
// the next walk; a client keeps the first row of a fan.
//
// `nextCursor` is opaque (its state is sealed: its holder reads nothing from
// it) and signed, valid only for the same page and person, and for an hour
// after the page that carried it. Every page carries a newly issued one, so the
// hour bounds the gap between two pages of a walk, not the walk. Any other use
// is 400 `bad_request` with the reason `cursor_invalid`, and the client reads
// the first page again.

/** The most rows one page carries. */
export const CLIENT_SPENDER_AWAITING_REPLY_MAX_LIMIT = 100;
export const CLIENT_SPENDER_AWAITING_REPLY_DEFAULT_LIMIT = 50;
/**
 * Known values of `readState`. On the wire an open token; a client reads one
 * it does not know as `unknown`.
 * - `unread`: the chat has unread fan messages (`unreadCount` says how many);
 * - `read`: nothing is unread and the chat's newest message is the fan's;
 * - `unknown`: the fan wrote after the page's last message, but the hub cannot
 *   tell whether it was read. Its own category, never folded into the other
 *   two; `unreadCount` is null.
 */
export const CLIENT_SPENDER_AWAITING_REPLY_READ_STATES = ["unread", "read", "unknown"] as const;

export type ClientSpenderAwaitingReplyReadState = (typeof CLIENT_SPENDER_AWAITING_REPLY_READ_STATES)[number];

export const clientSpenderAwaitingReplyQuerySchema = z.object({
  /** `nextCursor` of the page before; absent starts a new walk at the head of the queue. */
  cursor: clientCursorSchema.optional(),
  limit: z.coerce.number().int()
    .min(1).max(CLIENT_SPENDER_AWAITING_REPLY_MAX_LIMIT).default(CLIENT_SPENDER_AWAITING_REPLY_DEFAULT_LIMIT),
  /**
   * Chat Memory week 3: every fan who wrote in the last 30 days, not only payers (non-payers sort after them,
   * by their wait). A cursor walks the mode it was made in.
   */
  everyone: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
}).strict();

export const clientSpenderAwaitingReplyItemSchema = z.object({
  /** The platform's fan id: on OnlyFans also the chat id; a Fansly chat is a group apart from its fan. */
  fanRef: clientFanRefSchema,
  /** The fan's primary chat: on Fansly the group, on OnlyFans the fan. Absent from an older hub. */
  conversationRef: clientConversationRefSchema.nullable().optional(),
  /** The team's name for the fan on the page (Fansly «Custom Username», with its 💵/❌ marks). Absent from an older hub. */
  alias: z.string().nullable().optional(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  /** What the fan paid on the page in all. */
  lifetimeGrossMills: mills,
  lastFanMessageAt: isoTimestamp,
  /**
   * The page's last PERSONAL message to the fan (Chat Memory week 3: a mass message — Fansly's, or one text to
   * 5+ chats within an hour — is not an answer); null when the page never wrote to him personally.
   */
  lastModelMessageAt: isoTimestamp.nullable(),
  /** Null when `readState` is `unknown`: an unknown count is never 0. */
  unreadCount: count.nullable(),
  /** Open token; known values: CLIENT_SPENDER_AWAITING_REPLY_READ_STATES. */
  readState: clientOpenToken,
});

export const clientSpenderAwaitingReplyResponseSchema = z.object({
  /** In the queue's order. */
  items: z.array(clientSpenderAwaitingReplyItemSchema),
  /** Payers waiting for a reply on the page at `asOf`. */
  total: count,
  /** Rows the walk has served so far, this page included. The queue moves between pages, so the last page's `loaded` need not equal its `total`. */
  loaded: count,
  /** Of `total`, the payers whose read state is unknown. */
  unknown: count,
  /** Continues the walk; null at its end. */
  nextCursor: clientCursorSchema.nullable(),
  /** The instant this page and its counts were read at. */
  asOf: isoTimestamp,
});

// ── the owner's client-health view (H-11c) ───────────────────────────────────
//
// What the owner reads of the `client_health` rollups (H-11b): figures by client
// version and host build, never by person. The rollups hold no user, page, fan
// or device, so neither does this view, and it has no list of who runs what.
//
// A dashboard route, not a client's: `owner-session`, so no device token reaches
// it and it is on no narrow-token list. It lives in this module because every
// shape of the chat extension does (and `routes.ts` stays untouched).

/** The longest range one read may span, in days. */
export const ADMIN_CLIENT_HEALTH_MAX_RANGE_DAYS = 366;

export const adminClientHealthQuerySchema = z.object({
  /** First and last day of the range, inclusive, in the response's `range.timeZone`. */
  from: businessDate,
  to: businessDate,
  /** Only this client's rollups (`chat-extension`). */
  clientName: clientOpenToken.optional(),
  /** Only this metric among `perf`; the other sections are not narrowed by it. */
  metric: clientOpenToken.optional(),
}).strict().superRefine((query, ctx) => {
  // The field checks above report a malformed date; a range needs two real ones.
  if (!isValidBusinessDateString(query.from) || !isValidBusinessDateString(query.to)) {
    return;
  }
  // The read stops before the first hour of the day after `to`, and the hub has
  // to be able to name that day: 9999-12-31 has none, and the day after one in a
  // year below 1000 comes back from `nextBusinessDate` without its leading zero.
  // Refused here, or resolving the range throws and the route answers 500.
  if (!isValidBusinessDateString(nextBusinessDate(query.to))) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "`to` is outside the days the hub can read" });
    return;
  }
  if (query.from > query.to) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "`from` must be on or before `to`" });
    return;
  }
  if (diffBusinessDays(query.from, query.to) > ADMIN_CLIENT_HEALTH_MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: "custom",
      path: ["to"],
      message: `the range must not be longer than ${ADMIN_CLIENT_HEALTH_MAX_RANGE_DAYS} days`,
    });
  }
});

/**
 * One perf metric of one client group over the range, read off the buckets
 * merged across every report and hour of it (a percentile is never averaged
 * from parts). Milliseconds.
 *
 * A group with fewer than `minGroupSize` observations in the range asked for is
 * `suppressed`: it shows how many observations it has and no figure of them
 * (mean, max and both percentiles are null). The floor is on the range of one
 * read and no narrower: see the route's description.
 */
export const adminClientHealthPerfRowSchema = z.object({
  clientName: z.string(),
  /** A code, or `(other)` for a version that is not one. */
  clientVersion: z.string(),
  hostKind: z.string(),
  /** The host build fingerprint; `(other)` for one that is not a code, null when the client could not read it. */
  hostBuild: z.string().nullable(),
  metric: z.string(),
  /** The version of the metric's bounds and meaning; two versions are two rows. */
  schemaVersion: z.number().int(),
  /** Observations in the group. */
  count,
  mean: z.number().nullable(),
  max: z.number().nullable(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  suppressed: z.boolean(),
});

/**
 * The host-contract verdicts of one client version on one host build: counts of
 * reports, shown at any size (a build that breaks the contract shows from its
 * first report).
 */
export const adminClientHealthContractRowSchema = z.object({
  clientVersion: z.string(),
  hostBuild: z.string().nullable(),
  /** Reports received from the group. */
  reports: count,
  /** Reports that said the host contract was broken. */
  failedReports: count,
  /** The anchors of the host contract that reports did not find, each with how many reports missed it. */
  missing: z.array(z.object({ anchor: z.string(), reports: count })),
});

/**
 * The client's own footprint by client version: the 95th percentile, over
 * reports, of the size of its caches and logs (KB) and of the largest number of
 * its own DOM nodes in a report's window. Null under `minGroupSize` reports.
 */
export const adminClientHealthFootprintRowSchema = z.object({
  clientVersion: z.string(),
  cachesKBp95: z.number().nullable(),
  logsKBp95: z.number().nullable(),
  domNodesP95: z.number().nullable(),
});

export const adminClientHealthResponseSchema = z.object({
  /** The days read, as asked, and the zone they are days of. */
  range: z.object({ from: z.string(), to: z.string(), timeZone: z.string() }),
  /** The fewest observations a group needs, over the range asked for, to show a mean, a maximum or a percentile. */
  minGroupSize: positive,
  perf: z.array(adminClientHealthPerfRowSchema),
  contract: z.array(adminClientHealthContractRowSchema),
  /**
   * Counters by code, summed over the range: errors, prevented inserts, P1s, and
   * the client's own bookkeeping of what it left out of a report (`perf.capped`
   * and the like), which is not an error count.
   */
  counters: z.array(z.object({ code: z.string(), total: count })),
  footprint: z.array(adminClientHealthFootprintRowSchema),
  asOf: isoTimestamp,
});

// ── greeting lease and send custody (H-7b) ───────────────────────────────────
//
// Three separate facts about one OnlyFans fan of one page (chat-extension
// architecture §6.7.7–§6.7.9; the tables are migration 0241):
// 1. greeting: the fan's first greeting is confirmed, for good;
// 2. lease: who is working on that one greeting now (120 s, renewed while the
//    person works);
// 3. custody: one dispatched part of a send from the preview. It never expires:
//    a dispatch whose ticket ran out reads `uncertain-held` until it is reported
//    sent, failed with evidence, or resolved by the owner or a team lead.
//
// THE CLIENT'S SHAPE. The chat extension froze the body and the answer in its
// contracts (`ClaimBodySchema`, `ClaimStateSchema`,
// packages/contracts/src/hub/newcomers.ts). The hub takes every body that schema
// lets out and answers only what it reads. The states of the three automata are
// closed enums here and there: a new state is a new route version.
//
// A MANUAL GROUP (`manual-greeting-v1`, chat-extension R20 HF-3): a text
// the chatter wrote or edited, sent with no AI generation behind it. Its group
// is `{kind: "manual", textFingerprint}`, the sha256 of the exact text, and is
// one part. The hub keeps it as `generation_ref` `manual:<textFingerprint>`,
// variant 0, one part, and answers it in that form (`group.generationRef`):
// the custody rules see one more group, and no table changes. Only where the
// platform's admission takes it: on Fansly a greeting; on OnlyFans a greeting
// or a reply from the preview (audit 2026-10-20, row 1). The hub never sees
// the text, as with an AI group.

/** An id the client mints (lease token, install id, attempt id): its UUID form. */
const clientMintedId = z.string().regex(CLIENT_REQUEST_ID_PATTERN);

export const CLIENT_CLAIM_ACTIONS = [
  "claim", "renew", "release", "dispatch", "sent", "failed", "registerNativeSend",
] as const;
export const CLIENT_GREETING_STATES = ["none", "confirmed"] as const;
export const CLIENT_LEASE_STATES = ["none", "owned", "held", "expired", "released"] as const;
/** The holder of a lease is never named: only whether it is the caller elsewhere. */
export const CLIENT_LEASE_HOLDERS = ["you-elsewhere", "someone-else"] as const;
export const CLIENT_CUSTODY_STATES = [
  "dispatching", "sent", "failed", "uncertain-held", "resolved-sent", "resolved-not-sent",
] as const;
/**
 * Known values of `greeting.source`; on the wire an open token. `desktop-outbox`:
 * the desktop's new-follower command that OnlyFans confirmed greeted the fan.
 */
export const CLIENT_GREETING_SOURCES = ["preview-send", "native-register", "resolve", "desktop-outbox"] as const;
export const CLIENT_SEND_PURPOSES = ["greeting", "preview-reply"] as const;
export const CLIENT_SEND_FAILURE_REASONS = ["not_enqueued", "native_rejected"] as const;
/** A group has at most this many variants (Hi) and parts. */
export const CLIENT_CLAIM_MAX_VARIANTS = 3;
export const CLIENT_CLAIM_MAX_PARTS = 10;
/**
 * How a manual group's `generationRef` reads in an answer: this prefix and the
 * group's `textFingerprint`. An AI group's `generationRef` never starts with it.
 */
export const CLIENT_MANUAL_GROUP_REF_PREFIX = "manual:";
/** A manual group's `textFingerprint`: the sha256 of the exact text, lower-case hex. */
export const CLIENT_TEXT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type ClientClaimAction = (typeof CLIENT_CLAIM_ACTIONS)[number];
export type ClientCustodyState = (typeof CLIENT_CUSTODY_STATES)[number];
export type ClientGreetingSource = (typeof CLIENT_GREETING_SOURCES)[number];
export type ClientSendPurpose = (typeof CLIENT_SEND_PURPOSES)[number];

/** `native_rejected` proves a refusal only with a 4xx other than 401: a 401 says nothing about the send. */
function isNativeRefusalStatus(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus <= 499 && httpStatus !== 401;
}

/** The parts of one generation: one group. `variant` is the Hi variant, 0 elsewhere. */
export const clientClaimGroupSchema = z.object({
  /** The generation's `meta.requestId`. */
  generationRef: z.string().min(1).max(100),
  variant: z.number().int().min(0).max(CLIENT_CLAIM_MAX_VARIANTS - 1),
  partCount: z.number().int().min(1).max(CLIENT_CLAIM_MAX_PARTS),
}).strict();

/**
 * A text with no AI generation behind it (`manual-greeting-v1`): one part,
 * named by the sha256 of its exact text. Which purposes take it is the
 * platform's admission.
 */
export const clientManualClaimGroupSchema = z.object({
  kind: z.literal("manual"),
  textFingerprint: z.string().regex(CLIENT_TEXT_FINGERPRINT_PATTERN),
}).strict();

/** The group a send names: an AI generation's, or a manual one. */
export const clientClaimSendGroupSchema = z.union([clientClaimGroupSchema, clientManualClaimGroupSchema]);

const clientPartIndex = z.number().int().min(0).max(CLIENT_CLAIM_MAX_PARTS - 1);
const clientSendPurpose = z.enum(CLIENT_SEND_PURPOSES);
/** The columns that keep the two revisions are 32-bit. */
const clientRevision = z.number().int().min(0).max(2_147_483_647);

function clientLeaseAction<A extends "claim" | "renew" | "release">(action: A) {
  return z.object({ action: z.literal(action), leaseToken: clientMintedId, instanceId: clientMintedId }).strict();
}

export const clientFanClaimBodySchema = z.discriminatedUnion("action", [
  clientLeaseAction("claim"),
  clientLeaseAction("renew"),
  clientLeaseAction("release"),
  z.object({
    action: z.literal("dispatch"),
    attemptId: clientMintedId,
    instanceId: clientMintedId,
    purpose: clientSendPurpose,
    group: clientClaimSendGroupSchema,
    partIndex: clientPartIndex,
    textRevision: clientRevision,
    /**
     * An older client's lease on a greeting not yet confirmed: then that live lease of the caller's
     * install is required. Without it the greeting is claimed at the send (audit 2026-10-20 row 11).
     */
    leaseToken: clientMintedId.optional(),
    /**
     * The bootstrap `configRevision` the client acted on. Recorded with the
     * attempt and never decided by: the owner's switches are read under a lock
     * in the dispatch's own transaction, so an out-of-date revision is not a
     * refusal and an up-to-date one admits nothing.
     */
    flagRevision: clientRevision,
  }).strict(),
  z.object({
    action: z.literal("sent"),
    attemptId: clientMintedId,
    instanceId: clientMintedId,
    platformMessageId: clientNumericIdSchema,
    evidence: z.literal("receipt+echo"),
  }).strict(),
  z.object({
    action: z.literal("failed"),
    attemptId: clientMintedId,
    instanceId: clientMintedId,
    reason: z.enum(CLIENT_SEND_FAILURE_REASONS),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict(),
  z.object({
    action: z.literal("registerNativeSend"),
    attemptId: clientMintedId,
    instanceId: clientMintedId,
    purpose: clientSendPurpose,
    group: clientClaimSendGroupSchema,
    partIndex: clientPartIndex,
    platformMessageId: clientNumericIdSchema,
  }).strict(),
]).superRefine((body, ctx) => {
  if (body.action === "dispatch" || body.action === "registerNativeSend") {
    const { group } = body;
    if ("kind" in group) {
      // A manual group is one part; which purposes take it is the platform's admission.
      if (body.partIndex !== 0) {
        ctx.addIssue({ code: "custom", path: ["partIndex"], message: "a manual group is one part: partIndex must be 0" });
      }
    } else {
      if (body.partIndex >= group.partCount) {
        ctx.addIssue({ code: "custom", path: ["partIndex"], message: "partIndex must be below group.partCount" });
      }
      // The manual groups' namespace: an AI group there would read as one.
      if (group.generationRef.startsWith(CLIENT_MANUAL_GROUP_REF_PREFIX)) {
        ctx.addIssue({
          code: "custom",
          path: ["group", "generationRef"],
          message: `an AI group's generationRef never starts with "${CLIENT_MANUAL_GROUP_REF_PREFIX}"`,
        });
      }
    }
  }
  if (body.action === "failed") {
    const proven = body.reason === "native_rejected"
      ? body.httpStatus !== undefined && isNativeRefusalStatus(body.httpStatus)
      : body.httpStatus === undefined;
    if (!proven) {
      ctx.addIssue({
        code: "custom",
        path: ["httpStatus"],
        message: "native_rejected needs a 4xx other than 401; not_enqueued carries no status",
      });
    }
  }
});

/** The answer of the claim POST and, never with a ticket, of the status GET. */
export const clientFanClaimResponseSchema = z.object({
  greeting: z.object({
    state: z.enum(CLIENT_GREETING_STATES),
    at: isoTimestamp.nullable(),
    /** The OnlyFans message id of the first confirmed part, when known. */
    messageRef: z.string().nullable(),
    /** Open token; known values: CLIENT_GREETING_SOURCES. */
    source: clientOpenToken.nullable(),
  }),
  lease: z.object({
    state: z.enum(CLIENT_LEASE_STATES),
    /** The caller's own token only. */
    leaseToken: z.string().nullable(),
    expiresAt: isoTimestamp.nullable(),
    heldBy: z.enum(CLIENT_LEASE_HOLDERS).nullable(),
  }),
  group: z.object({
    generationRef: z.string(),
    variant: count,
    partCount: positive,
    sentParts: z.array(count),
    /**
     * Parts whose send nobody can vouch for (`uncertain-held`). A part still
     * inside its ticket is in flight, not held: `custody` says so.
     */
    heldParts: z.array(count),
  }).nullable(),
  custody: z.object({
    attemptId: z.string(),
    state: z.enum(CLIENT_CUSTODY_STATES),
    /** Only in the answer to the dispatch that created the attempt. */
    ticket: z.string().nullable(),
    ticketExpiresAt: isoTimestamp.nullable(),
  }).nullable(),
  serverNow: isoTimestamp,
  /** The bootstrap's `configRevision` as the hub reads it now. */
  flagRevision: count,
});

/** 429 `preview_send_rate_limited`: the error body plus when the window frees a slot. */
export const clientPreviewSendRateLimitedResponseSchema = errorResponseSchema.extend({
  retryAfterMs: count.optional(),
});

// The manual resolve of a held send, for the owner and team leads in the
// cabinet (cookie session). Not a client route: the extension never calls it.

export const clientSendCustodyParamsSchema = z.object({ pageLabel: pageLabelSchema, attemptId: clientMintedId });

export const clientSendCustodyResolveBodySchema = z.object({
  outcome: z.enum(["sent", "not_sent"]),
  /** The OnlyFans message id, when the resolver found the message. Only with `sent`. */
  platformMessageId: clientNumericIdSchema.optional(),
  note: z.string().trim().min(1).max(500),
}).strict().superRefine((body, ctx) => {
  if (body.outcome === "not_sent" && body.platformMessageId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["platformMessageId"],
      message: "a message id is evidence of a send: it cannot come with not_sent",
    });
  }
});

export const clientSendCustodyItemSchema = z.object({
  attemptId: z.string(),
  fanRef: z.string(),
  /** Who dispatched or registered the send. */
  userId: intId,
  /** Open token; known values: CLIENT_SEND_PURPOSES. */
  purpose: clientOpenToken,
  /** Open token; known values: CLIENT_CUSTODY_STATES. */
  state: clientOpenToken,
  generationRef: z.string(),
  partIndex: count,
  partCount: positive,
  createdAt: isoTimestamp,
  ticketExpiresAt: isoTimestamp.nullable(),
});

// The list of held sends, for the same cabinet (H-7e): what the owner and a
// team lead read before they resolve. It carries ids, states and times only.
// The custody tables hold no text and the list serves none: the hub does not
// know which text went out. `generationRef` names the AI generation the text
// came from; that generation's record (prompt and output) is restricted, and
// only the owner reads it, on its own route.

/**
 * `held`: sends past their ticket that nobody ended (`uncertain-held`), the
 * longest held first. A send still inside its ticket is in flight and is not
 * listed. `resolved`: sends the owner or a team lead ended by hand, the last
 * resolved first, each with who resolved it, when, how and why.
 */
export const CLIENT_SEND_CUSTODY_LIST_STATES = ["held", "resolved"] as const;
/** Known values of `resolution.outcome`; on the wire an open token. The resolve body's own. */
export const CLIENT_SEND_CUSTODY_RESOLVE_OUTCOMES = ["sent", "not_sent"] as const;

export type ClientSendCustodyListState = (typeof CLIENT_SEND_CUSTODY_LIST_STATES)[number];

export const clientSendCustodyListQuerySchema = z.object({
  state: z.enum(CLIENT_SEND_CUSTODY_LIST_STATES).default("held"),
  /** One page. Absent: every page the viewer reaches. */
  pageLabel: pageLabelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

export const clientSendCustodyListItemSchema = clientSendCustodyItemSchema.extend({
  /** The page of the send: the resolve route takes it in its path. */
  pageLabel: z.string(),
  /** With `generationRef`, `partIndex` and `partCount`: which part of which group. */
  variant: count,
  /** The login of `userId`, who dispatched the send. */
  username: z.string(),
  /** The client install that dispatched it. Only that install could report the outcome. */
  instanceId: z.string(),
  /**
   * The last recorded change of the attempt. For a held send it is the dispatch
   * itself: a held send is one whose client never reported, and a late report
   * the hub refuses is not recorded. For a resolved one it is the resolve.
   */
  updatedAt: isoTimestamp,
  /** Whether the fan's first greeting is on record, whoever sent it and however. */
  greeting: z.object({
    /** Open token; known values: CLIENT_GREETING_STATES. */
    state: clientOpenToken,
    at: isoTimestamp.nullable(),
    /** Open token; known values: CLIENT_GREETING_SOURCES. */
    source: clientOpenToken.nullable(),
    /**
     * The greeting names this attempt as its first part. With the source
     * `native-register` on a held send: the person sent this very part by hand
     * from the composer while the send from the preview was held.
     */
    firstPartIsThisAttempt: z.boolean(),
  }),
  /** How the send was ended by hand; null while it is held. */
  resolution: z.object({
    /** Open token; known values: CLIENT_SEND_CUSTODY_RESOLVE_OUTCOMES. */
    outcome: clientOpenToken,
    at: isoTimestamp,
    userId: intId,
    username: z.string(),
    /** The resolver's reason, as they wrote it. */
    note: z.string(),
    /** The OnlyFans message id the resolver recorded with `sent`, if any. */
    platformMessageId: z.string().nullable(),
  }).nullable(),
});

export const clientSendCustodyListResponseSchema = z.object({
  items: z.array(clientSendCustodyListItemSchema),
  limit: positive,
  offset: count,
  /** Sends in the asked state on the asked pages, whatever the page of the list. */
  total: count,
  /** The hub's clock when it read the list: "held for" is counted against it. */
  serverNow: isoTimestamp,
});

// ── the "new subscribers" list (H-7c) ────────────────────────────────────────
//
// Who subscribed to an OnlyFans page, or came back to it, inside a window of
// hours: newest first, one row per subscription notification the hub collected,
// with what the hub holds about the fan right now (the subscription, the chat,
// the greeting). Database only: the hub's own collected events and projections.
//
// THE CLIENT'S SHAPE. The chat extension froze the query and the answer in its
// contracts (`AudienceNewQuerySchema`, `AudienceNewPageSchema`,
// packages/contracts/src/hub/newcomers.ts). The hub takes every query that
// schema lets out and answers only what it reads: `fanRef` is the one numeric
// id shape there, so an event whose fan id is not one is never a row.
//
// ONE WALK, ONE WINDOW. A request without a cursor starts a walk and fixes its
// window: `window.to` and `window.snapshotAt` are the hub's clock at that
// moment, `window.from` is `hours` before, and every later page repeats them. A
// subscription the hub learns of during the walk is not in it; the next walk
// from the first page has it. The cursor is opaque and signed, valid for the
// same page and person, for an hour: anything else is 400 `bad_request` with
// the reason `cursor_invalid`, and a cursor presented with another
// `windowHours` is 400 with `cursor_window_mismatch`. Either way the client
// reads the first page again.
//
// The rows of a walk are fixed; what is said ABOUT each fan (`status`,
// `thread`, `claim`) and the page-level `coverage` and `welcomeTemplate` are
// read when the page is asked for.

export const CLIENT_AUDIENCE_NEW_DEFAULT_WINDOW_HOURS = 48;
/** The widest window; the bootstrap announces it as `limits.audienceWindowHours`. */
export const CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS = 720;
export const CLIENT_AUDIENCE_NEW_DEFAULT_LIMIT = 50;
export const CLIENT_AUDIENCE_NEW_MAX_LIMIT = 100;

/**
 * Known values of `kind`. On the wire an open token. `new`: a first
 * subscription (with `trial` when it is a free trial). `returning`: a fan who
 * was subscribed before and came back: OnlyFans says so, or it names the
 * subscription new (a free-trial link taken again reads as a new trial) while
 * the hub holds a subscription of the fan that started earlier. `trial` stays
 * as OnlyFans said it. There is no "renewed": OnlyFans sends no notification
 * when a subscription renews by itself.
 */
export const CLIENT_AUDIENCE_NEW_KINDS = ["new", "returning"] as const;
/**
 * Known values of `subscribedAtSource`. On the wire an open token.
 * `notification`: the time of the subscription notification, which OnlyFans
 * gives to the minute. `subscribeAt`: the subscription's own start as a
 * subscriber sweep read it from OnlyFans, used once it names the same
 * subscription as the notification.
 */
export const CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES = ["subscribeAt", "notification"] as const;
/** Known values of `status.subscriptionStatus`. On the wire an open token. */
export const CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES = ["active", "expired", "unknown"] as const;
/**
 * Known values of `status.source`: which collector the subscription's state
 * rests on. On the wire an open token. `sweep`: the newest subscriber sweep
 * saw the fan, or a sweep's end retired a subscription it no longer found.
 * `webhook`: a notification wrote the state and no sweep has confirmed it
 * since. `none`: the hub holds no subscription of the fan on the page.
 */
export const CLIENT_AUDIENCE_NEW_STATUS_SOURCES = ["sweep", "webhook", "none"] as const;
/**
 * Known values of `coverage.reasons`: why the list may be missing a
 * subscription or a row's `status` may be out of date. On the wire open
 * tokens; the list is append-only.
 * - `delivery_history_off`: the hub does not collect the provider's webhook
 *   delivery history, so nothing would tell it of a notification that never
 *   arrived (`unknown`);
 * - `delivery_history_pending`: the collection is on and has not finished a
 *   first window (`unknown`);
 * - `delivery_history_before_window`: the delivery history is checked only up
 *   to a moment before the window starts (`unknown`);
 * - `delivery_history_behind`: it is checked up to a moment inside the window
 *   that lies further back from the window's end than the collector normally
 *   lags (`partial`);
 * - `subscription_event_pending`: a subscription notification received since
 *   the window started is journaled and not turned into an event yet, so its
 *   row is not in the list (`partial`);
 * - `subscription_projection_pending`, `subscription_projection_failed`: a
 *   subscription notification received since the window started is not applied
 *   to the page's subscriber state yet, or could not be (`partial`);
 * - `audience_sweep_missing`: no subscriber sweep of the page has completed, so
 *   nothing but notifications vouches for any `status` (`partial`);
 * - `audience_sweep_unverified`: the last sweep ended without a result the hub
 *   trusts (`partial`).
 */
export const CLIENT_AUDIENCE_NEW_COVERAGE_REASONS = [
  "delivery_history_off", "delivery_history_pending", "delivery_history_before_window", "delivery_history_behind",
  "subscription_event_pending", "subscription_projection_pending", "subscription_projection_failed",
  "audience_sweep_missing", "audience_sweep_unverified",
  // A page fed by ChatSpace (its money writer is `chatspace`): the page's poll of ChatSpace's own notifications
  // (`clientOnlyfansPoll`) has never read them whole, read them last before the window, read them last too long
  // before its end, or failed since its last whole read.
  "notifications_poll_pending", "notifications_poll_before_window", "notifications_poll_behind", "notifications_poll_failing",
] as const;
/**
 * The `reason` beside this route's 400 `bad_request`. `cursor_invalid`: the
 * cursor is not one this hub issued for this request (forged or cut, issued
 * for another page or person, or older than an hour); the answer never says
 * which. `cursor_window_mismatch`: the cursor is the caller's own, of a walk
 * with another `windowHours`.
 */
export const CLIENT_AUDIENCE_NEW_REFUSAL_REASONS = ["cursor_invalid", "cursor_window_mismatch"] as const;

export type ClientAudienceNewKind = (typeof CLIENT_AUDIENCE_NEW_KINDS)[number];
export type ClientAudienceNewSubscribedAtSource = (typeof CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES)[number];
export type ClientAudienceNewSubscriptionStatus = (typeof CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES)[number];
export type ClientAudienceNewStatusSource = (typeof CLIENT_AUDIENCE_NEW_STATUS_SOURCES)[number];
export type ClientAudienceNewCoverageReason = (typeof CLIENT_AUDIENCE_NEW_COVERAGE_REASONS)[number];
export type ClientAudienceNewRefusalReason = (typeof CLIENT_AUDIENCE_NEW_REFUSAL_REASONS)[number];

export const clientAudienceNewQuerySchema = z.object({
  /** How far back the window reaches from the moment the walk starts. */
  windowHours: z.coerce.number().int().min(1).max(CLIENT_AUDIENCE_NEW_MAX_WINDOW_HOURS)
    .default(CLIENT_AUDIENCE_NEW_DEFAULT_WINDOW_HOURS),
  /** `nextCursor` of the previous page, with the same `windowHours`. */
  cursor: clientCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(CLIENT_AUDIENCE_NEW_MAX_LIMIT)
    .default(CLIENT_AUDIENCE_NEW_DEFAULT_LIMIT),
}).strict();

/**
 * The greeting, lease and custody of one fan as a list row carries them: the
 * states the claim status read (`clientFanClaimStatus`) answers for the same
 * fan and caller, without the tokens and ids. The read names no client
 * install, so the caller's own live lease reads `held` by `you-elsewhere`.
 */
export const clientClaimSummarySchema = z.object({
  greeting: z.enum(CLIENT_GREETING_STATES),
  lease: z.enum(CLIENT_LEASE_STATES),
  heldBy: z.enum(CLIENT_LEASE_HOLDERS).nullable(),
  custody: z.enum(CLIENT_CUSTODY_STATES).nullable(),
});

export const clientAudienceNewItemSchema = z.object({
  /** The hub's id of the subscription event: stable, so a client can tell an event it already announced. */
  eventRef: z.string(),
  fanRef: clientFanRefSchema,
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  /** Open token; known values: CLIENT_AUDIENCE_NEW_KINDS. */
  kind: clientOpenToken,
  /** The subscription started as a free trial. */
  trial: z.boolean(),
  subscribedAt: isoTimestamp,
  /** Open token; known values: CLIENT_AUDIENCE_NEW_SUBSCRIBED_AT_SOURCES. */
  subscribedAtSource: clientOpenToken,
  /** The fan's subscription to this page as the hub holds it now. */
  status: z.object({
    /** The page's fan record; null while the hub holds no subscription of the fan. */
    isSubscriber: z.boolean().nullable(),
    /** Open token; known values: CLIENT_AUDIENCE_NEW_SUBSCRIPTION_STATUSES. */
    subscriptionStatus: clientOpenToken,
    /** Null too when the hub holds only the end of the period before the fan came back. */
    endsAt: isoTimestamp.nullable(),
    /** When the subscription's state was last written; null with `source: "none"`. */
    asOf: isoTimestamp.nullable(),
    /** Open token; known values: CLIENT_AUDIENCE_NEW_STATUS_SOURCES. */
    source: clientOpenToken,
  }),
  /** The chat with the fan as the hub stores it; null while it holds no chat with them. */
  thread: z.object({
    lastMessageAt: isoTimestamp.nullable(),
    lastFanMessageAt: isoTimestamp.nullable(),
    lastModelMessageAt: isoTimestamp.nullable(),
    /**
     * Messages of the chat the hub's chat record counts, automatic ones included.
     * NOT the number the Hi gate checks: that gate counts the transcript a
     * generation reads (the message archive), which can run ahead of this record.
     */
    storedMessageCount: count,
    /** Open token; known values: CLIENT_COVERAGE_LEVELS. */
    coverage: clientOpenToken,
    /** The chat's history was read from OnlyFans to its first message. */
    backfillComplete: z.boolean(),
  }).nullable(),
  /**
   * The newest message a person sent the fan by hand in the page's own
   * composer at or after `subscribedAt`, as the chat extension reported it
   * (send-attribution-v1, the client's clock); null when the hub knows none.
   * A greeting made without Hi: a client shows the fan as greeted. Automatic
   * welcomes and mass messages are never reported, so they never count.
   */
  lastPersonalSendAt: isoTimestamp.nullable(),
  claim: clientClaimSummarySchema,
});

export const clientAudienceNewResponseSchema = z.object({
  pageLabel: z.string(),
  /** Fixed by the first page of the walk and repeated on every later one. */
  window: z.object({
    hours: positive,
    from: isoTimestamp,
    to: isoTimestamp,
    /** Events the hub recorded after this moment are not in the walk. */
    snapshotAt: isoTimestamp,
  }),
  serverNow: isoTimestamp,
  /** Whether the hub can vouch that the window's list is whole and its rows' `status` current. */
  coverage: z.object({
    /** Open token; known values: CLIENT_COVERAGE_LEVELS. */
    state: clientOpenToken,
    /**
     * Up to when the page's notifications are checked: the provider's webhook delivery history (OFAPI), or, on a
     * page fed by ChatSpace, the last pass of the page's poll that read ChatSpace's notifications whole.
     */
    deliveryFrontier: isoTimestamp.nullable(),
    /** When the last subscriber sweep of the page completed. */
    lastAudienceSweepAt: isoTimestamp.nullable(),
    /** Open tokens, empty when complete; known values: CLIENT_AUDIENCE_NEW_COVERAGE_REASONS. */
    reasons: z.array(clientOpenToken),
  }),
  /**
   * Subscription events of the window that are not rows and that the hub
   * cannot account for: one it cannot classify, and one without a usable fan
   * id. Counted over the whole window, not the page. A top-fan award (OnlyFans
   * reports it as a subscription) is left out on purpose and is not counted.
   */
  unknownCount: count,
  /** The page's automatic welcome message as last collected; null until it is collected. */
  welcomeTemplate: z.object({
    /** The provider's id of the template: changes when a new one is saved. */
    ref: z.string(),
    observedAt: isoTimestamp,
    /** Whether OnlyFans sends it; null when the provider did not say. */
    enabled: z.boolean().nullable(),
    hasText: z.boolean(),
    hasMedia: z.boolean(),
    /** Its price; null when the provider gave none the hub can use. */
    priceMills: mills.nullable(),
  }).nullable(),
  items: z.array(clientAudienceNewItemSchema),
  /** Null on the last page of the walk. */
  nextCursor: clientCursorSchema.nullable(),
});

// ── who sent each outgoing message (send-attribution-v1) ────────────────────
//
// The chat extension observes each send a person makes in the platform page's
// own composer and, once the page's own response named the platform's message
// id, reports it: this message of this page, to this fan, observed then, with a
// price or media or neither. The chatter is the user of the token that reports,
// never a field of the body. No text of the message travels.

/**
 * The clients that observe a send, by the page they run on: the `source` of a
 * report. Open on the wire; a platform admits its own (the hub's
 * CLIENT_SEND_ATTRIBUTION_ADMISSIONS): OnlyFans `chatspace-extension`, the
 * extension on OnlyMonster ChatSpace; Fansly `fansly-extension`, the extension
 * on fansly.com. Another one is 409 `client_feature_disabled` /
 * `platform_unsupported`.
 */
export const CLIENT_SEND_ATTRIBUTION_SOURCES = ["chatspace-extension", "fansly-extension"] as const;
/**
 * How the text of a send was written (Chat Memory week 1): `hand` — typed, or
 * pasted by something other than our buttons; `reply`, `fix`, `hi`, `ping`,
 * `coach` — inserted by that AI button of the extension; `unknown` — the client
 * could not tell (a send it could not link to the draft). Open on the wire: a
 * value the hub does not know is stored as `unknown`.
 */
export const CLIENT_SEND_ATTRIBUTION_COMPOSED_WITH = ["hand", "reply", "fix", "hi", "ping", "coach", "unknown"] as const;
/**
 * What the hub did with one fact; every one is final, nothing is retried:
 * - `recorded`: the first report of this message; it is stored.
 * - `duplicate`: the message was already reported by the same person for the same fan: a repeat.
 * - `conflict`: the message was already reported by another person, or for another fan. The first
 *   report stands.
 * - `out_of_range`: `observedAt` is more than CLIENT_SEND_ATTRIBUTION_MAX_AHEAD_MS ahead of the hub's
 *   clock or more than CLIENT_SEND_ATTRIBUTION_MAX_AGE_DAYS old; nothing is stored.
 */
export const CLIENT_SEND_ATTRIBUTION_OUTCOMES = ["recorded", "duplicate", "conflict", "out_of_range"] as const;
/** Facts in one report. */
export const CLIENT_SEND_ATTRIBUTION_MAX_FACTS = 50;
/** How far ahead of the hub's clock an `observedAt` may be (a client clock that runs fast). */
export const CLIENT_SEND_ATTRIBUTION_MAX_AHEAD_MS = 5 * 60_000;
/** How old an `observedAt` may be: a report owed longer than that is not taken. */
export const CLIENT_SEND_ATTRIBUTION_MAX_AGE_DAYS = 30;
/** RFC 3339 with a zone, as `Date.prototype.toISOString` writes it. */
export const CLIENT_SEND_ATTRIBUTION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export type ClientSendAttributionSource = (typeof CLIENT_SEND_ATTRIBUTION_SOURCES)[number];
export type ClientSendAttributionComposedWith = (typeof CLIENT_SEND_ATTRIBUTION_COMPOSED_WITH)[number];
export type ClientSendAttributionOutcome = (typeof CLIENT_SEND_ATTRIBUTION_OUTCOMES)[number];

export const clientSendAttributionFactSchema = z.object({
  /** The platform's id of the message, from the page's own response to exactly this send. */
  platformMessageId: clientNumericIdSchema,
  /** The fan the message went to (on OnlyFans the fan id, which is the chat id). */
  fanRef: clientFanRefSchema,
  /**
   * The chat, where a platform's chats have ids of their own: Fansly's group id,
   * required from `fansly-extension`. On OnlyFans the chat is the fan: not sent.
   */
  conversationRef: clientNumericIdSchema.optional(),
  /** When the client saw the page confirm the send, by the client's clock. */
  observedAt: z.string().regex(CLIENT_SEND_ATTRIBUTION_TIMESTAMP_PATTERN),
  /** The send carried a price (a PPV). */
  priced: z.boolean(),
  /** The send carried media. */
  withMedia: z.boolean(),
  /** Open token; known values: CLIENT_SEND_ATTRIBUTION_COMPOSED_WITH. An older client sends none. */
  composedWith: clientOpenToken.optional(),
  /** The text inserted by an AI button was changed before the send. */
  edited: z.boolean().optional(),
}).strict();

export const clientSendAttributionsBodySchema = z.object({
  /** Open token; known values: CLIENT_SEND_ATTRIBUTION_SOURCES. */
  source: clientOpenToken,
  facts: z.array(clientSendAttributionFactSchema).min(1).max(CLIENT_SEND_ATTRIBUTION_MAX_FACTS),
}).strict();

export const clientSendAttributionsResponseSchema = z.object({
  pageLabel: z.string(),
  /** One per fact, in the order of the body. */
  results: z.array(z.object({
    platformMessageId: z.string(),
    /** Open token; known values: CLIENT_SEND_ATTRIBUTION_OUTCOMES. */
    outcome: clientOpenToken,
  })),
  serverNow: isoTimestamp,
});

// ── the OnlyFans feed from ChatSpace (onlyfans-feed-v1) ─────────────────────
//
// From 2026-11-01 the hub has no OnlyFansAPI. The chat extension on
// OnlyMonster ChatSpace passes on what the page itself already received for
// the chatter — the socket's frames and the answers of the page's own reads —
// and never asks OnlyFans or OnlyMonster anything to feed the hub. One report
// names one page (its OnlyFans creator and the OnlyMonster account the page
// showed it under) and carries records of seven kinds:
// - `message`: a message of a chat, in either direction, with its text (as
//   OnlyFans gave it, HTML), price, media and marks; `via` says where the
//   page got it (`socket`, `history` — a page of the open chat's history,
//   `chat_list` — the last message of a chat in the chat list); a fan's
//   message from the socket also carries the fan's own OnlyFans facts;
// - `deleted`: a message the socket said was deleted;
// - `ppv`: the socket said a fan bought a message or a post, for its gross price;
// - `tip`: the socket said a fan tipped, gross;
// - `fan`: a fan as the page's fan read gave it: names, subscription, and the
//   platform's own lifetime sums by type (gross dollars);
// - `chat`: a chat of the chat list: its unread count and last message;
// - `ledger`: a row of the page's sales ledger (OnlyMonster's id, gross, net,
//   OnlyFans' description, status — `undo` is a chargeback).
// Every record is journaled under the reporting person before anything is
// written; the hub dedups by OnlyFans' ids, so any number of tabs may report
// the same thing.

/** Records in one report. */
export const CLIENT_ONLYFANS_FEED_MAX_RECORDS = 200;
/** A message's text, as OnlyFans gave it (HTML), at most this long; a longer one is not sent. */
export const CLIENT_ONLYFANS_FEED_TEXT_MAX = 20_000;
/** Media items one message names. */
export const CLIENT_ONLYFANS_FEED_MEDIA_MAX = 60;
/** The largest single amount a record carries, in dollars. */
export const CLIENT_ONLYFANS_FEED_MONEY_MAX_DOLLARS = 100_000;
/** How far ahead of the hub's clock an `observedAt` may be, and how old: outside it a record is journaled only. */
export const CLIENT_ONLYFANS_FEED_MAX_AHEAD_MS = 5 * 60_000;
export const CLIENT_ONLYFANS_FEED_MAX_AGE_DAYS = 30;
/** Where the page got a message (open on the wire). */
export const CLIENT_ONLYFANS_FEED_VIAS = ["socket", "history", "chat_list"] as const;
/** The OnlyMonster account a report names: `onlymonster:<id>`. */
export const CLIENT_ONLYFANS_FEED_HOST_ACCOUNT_PATTERN = /^onlymonster:[1-9]\d{0,29}$/;
/** OnlyMonster's id of a ledger row, and the socket's id of a tip. */
export const CLIENT_ONLYFANS_FEED_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const feedTimestamp = z.string().regex(CLIENT_SEND_ATTRIBUTION_TIMESTAMP_PATTERN);
const feedDollars = z.number().finite().min(0).max(CLIENT_ONLYFANS_FEED_MONEY_MAX_DOLLARS);
const feedSignedDollars = z.number().finite()
  .min(-CLIENT_ONLYFANS_FEED_MONEY_MAX_DOLLARS).max(CLIENT_ONLYFANS_FEED_MONEY_MAX_DOLLARS);
const feedRef = z.string().regex(CLIENT_ONLYFANS_FEED_REF_PATTERN);

/** A fan's own OnlyFans facts, as the page received them (the fan read, or the socket's sender). Null — not given. */
export const clientOnlyfansFeedFanFactsSchema = z.object({
  username: z.string().max(100).nullable(),
  /** OnlyFans' `name`: the fan's own display name. */
  name: z.string().max(200).nullable(),
  /** OnlyFans' `displayName`: the creator's custom name for the fan. */
  displayName: z.string().max(200).nullable(),
  /** OnlyFans' `subscribedOn`: the fan is (or was) subscribed. */
  subscribedOn: z.boolean().nullable(),
  /** OnlyFans' `subscribedOnExpiredNow`. */
  subscribedOnExpiredNow: z.boolean().nullable(),
  subscribeAt: feedTimestamp.nullable(),
  /** The end of the current period: the renewal date while auto-renew is on. */
  expiredAt: feedTimestamp.nullable(),
  renewedAt: feedTimestamp.nullable(),
  /** `subscribedOnData.status` (`Set to Expire` — auto-renew is off). */
  subscriptionStatus: z.string().max(64).nullable(),
  subscribePrice: feedDollars.nullable(),
  regularPrice: feedDollars.nullable(),
  /** The platform's own lifetime sums of the fan on this page, gross dollars (`*Summ`); null — not given. */
  spend: z.object({
    tips: feedDollars.nullable(),
    subscriptions: feedDollars.nullable(),
    messages: feedDollars.nullable(),
    posts: feedDollars.nullable(),
    streams: feedDollars.nullable(),
    total: feedDollars.nullable(),
  }).strict().nullable(),
}).strict();

export const clientOnlyfansFeedMessageSchema = z.object({
  kind: z.literal("message"),
  messageRef: clientNumericIdSchema,
  fanRef: clientFanRefSchema,
  fromFan: z.boolean(),
  sentAt: feedTimestamp,
  /** When the page received it, by the client's clock. */
  observedAt: feedTimestamp,
  /** Open token; known values: CLIENT_ONLYFANS_FEED_VIAS. */
  via: clientOpenToken,
  textHtml: z.string().max(CLIENT_ONLYFANS_FEED_TEXT_MAX),
  /** The price of a priced message; on a tip, the tip. Null — none given. */
  price: feedDollars.nullable(),
  isFree: z.boolean().nullable(),
  isOpened: z.boolean().nullable(),
  isNew: z.boolean().nullable(),
  isTip: z.boolean(),
  tipText: z.string().max(2000).nullable(),
  mediaCount: z.number().int().min(0).max(1000).nullable(),
  media: z.array(z.object({
    ref: feedRef,
    /** Open token: `photo`, `video`, `gif`, `audio`. */
    type: clientOpenToken,
    canView: z.boolean().nullable(),
    duration: z.number().finite().min(0).max(86_400).nullable(),
  }).strict()).max(CLIENT_ONLYFANS_FEED_MEDIA_MAX),
  /** Sent by a queue (OnlyFans' `isFromQueue`: a mass message, an automation). */
  automatic: z.boolean().nullable(),
  /** OnlyFans' `changedAt`. */
  changedAt: feedTimestamp.nullable(),
  /** The fan's facts, when the fan is the sender and the page received them (the socket). */
  fan: clientOnlyfansFeedFanFactsSchema.nullable(),
}).strict();

export const clientOnlyfansFeedDeletedSchema = z.object({
  kind: z.literal("deleted"),
  messageRef: clientNumericIdSchema,
  observedAt: feedTimestamp,
}).strict();

export const clientOnlyfansFeedPpvSchema = z.object({
  kind: z.literal("ppv"),
  fanRef: clientFanRefSchema,
  /** Open token: `message` or `post`. */
  contentType: clientOpenToken,
  contentRef: clientNumericIdSchema,
  priceGross: feedDollars,
  observedAt: feedTimestamp,
}).strict();

export const clientOnlyfansFeedTipSchema = z.object({
  kind: z.literal("tip"),
  fanRef: clientFanRefSchema,
  tipRef: feedRef,
  amountGross: feedDollars,
  observedAt: feedTimestamp,
}).strict();

export const clientOnlyfansFeedFanSchema = clientOnlyfansFeedFanFactsSchema.extend({
  kind: z.literal("fan"),
  fanRef: clientFanRefSchema,
  observedAt: feedTimestamp,
}).strict();

export const clientOnlyfansFeedChatSchema = z.object({
  kind: z.literal("chat"),
  fanRef: clientFanRefSchema,
  unreadCount: z.number().int().min(0).max(1_000_000).nullable(),
  lastMessageRef: clientNumericIdSchema.nullable(),
  observedAt: feedTimestamp,
}).strict();

export const clientOnlyfansFeedLedgerSchema = z.object({
  kind: z.literal("ledger"),
  /** OnlyMonster's id of the row. */
  transactionRef: feedRef,
  fanRef: clientFanRefSchema.nullable(),
  createdAt: feedTimestamp,
  amountGross: feedSignedDollars,
  amountNet: feedSignedDollars,
  /** OnlyFans' description, as plain text («Tip from …», «Payment for message from …»). */
  description: z.string().max(500),
  /** Open; `undo` — a chargeback. */
  status: z.string().max(64).nullable(),
  observedAt: feedTimestamp,
}).strict();

/**
 * A new subscriber, as ChatSpace's notifications list (`type=subscribed`)
 * shows OnlyFans' notification of it: the poll's read (`clientOnlyfansPoll`).
 */
export const clientOnlyfansFeedSubscriberSchema = z.object({
  kind: z.literal("subscriber"),
  /** The notification's id. */
  notificationRef: feedRef,
  fanRef: clientFanRefSchema,
  /** OnlyFans' `subType`: `new_subscriber`, `new_subscriber_trial`, `returning_subscriber`. Null — not given. */
  subType: clientOpenToken.nullable(),
  /** The notification's own time. */
  createdAt: feedTimestamp,
  observedAt: feedTimestamp,
}).strict();

export const clientOnlyfansFeedRecordSchema = z.discriminatedUnion("kind", [
  clientOnlyfansFeedMessageSchema,
  clientOnlyfansFeedDeletedSchema,
  clientOnlyfansFeedPpvSchema,
  clientOnlyfansFeedTipSchema,
  clientOnlyfansFeedFanSchema,
  clientOnlyfansFeedChatSchema,
  clientOnlyfansFeedLedgerSchema,
  clientOnlyfansFeedSubscriberSchema,
]);

export const clientOnlyfansFeedBodySchema = z.object({
  /** The OnlyMonster account the page showed these under. */
  hostAccountRef: z.string().regex(CLIENT_ONLYFANS_FEED_HOST_ACCOUNT_PATTERN),
  /** The OnlyFans creator of that account: it must be the page's. */
  creatorRef: clientNumericIdSchema,
  records: z.array(clientOnlyfansFeedRecordSchema).min(1).max(CLIENT_ONLYFANS_FEED_MAX_RECORDS),
}).strict();

export const clientOnlyfansFeedResponseSchema = z.object({
  pageLabel: z.string(),
  /** Records new to the hub, journaled and written. */
  taken: z.number().int().min(0),
  /** Records the hub already had: nothing changed. */
  duplicates: z.number().int().min(0),
  /** Money records journaled but not written: the page's money has another writer for now. */
  held: z.number().int().min(0),
  /** Records observed outside the hub's window: journaled only. */
  outOfRange: z.number().int().min(0),
  serverNow: isoTimestamp,
});

/** How often the hub lends a page's poll, for the whole team: ChatSpace's own pace. */
export const CLIENT_ONLYFANS_POLL_EVERY_SECONDS = 600;
/** Pages of 20 one poll reads back at most, of each list. */
export const CLIENT_ONLYFANS_POLL_MAX_PAGES = 5;

export const clientOnlyfansPollBodySchema = z.object({
  hostAccountRef: z.string().regex(CLIENT_ONLYFANS_FEED_HOST_ACCOUNT_PATTERN),
  creatorRef: clientNumericIdSchema,
  /**
   * A report of the pass this caller just made while it held the page's poll, instead of an ask: each list `true`
   * when it was read back to the hub's cursor with no refusal. «Новые» on a page fed by ChatSpace vouch for their
   * list by it. A report lends nothing.
   */
  passed: z.object({ subscribers: z.boolean(), ledger: z.boolean() }).strict().optional(),
}).strict();

export const clientOnlyfansPollResponseSchema = z.object({
  pageLabel: z.string(),
  /** This caller holds the page's poll now: read each list once, back to its cursor. Else another tab does, or not yet. */
  granted: z.boolean(),
  /** Who holds it: the agency's always-on ChatSpace tab, a chatter's tab, or nobody. Open token. */
  holder: clientOpenToken.nullable(),
  /** When the page's next poll may be lent. */
  nextAt: isoTimestamp,
  /** The newest of each list the hub already holds: a poll reads back to it and no further. Null — nothing yet. */
  cursors: z.object({
    subscribers: z.string().max(64).nullable(),
    ledger: z.string().max(64).nullable(),
  }),
  /** Pages of each list one poll reads back at most. */
  maxPages: z.number().int().min(1),
  serverNow: isoTimestamp,
});

export type ClientOnlyfansPollBody = z.infer<typeof clientOnlyfansPollBodySchema>;
export type ClientOnlyfansPollResponse = z.infer<typeof clientOnlyfansPollResponseSchema>;
export type ClientOnlyfansFeedFanFacts = z.infer<typeof clientOnlyfansFeedFanFactsSchema>;
export type ClientOnlyfansFeedRecord = z.infer<typeof clientOnlyfansFeedRecordSchema>;
export type ClientOnlyfansFeedMessage = z.infer<typeof clientOnlyfansFeedMessageSchema>;
export type ClientOnlyfansFeedLedger = z.infer<typeof clientOnlyfansFeedLedgerSchema>;
export type ClientOnlyfansFeedBody = z.infer<typeof clientOnlyfansFeedBodySchema>;
export type ClientOnlyfansFeedResponse = z.infer<typeof clientOnlyfansFeedResponseSchema>;

// ── who wrote each fan note (note-attribution-v1) ───────────────────────────
//
// Fansly notes live on Fansly; the hub reads them in its sync
// (page_fan_external_notes, by Fansly's note id) but never knew who wrote one.
// On OnlyFans the notes are OnlyMonster's own fan notes, which the hub does not
// sync. The chat extension writes notes through the page's own session; once
// the site confirmed a write, it reports one fact: this note of this fan,
// created, edited or deleted, from which control of the panel, and for a
// questionnaire write the labels of the fields it changed. The writer is the
// user of the token that reports, never a field of the body. No title or text
// of a note travels. `clientFanNoteAttributions` reads it back
// (note-attribution-read-v1): who created each note of a fan and who edited it
// last.

/** The clients that write notes and report them; open on the wire, a platform admits its own. */
export const CLIENT_NOTE_ATTRIBUTION_SOURCES = ["fansly-extension", "chatspace-extension"] as const;
/** What was written: a regular note (Fansly contentType 12000, the questionnaire included) or the fan's custom name (12002). */
export const CLIENT_NOTE_ATTRIBUTION_NOTE_KINDS = ["note", "custom_name"] as const;
export const CLIENT_NOTE_ATTRIBUTION_ACTIONS = ["created", "edited", "deleted"] as const;
/**
 * Which control of the extension's notes panel made the write: `quick` — the
 * quick-note box; `editor` — the text editor; `field` — one questionnaire field;
 * `fill` — the Goose's suggestions the chatter accepted; `undo` — taking back the
 * last accepted suggestion; `list` — a delete from the list; `name` — the custom
 * name field; `transfer` — the notes of the fan's old account moved onto this
 * account («Вставить сюда»). A value the hub does not know is stored as null.
 */
export const CLIENT_NOTE_ATTRIBUTION_ORIGINS = ["quick", "editor", "field", "fill", "undo", "list", "name", "transfer"] as const;
/** What the hub did with one fact; every one is final (the same words as send attribution). */
export const CLIENT_NOTE_ATTRIBUTION_OUTCOMES = ["recorded", "duplicate", "conflict", "out_of_range"] as const;
export const CLIENT_NOTE_ATTRIBUTION_MAX_FACTS = 50;
export const CLIENT_NOTE_ATTRIBUTION_MAX_AHEAD_MS = 5 * 60_000;
export const CLIENT_NOTE_ATTRIBUTION_MAX_AGE_DAYS = 30;
/** Questionnaire field labels one fact names, and the length of one. */
export const CLIENT_NOTE_ATTRIBUTION_MAX_FIELDS = 20;
export const CLIENT_NOTE_ATTRIBUTION_FIELD_MAX_CHARS = 100;

export type ClientNoteAttributionSource = (typeof CLIENT_NOTE_ATTRIBUTION_SOURCES)[number];
export type ClientNoteAttributionNoteKind = (typeof CLIENT_NOTE_ATTRIBUTION_NOTE_KINDS)[number];
export type ClientNoteAttributionAction = (typeof CLIENT_NOTE_ATTRIBUTION_ACTIONS)[number];
export type ClientNoteAttributionOrigin = (typeof CLIENT_NOTE_ATTRIBUTION_ORIGINS)[number];
export type ClientNoteAttributionOutcome = (typeof CLIENT_NOTE_ATTRIBUTION_OUTCOMES)[number];

export const clientNoteAttributionFactSchema = z.object({
  /** The client's own id of this write (8-4-4-4-12 hex): a repeat of a lost answer names it again. */
  eventId: z.string().regex(CLIENT_REQUEST_ID_PATTERN),
  /** The fan whose note it is (Fansly: the fan's account id; OnlyFans: the fan's numeric id). */
  fanRef: clientFanRefSchema,
  /** The note's id: Fansly's note id, as the hub's sync stores it; on OnlyFans, OnlyMonster's note id. */
  noteRef: clientNumericIdSchema,
  /** Known values: CLIENT_NOTE_ATTRIBUTION_NOTE_KINDS; another is 400. */
  noteKind: clientOpenToken,
  /** Known values: CLIENT_NOTE_ATTRIBUTION_ACTIONS; another is 400. */
  action: clientOpenToken,
  /** Open token; known values: CLIENT_NOTE_ATTRIBUTION_ORIGINS. */
  origin: clientOpenToken.optional(),
  /** A questionnaire write: the labels of the fields it changed (never their values). */
  fields: z.array(z.string().min(1).max(CLIENT_NOTE_ATTRIBUTION_FIELD_MAX_CHARS)).min(1).max(CLIENT_NOTE_ATTRIBUTION_MAX_FIELDS).optional(),
  /** When the site confirmed the write, by the client's clock. */
  observedAt: z.string().regex(CLIENT_SEND_ATTRIBUTION_TIMESTAMP_PATTERN),
}).strict();

export const clientNoteAttributionsBodySchema = z.object({
  /** Open token; known values: CLIENT_NOTE_ATTRIBUTION_SOURCES. */
  source: clientOpenToken,
  facts: z.array(clientNoteAttributionFactSchema).min(1).max(CLIENT_NOTE_ATTRIBUTION_MAX_FACTS),
}).strict();

export const clientNoteAttributionsResponseSchema = z.object({
  pageLabel: z.string(),
  /** One per fact, in the order of the body. */
  results: z.array(z.object({
    eventId: z.string(),
    /** Open token; known values: CLIENT_NOTE_ATTRIBUTION_OUTCOMES. */
    outcome: clientOpenToken,
  })),
  serverNow: isoTimestamp,
});

/** The most notes of one fan `clientFanNoteAttributions` answers, the latest written first. */
export const CLIENT_FAN_NOTE_ATTRIBUTIONS_MAX_NOTES = 200;

/** One person's write of a note, as the hub recorded it. */
export const clientNoteAttributionWhoSchema = z.object({
  userId: intId,
  /** The person's login, as the dashboard shows it. */
  name: z.string(),
  /** The caller themself. */
  isMe: z.boolean(),
  /** When the site confirmed the write, by the writer's client clock (the fact's `observedAt`). */
  at: isoTimestamp,
});

export const clientFanNoteAttributionsResponseSchema = z.object({
  pageLabel: z.string(),
  fanRef: clientFanRefSchema,
  /** The fan's notes the hub heard written and not deleted since, the latest written first. */
  notes: z.array(z.object({
    noteRef: z.string(),
    /** Open token; known values: CLIENT_NOTE_ATTRIBUTION_NOTE_KINDS. */
    noteKind: clientOpenToken,
    /** Who created it; null when its creation was never reported (written elsewhere, or before the extension reported). */
    created: clientNoteAttributionWhoSchema.nullable(),
    /** Who edited it last; null when nobody did through the extension. */
    edited: clientNoteAttributionWhoSchema.nullable(),
  })),
  serverNow: isoTimestamp,
});

// ── Chat Memory: activity and the shift (clientActivity, teamShifts) ─────────
//
// While a tab of a granted page is open, the extension's background beats once
// a minute with the pages it has open and how long ago the person was last
// active on each (a key, a click, a scroll; no content); its last tab closing,
// or the person signing out, sends one more beat with `closed`. The hub keeps
// the minutes and computes the actual shift from them when it is read: in at
// the first active minute, a pause from the CHATTER_SHIFT_IDLE_PAUSE_MINUTES-th
// idle minute to the next activity, out when the extension closes (or stays
// silent CLIENT_ACTIVITY_LOST_MINUTES) or after CHATTER_SHIFT_END_IDLE_MINUTES
// without activity.

/** How often the extension beats while a tab of a granted page is open. */
export const CLIENT_ACTIVITY_BEAT_SECONDS = 60;
/** Pages one beat may name. */
export const CLIENT_ACTIVITY_MAX_PAGES = 20;
/** The longest idle a beat may report: older activity is not news. */
export const CLIENT_ACTIVITY_MAX_IDLE_MS = 24 * 60 * 60_000;
/** An install silent this long is gone: its shift ended at its last beat. */
export const CLIENT_ACTIVITY_LOST_MINUTES = 3;
/** Idle minutes that still count as work; from this one on it is a pause. */
export const CHATTER_SHIFT_IDLE_PAUSE_MINUTES = 10;
/** Idle minutes that end a shift, the extension open or not. */
export const CHATTER_SHIFT_END_IDLE_MINUTES = 60;
/** The longest window `teamShifts` reads. */
export const CHATTER_SHIFTS_MAX_WINDOW_DAYS = 7;

export const clientActivityBodySchema = z.object({
  /** The install of the extension (its own stable id), so two browsers of one person are two installs. */
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  pages: z.array(z.object({
    pageLabel: pageLabelSchema,
    /** Milliseconds since the person was last active on this page's tabs; null — not since they opened. */
    idleMs: z.number().int().min(0).max(CLIENT_ACTIVITY_MAX_IDLE_MS).nullable(),
  }).strict()).max(CLIENT_ACTIVITY_MAX_PAGES),
  /** The last tab closed or the person signed out: this beat closes the install. */
  closed: z.boolean().optional(),
}).strict();

export const clientActivityResponseSchema = z.object({
  /** Pages of the beat that were recorded; a page that is not the caller's is skipped. */
  recorded: z.number().int().nonnegative(),
  serverNow: isoTimestamp,
});

// ── The always-on ChatSpace tab (clientChatspaceTabState) ─────────────────────
//
// The server's ChatSpace tab (apps/chatspace-browser; the extension knows it by
// its managed storage `serverTab`) reports once a minute what only the tab
// sees: ChatSpace signed in or on its sign-in page, the view it sits on, and
// for each OnlyMonster account open in it whether ChatSpace's socket covers it
// now. The hub keeps the last report of the server's own hub user
// (CHATSPACE_SERVER_USERNAME) and pages the owner when the reports stop, the
// tab is signed out, an account of the user's pages is not covered, or the tab
// sits in a fan's chat. Another user's report is taken and dropped.

/** How often the server's tab reports. */
export const CHATSPACE_TAB_REPORT_SECONDS = 60;
/** OnlyMonster accounts one report may name. */
export const CHATSPACE_TAB_MAX_ACCOUNTS = 20;

export const chatspaceTabRouteSchema = z.enum(["overview", "list", "chat", "sign-in", "other", "none"]);

export const clientChatspaceTabStateBodySchema = z.object({
  /** The install of the extension (its own stable id). */
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  extensionVersion: z.string().min(1).max(32),
  /**
   * Where the tab sits: ChatSpace's Accounts Overview, an account's chat list,
   * a fan's chat (opening one marks it read on OnlyFans), the sign-in page
   * (OnlyMonster's session is gone), anything else; `none` — no ChatSpace tab.
   */
  route: chatspaceTabRouteSchema,
  accounts: z.array(z.object({
    /** OnlyMonster's account id. */
    hostAccountId: z.string().regex(/^[0-9]{1,30}$/),
    /** The hub page the account is bound to; null — none of the caller's. */
    pageLabel: pageLabelSchema.nullable(),
    /** ChatSpace's socket covers it now: authenticated, subscribed, its frames coming. */
    covered: z.boolean(),
    /** Since when `covered` holds (the browser's clock). */
    since: isoTimestamp,
    /** chatspace-tab-state-v2: ChatSpace has subscribed it on its socket (its own subscription set). */
    subscribed: z.boolean().optional(),
  }).strict()).max(CHATSPACE_TAB_MAX_ACCOUNTS),
  /**
   * chatspace-tab-state-v2: ChatSpace's socket itself, as the tap saw it — connecting, open or closed and since when
   * (the browser's clock), authenticated or not; `observable` false: its subscription set could not be read. Absent: no
   * ChatSpace tab said, or an extension before v2.
   */
  socket: z.object({
    state: z.enum(["connecting", "open", "closed"]),
    since: isoTimestamp,
    authed: z.boolean(),
    observable: z.boolean(),
  }).strict().optional(),
}).strict();

export const clientChatspaceTabStateResponseSchema = z.object({
  /** The caller is the server's hub user and its report was kept. */
  recorded: z.boolean(),
  serverNow: isoTimestamp,
});

export const teamShiftsQuerySchema = z.object({
  /** RFC 3339; default 24 hours before `to`. */
  from: z.string().datetime({ offset: true }).optional(),
  /** RFC 3339; default now. */
  to: z.string().datetime({ offset: true }).optional(),
  /** One page only. */
  pageLabel: pageLabelSchema.optional(),
});

export const teamShiftSchema = z.object({
  userId: intId,
  username: z.string(),
  startedAt: isoTimestamp,
  /** Still going: the end is the hub's now. */
  endedAt: isoTimestamp,
  ongoing: z.boolean(),
  workedMinutes: z.number().int().nonnegative(),
  pauses: z.array(z.object({ from: isoTimestamp, to: isoTimestamp })),
  /** Active minutes per page. */
  pages: z.array(z.object({ pageLabel: z.string(), activeMinutes: z.number().int().nonnegative() })),
  /** Messages with this person as author during the shift, on the pages in scope. */
  authoredMessages: z.number().int().nonnegative(),
});

export const teamShiftsResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  /** Newest first. */
  shifts: z.array(teamShiftSchema),
  serverNow: isoTimestamp,
});

// ── Chat Memory: «в разговоре» (clientInConversation) ───────────────────────
//
// Whoever wrote to a fan of the page in the last IN_CONVERSATION_MINUTES is «в
// разговоре» with him, for everyone else. The mark drops after that much
// silence, or once that person's extension closed (or went silent
// CLIENT_ACTIVITY_LOST_MINUTES) after their message. Nobody owns a fan: the
// mark is a warning a chatter can pass, never a block. Only messages with an
// author set it: a send from a phone or a mass message does not.

/** How long a message keeps its author «в разговоре» with the fan. */
export const IN_CONVERSATION_MINUTES = 15;

export const clientInConversationResponseSchema = z.object({
  pageLabel: z.string(),
  /** One per fan someone is talking to; the chatters newest first. */
  fans: z.array(z.object({
    fanRef: clientFanRefSchema,
    /** Fansly's group; null on OnlyFans, where the chat is the fan. */
    conversationRef: clientConversationRefSchema.nullable(),
    chatters: z.array(z.object({
      userId: intId,
      /** The person's login, as the dashboard shows it. */
      name: z.string(),
      /** The caller themself. */
      isMe: z.boolean(),
      lastSentAt: isoTimestamp,
      /** When the mark drops if nobody writes again. */
      until: isoTimestamp,
    })),
  })),
  serverNow: isoTimestamp,
});

// ── Chat Memory: the share of messages without an author (teamAuthorship) ───
//
// Per page and Moscow day: the page's personal outgoing messages (not a
// Fansly mass message, not a burst of one text to MASS_SEND_MIN_CHATS chats or
// more within an hour), how many have an author, and the same for the ones
// sent while some chatter had the extension open on the page («из браузеров
// команды»).

/** One text (with its price and files) sent to this many chats of a page within an hour is a mass message. */
export const MASS_SEND_MIN_CHATS = 5;

export const teamAuthorshipQuerySchema = z.object({
  /** Whole Moscow days back from today, today included. */
  days: z.coerce.number().int().min(1).max(CHATTER_SHIFTS_MAX_WINDOW_DAYS).default(7),
});

const authorshipCountsSchema = z.object({
  personal: z.number().int().nonnegative(),
  authored: z.number().int().nonnegative(),
  /** Sent while some chatter had the extension open on the page. */
  inShift: z.number().int().nonnegative(),
  inShiftAuthored: z.number().int().nonnegative(),
});

export const teamAuthorshipResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: z.string(),
    total: authorshipCountsSchema,
    /** Oldest first; a day without personal messages is left out. */
    days: z.array(authorshipCountsSchema.extend({ day: businessDate })),
    /** Messages with an author in the window, most first. */
    authors: z.array(z.object({ userId: intId, username: z.string(), messages: z.number().int().nonnegative() })),
  })),
  serverNow: isoTimestamp,
});

// ── Chat Memory week 6: «Покрытие» (teamEmptyHours) ──
//
// docs/plans/2026-10-24-chat-memory/week-6.md §В. Read-only over what Hub holds.

/** The longest window of the coverage analytics, Moscow days. */
export const TEAM_COVERAGE_MAX_DAYS = 31;

export const teamCoverageQuerySchema = z.object({
  /** Whole Moscow days back from today, today included. */
  days: z.coerce.number().int().min(1).max(TEAM_COVERAGE_MAX_DAYS).default(7),
});

export const teamEmptyHoursResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: z.string(),
    /** The page's first minute in the chat extension; null — nobody has worked on it in the extension: nothing counted. */
    shiftsSince: isoTimestamp.nullable(),
    /** Clock hours of the window (from `shiftsSince`) in which fans wrote. */
    hoursWithFans: count,
    /** Of them: no chatter had the extension open on the page in any minute. */
    emptyHours: count,
    /** `emptyHours` by Moscow hour of day, 0–23. */
    emptyByHour: z.array(count).length(24),
    /** Fans who wrote in an empty hour. */
    fans: count,
    /** Of them: paid on the page in the last 30 days. */
    payers: count,
    /** Of them: waited more than an hour for a personal reply (or still wait). */
    waitedOverHour: count,
    /** The 30-day net of those who waited: who waited, not lost money. */
    waitedNetMills: mills,
  })),
  serverNow: isoTimestamp,
});

/** The longest broadcast list of `teamGreetings`. */
export const TEAM_BROADCASTS_MAX = 100;

const broadcastCountsSchema = z.object({
  /** Chats a broadcast went to (a chat that got two counts twice). */
  deliveries: count,
  /** The fan wrote within 24 hours after it. */
  replied: count,
  /** The fan bought anything but a subscription on the page within 7 days after it. */
  bought: count,
});

export const teamGreetingsResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: z.string(),
    /** Subscriptions that started in the window. */
    newSubscribers: count,
    /** Of them: the page wrote within 2 minutes — an automatic welcome, not a person. */
    autoWelcomed: count,
    /** Of them: a personal message (not a mass message, not one text to 5+ chats an hour) 2 minutes to 24 hours after. */
    greeted: count,
    greetingMedianSeconds: count.nullable(),
    /** Of `greeted`: the fan wrote within an hour after the greeting. */
    repliedWithinHour: count,
    /** Bought anything but a subscription within 7 days of subscribing: greeted / not greeted. */
    boughtGreeted: count,
    boughtNotGreeted: count,
    /** Subscribed less than 7 days ago: their 7 days are not over yet. */
    recent: count,
    broadcasts: broadcastCountsSchema.extend({ sent: count }),
  })),
  /** One row per page, text and Moscow day, newest first; at most `TEAM_BROADCASTS_MAX`. */
  broadcasts: z.array(broadcastCountsSchema.extend({
    pageLabel: z.string(),
    sentAt: isoTimestamp,
    /** The start of the text (the model's own words). */
    preview: z.string(),
    priceMills: mills.nullable(),
    files: count,
    /** A Fansly mass message; otherwise one text to 5+ chats within an hour. */
    massMessage: z.boolean(),
    /** A priced one: bought by the fan (Hub's link to the message, or a message purchase at its price within 7 days). */
    ppvBought: count,
  })),
  serverNow: isoTimestamp,
});

// ── Chat Memory week 2: the fan's card (clientFanCard, clientFanLinkDecide) ──
//
// One card per person across pages: every account of the person (a Fansly fan
// is one account on every page; a new account or the other platform's joins by
// a chatter's «Да»), and on each page the team's alias with its marks (💵, ❌),
// the subscription and the money; and the facts from the chats. Pages the
// caller is not granted show only that: never a message or a note of theirs.
// Hub suggests accounts that may be the same person; a chatter decides.

/** «Same person» suggestions in one card. */
export const CLIENT_FAN_CARD_MAX_SUGGESTIONS = 5;
/** Why Hub suggests a pair; open on the wire. */
export const CLIENT_FAN_LINK_REASONS = ["same_alias", "same_username", "replaced_account"] as const;
export const CLIENT_FAN_LINK_DECISIONS = ["same", "different"] as const;

export const clientFanCardPageSchema = z.object({
  pageLabel: z.string(),
  platform: clientOpenToken,
  modelName: z.string().nullable(),
  /** The account of the person this row is about. */
  fanRef: clientFanRefSchema,
  /** The caller works this page. */
  granted: z.boolean(),
  /** The team's name for the fan on this page (Fansly «Custom Username»), with its marks. */
  alias: z.string().nullable(),
  subscribed: z.boolean(),
  subscribedSince: isoTimestamp.nullable(),
  subscriptionEndsAt: isoTimestamp.nullable(),
  /** Everything the fan paid on this page, gross. */
  spentMills: mills,
  /** The last 30 days, gross, by kind (subscription, tip, message_purchase, post_purchase, other). */
  last30Mills: z.record(z.string(), mills),
  lastPurchaseAt: isoTimestamp.nullable(),
});

const clientFanCardAccountSchema = z.object({
  platform: clientOpenToken,
  fanRef: clientFanRefSchema,
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  /** Gone or hidden on the platform, as far as Hub saw. */
  gone: z.boolean(),
});

/** The kinds of a fact from the chat; open on the wire. */
export const CLIENT_FAN_FACT_KINDS = ["about", "promise", "agreement"] as const;
/** The longest fact a chatter may write. */
export const CLIENT_FAN_FACT_MAX_CHARS = 500;
/** The longest quote of a fact's message in the card; longer text is cut with «…». */
export const CLIENT_FAN_FACT_QUOTE_MAX_CHARS = 280;

/** The archived message a fact comes from, as the chatter checks it. */
export const clientFanFactQuoteSchema = z.object({
  /** Its text, cut at CLIENT_FAN_FACT_QUOTE_MAX_CHARS; empty for a message of media only. */
  text: z.string(),
  /** `fan` or `model`; open on the wire. */
  from: clientOpenToken,
  at: isoTimestamp,
  /** It carries media (a photo, a video, a PPV). */
  media: z.boolean(),
});

export const clientFanFactSchema = z.object({
  id: intId,
  /** Open token; known values: CLIENT_FAN_FACT_KINDS. */
  kind: clientOpenToken,
  text: z.string(),
  pageLabel: z.string(),
  /** The caller works the fact's page: only then the message can be opened and the fact changed. */
  granted: z.boolean(),
  conversationRef: clientConversationRefSchema,
  /** The message the fact comes from. */
  messageRef: clientNumericIdSchema,
  messageAt: isoTimestamp.nullable(),
  /** `ai` — written by the facts lane; `chatter` — a chatter's correction. */
  source: clientOpenToken,
  /** The chatter who wrote it; null for the AI's. */
  author: z.string().nullable(),
  createdAt: isoTimestamp,
  /** The message it comes from, as archived; absent from an older Hub, null when the archive has no such message. */
  quote: clientFanFactQuoteSchema.nullable().optional(),
});

/** Chat Memory week 4: the states of a custom; open on the wire. */
export const CLIENT_FAN_CUSTOM_STATES = ["ordered", "paid", "delivered", "cancelled"] as const;

export const clientFanCustomSchema = z.object({
  id: intId,
  pageLabel: z.string(),
  /** The caller works the custom's page: only then it can be changed. */
  granted: z.boolean(),
  description: z.string(),
  priceMills: mills.nullable(),
  /** Open token; known values: CLIENT_FAN_CUSTOM_STATES. */
  state: clientOpenToken,
  /** What the payment the chatter took for it was. */
  paymentMills: mills.nullable(),
  paidAt: isoTimestamp.nullable(),
  deliveredMessageRef: clientNumericIdSchema.nullable(),
  deliveredAt: isoTimestamp.nullable(),
  createdBy: z.string(),
  createdAt: isoTimestamp,
  /** An open custom of a granted page: media the page sent in its chat since the payment, the newest first — «это он?». */
  deliveryCandidates: z.array(z.object({
    messageRef: clientNumericIdSchema,
    at: isoTimestamp,
    mediaCount: count,
    priceMills: mills.nullable(),
  })),
});

export const clientFanCardResponseSchema = z.object({
  pageLabel: z.string(),
  fanRef: clientFanRefSchema,
  /** Hub holds this fan; false — nothing is known yet and the lists are empty. */
  known: z.boolean(),
  /** The person's accounts, the asked one first. */
  accounts: z.array(clientFanCardAccountSchema.extend({
    /** Who said «Да» to this account; null for the asked one. */
    linkedBy: z.string().nullable(),
  })),
  /** Every page of every account, most paid first. */
  pages: z.array(clientFanCardPageSchema),
  /** Accounts that may be the same person, most paid first. */
  suggestions: z.array(clientFanCardAccountSchema.extend({
    /** Open token; known values: CLIENT_FAN_LINK_REASONS. */
    reason: clientOpenToken,
    /** The alias, username or name both share. */
    shared: z.string(),
    /** Where the shared alias or name is, when it is on a page. */
    sharedOn: z.string().nullable(),
    pages: z.array(clientFanCardPageSchema),
  })),
  /** What the person told and what was promised and agreed, on every page, the newest message first. Empty — «не знаю». */
  facts: z.array(clientFanFactSchema),
  /** Chat Memory week 4: the person's customs, the open first; ended ones for 30 days. */
  customs: z.array(clientFanCustomSchema),
  /** The fan's tips on the asked page in 30 days that no custom took: «это оплата кастома?». */
  customPayments: z.array(z.object({
    paymentRef: clientNumericIdSchema,
    amountMills: mills,
    at: isoTimestamp,
    note: z.string().nullable(),
  })),
  serverNow: isoTimestamp,
});

export const clientFanFactChangeBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete") }).strict(),
  z.object({ action: z.literal("correct"), text: z.string().trim().min(1).max(CLIENT_FAN_FACT_MAX_CHARS) }).strict(),
]);

export const clientFanFactChangeParamsSchema = z.object({
  pageLabel: pageLabelSchema,
  fanRef: clientFanRefSchema,
  factId: z.coerce.number().int().positive(),
});

export const clientFanCustomCreateBodySchema = z.object({
  description: z.string().trim().min(1).max(500),
  priceMills: mills.nonnegative().optional(),
  /** A tip of `customPayments`: the custom is paid by it. */
  paymentRef: clientNumericIdSchema.optional(),
}).strict();

export const clientFanCustomChangeBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("paid"), paymentRef: clientNumericIdSchema }).strict(),
  z.object({ action: z.literal("delivered"), messageRef: clientNumericIdSchema }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("edit"), description: z.string().trim().min(1).max(500), priceMills: mills.nonnegative().nullable() }).strict(),
]);

export const clientFanCustomParamsSchema = z.object({
  pageLabel: pageLabelSchema,
  fanRef: clientFanRefSchema,
  customId: z.coerce.number().int().positive(),
});

export const clientFanFactChangeResponseSchema = z.object({
  /** false — the fact was no longer active (changed by someone else first): nothing changed. */
  changed: z.boolean(),
  card: clientFanCardResponseSchema,
});

export const clientFanLinkDecideBodySchema = z.object({
  otherPlatform: clientOpenToken,
  otherFanRef: clientFanRefSchema,
  decision: z.enum(CLIENT_FAN_LINK_DECISIONS),
}).strict();

export const clientFanLinkDecideResponseSchema = z.object({
  /** The pair's decision as it stands: the first one wins. */
  decision: z.enum(CLIENT_FAN_LINK_DECISIONS),
  /** This request recorded it; false — the pair was decided before. */
  recorded: z.boolean(),
  card: clientFanCardResponseSchema,
});

// ── Fan marks (clientFanMarks) ───────────────────────────────────────────────
//
// Two warnings about the open Fansly fan in the chat header: «💩 Бомж» — a
// user list labelled «бомж» on any of the agency's Fansly pages holds him;
// «Блоклист» — a post of the Telegram group FANSLY BLOCKLIST (a community
// blacklist of Fansly members) names his profile. Hub reads both on its own
// schedule (each page's lists every 6 hours, the group every 10 minutes);
// this read asks no platform.

/** Blocklist posts one read lists at most, the newest first. */
export const CLIENT_FAN_MARKS_MAX_POSTS = 5;
/** A post's text is cut at this many characters, with «…». */
export const CLIENT_FAN_MARKS_POST_MAX_CHARS = 600;

export const clientFanMarksQuerySchema = z.object({
  /** The fan's current Fansly username as the page shows it. */
  username: z.string().min(1).max(64).optional(),
}).strict();

export const clientFanMarkListSchema = z.object({
  pageLabel: z.string(),
  modelName: z.string().nullable(),
  /** The caller works this page. */
  granted: z.boolean(),
  /** The list's label, trimmed («💩 Бомж»). */
  label: z.string(),
  /** When Hub first saw him in this list; null — unknown. */
  since: isoTimestamp.nullable(),
});

export const clientFanMarkPostSchema = z.object({
  postedAt: isoTimestamp,
  /** At most CLIENT_FAN_MARKS_POST_MAX_CHARS characters, cut with «…». */
  text: z.string(),
  /** The poster's display name; null — unknown. */
  author: z.string().nullable(),
  /** The post in Telegram (`https://t.me/c/<chat>/<message>`), for a member of the group. */
  link: z.string(),
  /** The profile as the post wrote it. */
  handle: z.string(),
});

export const clientFanMarksResponseSchema = z.object({
  pageLabel: z.string(),
  fanRef: clientFanRefSchema,
  /** His current memberships in «бомж» lists of every Fansly page: the asked page first, then by model. Empty on OnlyFans. */
  lists: z.array(clientFanMarkListSchema),
  /** Posts not deleted that name his username (the asked one or Hub's), the newest first, at most 5. Empty on OnlyFans. */
  blocklist: z.array(clientFanMarkPostSchema),
  /** The oldest last full read of the lists among the agency's active Fansly pages; null — not every page read yet. */
  listsReadAt: isoTimestamp.nullable(),
  /** The blocklist reader's last full read; null — the reader is off or never read. */
  blocklistReadAt: isoTimestamp.nullable(),
});

// ── Chat Memory week 3: win back (clientWinBack, clientWinBackAttempt) ──────
//
// A few fans per page to win back now, most paid first: a subscription ending
// without renewal, a new subscriber nobody wrote to personally, a payer silent
// for two weeks. Fans «в разговоре» and fans someone picked an approach for in
// the last week are left out. The chatter picks one of the owner's approaches
// with one tap and writes in their own words; Hub records the pick and counts
// the result (teamWinBackResults). Hub assigns nothing and credits no sale.

export const CLIENT_WIN_BACK_REASONS = ["expiring", "new_unattended", "silent"] as const;
/** Fans one read lists: a few per shift, never crowding out the ones who wait. */
export const CLIENT_WIN_BACK_MAX_ITEMS = 10;

export const clientWinBackApproachSchema = z.object({ id: intId, label: z.string() });

export const clientWinBackResponseSchema = z.object({
  pageLabel: z.string(),
  /** The owner's approaches, in their order. */
  approaches: z.array(clientWinBackApproachSchema),
  items: z.array(z.object({
    fanRef: clientFanRefSchema,
    conversationRef: clientConversationRefSchema.nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    /** The team's name for the fan on the page, with its marks. */
    alias: z.string().nullable(),
    lifetimeGrossMills: mills,
    /** Open token; known values: CLIENT_WIN_BACK_REASONS. */
    reason: clientOpenToken,
    /** When the reason began: the subscription's end, its start, the fan's last message. */
    reasonAt: isoTimestamp.nullable(),
  })),
  serverNow: isoTimestamp,
});

export const clientWinBackAttemptBodySchema = z.object({
  fanRef: clientFanRefSchema,
  approachId: intId,
}).strict();

export const clientWinBackAttemptResponseSchema = z.object({
  attemptId: intId,
  /** The fan leaves the list for a week; the next read shows the rest. */
  list: clientWinBackResponseSchema,
});

export const teamWinBackResultsQuerySchema = z.object({
  /** Picks of the last `days` Moscow days, today included. */
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const teamWinBackResultsResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  rows: z.array(z.object({
    approachId: intId,
    approach: z.string(),
    userId: intId,
    username: z.string(),
    attempts: count,
    /** Picks followed by a message of the chatter to the fan within 48 hours. */
    sent: count,
    /** A result is counted once its window is over: `matured*` is the denominator. */
    matured72h: count,
    replied72h: count,
    matured7d: count,
    bought7d: count,
    matured30d: count,
    spent30dMills: mills,
  })),
  serverNow: isoTimestamp,
});

export const teamWinBackApproachesResponseSchema = z.object({
  approaches: z.array(clientWinBackApproachSchema.extend({ sortOrder: z.number().int(), active: z.boolean() })),
});

export const teamWinBackApproachSaveBodySchema = z.object({
  /** Absent — a new approach. */
  id: intId.optional(),
  label: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
}).strict();

// ── «Онлайн» (clientOnline, clientOnlinePresence, clientOnlineAttempt) ─────
//
// The page's fans seen online in the last minutes, each with why to write now
// and with what, for the extension's window that goes through them one click
// per fan. Hub reads what it holds (presence, chats, spend, subscriptions),
// keeps the fans a chatter's tab saw online (Fansly: the creator's followers
// active lately; OnlyFans: whom OnlyMonster's ChatSpace found online), lends
// one tab of the team at a time the page's bounded probe of its known spenders
// (`clientOnlineProbe`, OnlyFans, the owner's `onlineProbe`), and journals what
// the chatters did in the window. Hub sends nothing and assigns nobody.

/** Why to write now, the most urgent first. Open on the wire. */
export const CLIENT_ONLINE_REASONS = ["waiting", "new_unattended", "expiring", "silent", "quiet", "never_wrote", "none"] as const;
/** With what: Reply, Hi, Ping, or a text of the team's guide (A — talked before, B — never wrote). Open on the wire. */
export const CLIENT_ONLINE_ACTS = ["reply", "hi", "ping", "template_a", "template_b", "none"] as const;
/** Why a fan is not offered now, though a chatter may still write. Open on the wire. */
export const CLIENT_ONLINE_ASIDES = ["in_conversation", "wrote_recently", "attempted_recently", "dismissed", "unreachable"] as const;
export const CLIENT_ONLINE_ATTEMPT_ACTIONS = ["sent", "dismissed", "restored"] as const;
/** What a sent message was written with. */
export const CLIENT_ONLINE_SENT_ACTS = ["reply", "hi", "ping", "template"] as const;
export const CLIENT_ONLINE_DEFAULT_MINUTES = 30;
export const CLIENT_ONLINE_MAX_MINUTES = 180;
/** Fans one read lists at most: the newest activity first. */
export const CLIENT_ONLINE_MAX_ITEMS = 200;
/** Fans one presence report names at most (a Fansly `followersnew` page is 100). */
export const CLIENT_ONLINE_PRESENCE_MAX = 200;
/** Fans one probe names at most: one `fans-online` request of ChatSpace's own size. */
export const CLIENT_ONLINE_PROBE_MAX = 400;
/** One probe of a page this often at most, for the whole team: ChatSpace's own pace of its online poll. */
export const CLIENT_ONLINE_PROBE_EVERY_SECONDS = 300;

export const clientOnlineQuerySchema = z.object({
  /** The presence window: fans whose last activity is at most this many minutes old. */
  minutes: z.coerce.number().int().min(5).max(CLIENT_ONLINE_MAX_MINUTES).default(CLIENT_ONLINE_DEFAULT_MINUTES),
}).strict();

export const clientOnlineItemSchema = z.object({
  fanRef: clientFanRefSchema,
  /** The fan's primary chat (on Fansly the group); null — none known yet. */
  conversationRef: clientConversationRefSchema.nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  /** The team's name for the fan on the page, with its marks. */
  alias: z.string().nullable(),
  /** The name a guide's text puts instead of «love»: from the fan's profile name or nick; null — keep «love». */
  greetingName: z.string().nullable(),
  lifetimeGrossMills: mills,
  last30dGrossMills: mills,
  /** The fan's last activity Hub knows. */
  seenAt: isoTimestamp.nullable(),
  /** OnlyFans: online now by OnlyFansAPI's own state, since this moment (it says offline ~30 minutes late). */
  onlineSince: isoTimestamp.nullable(),
  /** Where `seenAt` came from. Open token. */
  seenSource: clientOpenToken.nullable(),
  /** Open token; known values: CLIENT_ONLINE_REASONS. */
  reason: clientOpenToken,
  /** When the reason began: the fan's message, the subscription's start or end, the fan's last message. */
  reasonAt: isoTimestamp.nullable(),
  /** Open token; known values: CLIENT_ONLINE_ACTS. */
  act: clientOpenToken,
  /** Open token; known values: CLIENT_ONLINE_ASIDES; null — offered. */
  aside: clientOpenToken.nullable(),
  /** When the aside began: the last message or send, the mark. */
  asideAt: isoTimestamp.nullable(),
  /** Who: the chatters «в разговоре» with the fan, or who marked «Не предлагать». */
  asideBy: z.string().nullable(),
  /** Messages of the primary chat in the archive, counted up to 10 (Ping's minimum). */
  messageCount: count,
  lastFanMessageAt: isoTimestamp.nullable(),
  /** The page's last personal message to the fan (no mass message). */
  lastPageMessageAt: isoTimestamp.nullable(),
  subscription: z.object({
    isSubscriber: z.boolean(),
    startedAt: isoTimestamp.nullable(),
    endsAt: isoTimestamp.nullable(),
    autoRenew: z.boolean().nullable(),
  }),
});

/** A text of the team's reactivation guide, word for word; `love` is the place of the fan's name. */
export const clientOnlineTemplateSchema = z.object({
  id: z.string(),
  /** Open token: `a` (talked before), `b` (never wrote). */
  group: clientOpenToken,
  text: z.string(),
});

export const clientOnlineResponseSchema = z.object({
  pageLabel: z.string(),
  minutes: z.number().int(),
  /** The most urgent reason first, the offered before the set aside, then the newest activity. */
  items: z.array(clientOnlineItemSchema),
  templates: z.array(clientOnlineTemplateSchema),
  serverNow: isoTimestamp,
});

export const clientOnlinePresenceBodySchema = z.object({
  /**
   * Fans the tab saw online and when: on Fansly the creator's followers active lately (`followersnew?lastSeenAfter=`
   * in the chatter's own session), on OnlyFans the fans ChatSpace's own online poll found online (when it asked).
   */
  seen: z.array(z.object({
    fanRef: clientFanRefSchema,
    lastSeenAt: z.string().datetime({ offset: true }),
  }).strict()).min(1).max(CLIENT_ONLINE_PRESENCE_MAX),
}).strict();

export const clientOnlinePresenceResponseSchema = z.object({
  /** Fans of the page whose presence was kept; the rest are not linked to the page (yet) or were in the future. */
  recorded: count,
  skipped: count,
  serverNow: isoTimestamp,
});

export const clientOnlineProbeBodySchema = z.object({}).strict();

export const clientOnlineProbeResponseSchema = z.object({
  /** This caller holds the page's probe now: ask about `fanRefs` once, report who is online. Else another tab does. */
  granted: z.boolean(),
  /** The page's known spenders to ask about, the most paid first; empty unless granted. */
  fanRefs: z.array(clientFanRefSchema).max(CLIENT_ONLINE_PROBE_MAX),
  /** When the page's next probe may be lent. */
  nextAt: isoTimestamp,
  serverNow: isoTimestamp,
});

export const clientOnlineAttemptBodySchema = z.object({
  fanRef: clientFanRefSchema,
  /** `sent` — a message went from the window; `dismissed` — «Не предлагать»; `restored` — its undo. */
  action: z.enum(CLIENT_ONLINE_ATTEMPT_ACTIONS),
  /** With `sent`: what wrote the message. */
  act: z.enum(CLIENT_ONLINE_SENT_ACTS).optional(),
  /** With a template: its id (`A1`…`B5`). */
  templateId: z.string().min(1).max(32).optional(),
  /** Why the list offered the fan when the chatter acted (its `reason`). */
  reason: clientOpenToken.optional(),
}).strict();

export const clientOnlineAttemptResponseSchema = z.object({
  attemptId: intId,
});

// ── Chat Memory week 3: the shift handoff (clientHandoff) ───────────────────
//
// What the next chatter of a page needs at the start of the shift, with no
// «кого оставить?»: who is still in a conversation, whom the team wrote to in
// the last hours, who waits for a reply, and the open promises. Open customs
// come with week 4.

export const CLIENT_HANDOFF_HOURS = 12;

export const clientHandoffResponseSchema = z.object({
  pageLabel: z.string(),
  /** Fans someone wrote to in the last CLIENT_HANDOFF_HOURS, the latest first. */
  recent: z.array(z.object({
    fanRef: clientFanRefSchema,
    conversationRef: clientConversationRefSchema.nullable(),
    username: z.string().nullable(),
    alias: z.string().nullable(),
    lastSentAt: isoTimestamp,
    messages: count,
    chatters: z.array(z.string()),
    /** Someone is still «в разговоре» with the fan: their names. */
    inConversation: z.array(z.string()),
  })),
  /** Fans waiting for a reply (everyone who wrote in 30 days): the queue's total and its head. */
  waiting: z.object({
    total: count,
    head: z.array(z.object({
      fanRef: clientFanRefSchema,
      conversationRef: clientConversationRefSchema.nullable(),
      username: z.string().nullable(),
      alias: z.string().nullable(),
      lifetimeGrossMills: mills,
      lastFanMessageAt: isoTimestamp,
    })),
  }),
  /** Chat Memory week 4: the page's open customs (ordered or paid), the oldest payment first. */
  customs: z.array(z.object({
    fanRef: clientFanRefSchema,
    conversationRef: clientConversationRefSchema.nullable(),
    description: z.string(),
    state: clientOpenToken,
    paidAt: isoTimestamp.nullable(),
    createdAt: isoTimestamp,
  })),
  /** Open promises from the facts of the page's chats, the newest first; empty — «не знаю». */
  promises: z.array(z.object({
    fanRef: clientFanRefSchema,
    conversationRef: clientConversationRefSchema,
    text: z.string(),
    messageRef: clientNumericIdSchema,
    messageAt: isoTimestamp.nullable(),
  })),
  serverNow: isoTimestamp,
});

export const teamCustomsResponseSchema = z.object({
  /** Open customs (ordered or paid) of the pages the viewer reaches, the oldest payment first. */
  customs: z.array(z.object({
    id: intId,
    pageLabel: z.string(),
    fanRef: clientFanRefSchema,
    description: z.string(),
    priceMills: mills.nullable(),
    state: clientOpenToken,
    paidAt: isoTimestamp.nullable(),
    createdBy: z.string(),
    createdAt: isoTimestamp,
  })),
  serverNow: isoTimestamp,
});

/** Chat Memory week 4: a chatter's mark on a sale of the draft shift report. */
export const SHIFT_REPORT_MARKS = ["mine", "share", "not_mine"] as const;
/** How far back the cabinet's shift report reaches. */
export const SHIFT_REPORT_MAX_DAYS = 14;
/** The longest owner's window (disputes, export). */
export const SHIFT_REPORT_EXPORT_MAX_DAYS = 31;

export const shiftReportSaleSchema = z.object({
  saleRef: clientNumericIdSchema,
  pageLabel: z.string(),
  platform: clientOpenToken,
  /** Open token: subscription, tip, message_purchase, post_purchase, stream_tip. */
  kind: clientOpenToken,
  fanRef: clientFanRefSchema.nullable(),
  fanName: z.string().nullable(),
  /** The creator's net, as the payout sheet counts it. */
  netMills: mills,
  occurredAt: isoTimestamp,
  /** Who sent the PPV the fan bought, when Hub tied the purchase to a message with an author. */
  ppvSender: z.string().nullable(),
  /** The PPV message was found, but it has no author (a phone, another browser, an old client). */
  ppvWithoutAuthor: z.boolean(),
  /** Who wrote to the fan on the page in the 48 hours before the sale, most messages first. */
  writers: z.array(z.object({ username: z.string(), messages: count })),
  /** Personal messages to the fan in those 48 hours with no author. */
  withoutAuthor: count,
  /** The caller's confirmed report holds the sale: its mark is final. */
  confirmed: z.boolean(),
  myMark: z.object({
    /** Open token; known values: SHIFT_REPORT_MARKS. */
    mark: clientOpenToken,
    shareWithUserId: intId.nullable(),
    shareWith: z.string().nullable(),
    /** The chatter's own net for a «моё» sale, never above Hub's; null — Hub's. */
    amountMills: mills.nullable(),
    note: z.string().nullable(),
  }).nullable(),
  /** The other chatters' marks on the sale. */
  otherMarks: z.array(z.object({ username: z.string(), mark: clientOpenToken, shareWith: z.string().nullable() })),
});

export const accountShiftReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(SHIFT_REPORT_MAX_DAYS).default(7),
});

export const accountShiftReportResponseSchema = z.object({
  /** The caller's actual shifts (week 1) on the pages they work, the newest first, each with the sales on the pages they were active on. «Делим» is half each. */
  shifts: z.array(z.object({
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    ongoing: z.boolean(),
    pages: z.array(z.string()),
    sales: z.array(shiftReportSaleSchema),
    /** What the marks claim for the caller now; after confirmation — what the confirmed report's lines claim. */
    creditedMills: mills,
    /** Sales the caller must mark before confirming (after a confirmation — among `pending`). */
    unmarked: count,
    /** After a confirmation: sales that came later (a late transaction) and wait to be marked and confirmed too. */
    pending: count,
    confirmedAt: isoTimestamp.nullable(),
  })),
  /** Sales outside the caller's shifts that someone marked «делим» with the caller: agree or dispute. */
  sharedWithMe: z.array(shiftReportSaleSchema),
  /** Who worked the caller's pages lately: whom a sale can be shared with. */
  teammates: z.array(z.object({ userId: intId, username: z.string() })),
  serverNow: isoTimestamp,
});

export const accountShiftReportMarkBodySchema = z.object({
  saleRef: clientNumericIdSchema,
  mark: z.enum(SHIFT_REPORT_MARKS),
  /** Required for `share`: one of `teammates`. */
  shareWithUserId: intId.optional(),
  /** `mine` only: the chatter's own net for the sale, at most Hub's (else 400 `amount_above_net`). */
  amountMills: mills.nonnegative().nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
}).strict();

export const accountShiftReportConfirmBodySchema = z.object({
  /** The `startedAt` of the shift, as the report gave it. */
  startedAt: isoTimestamp,
}).strict();

export const accountShiftReportChangeResponseSchema = z.object({
  changed: z.boolean(),
  serverNow: isoTimestamp,
});

export const teamShiftDisputesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(SHIFT_REPORT_EXPORT_MAX_DAYS).default(14),
});

export const teamShiftDisputesResponseSchema = z.object({
  /** Sales whose marks do not agree, the unresolved first. */
  disputes: z.array(z.object({
    saleRef: clientNumericIdSchema,
    pageLabel: z.string(),
    platform: clientOpenToken,
    fanRef: clientFanRefSchema.nullable(),
    occurredAt: isoTimestamp,
    netMills: mills,
    /** Open token: `two_mine` (two «моё»), `share_not_agreed` («делим» not answered by the same «делим»), `conflicting` (any other mix of claims). */
    reason: clientOpenToken,
    marks: z.array(z.object({
      userId: intId,
      username: z.string(),
      mark: clientOpenToken,
      shareWithUserId: intId.nullable(),
      shareWith: z.string().nullable(),
      amountMills: mills.nullable(),
    })),
    /** Who the sale can be split between: the chatters who marked it and those it is shared with. */
    people: z.array(z.object({ userId: intId, username: z.string() })),
    /** The owner's split, percent of the net per chatter; null — not decided yet. */
    resolution: z.array(z.object({ userId: intId, username: z.string(), percent: z.number().int() })).nullable(),
  })),
  serverNow: isoTimestamp,
});

export const teamShiftResolveParamsSchema = z.object({ saleRef: clientNumericIdSchema });

export const teamShiftResolveBodySchema = z.object({
  /** Who gets what percent of the sale's net; the percents sum to 100. */
  shares: z.array(z.object({ userId: intId, percent: z.number().int().min(1).max(100) })).min(1).max(5),
}).strict();

export const teamShiftExportQuerySchema = z.object({
  /** Moscow dates, both included: the days the shifts started on. */
  from: businessDate,
  to: businessDate,
});

export const teamShiftExportResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** Confirmed reports only: chatter × page × the sale's day (the Moscow day the earliest shift holding it started — anyone's, by the extension's activity — else the sale's own day; it never moves, a sale is in one export only) → net credited (Fansly to the cent, OnlyFans whole dollars). */
  rows: z.array(z.object({
    username: z.string(),
    pageLabel: z.string(),
    platform: clientOpenToken,
    shiftDate: businessDate,
    creditedMills: mills,
  })),
  /** Disputed sales without the owner's decision: left out of `rows`. */
  disputedOpen: count,
  /** «Моё» sales a chatter credited with their own amount below Hub's net: in `rows` with that amount. */
  ownAmounts: z.array(z.object({
    username: z.string(),
    pageLabel: z.string(),
    saleRef: clientNumericIdSchema,
    occurredAt: isoTimestamp,
    netMills: mills,
    amountMills: mills,
  })),
  /** Shifts that began on the window's days and are not confirmed yet (`ongoing` — still going): their credits are not in `rows` yet. */
  unconfirmed: z.array(z.object({ username: z.string(), startedAt: isoTimestamp, endedAt: isoTimestamp, ongoing: z.boolean() })),
  /** Credits of the window's days written (`added`) or superseded by the owner's split (`removed`) more than a day after their day ended: a day exported before has changed by them. */
  lateChanges: z.array(z.object({
    username: z.string(),
    pageLabel: z.string(),
    saleRef: clientNumericIdSchema,
    occurredAt: isoTimestamp,
    payDay: businessDate,
    creditedMills: mills,
    change: z.enum(["added", "removed"]),
    at: isoTimestamp,
  })),
  serverNow: isoTimestamp,
});

/** Chat Memory week 5: the longest window of the chatter numbers. */
export const CHATTER_NUMBERS_MAX_DAYS = 31;

/** The eight numbers of a shift or a week (week-5.md §1); only messages with the chatter as their author count. */
export const chatterNumbersSchema = z.object({
  workedMinutes: count,
  /** Credited by confirmed shift reports; null — not confirmed (a week: the confirmed shifts only). */
  revenueMills: mills.nullable(),
  /** `revenueMills` per worked hour of the confirmed shifts. */
  revenuePerHourMills: mills.nullable(),
  fansWritten: count,
  /** Of `fansWritten`: paid on the page after the chatter's first message to them in the shift, before its end. */
  fansPaid: count,
  messages: count,
  ppvSent: count,
  ppvBought: count,
  ppvAveragePriceMills: mills.nullable(),
  /** `ppvSent / messages`; null without messages. */
  ppvShare: z.number().nullable(),
  /** The chatter's messages that answered a fan who was waiting. */
  replies: count,
  replyMedianSeconds: count.nullable(),
  repliesWithinHour: count,
  /** Fans whose last message at the shift's end was theirs (a week: the average per shift). */
  waitingAtEnd: count,
  composed: z.object({ hand: count, reply: count, fix: count, other: count }),
});

export const teamChatterNumbersQuerySchema = z.object({
  from: isoTimestamp.optional(),
  to: isoTimestamp.optional(),
});

export const teamChatterNumbersResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  chatters: z.array(z.object({
    userId: intId,
    username: z.string(),
    week: chatterNumbersSchema.extend({ shifts: count, unconfirmedShifts: count }),
    shifts: z.array(z.object({
      startedAt: isoTimestamp,
      endedAt: isoTimestamp,
      ongoing: z.boolean(),
      pages: z.array(z.string()),
      confirmed: z.boolean(),
      numbers: chatterNumbersSchema,
    })),
  })),
  serverNow: isoTimestamp,
});

// ── Chat Memory week 6 «Продажи» (docs/plans/2026-10-24-chat-memory/week-6.md) ──
//
// A: PPV conversion by chatter and price. Personal PPVs only (not a Fansly mass
// message, not a burst of one text to MASS_SEND_MIN_CHATS chats or more within
// an hour); by chatter only the ones with an author. Net, a guide, not pay.

/** The longest window of the sales analytics, days. */
export const TEAM_SALES_MAX_DAYS = 31;

/** Price buckets of a PPV: up to and including `upToMills`; the last one has no upper bound. */
export const PPV_PRICE_BUCKETS = [
  { key: "upTo10", upToMills: 10_000 },
  { key: "10to25", upToMills: 25_000 },
  { key: "25to50", upToMills: 50_000 },
  { key: "50to100", upToMills: 100_000 },
  { key: "over100", upToMills: null },
] as const;

export const teamSalesQuerySchema = z.object({
  /** Whole Moscow days back from today, today included. */
  days: z.coerce.number().int().min(1).max(TEAM_SALES_MAX_DAYS).default(30),
});

const ppvCountsSchema = z.object({
  sent: count,
  bought: count,
  /** Net of the bought ones. */
  netMills: mills,
});

/** Every bucket of PPV_PRICE_BUCKETS, in its order, empty ones included. */
const ppvByPriceSchema = z.array(ppvCountsSchema.extend({ bucket: z.string() }));

export const teamSalesPpvResponseSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: z.string(),
    total: ppvCountsSchema,
    byPrice: ppvByPriceSchema,
    /** The first PPV Hub knows of in each chat (a thread's history may be partial), by its price. */
    firstPpv: ppvByPriceSchema,
    /** Of `total.sent`: PPVs without an author. */
    withoutAuthor: count,
  })),
  chatters: z.array(z.object({
    userId: intId,
    username: z.string(),
    total: ppvCountsSchema,
    byPrice: ppvByPriceSchema,
  })),
  serverNow: isoTimestamp,
});

// B: reply time against purchases. A reply is the page's first personal message
// after the fan's; its delay runs from the first of the fan's messages it
// answers. Bought: a tip or a message, post or stream purchase of that fan on
// the page within 24 hours after the reply (a subscription renewal does not count).

/** Delay buckets of a reply: below `underSeconds`; the last one has no upper bound. */
export const REPLY_DELAY_BUCKETS = [
  { key: "under5m", underSeconds: 300 },
  { key: "5to15m", underSeconds: 900 },
  { key: "15to60m", underSeconds: 3600 },
  { key: "1to6h", underSeconds: 21_600 },
  { key: "over6h", underSeconds: null },
] as const;

const replyCountsSchema = z.object({
  replies: count,
  /** Of `replies`: the fan bought within 24 hours after the reply. */
  bought: count,
});

/** Every bucket of REPLY_DELAY_BUCKETS, in its order, empty ones included. */
const replyByDelaySchema = z.array(replyCountsSchema.extend({ bucket: z.string() }));

export const teamSalesRepliesResponseSchema = z.object({
  from: isoTimestamp,
  /** Replies up to here: 24 hours before now, so each one's day for a purchase is over. */
  to: isoTimestamp,
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: z.string(),
    total: replyCountsSchema,
    byDelay: replyByDelaySchema,
  })),
  /** Replies with an author only. */
  chatters: z.array(z.object({
    userId: intId,
    username: z.string(),
    total: replyCountsSchema,
    byDelay: replyByDelaySchema,
  })),
  serverNow: isoTimestamp,
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
      + "whether the fan's latest dossier on this page has exactly the full recap's text. With "
      + "`conversation-recaps-v1`, `conversationRef` names the conversation apart from the fan (on Fansly "
      + "the group id): the pair is checked before anything is read (409 `conversation_fan_mismatch` for "
      + "another fan's chat; required on a page whose chats have ids of their own, 400 without it), and only "
      + "recaps of that conversation stored about this fan, or keyed by the fan itself, are selected. Behind "
      + "the chat-extension `recap` switch: 409 `client_feature_disabled` with the reason.",
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
  clientConversationFeed: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "One conversation's messages from the hub's own stores, newest first, with a Ping summary on the first page",
    description: "Read-only and database-only: no platform request, no refresh, no queued work, so the chat is "
      + "never marked read on the platform. `fanRef` is the OnlyFans fan id, which is the chat id. The reader is "
      + "the one a generation uses: `source` is `union` (archive ∪ webhook store) on OnlyFans, `archive` on Fansly. "
      + "Rows come "
      + "newest first, `limit` (1 to 100) a page; a message deleted on the platform stays as a row with "
      + "`deleted: true` and an empty `text`. A request without `cursor` starts a walk and freezes it: "
      + "`snapshotRevision`, `asOf`, "
      + "`coverage`, `head` and `newestKnownAt` are the same on every page of the walk, and a message that "
      + "arrives meanwhile is not in it. `head` is the reader's newest live message, the `servedHead` a "
      + "generation's `context_v1` frame reports from the same stored state. `summary` comes on the first page "
      + "only: the Ping segment and the fan's silence, counted by the generation's own rule over the newest "
      + "`summaryWindow` messages (5 to 1500, 100 by default). `nextOlderCursor` is opaque, signed, and valid "
      + "only for the same page, fan and person on the same reader, until the archive is rebuilt, and for a "
      + "day after the walk's first page (taking a page does not renew a walk): "
      + "anything else is 400 `bad_request` with the reason `cursor_invalid`, and the client reads the first "
      + "page again. With `conversation-recaps-v1`, `conversationRef` names the conversation apart from the "
      + "fan (on Fansly the group id): the pair is checked before anything is read (409 "
      + "`conversation_fan_mismatch` for another fan's chat; required on a page whose chats have ids of their "
      + "own, 400 without it), the feed reads that conversation, `target` repeats it, and a cursor is valid "
      + "only for the same conversation and fan. With `coach-depth-v1`, `depthMarks` (1 to 8 counts, each 1 "
      + "to 5000, joined by commas) asks the first page for `depth`: how many messages the hub holds of the "
      + "conversation as an AI generation reads them, the time of the oldest, whether the history is whole, "
      + "and the time of the count-th newest message for each count it holds. Behind the chat-extension "
      + "`preview` switch: 409 `client_feature_disabled` with the reason.",
    params: clientPageFanParamsSchema,
    querystring: clientConversationFeedQuerySchema,
    response: {
      200: clientConversationFeedResponseSchema,
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
      + "record was never written, so a client bounds its repeats. With `conversation-recaps-v1`, "
      + "`conversationRef` names the conversation the generation was made in, apart from the fan (on Fansly "
      + "the group id): the pair is checked before the generation is read (409 `conversation_fan_mismatch` "
      + "for another fan's chat; required on a page whose chats have ids of their own, 400 without it), and "
      + "a generation of that conversation that names this fan is found too. Behind the chat-extension "
      + "`recap` switch: 409 `client_feature_disabled` with the reason.",
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
  clientAiUsageDaily: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The caller's own AI spend on one page, by day",
    description: "Read-only and database-only: no platform request, no queued work. Only the caller's own "
      + "ledger rows on the page of the path; an owner too reads only their own. `date` is the last of "
      + "`days` (1 to 7) calendar days in `timeZone` (Europe/Moscow by default); every day carries the "
      + "instants it was cut at. A day is `partial` while it is not over (`day_open`), while a generation "
      + "of it is still running (`open_reservations`), or when a cost in it is an estimate "
      + "(`approximate_cost`). `quota` is counted over the UTC day, not over `timeZone`. Refused with 400 "
      + "and a `reason`: `unknown_time_zone`, `date_in_future`, `date_too_old` (more than 8 days before "
      + "today in `timeZone`). Behind the chat-extension master switch and minimum version: 409 "
      + "`client_feature_disabled` with the reason (`disabled`, `client_outdated`, `not_granted`).",
    params: clientPageParamsSchema,
    querystring: clientAiUsageQuerySchema,
    response: {
      200: clientAiUsageResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientAiLimit: {
    auth: { kind: "apiKey" },
    tags: ["client"],
    summary: "The caller's personal daily AI limit and their AI spend today over all pages",
    description: "Read-only and database-only. The limit is the owner's, per Moscow day over all pages; "
      + "null when the caller has none. At the limit every AI generation of the caller answers 429 "
      + "`quota_denied` with reason `personal_daily_limit` and `retryAfterMs` until `resetsAt`.",
    response: {
      200: clientAiLimitResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  clientSpenderStats: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Spenders statistics of one page: 30 local days of money, tiers, silence, new payers, awaiting reply",
    description: "Read-only and database-only: no platform request, no queued work. The window is `windowDays` "
      + "(30) local dates of `timeZone`, today included up to `asOf`; money is gross integer mills, every "
      + "transaction state counted (`includedStates`), so with `timeZone=UTC` `totals.d30.grossMills` equals "
      + "the `/api/v2/spenders` `period=30d` total of the page at the same instant. `tiers` are the hub's "
      + "spender buckets by lifetime gross plus the remainders `untiered` and `unattributed`, and their "
      + "window gross sums to the window total. `silence` counts payers by whole days since the fan's last "
      + "text message, among the messages a generation of the page reads. What the hub cannot vouch for it "
      + "says in `coverage` (`complete`, `partial`, `unknown`, with reasons); an unknown number is null, "
      + "never 0. An answer is kept for up to 60 seconds: `asOf` is the instant it was counted at. Refused "
      + "with 400 and the `reason` `unknown_time_zone` for a zone that is not an IANA name the hub knows. "
      + "Behind the chat-extension `stats` switch: 409 `client_feature_disabled` with the reason.",
    params: clientPageParamsSchema,
    querystring: clientSpenderStatsQuerySchema,
    response: {
      200: clientSpenderStatsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientSpenderAwaitingReply: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The payers of one page whose fan waits for a reply, biggest spender first, a page at a time",
    description: "Read-only and database-only: no platform request, no queued work, so no chat is marked read on "
      + "the platform. A payer waits when the last fan message of the chat is later than the page's last "
      + "PERSONAL message there, or the page never wrote to him personally: a Fansly mass message, or one text "
      + "sent to 5 or more chats of the page within an hour (the last 30 days are sorted; an older message of "
      + "the page counts as personal), is not an answer. `everyone=true` takes every fan who wrote in the last "
      + "30 days, not only payers. A fan the page can no longer message (its own account lookup does not "
      + "find him, or an OnlyFans closed chat) is left out. The payers and the rule are those of `queueSummary` in the Spenders "
      + "statistics. Each row names the fan's primary chat (`conversationRef`) and the team's alias. Rows come "
      + "by lifetime gross, largest first, then the fan waiting longest, "
      + "`limit` (1 to 100, 50 by default) a page. `readState` is `unread`, `read` or `unknown`: a fan whose "
      + "read state the hub cannot tell is its own category, with a null `unreadCount`. `total` and "
      + "`unknown` count the whole queue at `asOf`; `loaded` counts the rows the walk has served so far. "
      + "Every page is read at its own instant: a fan whose place in the order does not change is served "
      + "exactly once, a fan answered meanwhile is not served, and a fan whose place changed can be met "
      + "twice. `nextCursor` is opaque, signed, and valid only for the same page and person, for an hour "
      + "after the page that carried it (every page carries a new one, so the hour bounds the gap between "
      + "two pages, not the walk): anything else is 400 `bad_request` with the reason `cursor_invalid`, and "
      + "the client reads the first page again. Behind the chat-extension `stats` switch: 409 "
      + "`client_feature_disabled` with the reason.",
    params: clientPageParamsSchema,
    querystring: clientSpenderAwaitingReplyQuerySchema,
    response: {
      200: clientSpenderAwaitingReplyResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanClaim: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The greeting lease and the send custody of one fan: claim, renew, release, dispatch, sent, failed, registerNativeSend",
    description: "Database-only: no platform request, no queued work; the hub never sends the message itself. "
      + "`fanRef` is the platform's fan id: on OnlyFans the fan id, which is the chat id; on Fansly the fan's "
      + "account id (18 to 19 digits, kept as text). Three facts per fan: the first greeting is "
      + "confirmed; one person and client install may hold the lease on working it out (`claim`, `renew`, "
      + "`release`: older clients; a greeting may be sent without one); one attempt holds the custody of a "
      + "part being sent (`dispatch`, then `sent` or `failed`). "
      + "A lease is refused while another person or install holds the fan (409 `claim_busy`), to everyone "
      + "but the greeting's owner once the fan is greeted (409 `greeting_done`), and to everyone while a "
      + "desktop new-follower command may have greeted the fan (409 `custody_held`). "
      + "`dispatch` decides in one transaction, in this order: a repeat of the same `attemptId` with the same "
      + "body only reads (never a second ticket), another body is 409 `attempt_conflict`; the owner's switches; "
      + "the rate (per person and platform: on OnlyFans 30 sends from the preview per 60 s, greetings and "
      + "replies together, `limits.previewSendPerMinute`; on Fansly 30 greetings per 60 s, "
      + "`limits.greetingSendPerMinute`; 429 `preview_send_rate_limited` with `retryAfterMs`); no send to "
      + "the fan in flight (409 `custody_held` while another dispatch is inside its ticket; one past its "
      + "ticket with no proof is set aside as unconfirmed and holds nothing); for a greeting, no desktop "
      + "new-follower command that greeted the fan (409 `greeting_done`) or may have (409 `custody_held`), "
      + "then either the confirmed greeting's owner and group (409 `greeting_done`, `generation_mismatch`), "
      + "or with no `leaseToken` no live lease of another person (409 `claim_busy`: the greeting is claimed "
      + "at the send), or with a `leaseToken` the caller's live lease (409 `claim_busy` while another person "
      + "or install holds the fan, `claim_expired` when there is no live lease or this install holds the fan "
      + "under another token than the one named); the part not sent yet (409 `part_already_sent`). It answers "
      + "a one-time `ticket` once. "
      + "The switches of a dispatch are the owner's stored `chatExtensionEnabled` and `chatExtensionFeatures`, "
      + "read under a row lock inside that transaction, so a change of them waits for the dispatch and holds "
      + "from the next one; a value that only the environment sets admits no dispatch. Past its ticket an "
      + "unreported dispatch reads `uncertain-held` (the outcome is unknown) until `sent`, a manual resolve, "
      + "or the next dispatch to the fan, which sets it aside as unconfirmed (it still reads `uncertain-held` "
      + "to its own sender, frees the fan and the part, and a late `sent` still lands on it unless its part "
      + "was sent or dispatched again since: 409 `attempt_conflict`). `sent` and `failed` come only from the "
      + "person and install that dispatched (409 `custody_not_owned`); `failed` only with proof the part never "
      + "went out, and only while the ticket lasts (409 `custody_held` after it: `uncertain-held` never "
      + "becomes `failed`). The proof is "
      + "`not_enqueued` (no request was made: the native queue never took the part, or the client's last "
      + "check before its own request refused it) or `native_rejected` with the platform's 4xx other than "
      + "401. Nothing else proves it: a 401, a 5xx, a timeout or a 2xx that says it failed (Fansly's `200` "
      + "with `success: false`) is no proof, and the send stays `uncertain-held` once the ticket is over. "
      + "`registerNativeSend` records a proven send from the composer, once per page and message, and frees "
      + "nobody's custody: a part whose send from the preview is unresolved stays held (409 `custody_held`). "
      + "A greeting is the exception in what it records, not in what it frees: the proof confirms the fan's "
      + "greeting (200, `greeting.source` `native-register`) while that part's send stays held, so the fan "
      + "never reads as not greeted after it. In the group `heldParts` lists only the parts nobody can vouch "
      + "for (`uncertain-held`); a part inside its ticket is in flight. "
      + "A group is an AI generation's (`generationRef`, `variant`, `partCount`) or, with `manual-greeting-v1`, "
      + "a manual one (`{kind: \"manual\", textFingerprint}`: a text with no generation, one part, the "
      + "sha256 of its exact text), answered as `generationRef` `manual:<textFingerprint>`, variant 0, one "
      + "part. What each platform admits (purpose, group, switches): on OnlyFans a greeting or a reply, an "
      + "AI or a manual group, `dispatch` needs `previewSend` and `newcomers` too for a greeting; on Fansly a greeting "
      + "only (a reply, `dispatch` or `registerNativeSend`, is 409 `client_feature_disabled` / "
      + "`platform_unsupported`), an AI or a manual group, `dispatch` needs `newcomers` and not `previewSend`. "
      + "The admission is decided after the repeat check, with the switches. `claim` and `renew` need "
      + "`newcomers` everywhere; "
      + "`release`, `sent` and `failed` end what the hub already admitted and need only the page grant; "
      + "`registerNativeSend` reports a send that already happened and needs only the page grant on a page of "
      + "a platform where the custody exists, with a purpose and group that platform admits: no switch, flag "
      + "or minimum version refuses it, and it admits no dispatch. The custody exists on a platform where "
      + "every switch of one of its sends exists: OnlyFans and Fansly. On Fansly the owner's switches are "
      + "the page's own row (`newcomers`; the `\"*\"` row never reaches a Fansly page). A refusal by the "
      + "switches is 409 `client_feature_disabled` with the reason.",
    params: clientPageFanParamsSchema,
    body: clientFanClaimBodySchema,
    response: {
      200: clientFanClaimResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: clientPreviewSendRateLimitedResponseSchema,
    },
  },
  clientFanClaimStatus: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The greeting, lease and custody state of one fan, read only",
    description: "Read-only and database-only: one snapshot, no lock, no write, never a ticket. The same answer "
      + "as the claim POST. The request names no client install, so the caller's own live lease reads `held` "
      + "by `you-elsewhere`; an idempotent `claim` with the lease's token answers `owned`. It names no attempt "
      + "either: `custody` is the fan's unresolved send (anyone's, `dispatching` or `uncertain-held`), and "
      + "while there is none, the caller's own last send to the fan dispatched from the preview, in the state "
      + "it ended (`sent`, `failed`, `resolved-sent`, `resolved-not-sent`). That is how a client that lost "
      + "track of its send learns of a manual resolve. Nobody else's finished send is shown. A desktop "
      + "new-follower command that OnlyFans confirmed reads as a confirmed greeting with the source "
      + "`desktop-outbox`. One whose outcome is unknown (queued, in flight, indeterminate, or failed without "
      + "proof it never left) may have greeted the fan and holds it the same way as a send nobody can vouch "
      + "for: while no send of the extension is unresolved, `custody` reads `uncertain-held` under the "
      + "command's id, and the fan never reads as free. Behind the chat-extension master switch and minimum "
      + "version, with no flag of its own, on a page of a platform where the custody exists (see the claim "
      + "POST): it answers while `previewSend` and `newcomers` are off. 409 "
      + "`client_feature_disabled` with the reason (`not_granted`, `platform_unsupported`, `disabled`, "
      + "`client_outdated`).",
    params: clientPageFanParamsSchema,
    response: {
      200: clientFanClaimResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientSendAttributions: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Report who sent outgoing messages: the caller sent these messages of the page from their browser",
    description: "Database-only: no platform request, no queued work; the hub never sends anything. The chat "
      + "extension observed a person's send from the platform page in their browser and the page's own response "
      + "named the platform's message id: one fact per message, at most 50 a report, all of the page in the path. "
      + "The chatter is the user of the token, never a field of the body; no text of a message travels or is "
      + "stored. Each fact is journaled in the capture journal before it is recorded. `source` names the client "
      + "that observed the sends and must be one the page's platform admits (OnlyFans: `chatspace-extension`; "
      + "Fansly: `fansly-extension`, whose every fact names its chat in `conversationRef`, else 400), else 409 "
      + "`client_feature_disabled` with the reason `platform_unsupported`. `composedWith` and `edited` say how "
      + "the text was written; an unknown `composedWith` is stored as `unknown`. "
      + "One row per message of a page, the first report wins: each fact is answered "
      + "`recorded`, `duplicate` (the same person already reported it for the same fan and chat), `conflict` "
      + "(another person, or another fan or chat, reported it first; nothing changes) or `out_of_range` (`observedAt` more than "
      + "5 minutes ahead of the hub's clock or more than 30 days old; nothing is stored). Every answer is final: "
      + "a client never repeats a fact the hub answered, and a repeat of a lost answer reads `duplicate`. "
      + "It needs only the page grant: a send that already happened is recorded whatever the owner's switches "
      + "and the minimum version say, like `registerNativeSend`. A page that is not an active page granted to "
      + "the caller is 409 `client_feature_disabled` with the reason `not_granted`.",
    params: clientPageParamsSchema,
    body: clientSendAttributionsBodySchema,
    response: {
      200: clientSendAttributionsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientOnlyfansFeed: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Pass on what an OnlyFans page's ChatSpace already received: messages, deletions, purchases, tips, fans, chats, the sales ledger",
    description: "Database-only: no platform request, no queued work; the hub never sends anything and the client "
      + "made no request of its own for it. The chat extension on OnlyMonster ChatSpace observed these on the page: "
      + "frames of the page's socket and answers of the page's own reads. At most 200 records a report, all of the "
      + "page in the path, whose OnlyFans creator `creatorRef` must be (or the owner bound `hostAccountRef` to it), "
      + "else 409 `client_feature_disabled` with the reason `binding_mismatch`. Each record is journaled in the "
      + "capture journal under the reporting person before anything is written, keyed by OnlyFans' ids and the "
      + "record's content: a record the hub already holds is a `duplicate` and changes nothing, so any number of "
      + "tabs may report the same thing. Messages reach the archive and the page's chats; purchases, tips and "
      + "ledger rows reach the page's transactions only while the page's transactions writer is `chatspace` "
      + "(else they are `held`: journaled, replayed when it becomes so), paired one to one so a purchase seen by "
      + "the socket, the ledger and an earlier writer counts once; fans reach the page's fans. A record observed "
      + "more than 5 minutes ahead of the hub's clock or more than 30 days ago is journaled only (`outOfRange`). "
      + "It needs the page's `ofFeed` switch: else 409 `client_feature_disabled` (`flag_off`, `not_granted`, …).",
    params: clientPageParamsSchema,
    body: clientOnlyfansFeedBodySchema,
    response: {
      200: clientOnlyfansFeedResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientOnlyfansPoll: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Ask for the page's poll of ChatSpace: its new subscribers and its sales ledger, lent to one tab of the team",
    description: "Database-only: the hub asks no platform. The owner allowed the extension light reads of ChatSpace, "
      + "ChatSpace's own requests at its own pace: the page's notifications of new subscribers and its sales ledger, "
      + "the first page of each every 10 minutes, read back to the newest the hub holds (`cursors`), at most "
      + "`maxPages` pages, never retried. The hub lends the page's poll to one tab of the team at a time: the "
      + "agency's always-on ChatSpace tab when it is there (it asked within the last 15 minutes), else the first tab "
      + "that asks once `nextAt` has passed. `granted: false` — another tab holds it or its time has not come. What "
      + "the poll reads goes through `clientOnlyfansFeed`. Behind the page's `ofPoll` and `ofFeed`; the report's "
      + "account must be the page's, else 409 `client_feature_disabled` (`binding_mismatch`).",
    params: clientPageParamsSchema,
    body: clientOnlyfansPollBodySchema,
    response: {
      200: clientOnlyfansPollResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientNoteAttributions: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Report who wrote fan notes: the caller created, edited or deleted these notes of the page's fans",
    description: "Database-only: no platform request, no queued work. The chat extension wrote a fan note "
      + "(a Fansly note; on OnlyFans, an OnlyMonster fan note) through the page's own session and the site "
      + "confirmed it: one fact per write, at most 50 a report, all of "
      + "the page in the path. The writer is the user of the token, never a field of the body; no title or text "
      + "of a note travels or is stored, only the note's id, its kind (`note`, `custom_name`), the action "
      + "(`created`, `edited`, `deleted`; another kind or action is 400), the panel control that made it "
      + "(`origin`, an unknown one stored as null) and, for a questionnaire write, the labels of the fields it "
      + "changed. Each fact is journaled in the capture journal before it is recorded. `source` must be one the "
      + "page's platform admits (Fansly: `fansly-extension`; OnlyFans: `chatspace-extension`), else 409 `client_feature_disabled` with the reason "
      + "`platform_unsupported`. One row per `eventId` of a page, the first report wins: `recorded`, `duplicate` "
      + "(the same person already reported this event for the same note and action), `conflict` (the event id "
      + "was reported with another person, note or action; nothing changes) or `out_of_range` (`observedAt` more "
      + "than 5 minutes ahead of the hub's clock or more than 30 days old; nothing is stored). Every answer is "
      + "final. It needs only the page grant. A page that is not an active page granted to the caller is 409 "
      + "`client_feature_disabled` with the reason `not_granted`.",
    params: clientPageParamsSchema,
    body: clientNoteAttributionsBodySchema,
    response: {
      200: clientNoteAttributionsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanNoteAttributions: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Who created each note of a fan and who edited it last, as the chat extension reported its writes",
    description: "Read-only and database-only: no platform request, no queued work, and no title or text of a "
      + "note (the hub holds none for this). A device token's, for an active page granted to the caller (else 409 "
      + "`client_feature_disabled` / `not_granted`); a cookie session is 403. No owner switch, like the report. "
      + "One item per note of the fan in the path that `clientNoteAttributions` heard written, the latest written "
      + "first, at most 200: `created` is the person of its `created` fact and `edited` the person of its latest "
      + "`edited` fact, each with their login (`name`), `isMe` for the caller and `at` (the fact's `observedAt`); "
      + "either is null when no such fact was reported. A note whose latest fact is `deleted` is left out. "
      + "`fanRef` is the fan's account id on Fansly and the fan's numeric id on OnlyFans; `noteRef` is the "
      + "platform's note id (OnlyFans: OnlyMonster's).",
    params: clientPageFanParamsSchema,
    response: {
      200: clientFanNoteAttributionsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientActivity: {
    auth: { kind: "apiKey" },
    tags: ["client"],
    summary: "The chat extension's beat: the pages it has open and how long ago the person was active on them",
    description: "Database-only: no platform request, no queued work. A device token's (a cookie session is 403). "
      + "Sent once a minute while a tab of a granted page is open, and once with `closed` when the last tab closes or "
      + "the person signs out. Each named page that is the caller's records its minute as open and the minute of "
      + "the last activity as active; a page that is not the caller's, or does not exist, is skipped. No content "
      + "of a page travels: only that a page was open and when the person was last active on it. The shift is "
      + "computed from these minutes (`teamShifts`).",
    body: clientActivityBodySchema,
    response: {
      200: clientActivityResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  clientChatspaceTabState: {
    auth: { kind: "apiKey" },
    tags: ["client"],
    summary: "The always-on ChatSpace tab's report: signed in or not, its view, the socket's coverage of each account",
    description: "Database-only: no platform request. A device token's (a cookie session is 403). Sent once a minute "
      + "by the server's ChatSpace tab (apps/chatspace-browser). The last report of the server's hub user is kept "
      + "and watched: the owner is paged when the reports stop, the tab is signed out of OnlyMonster, an account of "
      + "its pages is not covered by ChatSpace's socket, or the tab sits in a fan's chat. Another user's report is "
      + "answered `recorded: false` and kept nowhere. No content of a chat travels.",
    body: clientChatspaceTabStateBodySchema,
    response: {
      200: clientChatspaceTabStateResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamShifts: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "The actual shifts of the team, from the chat extension's activity",
    description: "A cabinet route for the owner and team leads (cookie session); read-only and database-only. A "
      + "shift starts at a person's first active minute in the extension, pauses from the 10th idle minute to the "
      + "next activity, and ends when the extension closes (or is silent 3 minutes) or after 60 idle minutes. The "
      + "owner reads every page, a team lead the pages assigned to them; `pageLabel` narrows to one page (404 for "
      + "a page that does not exist, 403 for one the viewer does not reach). The window is at most 7 days; a shift "
      + "that began before `from` is shown from `from`.",
    querystring: teamShiftsQuerySchema,
    response: {
      200: teamShiftsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  clientInConversation: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Who is talking to which fan of the page now: whoever wrote to him in the last 15 minutes",
    description: "Read-only and database-only: no platform request, no queued work. A device token's, for an active "
      + "page granted to the caller (else 409 `client_feature_disabled` / `not_granted`); a cookie session is 403. "
      + "A fan is listed while someone's message to him with an author (`clientSendAttributions`) is under 15 "
      + "minutes old, and that person's extension has not closed (or gone silent 3 minutes) since it. The caller "
      + "is listed too, marked `isMe`. A mark is a warning, never a block: nobody owns a fan.",
    params: clientPageParamsSchema,
    response: {
      200: clientInConversationResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  teamAuthorship: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "How many of each page's outgoing messages have an author, per day",
    description: "A cabinet route for the owner and team leads (cookie session); read-only and database-only. Per "
      + "page and Moscow day of the last `days`: the page's personal outgoing messages (not a Fansly mass "
      + "message, not one text sent to 5 or more chats of the page within an hour), how many have an author "
      + "(`clientSendAttributions`), and the same for the ones sent while some chatter had the extension open on "
      + "the page. The owner reads every page, a team lead the pages assigned to them.",
    querystring: teamAuthorshipQuerySchema,
    response: {
      200: teamAuthorshipResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamEmptyHours: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "Empty hours of each page and who waited in them",
    description: "The owner and team leads, for the pages they reach; read-only and database-only. Per page over the "
      + "last `days` Moscow days (at most 31), counted from the page's first minute in the chat extension: the clock "
      + "hours in which fans wrote, those with no chatter minute on the page (empty), by Moscow hour of day; the fans "
      + "who wrote in an empty hour, the payers among them (30 days), who waited over an hour for a personal reply "
      + "and their 30-day net.",
    querystring: teamCoverageQuerySchema,
    response: {
      200: teamEmptyHoursResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamGreetings: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "Greetings of new subscribers and replies to broadcasts",
    description: "The owner and team leads, for the pages they reach; read-only and database-only. Per page over the "
      + "last `days` Moscow days (at most 31): new subscribers, how many got the page's automatic welcome (within 2 "
      + "minutes) and a personal greeting (2 minutes to 24 hours, not a mass message or one text to 5+ chats within an "
      + "hour), how fast, how many replied within an hour and who bought within 7 days, greeted or not. Broadcasts — "
      + "Fansly mass messages and such bursts — per text and day: deliveries, replies within 24 hours, purchases "
      + "within 7 days.",
    querystring: teamCoverageQuerySchema,
    response: {
      200: teamGreetingsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  clientFanCard: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The fan's card across pages: the person's accounts, the team's alias and the money on every page, and accounts that may be the same person",
    description: "Read-only and database-only: no platform request, no queued work. A device token's, for an active "
      + "page granted to the caller (else 409 `client_feature_disabled` / `not_granted`); a cookie session is 403. "
      + "The person is the fan and every account a chatter linked to it. Each page row shows the team's alias with "
      + "its marks, the subscription and the money, also for pages the caller does not work (`granted: false`); "
      + "`facts` lists Hub's facts from the chats of every page, the newest first (empty means «не знаю»). Never a "
      + "message or a note of another page. Suggestions come from what Hub holds (the same «nick/country/age» "
      + "alias on a page of the same model, the same username on the other platform, a gone account that shares a "
      + "name and paid); a pair decided before is not suggested again. An unknown fan answers `known: false`.",
    params: clientPageFanParamsSchema,
    response: {
      200: clientFanCardResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanMarks: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Warnings about a Fansly fan: «бомж» lists of the agency's Fansly pages and FANSLY BLOCKLIST posts that name him",
    description: "Read-only and database-only: no platform request, no queued work. A device token's, for an active "
      + "page granted to the caller (else 409 `client_feature_disabled` / `not_granted`); a cookie session is 403. "
      + "`lists`: the fan's current memberships in a user list whose label says «бомж», on every active Fansly page "
      + "of the agency (also pages the caller does not work, `granted: false`), the asked page first, then by model; "
      + "Hub reads each page's lists every 6 hours. `blocklist`: posts of the Telegram group FANSLY BLOCKLIST, "
      + "read by Hub's own account, whose fansly.com link names the fan — `username` (the fan's current username "
      + "as the page shows it) or the username Hub holds, exactly, any case — not deleted, the newest first, at "
      + "most 5, each text cut at 600 characters. `listsReadAt` is the oldest last full read of the lists among the "
      + "active Fansly pages (null until every one read them); `blocklistReadAt` the reader's last full read (null "
      + "while it is off or never read). An OnlyFans page answers empty lists.",
    params: clientPageFanParamsSchema,
    querystring: clientFanMarksQuerySchema,
    response: {
      200: clientFanMarksResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanLinkDecide: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "A chatter decides whether a suggested account is the same person as the fan",
    description: "Database-only. A device token's, for an active page granted to the caller. Only a pair the fan's "
      + "card suggests right now is taken (else 409 `not_suggested`). `same` links the two accounts into one "
      + "person, `different` keeps the suggestion from coming back; the first decision of a pair stands and a "
      + "repeat reads `recorded: false`. The decider is the token's user. Answers the card as it is after it.",
    params: clientPageFanParamsSchema,
    body: clientFanLinkDecideBodySchema,
    response: {
      200: clientFanLinkDecideResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanFactChange: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "A chatter deletes or corrects a fact from the chat in one click",
    description: "Database-only. A device token's, for an active page granted to the caller; the fact must be one of "
      + "the fan's card and of a page the caller works (else 409 `client_feature_disabled` / `not_granted`, or "
      + "404 for a fact of another fan). `delete` removes it from the card; `correct` writes the chatter's text as "
      + "a new fact on the same message, which the facts lane never rewrites. A fact already changed by someone "
      + "else answers `changed: false`. Answers the card as it is after it.",
    params: clientFanFactChangeParamsSchema,
    body: clientFanFactChangeBodySchema,
    response: {
      200: clientFanFactChangeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientWinBack: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "A few fans of the page to win back now, with the owner's approaches",
    description: "Read-only and database-only: no platform request. A device token's, for an active page granted to "
      + "the caller (else 409 `client_feature_disabled` / `not_granted`). Up to 10 fans, most paid first, each with "
      + "the most urgent reason: `expiring` (a current subscription without renewal ends within 3 days), "
      + "`new_unattended` (subscribed within 7 days, no personal message since), `silent` (paid and silent for 14 "
      + "days). Fans someone wrote to in the last 15 minutes and fans with a pick in the last 7 days are left out.",
    params: clientPageParamsSchema,
    response: {
      200: clientWinBackResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientWinBackAttempt: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "A chatter picks a win-back approach for a fan of the list",
    description: "Database-only; the hub sends nothing. A device token's, for an active page granted to the caller. "
      + "The fan must be on the page's list right now and the approach active (else 409 `not_listed` / "
      + "`approach_inactive`). The pick is journaled, then recorded under the token's user with the reason the fan "
      + "was listed; its result is counted from the chatter's next message to the fan. Answers the list after it.",
    params: clientPageParamsSchema,
    body: clientWinBackAttemptBodySchema,
    response: {
      200: clientWinBackAttemptResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientOnline: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The page's fans seen online recently, why to write to each now, and with what",
    description: "Read-only and database-only: no platform request. A device token's, for an active page granted to "
      + "the caller (else 409 `client_feature_disabled` / `not_granted`). The fans whose last activity is at most "
      + "`minutes` old (5 to 180, 30 by default), and on OnlyFans the fans OnlyFansAPI holds online now, up to 200, "
      + "each with the most urgent reason: `waiting` (wrote last within 30 days, no personal answer since), "
      + "`new_unattended` (subscribed within 7 days, no personal message since), `expiring` (a current subscription "
      + "without renewal ends within 3 days), `silent` (paid, wrote before, nothing either way for 5 days), "
      + "`quiet` (the same, never paid), `never_wrote`, `none`. `act` is what to write with: Reply, Hi, Ping from 10 "
      + "messages of the chat, a text of the team's guide below that (A, or B for a fan who never wrote). `aside` "
      + "says why a fan is not offered now: another chatter is in a conversation with him, the page wrote within 48 "
      + "hours and he did not answer, the window, a fan queue or an outreach wrote within 21 days and he did not "
      + "answer, «Не предлагать», or "
      + "the platform says he cannot be written to. A mass message is never a personal one. `templates` are the "
      + "guide's texts word for word.",
    params: clientPageParamsSchema,
    querystring: clientOnlineQuerySchema,
    response: {
      200: clientOnlineResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientOnlinePresence: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The fans a chatter's tab saw online, kept as their presence",
    description: "Database-only; Hub asks no platform. A device token's, for an active Fansly or OnlyFans page "
      + "granted to the caller (else 409 `client_feature_disabled` / `not_granted`; another platform "
      + "`platform_unsupported`). Up to 200 fans with the moment each was seen: on Fansly when Fansly last saw the "
      + "follower, on OnlyFans when OnlyMonster's ChatSpace found the fan online. Only fans already linked to the "
      + "page are kept, a moment in the future is not. The report is journaled once, then each fan's presence moves "
      + "forward only; OnlyFansAPI's own presence of an OnlyFans page is read as before.",
    params: clientPageParamsSchema,
    body: clientOnlinePresenceBodySchema,
    response: {
      200: clientOnlinePresenceResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientOnlineProbe: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Lends one tab of the team the page's probe of who of its known spenders is online",
    description: "Database-only; Hub asks no platform and sends nothing. A device token's, for an active OnlyFans "
      + "page granted to the caller where the owner's `onlineProbe` is on (else 409 `client_feature_disabled` with "
      + "its reason). One tab of the whole team at a time, at most every 300 seconds a page: the first caller after "
      + "that is `granted` with up to 400 of the page's known spenders, the most paid first, to ask OnlyMonster about "
      + "once (one `fans-online` read of ChatSpace's own size) and report the online ones (`clientOnlinePresence`); "
      + "every other caller meanwhile gets `granted: false` and `nextAt`. A lent probe is never lent again before "
      + "`nextAt`, whatever became of it.",
    params: clientPageParamsSchema,
    body: clientOnlineProbeBodySchema,
    response: {
      200: clientOnlineProbeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientOnlineAttempt: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "What a chatter did with a fan in the «Онлайн» window",
    description: "Database-only; the hub sends nothing. A device token's, for an active page granted to the caller. "
      + "`sent` — a message went from the window (what wrote it, the template's id); a fan written to this way and "
      + "silent since is set aside for 21 days. `dismissed` — «Не предлагать» for the whole team, `restored` — its "
      + "undo; the latest wins. The fan must be linked to the page (else 409 `not_listed`). Journaled first, then "
      + "recorded under the token's user.",
    params: clientPageParamsSchema,
    body: clientOnlineAttemptBodySchema,
    response: {
      200: clientOnlineAttemptResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  teamWinBackResults: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "Win-back results by approach and chatter",
    description: "A cabinet route for the owner and team leads; read-only. For the picks of the last `days` on the "
      + "pages the viewer reaches: attempts, those followed by the chatter's message within 48 hours, and — once "
      + "each window is over — replies within 72 hours, purchases within 7 days and spend in 30 days.",
    querystring: teamWinBackResultsQuerySchema,
    response: {
      200: teamWinBackResultsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamWinBackApproaches: {
    auth: { kind: "owner-session" },
    tags: ["client"],
    summary: "The owner's list of win-back approaches, retired ones included",
    response: {
      200: teamWinBackApproachesResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamWinBackApproachSave: {
    auth: { kind: "owner-session" },
    tags: ["client"],
    summary: "The owner adds, renames, reorders or retires a win-back approach",
    description: "A retired approach (`active: false`) leaves the chatters' list and keeps its results.",
    body: teamWinBackApproachSaveBodySchema,
    response: {
      200: teamWinBackApproachesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientHandoff: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "The shift handoff of a page: who is in a conversation, whom the team wrote to, who waits, open promises",
    description: "Read-only and database-only: no platform request. A device token's, for an active page granted to "
      + "the caller (else 409 `client_feature_disabled` / `not_granted`). `recent`: fans with a message with an "
      + "author in the last 12 hours (up to 50), who wrote and whether someone is still «в разговоре»; `waiting`: "
      + "the awaiting-reply queue of every fan who wrote in 30 days (a mass message is not an answer), its total and "
      + "first 10; `promises`: the active `promise` facts of the page's chats (up to 30).",
    params: clientPageParamsSchema,
    response: {
      200: clientHandoffResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanCustomCreate: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "A chatter writes a custom into the fan's record, paid by one of the suggested tips or not yet",
    description: "Database-only. A device token's, for an active page granted to the caller. `paymentRef` must be one "
      + "of the card's `customPayments` (else 409 `not_suggested`); without it the custom waits for its payment. "
      + "Answers the card after it.",
    params: clientPageFanParamsSchema,
    body: clientFanCustomCreateBodySchema,
    response: {
      200: clientFanFactChangeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientFanCustomChange: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "A chatter marks a custom paid, delivered, cancelled, or edits it",
    description: "Database-only. A device token's; the custom must be of the fan's card and of a page the caller works. "
      + "`paid` takes a tip of `customPayments`, `delivered` a message of the custom's `deliveryCandidates` (else 409 "
      + "`not_suggested`). A delivered or cancelled custom is final: a change answers `changed: false`.",
    params: clientFanCustomParamsSchema,
    body: clientFanCustomChangeBodySchema,
    response: {
      200: clientFanFactChangeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  teamCustoms: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "Open customs of the pages the viewer reaches",
    description: "A cabinet route for the owner and team leads; read-only. Customs ordered or paid and not delivered, "
      + "the oldest payment first, up to 200.",
    response: {
      200: teamCustomsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  accountShiftReport: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller's draft shift reports: their shifts, the sales on their pages and the facts of each",
    description: "The chatter's cabinet; read-only. Shifts are week 1's actual shifts of the caller in the last `days`; "
      + "a shift's sales are the money fans paid on the pages the caller was active on during it. Hub credits no "
      + "sale: the marks are the people's.",
    querystring: accountShiftReportQuerySchema,
    response: {
      200: accountShiftReportResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  accountShiftReportMark: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller marks a sale of their shift «моё», «делим с …» or «не моё», maybe with their own amount",
    description: "The sale must be of one of the caller's shifts in the last 14 days, or shared with the caller (else 404). "
      + "A sale of a confirmed shift keeps its mark (409 `confirmed`). `share` needs `shareWithUserId` of `teammates`.",
    body: accountShiftReportMarkBodySchema,
    response: {
      200: accountShiftReportChangeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  accountShiftReportConfirm: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller confirms the report of an ended shift: its lines go to the payout export as they stand",
    description: "Every sale must be marked (409 `unmarked`); a going shift cannot be confirmed (409 `ongoing`). "
      + "Confirming twice answers `changed: false`.",
    body: accountShiftReportConfirmBodySchema,
    response: {
      200: accountShiftReportChangeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  teamShiftDisputes: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "Sales of the last days whose marks do not agree, with the owner's decision when made",
    description: "The owner and team leads, for the pages they reach. Two «моё», or «делим с X» that X did not answer with «делим» back.",
    querystring: teamShiftDisputesQuerySchema,
    response: {
      200: teamShiftDisputesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamShiftResolve: {
    auth: { kind: "owner-session" },
    tags: ["client"],
    summary: "The owner splits a disputed sale between chatters",
    description: "Owner only. The sale must be disputed (else 409 `not_disputed`); every chatter named must have marked it "
      + "or be named in a «делим» (else 400). Deciding again replaces the decision. The export takes the split instead of the chatters' lines.",
    params: teamShiftResolveParamsSchema,
    body: teamShiftResolveBodySchema,
    response: {
      200: accountShiftReportChangeResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  teamShiftExport: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "The payout export: confirmed shift reports as chatter × page × day → net",
    description: "The owner and team leads, for the pages they reach; read-only. The days are Moscow days the shifts "
      + "started on, at most 31. Disputed sales count only once the owner decided them.",
    querystring: teamShiftExportQuerySchema,
    response: {
      200: teamShiftExportResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamChatterNumbers: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "The eight numbers of each chatter's shifts and week",
    description: "The owner and team leads, for the pages they reach; read-only. Shifts are week 1's actual shifts that "
      + "started in [from, to) (default: the last 7 days, at most 31); only messages with the chatter as their author "
      + "count, revenue only from confirmed shift reports. A guide, not a basis for pay.",
    querystring: teamChatterNumbersQuerySchema,
    response: {
      200: teamChatterNumbersResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamSalesPpv: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "PPV conversion by page, chatter and price",
    description: "The owner and team leads, for the pages they reach; read-only, database only. Personal PPVs sent in the "
      + "last `days` Moscow days (default 30, at most 31): sent, bought and their net, by price bucket; the first PPV of "
      + "each chat by its price; by chatter only PPVs with an author. A guide, not a basis for pay.",
    querystring: teamSalesQuerySchema,
    response: {
      200: teamSalesPpvResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  teamSalesReplies: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "How fast the page answered a fan, against whether the fan bought within 24 hours",
    description: "The owner and team leads, for the pages they reach; read-only, database only. Replies of the last "
      + "`days` Moscow days (default 30, at most 31) up to 24 hours ago, by page and by chatter (replies with an author), "
      + "per delay bucket: how many and how many were followed by the fan's purchase within 24 hours. A guide.",
    querystring: teamSalesQuerySchema,
    response: {
      200: teamSalesRepliesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  clientAudienceNew: {
    auth: { kind: "apiKey", scope: "page" },
    tags: ["client"],
    summary: "Who subscribed to an OnlyFans page or came back, inside a window of hours, with each fan's greeting state",
    description: "Read-only and database-only: the hub's own collected subscription notifications and "
      + "projections; no platform request, no queued work, and no chat is marked read. One row per "
      + "subscription notification, newest first. `kind` is `new` (with `trial` for a free trial) or "
      + "`returning`; there is no renewal row, because OnlyFans sends no notification when a subscription "
      + "renews by itself. A subscription OnlyFans names new is `returning` when the hub holds an earlier "
      + "subscription of the fan. A notification the hub cannot classify and one without a usable fan id are "
      + "not rows: `unknownCount` counts them over the whole window. A top-fan award is not a row either and "
      + "is not counted. `subscribedAt` is the notification's time (to the minute) until a subscriber sweep "
      + "has read the same subscription's own start (`subscribedAtSource`). "
      + "`status` is the fan's subscription as the hub holds it now, with when "
      + "it was written (`asOf`) and by which collector; `thread` what the hub stores of the chat; `claim` "
      + "the states `clientFanClaimStatus` answers for the same fan and caller, where a greeting the desktop "
      + "sent counts as confirmed and a desktop command that may have greeted reads as custody "
      + "`uncertain-held`. `coverage` says whether the hub can vouch for the list (`complete`, "
      + "`partial`, `unknown`) and why not. `welcomeTemplate` is the page's automatic welcome message as last "
      + "collected, null until the owner switches its collection on. A request without `cursor` starts a "
      + "walk and fixes its window (`window`); a later page repeats the window and never shows a "
      + "subscription the hub learned of after `window.snapshotAt`. `cursor` is valid for the same page and "
      + "person for an hour: otherwise 400 `bad_request` with the reason `cursor_invalid`, and with another "
      + "`windowHours` than its walk's, `cursor_window_mismatch`; the client then reads the first page again. "
      + "Behind the chat-extension `newcomers` switch, on an OnlyFans page: 409 `client_feature_disabled` "
      + "with the reason.",
    params: clientPageParamsSchema,
    querystring: clientAudienceNewQuerySchema,
    response: {
      200: clientAudienceNewResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientSendCustodyResolve: {
    auth: { kind: "session", scope: "page" },
    tags: ["client"],
    summary: "Resolve a held chat-extension send by hand: sent or not sent, with a note",
    description: "A cabinet route for the owner and team leads (cookie session, a page they reach); no device "
      + "token reaches it and it is on no narrow-token list. Ends the custody of one attempt that is still "
      + "`dispatching` or `uncertain-held` (a send set aside as unconfirmed included), after the resolver "
      + "looked at the chat: `sent` (optionally with the "
      + "OnlyFans message id; the first part of a greeting then confirms the greeting) or `not_sent` (the part "
      + "may be sent again). `not_sent` waits for the attempt's ticket to run out: inside it the page may still "
      + "send the part (409 `conflict` with the reason `ticket_live`). Audited as "
      + "`client.send_custody_resolved` in the same transaction. Idempotent: the same resolve again answers "
      + "the same and writes nothing. 404 for an attempt that is not of this page; 409 `conflict` with the "
      + "reason `custody_not_held` for one already reported sent or failed; 409 `attempt_conflict` for one "
      + "resolved otherwise, a message id another send already carries, or `sent` of a set-aside send whose "
      + "part was sent or dispatched again since.",
    params: clientSendCustodyParamsSchema,
    body: clientSendCustodyResolveBodySchema,
    response: {
      200: clientSendCustodyItemSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  clientSendCustodyList: {
    auth: { kind: "session" },
    tags: ["client"],
    summary: "Held chat-extension sends of the pages the viewer reaches, and the ones resolved by hand",
    description: "A cabinet route for the owner and team leads (cookie session); no device token reaches it and it "
      + "is on no narrow-token list. Read-only and database-only: it asks OnlyFans nothing and queues nothing. "
      + "`state=held` (the default) lists the sends past their ticket that nobody ended (`uncertain-held`), the "
      + "longest held first; a send still inside its ticket is in flight and is not listed. `state=resolved` lists "
      + "the sends ended by hand, the last resolved first, each with its resolver, time, outcome and note. The "
      + "owner reads every active page, a team lead the pages assigned to them; `pageLabel` narrows the list to one "
      + "page (404 for a page that does not exist, 403 for one the viewer does not reach). Each item names the "
      + "page, the fan, the purpose, the part of its group, the attempt, who dispatched it and from which client "
      + "install, when, and whether the fan's greeting is on record. No text of any message is served: the "
      + "custody tables hold none, and the hub does not know which text went out. `generationRef` names the AI "
      + "generation the text came from; its record stays the owner's alone, on "
      + "`GET /api/v1/ai/restricted/generations/:generationRef`. `limit` and `offset` page the list; `total` "
      + "counts the whole of it.",
    querystring: clientSendCustodyListQuerySchema,
    response: {
      200: clientSendCustodyListResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminClientHealth: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Owner view of the chat extension's health: speed, host contract, counters and footprint by client version",
    description: "Read-only and database-only, over the hourly `client_health` rollups, which hold no user, page, "
      + "fan or device: the view names no person. Reports are filed under the hour the hub received them; the range "
      + "is whole days of `range.timeZone`. Percentiles are read off buckets merged over the range. A group with "
      + "fewer than `minGroupSize` observations in the range asked for shows its size and no mean, maximum or "
      + "percentile. That floor is on the range of one read and no narrower: the mean and the maximum of a few "
      + "observations can be worked out from two reads of larger ranges, so it keeps a thin figure from being read "
      + "as the version's and does not seal a small group off. Contract verdicts and counters are counts of reports "
      + "and events, shown at any size.",
    querystring: adminClientHealthQuerySchema,
    response: {
      200: adminClientHealthResponseSchema,
      400: errorResponseSchema,
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
export type ClientConversationRecapsQuery = z.infer<typeof clientConversationRecapsQuerySchema>;
export type ClientRecapBody = z.infer<typeof clientRecapBodySchema>;
export type ClientConversationRecapsResponse = z.infer<typeof clientConversationRecapsResponseSchema>;
export type ClientFanProfileFromGenerationBody = z.infer<typeof clientFanProfileFromGenerationBodySchema>;
export type ClientFanProfileFromGenerationResponse = z.infer<typeof clientFanProfileFromGenerationResponseSchema>;
export type ClientConversationFeedQuery = z.infer<typeof clientConversationFeedQuerySchema>;
export type ClientFeedItem = z.infer<typeof clientFeedItemSchema>;
export type ClientFeedHead = z.infer<typeof clientFeedHeadSchema>;
export type ClientFeedSummary = z.infer<typeof clientFeedSummarySchema>;
export type ClientFeedDepth = z.infer<typeof clientFeedDepthSchema>;
export type ClientConversationFeedResponse = z.infer<typeof clientConversationFeedResponseSchema>;
export type ClientAiUsageQuery = z.infer<typeof clientAiUsageQuerySchema>;
export type ClientAiUsageTotals = z.infer<typeof clientAiUsageTotalsSchema>;
export type ClientAiUsageDay = z.infer<typeof clientAiUsageDaySchema>;
export type ClientAiUsageResponse = z.infer<typeof clientAiUsageResponseSchema>;
export type ClientAiLimitResponse = z.infer<typeof clientAiLimitResponseSchema>;
export type ClientSpenderStatsQuery = z.infer<typeof clientSpenderStatsQuerySchema>;
export type ClientSpenderStatsMoneyWindow = z.infer<typeof clientSpenderStatsMoneyWindowSchema>;
export type ClientSpenderStatsResponse = z.infer<typeof clientSpenderStatsResponseSchema>;
export type ClientSpenderAwaitingReplyQuery = z.infer<typeof clientSpenderAwaitingReplyQuerySchema>;
export type ClientSpenderAwaitingReplyItem = z.infer<typeof clientSpenderAwaitingReplyItemSchema>;
export type ClientSpenderAwaitingReplyResponse = z.infer<typeof clientSpenderAwaitingReplyResponseSchema>;
export type ClientClaimGroup = z.infer<typeof clientClaimGroupSchema>;
export type ClientManualClaimGroup = z.infer<typeof clientManualClaimGroupSchema>;
export type ClientClaimSendGroup = z.infer<typeof clientClaimSendGroupSchema>;
export type ClientFanClaimBody = z.infer<typeof clientFanClaimBodySchema>;
export type ClientFanClaimResponse = z.infer<typeof clientFanClaimResponseSchema>;
export type ClientSendCustodyResolveBody = z.infer<typeof clientSendCustodyResolveBodySchema>;
export type ClientSendCustodyItem = z.infer<typeof clientSendCustodyItemSchema>;
export type ClientSendCustodyListQuery = z.infer<typeof clientSendCustodyListQuerySchema>;
export type ClientSendCustodyListItem = z.infer<typeof clientSendCustodyListItemSchema>;
export type ClientSendCustodyListResponse = z.infer<typeof clientSendCustodyListResponseSchema>;
export type ClientSendAttributionFact = z.infer<typeof clientSendAttributionFactSchema>;
export type ClientSendAttributionsBody = z.infer<typeof clientSendAttributionsBodySchema>;
export type ClientNoteAttributionFact = z.infer<typeof clientNoteAttributionFactSchema>;
export type ClientNoteAttributionsBody = z.infer<typeof clientNoteAttributionsBodySchema>;
export type ClientActivityBody = z.infer<typeof clientActivityBodySchema>;
export type ClientActivityResponse = z.infer<typeof clientActivityResponseSchema>;
export type ClientChatspaceTabStateBody = z.infer<typeof clientChatspaceTabStateBodySchema>;
export type ClientChatspaceTabStateResponse = z.infer<typeof clientChatspaceTabStateResponseSchema>;
export type TeamShiftsQuery = z.infer<typeof teamShiftsQuerySchema>;
export type TeamShift = z.infer<typeof teamShiftSchema>;
export type TeamShiftsResponse = z.infer<typeof teamShiftsResponseSchema>;
export type ClientInConversationResponse = z.infer<typeof clientInConversationResponseSchema>;
export type TeamAuthorshipQuery = z.infer<typeof teamAuthorshipQuerySchema>;
export type TeamAuthorshipResponse = z.infer<typeof teamAuthorshipResponseSchema>;
export type TeamCoverageQuery = z.infer<typeof teamCoverageQuerySchema>;
export type TeamEmptyHoursResponse = z.infer<typeof teamEmptyHoursResponseSchema>;
export type TeamGreetingsResponse = z.infer<typeof teamGreetingsResponseSchema>;
export type ChatterNumbers = z.infer<typeof chatterNumbersSchema>;
export type TeamChatterNumbersResponse = z.infer<typeof teamChatterNumbersResponseSchema>;
export type TeamSalesQuery = z.infer<typeof teamSalesQuerySchema>;
export type TeamSalesPpvResponse = z.infer<typeof teamSalesPpvResponseSchema>;
export type TeamSalesRepliesResponse = z.infer<typeof teamSalesRepliesResponseSchema>;
export type ShiftReportSale = z.infer<typeof shiftReportSaleSchema>;
export type AccountShiftReportResponse = z.infer<typeof accountShiftReportResponseSchema>;
export type AccountShiftReportMarkBody = z.infer<typeof accountShiftReportMarkBodySchema>;
export type AccountShiftReportChangeResponse = z.infer<typeof accountShiftReportChangeResponseSchema>;
export type TeamShiftDisputesResponse = z.infer<typeof teamShiftDisputesResponseSchema>;
export type TeamShiftResolveBody = z.infer<typeof teamShiftResolveBodySchema>;
export type TeamShiftExportResponse = z.infer<typeof teamShiftExportResponseSchema>;
export type ClientFanCustom = z.infer<typeof clientFanCustomSchema>;
export type ClientFanCustomCreateBody = z.infer<typeof clientFanCustomCreateBodySchema>;
export type ClientFanCustomChangeBody = z.infer<typeof clientFanCustomChangeBodySchema>;
export type TeamCustomsResponse = z.infer<typeof teamCustomsResponseSchema>;
export type ClientHandoffResponse = z.infer<typeof clientHandoffResponseSchema>;
export type ClientWinBackResponse = z.infer<typeof clientWinBackResponseSchema>;
export type ClientWinBackAttemptBody = z.infer<typeof clientWinBackAttemptBodySchema>;
export type ClientWinBackAttemptResponse = z.infer<typeof clientWinBackAttemptResponseSchema>;
export type ClientOnlineQuery = z.infer<typeof clientOnlineQuerySchema>;
export type ClientOnlineItem = z.infer<typeof clientOnlineItemSchema>;
export type ClientOnlineResponse = z.infer<typeof clientOnlineResponseSchema>;
export type ClientOnlinePresenceBody = z.infer<typeof clientOnlinePresenceBodySchema>;
export type ClientOnlinePresenceResponse = z.infer<typeof clientOnlinePresenceResponseSchema>;
export type ClientOnlineProbeBody = z.infer<typeof clientOnlineProbeBodySchema>;
export type ClientOnlineProbeResponse = z.infer<typeof clientOnlineProbeResponseSchema>;
export type ClientOnlineAttemptBody = z.infer<typeof clientOnlineAttemptBodySchema>;
export type ClientOnlineAttemptResponse = z.infer<typeof clientOnlineAttemptResponseSchema>;
export type TeamWinBackResultsQuery = z.infer<typeof teamWinBackResultsQuerySchema>;
export type TeamWinBackResultsResponse = z.infer<typeof teamWinBackResultsResponseSchema>;
export type TeamWinBackApproachesResponse = z.infer<typeof teamWinBackApproachesResponseSchema>;
export type TeamWinBackApproachSaveBody = z.infer<typeof teamWinBackApproachSaveBodySchema>;
export type ClientFanCardPage = z.infer<typeof clientFanCardPageSchema>;
export type ClientFanCardResponse = z.infer<typeof clientFanCardResponseSchema>;
export type ClientFanMarksQuery = z.infer<typeof clientFanMarksQuerySchema>;
export type ClientFanMarksResponse = z.infer<typeof clientFanMarksResponseSchema>;
export type ClientFanLinkDecideBody = z.infer<typeof clientFanLinkDecideBodySchema>;
export type ClientFanLinkDecideResponse = z.infer<typeof clientFanLinkDecideResponseSchema>;
export type ClientFanFact = z.infer<typeof clientFanFactSchema>;
export type ClientFanFactQuote = z.infer<typeof clientFanFactQuoteSchema>;
export type ClientFanFactChangeBody = z.infer<typeof clientFanFactChangeBodySchema>;
export type ClientFanFactChangeResponse = z.infer<typeof clientFanFactChangeResponseSchema>;
export type ClientSendAttributionsResponse = z.infer<typeof clientSendAttributionsResponseSchema>;
export type ClientNoteAttributionsResponse = z.infer<typeof clientNoteAttributionsResponseSchema>;
export type ClientFanNoteAttributionsResponse = z.infer<typeof clientFanNoteAttributionsResponseSchema>;
export type ClientNoteAttributionWho = z.infer<typeof clientNoteAttributionWhoSchema>;
export type ClientAudienceNewQuery = z.infer<typeof clientAudienceNewQuerySchema>;
export type ClientClaimSummary = z.infer<typeof clientClaimSummarySchema>;
export type ClientAudienceNewItem = z.infer<typeof clientAudienceNewItemSchema>;
export type ClientAudienceNewResponse = z.infer<typeof clientAudienceNewResponseSchema>;
export type AdminClientHealthQuery = z.infer<typeof adminClientHealthQuerySchema>;
export type AdminClientHealthResponse = z.infer<typeof adminClientHealthResponseSchema>;

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
// hub older than the intake (H-11b) journals an unknown kind in `observations`
// (`desktop.unknown:<kind>`) with the user, forever and on into the lake, which
// is exactly what this report must never become. The intake (H-11b) never
// journals the kind, from any token: behind the capability (the owner's
// `chatExtensionHealthIngestEnabled`) it checks a report against this schema
// and the bounds registry and folds it into hourly rollups keyed without the
// user; without it, it accepts the report and keeps nothing.
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
 * The perf metrics and the fixed upper bounds (ms) of their buckets: the client
 * builds every histogram from these, and the hub checks a histogram against
 * them before it merges one. The first eleven are as the client froze them
 * (`PERF_METRICS`, contracts v1.0.0); the hub holds the Fansly ones below first,
 * and the client adopts the same names and bounds before it sends them.
 *
 * Buckets: a histogram with n bounds has n + 1 counts. counts[0] holds values
 * ≤ bounds[0]; counts[i] values in (bounds[i-1], bounds[i]]; counts[n] values
 * above bounds[n-1] (that bucket tops out at the histogram's `max`).
 *
 * A metric names no host: the intake keys every rollup row by the report's
 * host kind and build, so one metric measured on two host pages is two rows
 * and never one set of buckets.
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

  // Fansly (chat-extension Project Unite R20, HF-13), reported from a
  // `fansly-web` tab. Each set has an edge at every budget it is checked
  // against, so the share within a budget and each overrun past it are read
  // off the buckets, not guessed inside one: a frame parsed in ≤ 0.1 ms on
  // average (the mean is sum / count, exact; the edges below 0.1 show where the
  // mass lies), a response parsed in ≤ 2 ms per task, the snapshot step in
  // ≤ 5 ms. Past a budget the edges run on to a 60 Hz frame (16 ms) and a long
  // task (50 ms); the last bucket keeps the rest, topped by `max`.
  /** One socket frame of the host page parsed by the client's tap in the page. */
  frameParseMs: { unit: "ms", schemaVersion: 1, bounds: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 16, 50, 100] },
  /** One XHR response of the host page parsed by the client's observer: one task, deferred or not. */
  xhrParseMs: { unit: "ms", schemaVersion: 1, bounds: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 16, 50, 100] },
  /** The generation snapshot's one synchronous step in the page. */
  snapshotMs: { unit: "ms", schemaVersion: 1, bounds: [0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 8, 16, 32, 50, 100, 250] },
  /** Click → the generation request ready, the snapshot's round trip through the page included. */
  snapshotRoundTripMs: {
    unit: "ms", schemaVersion: 1,
    bounds: [1, 2, 5, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500, 5000],
  },
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
     * `index-AbCdEfGh`); null when it could not be read. The client's bounded
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
  /**
   * Code → occurrences in the window: errors by code, prevented inserts, P1s.
   * One code the client sends here is a level, not a count: `footprint.dom-nodes-max`,
   * the largest number of its own DOM nodes in the window. The intake buckets
   * it, one observation per report, and keeps it out of the counter totals.
   */
  counters: z.record(healthCode, healthCounterValue)
    .refine((counters) => Object.keys(counters).length <= 200, { message: "at most 200 counters" }),
  /** The client's own caches and logs, not the heap (Firefox has no portable heap reading). */
  footprint: z.object({ kind: z.literal("owned-estimate"), cachesKB: count, logsKB: count }).strict(),
}).strict();

export type ClientHealthPerfHistogram = z.infer<typeof clientHealthPerfHistogramSchema>;
export type ClientHealthReportV1 = z.infer<typeof clientHealthReportV1Schema>;
