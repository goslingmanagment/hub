// The one-off repair for the `media_stats` queue rows of media a page showed
// only in DMs (`fansly:media-stats-prune-dm-only`).
//
// Owner decision 2026-09-29: the per-media views of media the model sent only
// in DMs (PPV) are not needed. Until then every DM sidecar queued the page's own
// media, and a purchase notification queued any ref it named: ~10 k of a 19 k
// queue on production, growing 34–155 rows a day against 1–33 for posts, for
// 3 % of the views. The enqueue and the purchase mark now leave them out; the
// rows already queued stay until this runs, owner-approved, after that deploy.
//
// Owner-run, never scheduled: dry-run is the DEFAULT and is provably read-only
// (a READ ONLY transaction); `--execute` opts in; a re-run reports zeros. It
// deletes queue state only — the heads, the collected buckets and the journal
// stay — and it makes no platform call. A page's first enable does not need
// it: the seeding skips the same heads (see `seedMediaStatsQueue`).

import { sql } from "drizzle-orm";

import {
  countDmOnlyMediaStatsQueueRows,
  deleteDmOnlyMediaStatsQueueRows,
  type Database,
  type DmOnlyMediaStatsQueueCount,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export interface FanslyMediaStatsDmOnlyPruneOptions {
  /** Default true: count what WOULD be deleted, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface FanslyMediaStatsDmOnlyPruneResult {
  dryRun: boolean;
  /** Per page, the rows deleted (or that would be). Pages with none are absent. */
  pages: DmOnlyMediaStatsQueueCount[];
  rows: number;
  visited: number;
  dirty: number;
  headless: number;
}

export async function runFanslyMediaStatsDmOnlyPrune(
  app: Pick<AppContext, "db" | "logger">,
  options: FanslyMediaStatsDmOnlyPruneOptions = {},
): Promise<FanslyMediaStatsDmOnlyPruneResult> {
  const dryRun = options.dryRun !== false;
  const scope = { pageId: options.accountId ?? null };

  const pages = dryRun
    ? await app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return countDmOnlyMediaStatsQueueRows(tx as unknown as Database, scope);
    })
    : await deleteDmOnlyMediaStatsQueueRows(app.db as Database, scope);

  const result = {
    dryRun,
    pages,
    rows: pages.reduce((sum, page) => sum + page.rows, 0),
    visited: pages.reduce((sum, page) => sum + page.visited, 0),
    dirty: pages.reduce((sum, page) => sum + page.dirty, 0),
    headless: pages.reduce((sum, page) => sum + page.headless, 0),
  };
  if (!dryRun) {
    app.logger.info(result, "Fansly media_stats DM-only queue rows deleted");
  }
  return result;
}
