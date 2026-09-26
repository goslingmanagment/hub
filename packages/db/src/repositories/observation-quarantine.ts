// H2 (INC-001): the terminal-quarantine outcome log (migration 0209). A
// canonicalizer family names an accepted observation that produced zero events
// a QUARANTINE (fixed reason code); the canonicalize driver records it here and
// stamps parse_version in the same transaction. Stamped rows are outside the
// backlog-age gauge by construction, so the quarantine count is its own gauge
// (health-floors.ts) and never feeds the 10-minute backlog threshold.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface ObservationQuarantineInput {
  observationId: number;
  parseVersion: number;
  source: string;
  lane: string;
  kind: string;
  reasonCode: string;
  receivedAt: Date;
}

/** Idempotent: a replay at the same parse version records nothing new. */
export async function recordObservationQuarantine(
  db: Database,
  input: ObservationQuarantineInput,
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into observation_parse_quarantine (
      observation_id, parse_version, source, lane, kind, reason_code, received_at
    ) values (
      ${input.observationId}, ${input.parseVersion}, ${input.source}, ${input.lane},
      ${input.kind}, ${input.reasonCode}, ${input.receivedAt}
    )
    on conflict (observation_id, parse_version) do nothing
    returning observation_id
  `);
  return result.rows.length > 0;
}

/** Quarantined observations for one family at one parser version. */
export async function countObservationQuarantine(
  db: Database,
  input: { source: string; lane: string; parseVersion: number },
): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from observation_parse_quarantine
    where source = ${input.source}
      and lane = ${input.lane}
      and parse_version = ${input.parseVersion}
  `);
  return Number(result.rows[0]?.n ?? 0);
}
