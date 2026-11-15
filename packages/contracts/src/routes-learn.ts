/**
 * «Обучение» (products plan 2026-11-13 §2.3): the pages an agent publishes from /OS for the chat team (a chatter's job
 * description, the SOPs) through the agent-reports door (`hub report put … --section learn`), read in Workboard by every
 * role once the owner approved them. The owner sees every page of the section and approves or takes back each; anyone
 * else only the approved ones (another page is 404, the same as one that does not exist). Database only.
 */
import { z } from "zod";

import { agentReportMetaSchema, agentReportSlugSchema } from "./agent-reports.ts";
import { errorResponseSchema, isoTimestamp } from "./primitives.ts";

export const learnPageMetaSchema = agentReportMetaSchema.extend({
  /** The owner approved it for the team: everyone reads it. */
  approved: z.boolean(),
});
export type LearnPageMeta = z.infer<typeof learnPageMetaSchema>;

export const learnPagesResponseSchema = z.object({
  /** The owner: every page of the section; anyone else: the approved ones. */
  pages: z.array(learnPageMetaSchema),
  /** The viewer approves (the owner's full session). */
  canApprove: z.boolean(),
  serverNow: isoTimestamp,
});
export type LearnPagesResponse = z.infer<typeof learnPagesResponseSchema>;

export const learnPageParamsSchema = z.object({ slug: agentReportSlugSchema });

export const learnPageResponseSchema = z.object({
  page: learnPageMetaSchema.extend({ body: z.string() }),
  canApprove: z.boolean(),
  serverNow: isoTimestamp,
});
export type LearnPageResponse = z.infer<typeof learnPageResponseSchema>;

export const learnPageApproveBodySchema = z.object({ approved: z.boolean() }).strict();

export const learnPageApproveResponseSchema = z.object({ page: learnPageMetaSchema, savedAt: isoTimestamp });

const errors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema } as const;

export const learnRouteSchemas = {
  learnPages: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "The pages of «Обучение»: every one for the owner, the approved ones for anyone else",
    description: "Any session (the extension's narrow one too). Database only.",
    response: { 200: learnPagesResponseSchema, ...errors },
  },
  learnPage: {
    auth: { kind: "any-session" }, tags: ["client"],
    summary: "One page of «Обучение» with its text",
    description: "Any session; a page the owner did not approve is the owner's alone (404 to anyone else).",
    params: learnPageParamsSchema,
    response: { 200: learnPageResponseSchema, ...errors },
  },
  learnPageApprove: {
    auth: { kind: "owner-session" }, tags: ["client"],
    summary: "The owner approves a page of «Обучение» for the team, or takes the approval back",
    description: "The owner's full session. An approval holds across the agent's republishing of the page.",
    params: learnPageParamsSchema,
    body: learnPageApproveBodySchema,
    response: { 200: learnPageApproveResponseSchema, ...errors },
  },
} as const;
