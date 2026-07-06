import { countArchiveCoverageGaps } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

// Kernel Stage 28: the Stage 1 prune kill-switch retires — history now lives
// in the archive+ledger, so the per-conversation page_dm_messages prune
// returns as a CACHE policy. Two gates remain:
// 1. The flag (kill-switch semantics kept for one release, default ON now).
// 2. The archive coverage query: pruning is allowed only while the archive
//    provably holds every hot message (archive >= hot per conversation).
//    Checked at most once per TTL window — a prune call must not pay a
//    full-table aggregation every time.
const COVERAGE_CHECK_TTL_MS = 15 * 60 * 1000;

let coverageCache: { checkedAt: number; covered: boolean } | null = null;

export function isPageDmPruneEnabled(
  config?: Pick<AppContext["config"], "pageDmPruneEnabled">,
) {
  return config?.pageDmPruneEnabled === true;
}

/** Async gate for prune call sites: flag AND archive coverage. Fails closed
 * (a coverage-query error keeps pruning off until the next check). */
export async function isPageDmPruneAllowed(
  app: Pick<AppContext, "db" | "config" | "logger">,
): Promise<boolean> {
  if (!isPageDmPruneEnabled(app.config)) {
    return false;
  }

  const now = Date.now();
  if (coverageCache && now - coverageCache.checkedAt < COVERAGE_CHECK_TTL_MS) {
    return coverageCache.covered;
  }

  try {
    const gaps = await countArchiveCoverageGaps(app.db);
    const covered = gaps === 0;
    coverageCache = { checkedAt: now, covered };
    if (!covered) {
      app.logger.warn(
        { uncoveredConversations: gaps },
        "page_dm_messages prune held: archive does not yet cover all hot messages",
      );
    }
    return covered;
  } catch (error) {
    app.logger.warn({ err: error }, "Archive coverage check failed; prune stays off");
    coverageCache = { checkedAt: now, covered: false };
    return false;
  }
}

/** Test seam: drop the cached coverage verdict. */
export function resetPageDmPruneCoverageCache() {
  coverageCache = null;
}
