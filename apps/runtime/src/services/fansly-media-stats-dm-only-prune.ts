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
//
// `--execute` WAITS FOR THE PROJECTORS, AND REFUSES WITHOUT THEM. A row queued
// before the deploy carries no stamp of the post that showed its media; what
// keeps it is the post in `creator_posts`, or the ranking in `stats_top_media`.
// Those are other projectors' tables, and a rotation can run the media plane
// (which queued the row from the post) before them. So `--execute` reads the
// journal head per page, waits up to `waitMs` for the media plane,
// creator_posts and fansly_stats to consume everything up to it, and then
// re-checks and deletes in ONE repeatable-read snapshot. Still behind at the
// deadline: it deletes nothing and says which projector is behind where. The
// dry run reports the same lag against the head now.

import { setTimeout as sleep } from "node:timers/promises";

import {
  checkDmOnlyPruneProjections,
  countDmOnlyMediaStatsQueueRows,
  deleteDmOnlyMediaStatsQueueRows,
  type Database,
  type DmOnlyMediaStatsQueueCount,
  type DmOnlyPruneProjectionLag,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { CREATOR_POSTS_PROJECTION } from "./projections/creator-posts.ts";
import { FANSLY_STATS_PROJECTION } from "./projections/fansly-stats.ts";
import { MEDIA_PLANE_PROJECTION } from "./projections/media-plane.ts";

/** The queueing projector, and the two whose tables keep an unstamped row. */
export const DM_ONLY_PRUNE_PROJECTIONS = [
  MEDIA_PLANE_PROJECTION,
  CREATOR_POSTS_PROJECTION,
  FANSLY_STATS_PROJECTION,
] as const;

/** Long enough for the minutely projection tick to drain a normal backlog. */
export const DM_ONLY_PRUNE_DEFAULT_WAIT_MS = 180_000;
const DEFAULT_POLL_MS = 5_000;

export interface FanslyMediaStatsDmOnlyPruneOptions {
  /** Default true: count what WOULD be deleted, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
  /** `--execute` only: how long to wait for the projectors. */
  waitMs?: number;
  pollMs?: number;
}

export interface FanslyMediaStatsDmOnlyPruneResult {
  dryRun: boolean;
  /** `--execute` only: the projectors did not reach the head in time, and
   *  nothing was deleted. */
  refused: boolean;
  /** Each (page, projector) still behind the journal head: the head now for a
   *  dry run, the head `--execute` started at for a refusal. */
  lagging: DmOnlyPruneProjectionLag[];
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
  const check = { ...scope, projections: DM_ONLY_PRUNE_PROJECTIONS };

  if (dryRun) {
    const { lagging, pages } = await app.db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      return {
        lagging: (await checkDmOnlyPruneProjections(database, check)).lagging,
        pages: await countDmOnlyMediaStatsQueueRows(database, scope),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    return summarize({ dryRun, refused: false, lagging, pages });
  }

  const deadline = Date.now() + Math.max(0, options.waitMs ?? DM_ONLY_PRUNE_DEFAULT_WAIT_MS);
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  let heads: Map<number, number> | undefined;
  for (;;) {
    let lagging: DmOnlyPruneProjectionLag[];
    try {
      const outcome = await app.db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const checked = await checkDmOnlyPruneProjections(database, {
          ...check,
          ...(heads === undefined ? {} : { heads }),
        });
        heads ??= checked.heads;
        if (checked.lagging.length > 0) {
          return { lagging: checked.lagging, pages: null };
        }
        return { lagging: [], pages: await deleteDmOnlyMediaStatsQueueRows(database, scope) };
      }, { isolationLevel: "repeatable read" });
      if (outcome.pages !== null) {
        const result = summarize({ dryRun, refused: false, lagging: [], pages: outcome.pages });
        app.logger.info(result, "Fansly media_stats DM-only queue rows deleted");
        return result;
      }
      lagging = outcome.lagging;
    } catch (error) {
      // An enqueue stamped a row this snapshot saw unstamped, so the delete
      // failed rather than remove it. Nothing was deleted: look again.
      if (!isSerializationFailure(error) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const result = summarize({ dryRun, refused: true, lagging, pages: [] });
      app.logger.warn(result, "Fansly media_stats DM-only prune refused: projectors behind the journal");
      return result;
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

function isSerializationFailure(error: unknown): boolean {
  const record = error instanceof Error ? error as Error & { code?: unknown; cause?: unknown } : null;
  const cause = record?.cause instanceof Error ? record.cause as Error & { code?: unknown } : null;
  return record?.code === "40001" || cause?.code === "40001";
}

function summarize(input: {
  dryRun: boolean;
  refused: boolean;
  lagging: DmOnlyPruneProjectionLag[];
  pages: DmOnlyMediaStatsQueueCount[];
}): FanslyMediaStatsDmOnlyPruneResult {
  const { pages } = input;
  return {
    ...input,
    rows: pages.reduce((sum, page) => sum + page.rows, 0),
    visited: pages.reduce((sum, page) => sum + page.visited, 0),
    dirty: pages.reduce((sum, page) => sum + page.dirty, 0),
    headless: pages.reduce((sum, page) => sum + page.headless, 0),
  };
}
