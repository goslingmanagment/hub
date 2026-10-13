import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { textArrayParam, timestampParam, toDate } from "./values.ts";

// Fansly Sync Engine, step 3 (design S3-04 item 5, G17, E19): the socket gaps
// `repair.ws-gap` reconciles. A pass takes its window from the page's verified
// socket connections that no repair has reconciled yet — never from the work's
// parameters, which an open row keeps from its first demand — and stamps them
// once the chats and the money the gap may have hidden were read again.

/** A connection older than this is not reconciled any more (history, not a gap). */
export const SYNC_WS_GAP_LOOKBACK_HOURS = 24;
/** A site socket's connection on a page's browser (Project Browser, PR 13)
 *  is verified when the engine takes its events from the operator's buffer,
 *  which keeps them up to 72 h (spec §5) — its gap is still a gap that long
 *  after it opened: a week, past the buffer's cap. */
export const SYNC_WS_GAP_BROWSER_LOOKBACK_HOURS = 7 * 24;
/** The window of a pass starts this long before the earliest gap. */
export const SYNC_WS_GAP_MARGIN_MS = 60_000;

export interface FanslyWsGapPass {
  /** The connections the pass stamps, by `started_at` (uuid text). */
  targets: string[];
  /** The earliest `gap_since` minus the margin; null without a target (or a
   *  target without a recorded gap). */
  since: Date | null;
}

/**
 * The connections a new repair pass reconciles (read-only): verified, not yet
 * reconciled, and the instant the pass reads back to — the earliest gap they
 * record, 60 s earlier. A connection's gap is the one it opened with
 * (`gap_since`: started within the last day — a page browser's within the
 * week its buffer may replay) and, on a page's browser, a loss found on it
 * since (`loss_since`, 0276: within the week, whatever the connection's
 * age). A connection whose opening gap was reconciled before
 * (`transient_unknown` set) reads back from its loss alone.
 */
export async function readFanslyWsGapPass(db: Database, input: { pageId: number }): Promise<FanslyWsGapPass> {
  const browserCutoff = sql`clock_timestamp() - ${SYNC_WS_GAP_BROWSER_LOOKBACK_HOURS}::double precision * interval '1 hour'`;
  const result = await db.execute<{ targets: string[] | null; since: Date | string | null }>(sql`
    select array_agg(c.id::text order by c.started_at, c.id) as targets,
           min(case when c.transient_unknown is not null and c.loss_since is not null then c.loss_since
                    else least(c.gap_since, coalesce(c.loss_since, c.gap_since)) end)
             - ${SYNC_WS_GAP_MARGIN_MS}::double precision * interval '1 millisecond' as since
      from fansly_ws_connections c
     where c.page_id = ${input.pageId}
       and c.verified_at is not null
       and c.state_reconciled_at is null
       and (c.started_at > clock_timestamp() - (case when c.origin = 'browser'
              then ${SYNC_WS_GAP_BROWSER_LOOKBACK_HOURS} else ${SYNC_WS_GAP_LOOKBACK_HOURS} end)::double precision * interval '1 hour'
            or c.loss_since > ${browserCutoff})
  `);
  const row = result.rows[0];
  return { targets: row?.targets ?? [], since: toDate(row?.since ?? null) };
}

/**
 * Stamp a pass's connections reconciled: `state_reconciled_at` now and
 * `transient_unknown` = [the connection's gap (or the pass's start), its
 * verification) — a message created and deleted inside that interval is not
 * recoverable (plan §8). A connection stamped by an earlier pass is left as
 * it is. A loss found on a page browser's connection (`loss_since`) is
 * reconciled with it — unless it is older than what the pass read back to
 * (a loss marked after the pass was planned): that row waits for the next.
 * Returns how many rows it stamped.
 */
export async function stampFanslyWsGapReconciled(
  db: Database,
  input: { pageId: number; targets: readonly string[]; since: Date },
): Promise<number> {
  if (input.targets.length === 0) return 0;
  const result = await db.execute(sql`
    update fansly_ws_connections c
       set state_reconciled_at = clock_timestamp(),
           transient_unknown = tstzrange(least(coalesce(c.gap_since, ${timestampParam(input.since)}), c.verified_at), c.verified_at),
           loss_since = null
     where c.page_id = ${input.pageId}
       and c.id::text = any(${textArrayParam(input.targets)})
       and c.verified_at is not null
       and c.state_reconciled_at is null
       and (c.loss_since is null or c.loss_since >= ${timestampParam(input.since)})
  `);
  return result.rowCount ?? 0;
}
