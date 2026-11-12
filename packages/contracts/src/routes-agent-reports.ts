import { z } from "zod";

import {
  agentReportListResponseSchema,
  agentReportPutBodySchema,
  agentReportPutResponseSchema,
  agentReportSlugSchema,
  reportGetResponseSchema,
  reportsListResponseSchema,
} from "./agent-reports.ts";
import { errorResponseSchema } from "./primitives.ts";

// Agent reports (ecosystem plan, package O). An agent key with write:reports
// publishes a named markdown page by its slug and lists what is published; a
// person reads them by session: the owner every report, a team lead the ones
// opened to team leads, a chatter none. Database only.

const agentReportParamsSchema = z.object({ slug: agentReportSlugSchema });
const readErrors = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema } as const;
const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  429: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const agentReportRouteSchemas = {
  agentReportPut: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Publish a report page by its slug: the same slug again replaces it, a changed text counts a new version"
      + " (needs write:reports)",
    description: "Database only. The body is markdown up to 256 KB; the app renders it and never reformats it. "
      + "`teamLeads` opens it to team leads (the owner reads every report); `validHours` marks it stale that many hours "
      + "after publishing.",
    params: agentReportParamsSchema,
    body: agentReportPutBodySchema,
    response: { 200: agentReportPutResponseSchema, ...agentErrors },
  },
  agentReportList: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The published report pages without their bodies: slug, title, section, version, when and by which key"
      + " (needs write:reports)",
    response: { 200: agentReportListResponseSchema, ...agentErrors },
  },
  reportsList: {
    auth: { kind: "session" }, tags: ["admin"],
    summary: "The report pages agents published, without bodies: the owner's every one, a team lead's those opened to team leads",
    description: "Database only. Newest first. `stale` says the page is older than the validity its agent gave it.",
    response: { 200: reportsListResponseSchema, ...readErrors },
  },
  reportGet: {
    auth: { kind: "session" }, tags: ["admin"],
    summary: "One report page with its markdown body; a report a team lead may not read is 404, as one that does not exist",
    params: agentReportParamsSchema,
    response: { 200: reportGetResponseSchema, ...readErrors },
  },
} as const;
