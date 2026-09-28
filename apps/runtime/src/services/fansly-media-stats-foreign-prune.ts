// M11 — the one-off repair for the `media_stats` queue rows of media a page
// does not own (`fansly:media-stats-prune-foreign`).
//
// Until M11 every `media.observed` head queued a per-media statistics row,
// including the media fans send in DMs. `/it/moie/statsnew` cannot serve
// another account's media offer, so each such row can only ever fail. The
// enqueue now skips them, but the rows queued before that stay, and once the
// lane honours its failure backoff (M1) each one is a guaranteed failed look
// per day — up to four attempts with the adapter's retries, more than the
// daily cap on every page in production (3,626 rows on 2026-09-28). So this
// runs, owner-approved, on the day that backoff is deployed.
//
// Owner-run, never scheduled: dry-run is the DEFAULT and is provably read-only
// (a READ ONLY transaction); `--execute` opts in; a re-run reports zeros. It
// deletes queue state only — the heads and the journal stay — and it makes no
// platform call. Also the repair for a page's first enable, whose seeding
// cannot tell a fan's media from its own (see `seedMediaStatsQueue`).

import { sql } from "drizzle-orm";

import {
  countForeignMediaStatsQueueRows,
  deleteForeignMediaStatsQueueRows,
  type Database,
  type ForeignMediaStatsQueueCount,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export interface FanslyMediaStatsForeignPruneOptions {
  /** Default true: count what WOULD be deleted, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface FanslyMediaStatsForeignPruneResult {
  dryRun: boolean;
  /** Per page, the rows deleted (or that would be). Pages with none are absent. */
  pages: ForeignMediaStatsQueueCount[];
  rows: number;
  failing: number;
}

export async function runFanslyMediaStatsForeignPrune(
  app: Pick<AppContext, "db" | "logger">,
  options: FanslyMediaStatsForeignPruneOptions = {},
): Promise<FanslyMediaStatsForeignPruneResult> {
  const dryRun = options.dryRun !== false;
  const scope = { pageId: options.accountId ?? null };

  const pages = dryRun
    ? await app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return countForeignMediaStatsQueueRows(tx as unknown as Database, scope);
    })
    : await deleteForeignMediaStatsQueueRows(app.db as Database, scope);

  const result = {
    dryRun,
    pages,
    rows: pages.reduce((sum, page) => sum + page.rows, 0),
    failing: pages.reduce((sum, page) => sum + page.failing, 0),
  };
  if (!dryRun) {
    app.logger.info(result, "Fansly media_stats foreign-media queue rows deleted");
  }
  return result;
}
