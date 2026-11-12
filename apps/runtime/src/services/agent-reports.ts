import { createHash } from "node:crypto";

import {
  type AgentReportListResponse,
  type AgentReportMeta,
  type AgentReportPutBody,
  type AgentReportPutResponse,
  type ReportGetResponse,
} from "@agency_hub_core/contracts";
import { findAgentReport, listAgentReports, putAgentReport, type AgentReportRow } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { NotFoundError } from "./errors.ts";

/**
 * Agent reports (ecosystem plan §2 «Канал трафика», package O): an agent key
 * with write:reports publishes a named markdown page; people read it by
 * session. Who reads what is decided here: the owner every report, a team
 * lead the ones the agent opened to team leads, anyone else none (the route's
 * `session` kind already refuses a chatter). A report a team lead may not
 * read is the same 404 as one that does not exist. Database only.
 */

type ReportsApp = Pick<AppContext, "db">;

const HOUR_MS = 60 * 60 * 1000;

export function agentReportWire(row: AgentReportRow, now: Date): AgentReportMeta {
  const staleAt = row.validHours === null ? null : new Date(row.publishedAt.getTime() + row.validHours * HOUR_MS);
  return {
    slug: row.slug,
    title: row.title,
    section: row.section,
    teamLeads: row.teamLeads,
    validHours: row.validHours,
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    publishedBy: row.publishedBy,
    bytes: row.bytes,
    staleAt: staleAt?.toISOString() ?? null,
    stale: staleAt !== null && now.getTime() > staleAt.getTime(),
  };
}

/** The body's digest for the audit row: proves two publishes were the same text without keeping it. */
export function agentReportBodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function publishAgentReport(
  app: ReportsApp,
  input: { slug: string; body: AgentReportPutBody; agentKeyId: number },
  now: Date = new Date(),
): Promise<AgentReportPutResponse> {
  const { report, changed } = await putAgentReport(app.db, {
    slug: input.slug,
    title: input.body.title,
    section: input.body.section,
    body: input.body.body,
    teamLeads: input.body.teamLeads ?? false,
    validHours: input.body.validHours ?? null,
    agentKeyId: input.agentKeyId,
    at: now,
  });
  return { report: agentReportWire(report, now), changed };
}

export async function readAgentReportsForAgent(app: ReportsApp, now: Date = new Date()): Promise<AgentReportListResponse> {
  const rows = await listAgentReports(app.db, { teamLeadsOnly: false });
  return { reports: rows.map((row) => agentReportWire(row, now)), serverNow: now.toISOString() };
}

/** Whether a person reads every report (the owner) or only the team leads' ones; null — none. */
function readerOf(principal: HumanAuthPrincipal): "all" | "team_leads" | null {
  if (principal.user.role === "owner") return "all";
  if (principal.user.role === "team_lead") return "team_leads";
  return null;
}

export async function readReportsList(app: ReportsApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<AgentReportListResponse> {
  const reader = readerOf(principal);
  const rows = reader === null ? [] : await listAgentReports(app.db, { teamLeadsOnly: reader === "team_leads" });
  return { reports: rows.map((row) => agentReportWire(row, now)), serverNow: now.toISOString() };
}

export async function readReport(app: ReportsApp, principal: HumanAuthPrincipal, slug: string, now: Date = new Date()): Promise<ReportGetResponse> {
  const reader = readerOf(principal);
  const row = reader === null ? null : await findAgentReport(app.db, slug);
  if (row === null || (reader === "team_leads" && !row.teamLeads)) throw new NotFoundError("No such report");
  return { report: { ...agentReportWire(row, now), body: row.body }, serverNow: now.toISOString() };
}
