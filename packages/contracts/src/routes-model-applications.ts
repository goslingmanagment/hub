import { z } from "zod";

import { errorResponseSchema, intId } from "./primitives.ts";

// The model questionnaire («анкета модели») from the agency site
// gosling-agency.ru: its nginx proxies /api/ to Hub, so the page posts here
// same-origin. Public, no principal; the site is written against this shape.

export const modelApplicationAnswerSchema = z.object({
  section: z.string().max(120),
  key: z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/),
  label: z.string().max(300),
  /** Plain text; a multiple choice arrives joined by ", ". May be empty. */
  value: z.string().max(5000),
});

/** The agency Google Form's fields (`entry.<n>`), forwarded as they come. */
export const modelApplicationGoogleFieldsSchema = z.record(
  z.string().regex(/^entry\.\d+$/),
  z.union([z.string().max(5000), z.array(z.string().max(300)).max(40)]),
).refine((fields) => Object.keys(fields).length <= 200, { message: "Too many Google Form fields" });

/** The page's own id of one filling of the questionnaire (a UUID v4). */
export const modelApplicationSessionIdSchema = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const modelApplicationSubmitBodySchema = z.object({
  form: z.string().max(40),
  answers: z.array(modelApplicationAnswerSchema).min(1).max(200),
  google: modelApplicationGoogleFieldsSchema.optional(),
  /** The filling this questionnaire ends (its progress posts' `session`). */
  session: modelApplicationSessionIdSchema.optional(),
  /** Honeypot: a person never fills it. */
  website: z.string().optional(),
});

/** Where a filling stands: sent debounced while the model types, and once on pagehide. */
export const modelApplicationProgressBodySchema = z.object({
  session: modelApplicationSessionIdSchema,
  form: z.string().max(40),
  filled: z.number().int().min(0).max(500),
  total: z.number().int().min(0).max(500),
  section: z.string().max(120).optional(),
  name: z.string().max(120).optional(),
  /** The answers so far, the same shape as the questionnaire's; the latest is kept. */
  answers: z.array(modelApplicationAnswerSchema).max(200).optional(),
  /** Honeypot: a person never fills it. */
  website: z.string().optional(),
}).refine((body) => body.filled <= body.total, { message: "filled must not exceed total", path: ["filled"] });

export const modelApplicationSubmitResponseSchema = z.object({
  ok: z.literal(true),
  id: intId,
});

export const modelApplicationRouteSchemas = {
  modelApplicationSubmit: {
    auth: { kind: "public" },
    tags: ["site"],
    summary: "Submit a model questionnaire from the agency site",
    description: "Stores the answers, then forwards `google` (if given) to the "
      + "agency's Google Form once and tells the owner in Telegram; neither "
      + "can fail the request. A filled `website` (honeypot) answers like a "
      + "success and stores nothing. At most 5 stored per client address an "
      + "hour (429 after). With `session`, that filling is marked sent. "
      + "Body cap 128 KiB.",
    body: modelApplicationSubmitBodySchema,
    response: {
      201: modelApplicationSubmitResponseSchema,
      400: errorResponseSchema,
      413: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
  modelApplicationProgress: {
    auth: { kind: "public" },
    tags: ["site"],
    summary: "Report how far a model has filled the questionnaire",
    description: "Upserts the filling by `session`; the owner hears in Telegram "
      + "when one starts (first post with filled ≥ 1) and when one is left "
      + "unsent for 30 minutes. JSON as application/json or text/plain "
      + "(navigator.sendBeacon). A filled `website` (honeypot) is ignored. At "
      + "most 1000 posts and 50 new fillings per client address (an hour / a "
      + "day; 429 beyond). With `answers`, the latest snapshot is kept on "
      + "the filling. Body cap 128 KiB.",
    body: modelApplicationProgressBodySchema,
    response: {
      204: z.null(),
      400: errorResponseSchema,
      413: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
} as const;
