// H2 (INC-001): how a ledger reader tells a SUPERSEDED event from a live one,
// for supersessions minted by one-shot repairs of fact events (today the
// OFAPI PPV conversation-ref repair; H3's facts route excludes what this
// names).
//
// The ledger is append-only, so a repair appends a SUPERSEDING event (schema
// 2, data.supersedesEventId) and leaves the original in place. The superseding
// event's dedup key is `supersedes:<original event id>`, claimed in
// domain_event_keys like any other key. That one convention gives three
// properties without a new table:
//   * at most one superseding event per original, by the (account_id,
//     dedup_key) primary key — a repair re-run dedupes to zero;
//   * "is event E superseded?" is one primary-key probe from E's own row;
//   * erasure already removes domain_event_keys with their events.
//
// Scope, stated so nobody over-reads it: the Wave-2 corrections reconciler's
// superseding MESSAGE events keep their own fingerprint keys
// (msg:<dir>:<id>:<fpHex>) — those supersede material revisions of one
// message and are NOT visible through this helper.

import { sql, type SQL } from "drizzle-orm";

export const SUPERSESSION_DEDUP_KEY_PREFIX = "supersedes:";

/** The dedup key a superseding repair event claims for `originalEventId`. */
export function supersessionDedupKey(originalEventId: number): string {
  if (!Number.isSafeInteger(originalEventId) || originalEventId <= 0) {
    throw new Error(`Invalid superseded event id: ${String(originalEventId)}`);
  }
  return `${SUPERSESSION_DEDUP_KEY_PREFIX}${originalEventId}`;
}

/**
 * SQL predicate: the domain_events row aliased `alias` has NOT been
 * superseded by a repair. `alias` is a fixed identifier chosen by the caller
 * in code (never input), e.g. `domainEventNotSupersededSql("e")`.
 */
export function domainEventNotSupersededSql(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  const table = sql.raw(alias);
  return sql`not exists (
    select 1 from domain_event_keys supersession
    where supersession.account_id = ${table}.account_id
      and supersession.dedup_key = ${SUPERSESSION_DEDUP_KEY_PREFIX}::text || ${table}.id::text
  )`;
}
