import { z } from "zod";

import { isoTimestamp, mills } from "./primitives.ts";
import {
  CLIENT_REQUEST_ID_PATTERN,
  clientFanRefSchema,
  clientNumericIdSchema,
  clientOpenToken,
  clientPageParamsSchema,
} from "./routes-client.ts";

// «Рассылка» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md). The
// extension's outreach window: one common text, the fans it is for, each fan's
// version (Fix with `draftPurpose: "outreach"`), the person's own words for a
// version, and one click per fan to send it. Until now the whole state lived in
// one browser; here it lives in Hub, one outreach of one page, shared by the
// page's team: everyone granted the page lists its outreaches, opens any of
// them, writes in it and sends from it. Hub sends nothing to a fan.
//
// Hub keeps:
// - the outreach: its id (minted by the client, so an outreach made while Hub
//   did not answer keeps its id), page, author, the common text, whether its
//   offer carries media, and `settings` — the window's own state (who it is
//   for, conditions, the offer), stored as the client sent it and never read;
// - the order of its fans once their versions are written;
// - one row per fan: the version, the common text it was written from (an
//   opaque `basis` the client compares), the person's words and who wrote them,
//   and the send.
//
// THE SEND is the one strict part. `claim` before the platform is asked:
// one claim per fan of an outreach, ever, unless the platform proved it was
// refused (`failed`); and one claim on its way per fan of the page across all
// outreaches. A claim that is not reported within OUTREACH_SEND_TICKET_SECONDS
// reads `uncertain`: never claimed again. An uncertain send is proven sent by
// the archive (Hub's own copy of the chat) when the page's message to the fan
// with the same text is there; nothing proves it was not.
//
// Results are Hub's, read when asked: the fan wrote within 72 hours of the
// send, the fan paid within 7 days (fan queues count the same).

/** The common text and one version at most (the window's own limit). */
export const OUTREACH_TEXT_MAX = 5_000;
/** Fans one outreach holds at most. */
export const OUTREACH_FANS_MAX = 1_000;
/** Fans one save changes at most. */
export const OUTREACH_SAVE_FANS_MAX = 50;
/** `settings` at most, as JSON. */
export const OUTREACH_SETTINGS_MAX_BYTES = 32 * 1024;
/** Outreaches the list answers at most, newest change first. */
export const OUTREACH_LIST_MAX = 50;
/** An outreach untouched this long is gone from the list and deleted. */
export const OUTREACH_KEEP_DAYS = 90;
/** A claim not reported within this reads `uncertain`. */
export const OUTREACH_SEND_TICKET_SECONDS = 120;
/** A send made before the outreach reached Hub (`record`) is taken this old at most. */
export const OUTREACH_RECORD_MAX_AGE_DAYS = 30;
/** «Писали за 3 дня»: how far back the touches reach. */
export const OUTREACH_TOUCH_HOURS = 72;
/** The fan wrote within this after the send. */
export const OUTREACH_REPLIED_HOURS = 72;
/** The fan paid within this after the send. */
export const OUTREACH_BOUGHT_DAYS = 7;
/** An uncertain send is looked for in the archive this long after its click. */
export const OUTREACH_EVIDENCE_MINUTES = 30;

/** The states of a fan's send. `sending` past its ticket answers as `uncertain`. */
export const OUTREACH_SEND_STATES = ["sending", "sent", "uncertain", "failed"] as const;
/** What a send action did. Open on the wire. */
export const OUTREACH_SEND_OUTCOMES = [
  // done as asked (or already so: a repeated report)
  "ok",
  // claim: this fan of the outreach went, may have, or is on its way; `fan.send` says who and when
  "taken",
  // claim: another outreach's send to this fan is on its way right now
  "busy",
  // sent / failed / uncertain: the send is another attempt's (or none)
  "not_yours",
] as const;
/** Where a touch of the last OUTREACH_TOUCH_HOURS came from. Open on the wire. */
export const OUTREACH_TOUCH_KINDS = ["outreach", "queue", "online"] as const;
/** Who settled an uncertain send. Open on the wire. */
export const OUTREACH_RESOLVED_BY = ["archive"] as const;

export type OutreachSendState = (typeof OUTREACH_SEND_STATES)[number];
export type OutreachSendOutcome = (typeof OUTREACH_SEND_OUTCOMES)[number];
export type OutreachTouchKind = (typeof OUTREACH_TOUCH_KINDS)[number];

const count = z.number().int().nonnegative();
const outreachId = z.string().regex(CLIENT_REQUEST_ID_PATTERN);
const attemptId = z.string().regex(CLIENT_REQUEST_ID_PATTERN);
const text = z.string().max(OUTREACH_TEXT_MAX);
/** The common text a version was written from, as the client names it (a hash of its own); Hub compares nothing. */
const basis = z.string().min(1).max(64);
/** The window's own state and a send's media: stored as sent, never read by Hub. */
const opaque = z.record(z.string(), z.unknown());

