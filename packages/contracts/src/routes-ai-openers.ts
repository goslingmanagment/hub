/**
 * Hi's first messages (owner, 2026-10-25): a persona's own openers, which Hi
 * draws from on an empty chat, and how the fans each one went to answered.
 * Owner session only: the texts are prompt content.
 *
 * A text is never edited or deleted: the owner switches one off and adds
 * another, so the numbers stay with the words they counted.
 */
import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp } from "./primitives.ts";

const count = z.number().int().nonnegative();

/** One line the persona sends: no line breaks. */
const adminAiPersonaOpenerTextSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), "One line: no line breaks");

/** The hours of the day a text may go out in: [from, to) in `timeZone`
 *  (IANA), across midnight when from > to. */
export const adminAiPersonaOpenerHoursSchema = z.object({
  from: z.number().int().min(0).max(23),
  to: z.number().int().min(0).max(23),
  timeZone: z.string().min(1).max(64),
}).strict();

/** The greetings sent with one text, and how the fans answered. A greeting
 *  counts toward an answer once 72 hours passed, toward money once 14 days. */
export const adminAiPersonaOpenerOutcomeSchema = z.object({
  sent: count,
  /** Sent with a text other than the generation's. */
  edited: count,
  /** Sent at least 72 hours ago. */
  matured: count,
  /** Of `matured`: the fan wrote back within 72 hours. */
  replied: count,
  /** Of `matured`: the fan wrote, the page answered, the fan wrote again. */
  talked: count,
  /** Sent at least 14 days ago. */
  maturedPaid: count,
  /** Of `maturedPaid`: the fan paid the page within 14 days. */
  paid: count,
}).strict();

export const adminAiPersonaOpenerSchema = z.object({
  id: intId,
  body: z.string(),
  /** any: every fan; bare: only a fan with nothing to hook on (a default
   *  username, no other name, no bio, no picture). */
  audience: z.enum(["any", "bare"]),
  /** null: any time. */
  hours: adminAiPersonaOpenerHoursSchema.nullable(),
  enabled: z.boolean(),
  createdAt: isoTimestamp,
  /** all: every fan; bare: nothing to hook on (the text went as written);
   *  named: a name or a chosen username; other: a default username with a
   *  bio or a picture, or a fan the hub knows no name of. */
  outcomes: z.object({
    all: adminAiPersonaOpenerOutcomeSchema,
    bare: adminAiPersonaOpenerOutcomeSchema,
    named: adminAiPersonaOpenerOutcomeSchema,
    other: adminAiPersonaOpenerOutcomeSchema,
  }).strict(),
}).strict();

export const adminAiPersonaOpenersResponseSchema = z.object({
  personaKey: z.string(),
  openers: z.array(adminAiPersonaOpenerSchema),
}).strict();

export const adminAiPersonaOpenersParamsSchema = z.object({
  key: z.string().min(1).max(120),
});

export const adminAiPersonaOpenerParamsSchema = z.object({
  key: z.string().min(1).max(120),
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const adminAiPersonaOpenerCreateBodySchema = z.object({
  body: adminAiPersonaOpenerTextSchema,
  audience: z.enum(["any", "bare"]),
  hours: adminAiPersonaOpenerHoursSchema.nullable(),
}).strict();

export const adminAiPersonaOpenerUpdateBodySchema = z.object({
  enabled: z.boolean(),
}).strict();

export type AdminAiPersonaOpener = z.infer<typeof adminAiPersonaOpenerSchema>;
export type AdminAiPersonaOpenerOutcome = z.infer<typeof adminAiPersonaOpenerOutcomeSchema>;
export type AdminAiPersonaOpenersResponse = z.infer<typeof adminAiPersonaOpenersResponseSchema>;
export type AdminAiPersonaOpenerCreateBody = z.infer<typeof adminAiPersonaOpenerCreateBodySchema>;
export type AdminAiPersonaOpenerUpdateBody = z.infer<typeof adminAiPersonaOpenerUpdateBodySchema>;

export const aiOpenerRouteSchemas = {
  adminAiPersonaOpenersList: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "List a persona's Hi openers and how fans answered each one",
    params: adminAiPersonaOpenersParamsSchema,
    response: {
      200: adminAiPersonaOpenersResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminAiPersonaOpenerCreate: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Add a Hi opener to a persona",
    params: adminAiPersonaOpenersParamsSchema,
    body: adminAiPersonaOpenerCreateBodySchema,
    response: {
      200: adminAiPersonaOpenersResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
  adminAiPersonaOpenerUpdate: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Switch a persona's Hi opener on or off",
    params: adminAiPersonaOpenerParamsSchema,
    body: adminAiPersonaOpenerUpdateBodySchema,
    response: {
      200: adminAiPersonaOpenersResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
} as const;
