import { z } from "zod";

import { isoTimestamp, platformEnum } from "./primitives.ts";

/**
 * «Начало» (ecosystem plan 2026-11-12, §5 «Новый чаттер», package J): a new
 * chatter's way from the invitation to the first shift, as Hub sees it. Every
 * step closes by itself when its fact appears — nobody ticks anything:
 *
 * - `install`   — the extension is installed: seen when it signs in (Hub cannot see an install alone);
 * - `extension` — the extension signed in: a device sign-in of one of the person's logins;
 * - `pages`     — a page is opened to the person's login (the owner assigns it);
 * - `activity`  — the first active minute on a page in the extension (the platform account's access is the owner's);
 * - `payout`    — the person wrote where their payouts go.
 *
 * The path is a newcomer's: a human chatter of the people registry who is not
 * working yet (state invited or set up) and holds a login. The person reads it
 * on Workboard's «Начало», the owner on the person's card («Ввод: 3 из 5»).
 * Where payouts go is money-adjacent: the person's own session and the owner's
 * only, never a team lead's, another chatter's, or an agent key's. The person's
 * narrow session (from the extension, no password) learns only whether it is
 * written, never the text (`ownPayoutDetailsSchema`).
 */

export const PERSON_START_STEPS = ["install", "extension", "pages", "activity", "payout"] as const;
export type PersonStartStepId = (typeof PERSON_START_STEPS)[number];
/** How long a newcomer stays on one step before the owner gets a matter. */
export const PERSON_START_STUCK_HOURS = 48;
/** Where payouts go: one free text, at most this long. */
export const PAYOUT_DETAILS_MAX_LENGTH = 500;

export const personStartStepEnum = z.enum(PERSON_START_STEPS);

export const personStartStepSchema = z.object({
  step: personStartStepEnum,
  done: z.boolean(),
  /** When Hub first saw it done; null — not done. */
  doneAt: isoTimestamp.nullable(),
});

export const personStartSchema = z.object({
  /** The path is the person's: a chatter not working yet (invited or set up) with a login. */
  newcomer: z.boolean(),
  /** A login of the person has its password (the invitation is opened). */
  signedUp: z.boolean(),
  /** The five steps, in order. */
  steps: z.array(personStartStepSchema),
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  /** The first step not done; null — every step is done. */
  current: personStartStepEnum.nullable(),
  /**
   * Since when the person stands where they stand: the invitation (not opened yet), its use, or the moment the
   * step before the current one closed. Null — every step is done.
   */
  since: isoTimestamp.nullable(),
  /** A newcomer on the same place for PERSON_START_STUCK_HOURS or more (the owner has a matter about it). */
  stuck: z.boolean(),
  /** The extension's sign-in Hub saw (the newest live one, else the newest): «Firefox · Windows · ChatGoose». */
  extension: z.object({ label: z.string(), signedInAt: isoTimestamp, active: z.boolean() }).nullable(),
  /** The pages opened to the person's logins, by model and label. */
  pages: z.array(z.object({ pageLabel: z.string(), platform: platformEnum, modelName: z.string() })),
  /** The first active minute in the extension, and its page. */
  firstActivity: z.object({ at: isoTimestamp, pageLabel: z.string() }).nullable(),
});

/** Where the person's payouts go, as they wrote it; null — not written. */
export const payoutDetailsSchema = z.object({
  text: z.string(),
  updatedAt: isoTimestamp,
}).nullable();

/**
 * The same, as the person's own session reads it. A narrow session (opened from the extension, no password:
 * web-session-scopes.ts) learns only WHETHER they are written and when: Hub leaves the text out of its answer
 * (`text` null), and the screen shows the way to the password instead. Null as a whole — not written.
 */
export const ownPayoutDetailsSchema = z.object({
  /** As the person wrote it; null — written, and this session (a narrow one) is not told what. */
  text: z.string().nullable(),
  updatedAt: isoTimestamp,
}).nullable();

export const accountStartResponseSchema = z.object({
  /** The person of the session's login; null — the login is nobody's in the registry (no «Начало»). */
  person: z.object({ code: z.string(), displayName: z.string() }).nullable(),
  /** The session's login: the one to type in the extension. */
  username: z.string(),
  start: personStartSchema.nullable(),
  /** The person's own; never anyone else's. A narrow session gets it without the text. */
  payoutDetails: ownPayoutDetailsSchema,
  /** The person hands shifts in through Hub (right «сдаёт смену в системе»); false — through Генгар and «Отчётность». */
  submitsShift: z.boolean(),
  serverNow: isoTimestamp,
});

export const accountPayoutDetailsBodySchema = z.object({
  /** Where to pay, in the person's words; empty — clear it. */
  text: z.string().max(PAYOUT_DETAILS_MAX_LENGTH),
}).strict();

export const accountPayoutDetailsResponseSchema = z.object({
  payoutDetails: payoutDetailsSchema,
});

export type PersonStart = z.infer<typeof personStartSchema>;
export type PersonStartStep = z.infer<typeof personStartStepSchema>;
export type PayoutDetails = z.infer<typeof payoutDetailsSchema>;
export type OwnPayoutDetails = z.infer<typeof ownPayoutDetailsSchema>;
export type AccountStartResponse = z.infer<typeof accountStartResponseSchema>;
export type AccountPayoutDetailsBody = z.infer<typeof accountPayoutDetailsBodySchema>;
export type AccountPayoutDetailsResponse = z.infer<typeof accountPayoutDetailsResponseSchema>;