export const clientOutreachParamsSchema = clientPageParamsSchema.extend({ outreachId });

/** A person of the page's team: their login as the dashboard shows it, and whether it is the caller. */
export const clientOutreachPersonSchema = z.object({
  name: z.string(),
  isMe: z.boolean(),
});

export const clientOutreachSendSchema = z.object({
  /** Open token: OUTREACH_SEND_STATES. A claim past its ticket answers `uncertain`. */
  state: clientOpenToken,
  attemptId: z.string(),
  by: clientOutreachPersonSchema,
  clickedAt: isoTimestamp,
  /** `sending`: until when the claim waits for its report. */
  ticketUntil: isoTimestamp.nullable(),
  sentAt: isoTimestamp.nullable(),
  /** `failed`: the client's code (a CG code or the site's own). */
  code: z.string().nullable(),
  /** The version as it went. */
  text: z.string().nullable(),
  /** What went with it, as the client sent it. */
  media: opaque.nullable(),
  platformMessageId: z.string().nullable(),
  /** Open token: OUTREACH_RESOLVED_BY; null — reported by the client. */
  resolvedBy: clientOpenToken.nullable(),
});

/** What came of a send: Hub's archive and money, read when asked. */
export const clientOutreachOutcomeSchema = z.object({
  /** The fan's first message within OUTREACH_REPLIED_HOURS of the send. */
  replied: z.object({ at: isoTimestamp, text: z.string().nullable() }).nullable(),
  /** The fan's money within OUTREACH_BOUGHT_DAYS of the send: the sum and the first payment. */
  bought: z.object({ mills, at: isoTimestamp }).nullable(),
});

export const clientOutreachFanSchema = z.object({
  fanRef: clientFanRefSchema,
  /** Fix's version; null — none kept. */
  version: z.string().nullable(),
  basis: z.string().nullable(),
  versionAt: isoTimestamp.nullable(),
  /** The person's own words for the version; null — Fix's stands. */
  edit: z.string().nullable(),
  editedBy: clientOutreachPersonSchema.nullable(),
  editedAt: isoTimestamp.nullable(),
  send: clientOutreachSendSchema.nullable(),
  /** Only for a send that went (`sent`). */
  outcome: clientOutreachOutcomeSchema.nullable(),
});

export const clientOutreachSchema = z.object({
  outreachId: z.string(),
  author: clientOutreachPersonSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  updatedBy: clientOutreachPersonSchema,
  text: z.string(),
  withMedia: z.boolean(),
  settings: opaque,
  /** The fans in the window's order once their versions are written; empty — not written yet. */
  order: z.array(clientFanRefSchema),
  /** Every fan with a version, the person's words or a send — those out of `order` too (a send is never lost). */
  fans: z.array(clientOutreachFanSchema),
  serverNow: isoTimestamp,
});

export const clientOutreachSummarySchema = z.object({
  outreachId: z.string(),
  author: clientOutreachPersonSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  updatedBy: clientOutreachPersonSchema,
  /** The common text, its first 300 characters. */
  text: z.string(),
  withMedia: z.boolean(),
  /** Fans in `order`. */
  fans: count,
  /** Fans with a version or the person's words. */
  written: count,
  sent: count,
  uncertain: count,
  sending: count,
  failed: count,
  replied: count,
  bought: count,
  boughtMills: mills,
  lastSentAt: isoTimestamp.nullable(),
});

export const clientOutreachesResponseSchema = z.object({
  pageLabel: z.string(),
  /** The page's outreaches changed within OUTREACH_KEEP_DAYS, newest change first, at most OUTREACH_LIST_MAX. */
  outreaches: z.array(clientOutreachSummarySchema),
  serverNow: isoTimestamp,
});

/** One fan's change in a save. An absent field is left as it is. */
export const clientOutreachFanChangeSchema = z.strictObject({
  fanRef: clientFanRefSchema,
  /** Fix's version; null — let go («Очистить»). Comes with `basis`. */
  version: text.nullable().optional(),
  basis: basis.optional(),
  /** The Fix generation that wrote it (its `meta.requestId`). */
  generationRef: z.string().min(1).max(100).optional(),
  /** The person's own words; null — back to Fix's version. */
  edit: text.nullable().optional(),
}).superRefine((value, ctx) => {
  if (typeof value.version === "string" && value.basis === undefined) {
    ctx.addIssue({ code: "custom", path: ["basis"], message: "a version names the text it was written from" });
  }
});

/**
 * Create the outreach (the first save of its id) or change it. Each field is
 * the latest word: the save that comes last wins it. A fan's version and words
 * stay as they are once the fan's send was claimed (`kept` in the answer).
 */
