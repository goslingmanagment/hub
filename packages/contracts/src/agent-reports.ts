/**
 * Agent reports (ecosystem plan §2 «Канал трафика», package O): a named
 * markdown page an agent key publishes and people read inside the app — the
 * traffic routine's daily summary first, the customs board and the others
 * later. One row per slug: publishing the same slug again replaces the page
 * and counts its version. The owner reads every report; a team lead only the
 * ones the agent opened to team leads; a chatter none. The body is the
 * agent's text: the app renders it with its own typography and never
 * reformats the money, dates or periods in it.
 */
import { z } from "zod";

import { intId, isoTimestamp } from "./primitives.ts";

/** Lowercase words and hyphens: `traffic`, `customs-board`. */
export const AGENT_REPORT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const agentReportSlugSchema = z.string().regex(AGENT_REPORT_SLUG_PATTERN);

/** Where a report belongs in the owner's place. */
export const AGENT_REPORT_SECTIONS = ["traffic", "team", "content", "system"] as const;
export const agentReportSectionSchema = z.enum(AGENT_REPORT_SECTIONS);
export type AgentReportSection = z.infer<typeof agentReportSectionSchema>;

/** The body's ceiling, in UTF-8 bytes (the database repeats it). */
export const AGENT_REPORT_BODY_MAX_BYTES = 256 * 1024;
/** «Valid for» runs from an hour to a year. */
export const AGENT_REPORT_VALID_HOURS_MAX = 24 * 366;

const utf8 = new TextEncoder();
export function agentReportBodyBytes(body: string): number {
  return utf8.encode(body).length;
}

export const agentReportPutBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  section: agentReportSectionSchema,
  /** Markdown: headings, lists, tables, links, code. Raw HTML is shown as text. */
  body: z.string().min(1).refine((body) => agentReportBodyBytes(body) <= AGENT_REPORT_BODY_MAX_BYTES, {
    message: `The body is over ${AGENT_REPORT_BODY_MAX_BYTES} bytes`,
  }),
  /** Team leads read it too. Absent: the owner only. */
  teamLeads: z.boolean().optional(),
  /** After this many hours since publishing the page is shown as stale. Absent or null: never. */
  validHours: z.number().int().min(1).max(AGENT_REPORT_VALID_HOURS_MAX).nullable().optional(),
}).strict();
export type AgentReportPutBody = z.infer<typeof agentReportPutBodySchema>;

/** What a report is, without its body. */
export const agentReportMetaSchema = z.object({
  slug: z.string(),
  title: z.string(),
  section: agentReportSectionSchema,
  teamLeads: z.boolean(),
  validHours: z.number().int().nullable(),
  /** Counts the changes of the page: the same text published again keeps it. */
  version: z.number().int(),
  publishedAt: isoTimestamp,
  /** The key that published it last; null when that key is gone from the table. */
  publishedBy: z.object({ agentKeyId: intId, name: z.string() }).nullable(),
  bytes: z.number().int(),
  /** `publishedAt` plus `validHours`; null without a validity. */
  staleAt: isoTimestamp.nullable(),
  stale: z.boolean(),
});
export type AgentReportMeta = z.infer<typeof agentReportMetaSchema>;

export const agentReportPutResponseSchema = z.object({
  report: agentReportMetaSchema,
  /** The title, section, body, readers or validity differ from what was there (a new report too). */
  changed: z.boolean(),
});
export type AgentReportPutResponse = z.infer<typeof agentReportPutResponseSchema>;

export const agentReportListResponseSchema = z.object({
  reports: z.array(agentReportMetaSchema),
  serverNow: isoTimestamp,
});
export type AgentReportListResponse = z.infer<typeof agentReportListResponseSchema>;

export const reportsListResponseSchema = agentReportListResponseSchema;
export type ReportsListResponse = AgentReportListResponse;

export const reportGetResponseSchema = z.object({
  report: agentReportMetaSchema.extend({ body: z.string() }),
  serverNow: isoTimestamp,
});
export type ReportGetResponse = z.infer<typeof reportGetResponseSchema>;
