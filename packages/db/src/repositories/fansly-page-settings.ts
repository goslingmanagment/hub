// Fansly page settings (0338): the writer and the reader of the typed copy of
// `page-settings.daily`'s answers (apps/runtime/src/sync/fansly/lib/
// page-settings.ts). A version is keyed by its route and body: the same answer
// seen again only widens first/last seen, so the order answers are applied in
// does not matter. A route's current answer is its version seen last.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface UpsertFanslyPageSettingsInput {
  pageId: number;
  route: string;
  observationId: number;
  capturedAt: Date;
  bodySha256: string;
  body: unknown;
  summary: string;
}

export async function upsertFanslyPageSettingsVersion(db: Database, input: UpsertFanslyPageSettingsInput): Promise<void> {
  await db.execute(sql`
    insert into fansly_page_settings_versions as t (
      page_id, route, body_sha256, body, summary, first_seen_at, last_seen_at, first_observation_id, last_observation_id
    ) values (
      ${input.pageId}, ${input.route}, ${input.bodySha256}, ${JSON.stringify(input.body ?? null)}::jsonb, ${input.summary},
      ${input.capturedAt}, ${input.capturedAt}, ${input.observationId}, ${input.observationId}
    )
    on conflict (page_id, route, body_sha256) do update set
      first_observation_id = case when excluded.first_seen_at < t.first_seen_at then excluded.first_observation_id else t.first_observation_id end,
      first_seen_at = least(t.first_seen_at, excluded.first_seen_at),
      last_observation_id = case when excluded.last_seen_at > t.last_seen_at then excluded.last_observation_id else t.last_observation_id end,
      last_seen_at = greatest(t.last_seen_at, excluded.last_seen_at)
    where excluded.first_seen_at < t.first_seen_at or excluded.last_seen_at > t.last_seen_at
  `);
}

export interface FanslyPageSettingsVersion {
  route: string;
  summary: string;
  body: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FanslyPageSettingsRoute {
  route: string;
  /** The version seen last. */
  current: FanslyPageSettingsVersion;
  /** Every other version, the latest first seen first. */
  earlier: FanslyPageSettingsVersion[];
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function body(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Every route the page's settings sweep read, with its current answer and its earlier ones. */
export async function readFanslyPageSettings(db: Database, pageId: number): Promise<FanslyPageSettingsRoute[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select route, summary, body, first_seen_at, last_seen_at
      from fansly_page_settings_versions
     where page_id = ${pageId}
     order by route asc, last_seen_at desc, first_seen_at desc
  `);
  const byRoute = new Map<string, FanslyPageSettingsVersion[]>();
  for (const row of result.rows) {
    const version: FanslyPageSettingsVersion = {
      route: String(row.route),
      summary: String(row.summary),
      body: body(row.body),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
    };
    byRoute.set(version.route, [...(byRoute.get(version.route) ?? []), version]);
  }
  return [...byRoute.entries()].map(([route, versions]) => ({
    route,
    current: versions[0]!,
    earlier: versions.slice(1).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)),
  }));
}
