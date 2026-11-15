import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp, pageParamsSchema } from "./primitives.ts";

/**
 * «Кто с ним работал» on a fan's card (products package M): who wrote to this fan on this page and when — the
 * authorship Hub keeps for every outgoing message a team browser sent (`client_send_attributions`), by login, and the
 * shifts those messages fell in (`shifts`). Counts only: no text, no money, nothing about whose a sale is (a sale's
 * chain says that). The client names a login by its person (packages/ui people.ts).
 */
const workedWithAuthorSchema = z.object({
  userId: intId,
  username: z.string(),
  messages: z.number().int().nonnegative(),
  /** Of them, with a price (a paid message offered). */
  priced: z.number().int().nonnegative(),
  firstAt: isoTimestamp,
  lastAt: isoTimestamp,
  /** Shifts with at least one of those messages. */
  shifts: z.number().int().nonnegative(),
});

const workedWithShiftSchema = z.object({
  /** null — the messages fell outside any shift of that login. */
  shiftId: intId.nullable(),
  userId: intId,
  username: z.string(),
  /** The shift's bounds; for messages outside a shift, the first and the last of them. */
  startedAt: isoTimestamp,
  endedAt: isoTimestamp,
  messages: z.number().int().nonnegative(),
  priced: z.number().int().nonnegative(),
});

export const pageFanWorkedWithResponseSchema = z.object({
  pageLabel: z.string(),
  /** Messages to the fan with an author, all time. */
  messages: z.number().int().nonnegative(),
  /** By login, the most messages first. */
  authors: z.array(workedWithAuthorSchema),
  /** The newest shifts first, at most `SHIFTS_SHOWN`. */
  shifts: z.array(workedWithShiftSchema),
  /** Shifts with messages to the fan, all of them (the list above may be cut). */
  shiftsTotal: z.number().int().nonnegative(),
});
export type PageFanWorkedWithResponse = z.infer<typeof pageFanWorkedWithResponseSchema>;

/** How many shifts the card lists. */
export const FAN_WORKED_WITH_SHIFTS_SHOWN = 20;

const pageFanParamsSchema = pageParamsSchema.extend({ platformUserId: z.string().min(1) });

export const fanRouteSchemas = {
  pageFanWorkedWith: {
    auth: { kind: "any-session", scope: "page" },
    tags: ["fans"],
    summary: "Кто с ним работал: who wrote to a fan on a page and in which shifts",
    description: "Any session, on a page of the viewer's teams (services/fan-reads.ts). Database only and read-only: "
      + "counts of the authored outgoing messages to the fan by login and by shift. No text, no money.",
    params: pageFanParamsSchema,
    response: {
      200: pageFanWorkedWithResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
} as const;
