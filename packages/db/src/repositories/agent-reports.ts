import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Agent reports (0390, ecosystem plan package O): one row per slug, the page an
// agent key published last. Publishing the slug again replaces the page; the
// version counts the changes of its text, so the same text published again
// keeps its version and only moves `published_at`. Raw SQL: the table is the
// migration's alone.

export const AGENT_REPORT_SECTIONS = ["traffic", "team", "content", "system"] as const;
export type AgentReportSectionValue = (typeof AGENT_REPORT_SECTIONS)[number];

export interface AgentReportRow {
  slug: string;
  title: string;
  section: AgentReportSectionValue;
  teamLeads: boolean;
  validHours: number | null;
  version: number;
  publishedAt: Date;
  publishedBy: { agentKeyId: number; name: string } | null;
  bytes: number;
}

export interface AgentReportWithBody extends AgentReportRow {
  body: string;
}

export interface AgentReportPutInput {
  slug: string;
  title: string;
  section: AgentReportSectionValue;
  body: string;
  teamLeads: boolean;
  validHours: number | null;
  agentKeyId: number;
  at: Date;
}

type AgentReportDbRow = {
  slug: string;
  title: string;
  section: AgentReportSectionValue;
  team_leads: boolean;
  valid_hours: number | null;
  version: number;
  published_at: Date | string;
  published_by_key_id: string | number | bigint | null;
  key_name: string | null;
  bytes: number | string;
  body?: string;
};

function reportOf(row: AgentReportDbRow): AgentReportRow {
  return {
    slug: row.slug,
    title: row.title,
    section: row.section,
    teamLeads: row.team_leads,
    validHours: row.valid_hours,
    version: Number(row.version),
    publishedAt: new Date(row.published_at),
    publishedBy: row.published_by_key_id === null || row.key_name === null
      ? null
      : { agentKeyId: Number(row.published_by_key_id), name: row.key_name },
    bytes: Number(row.bytes),
  };
}

const META = sql.raw(
  "r.slug, r.title, r.section, r.team_leads, r.valid_hours, r.version, r.published_at, r.published_by_key_id, "
  // The page is signed by the agent the key belongs to (the people registry), by the key's own name only while it
  // belongs to nobody.
  + "coalesce(ap.display_name, k.name) as key_name, octet_length(r.body) as bytes",
);

/**
 * Publishes the page of a slug: a new row, or the existing one replaced. The
 * version moves only when the title, section, body, readers or validity
 * differ; `published_at` and the key move on every publish (the agent
 * confirmed the page is current). One statement, so two publishes of a slug
 * at once leave one row.
 */
export async function putAgentReport(db: Database, input: AgentReportPutInput): Promise<{ report: AgentReportRow; changed: boolean }> {
  const result = await db.execute<AgentReportDbRow & { changed: boolean }>(sql`
    with previous as (
      select title, section, body, team_leads, valid_hours from agent_reports where slug = ${input.slug}
    ),
    put as (
      insert into agent_reports as r (slug, title, section, body, team_leads, valid_hours, version, published_at, published_by_key_id)
      values (${input.slug}, ${input.title}, ${input.section}, ${input.body}, ${input.teamLeads}, ${input.validHours},
        1, ${input.at.toISOString()}::timestamptz, ${input.agentKeyId})
      on conflict (slug) do update set
        title = excluded.title,
        section = excluded.section,
        body = excluded.body,
        team_leads = excluded.team_leads,
        valid_hours = excluded.valid_hours,
        version = r.version + case when (r.title, r.section, r.body, r.team_leads, r.valid_hours)
          is distinct from (excluded.title, excluded.section, excluded.body, excluded.team_leads, excluded.valid_hours)
          then 1 else 0 end,
        published_at = excluded.published_at,
        published_by_key_id = excluded.published_by_key_id
      returning r.*
    )
    select ${META},
      not exists (
        select 1 from previous p
        where (p.title, p.section, p.body, p.team_leads, p.valid_hours)
          is not distinct from (r.title, r.section, r.body, r.team_leads, r.valid_hours)
      ) as changed
    from put r
    left join agent_keys k on k.id = r.published_by_key_id
    left join person_agent_keys pk on pk.agent_key_id = k.id
    left join people ap on ap.id = pk.person_id`);
  const row = result.rows[0]!;
  return { report: reportOf(row), changed: row.changed };
}

/** Every report without its body, newest first; `teamLeadsOnly` keeps the ones opened to team leads. */
export async function listAgentReports(db: Database, options: { teamLeadsOnly: boolean }): Promise<AgentReportRow[]> {
  const result = await db.execute<AgentReportDbRow>(sql`
    select ${META}
    from agent_reports r
    left join agent_keys k on k.id = r.published_by_key_id
    left join person_agent_keys pk on pk.agent_key_id = k.id
    left join people ap on ap.id = pk.person_id
    where ${options.teamLeadsOnly ? sql`r.team_leads` : sql`true`}
    order by r.published_at desc, r.slug`);
  return result.rows.map(reportOf);
}

/** One report with its body, or null. */
export async function findAgentReport(db: Database, slug: string): Promise<AgentReportWithBody | null> {
  const result = await db.execute<AgentReportDbRow>(sql`
    select ${META}, r.body
    from agent_reports r
    left join agent_keys k on k.id = r.published_by_key_id
    left join person_agent_keys pk on pk.agent_key_id = k.id
    left join people ap on ap.id = pk.person_id
    where r.slug = ${slug}`);
  const row = result.rows[0];
  return row ? { ...reportOf(row), body: row.body ?? "" } : null;
}
