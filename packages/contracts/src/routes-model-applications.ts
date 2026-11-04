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

export const modelApplicationSubmitBodySchema = z.object({
  form: z.string().max(40),
  answers: z.array(modelApplicationAnswerSchema).min(1).max(200),
  google: modelApplicationGoogleFieldsSchema.optional(),
  /** Honeypot: a person never fills it. */
  website: z.string().optional(),
});

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
      + "hour (429 after). Body cap 128 KiB.",
    body: modelApplicationSubmitBodySchema,
    response: {
      201: modelApplicationSubmitResponseSchema,
      400: errorResponseSchema,
      413: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
} as const;