export const clientOutreachSaveBodySchema = z.strictObject({
  text: text.optional(),
  withMedia: z.boolean().optional(),
  settings: opaque.optional(),
  /** The whole order once versions are written; [] — none written (the fans with a send stay). */
  order: z.array(clientFanRefSchema).max(OUTREACH_FANS_MAX).optional(),
  fans: z.array(clientOutreachFanChangeSchema).max(OUTREACH_SAVE_FANS_MAX).optional(),
  /** First save only: when the outreach was made, if before (an outreach kept by the browser); at most 30 days back. */
  createdAt: isoTimestamp.optional(),
});

export const clientOutreachSaveResponseSchema = clientOutreachSchema.extend({
  /** Fans whose change this save did not take: their send was claimed, or Hub does not know them on the page. */
  kept: z.array(clientFanRefSchema),
});

export const clientOutreachSendBodySchema = z.discriminatedUnion("action", [
  /** Before the platform is asked: the version as it will go, and what goes with it. */
  z.strictObject({
    action: z.literal("claim"),
    fanRef: clientFanRefSchema,
    attemptId,
    text: z.string().min(1).max(OUTREACH_TEXT_MAX),
    media: opaque.nullable(),
  }),
  /** The platform took it; Fansly answers the message id. */
  z.strictObject({
    action: z.literal("sent"),
    fanRef: clientFanRefSchema,
    attemptId,
    platformMessageId: clientNumericIdSchema.optional(),
  }),
  /** The platform refused it (proven): the fan may be claimed again. */
  z.strictObject({
    action: z.literal("failed"),
    fanRef: clientFanRefSchema,
    attemptId,
    code: z.string().min(1).max(64),
  }),
  /** Nobody knows whether it went: never claimed again. */
  z.strictObject({
    action: z.literal("uncertain"),
    fanRef: clientFanRefSchema,
    attemptId,
  }),
  /**
   * A send made before the outreach reached Hub (kept by the browser): taken
   * only for a fan with no send yet, at most OUTREACH_RECORD_MAX_AGE_DAYS old.
   */
  z.strictObject({
    action: z.literal("record"),
    fanRef: clientFanRefSchema,
    attemptId,
    state: z.enum(["sent", "uncertain"]),
    clickedAt: isoTimestamp,
    sentAt: isoTimestamp.optional(),
    text: z.string().min(1).max(OUTREACH_TEXT_MAX),
    media: opaque.nullable(),
    platformMessageId: clientNumericIdSchema.optional(),
  }),
]);

export const clientOutreachSendResponseSchema = z.object({
  /** Open token: OUTREACH_SEND_OUTCOMES. */
  outcome: clientOpenToken,
  /** The fan as it stands after the action. */
  fan: clientOutreachFanSchema,
  serverNow: isoTimestamp,
});

/** A fan written to in the last OUTREACH_TOUCH_HOURS by an outreach, a fan queue or «Онлайн»: the latest touch. */
export const clientOutreachTouchSchema = z.object({
  fanRef: clientFanRefSchema,
  at: isoTimestamp,
  /** Open token: OUTREACH_TOUCH_KINDS. */
  kind: clientOpenToken,
  by: clientOutreachPersonSchema.nullable(),
  /** `outreach`: which one. */
  outreachId: z.string().nullable(),
});

export const clientOutreachTouchesResponseSchema = z.object({
  pageLabel: z.string(),
  hours: count,
  fans: z.array(clientOutreachTouchSchema),
  serverNow: isoTimestamp,
});

export type ClientOutreachPerson = z.infer<typeof clientOutreachPersonSchema>;
export type ClientOutreachSend = z.infer<typeof clientOutreachSendSchema>;
export type ClientOutreachOutcome = z.infer<typeof clientOutreachOutcomeSchema>;
export type ClientOutreachFan = z.infer<typeof clientOutreachFanSchema>;
export type ClientOutreach = z.infer<typeof clientOutreachSchema>;
export type ClientOutreachSummary = z.infer<typeof clientOutreachSummarySchema>;
export type ClientOutreachesResponse = z.infer<typeof clientOutreachesResponseSchema>;
export type ClientOutreachFanChange = z.infer<typeof clientOutreachFanChangeSchema>;
export type ClientOutreachSaveBody = z.infer<typeof clientOutreachSaveBodySchema>;
export type ClientOutreachSaveResponse = z.infer<typeof clientOutreachSaveResponseSchema>;
export type ClientOutreachSendBody = z.infer<typeof clientOutreachSendBodySchema>;
export type ClientOutreachSendResponse = z.infer<typeof clientOutreachSendResponseSchema>;
export type ClientOutreachTouch = z.infer<typeof clientOutreachTouchSchema>;
export type ClientOutreachTouchesResponse = z.infer<typeof clientOutreachTouchesResponseSchema>;
