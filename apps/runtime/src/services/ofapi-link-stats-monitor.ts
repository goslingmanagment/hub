// The watchman of the OnlyFans link series (traffic sources plan §2.10),
// run every minute by the OFAPI sweep. The reconcile says what each of ITS
// passes did; it cannot say that a pass never ran (04.09 and 05.09: the job
// did not start, and nothing reported it). So the series is watched from the
// outside, by what it holds:
//
//   series_stale   a (page, link kind) whose latest USABLE result is older
//                  than two windows plus the time its retries take. Usable is
//                  the shared definition (linkStatRunUsableResultSql): rows of
//                  failed, skipped and truncated attempts do not count, nor
//                  does the `window_missed` row this monitor writes itself —
//                  an attempt is not a result. Judged per pair: a kind that
//                  keeps failing is stale however well the other one reads.
//                  A page whose cause is another signal's — no mapping
//                  (below), a dead session (ofapi_auth) — gets no second
//                  latch for the same cause: a stale latch is not opened for
//                  it, and one already open is left as it is until the series
//                  is written again.
//   page_unmapped  an active OnlyFans page has no OFAPI account mapping.
//                  The latch opens at once; the paging policy gives the
//                  binding reconciler its 30 minutes before a message.
//   window_missed  not an incident but a row: a window that closed without
//                  any attempt for a pair gets one `skipped` / `window_missed`
//                  row, so that whoever reads the series — a dataset, a
//                  report — sees the hole where it is.
//
// The latches are page-scoped sub-keys of the kind a failed pass already has
// (no new incident kind: an image rolled back to could not show one).

import {
  listLinkStatAttemptWindows,
  listLinkStatSeriesHealth,
  listNotificationIncidents,
  recordLinkStatWindowMissed,
  type LinkStatKind,
  type LinkStatSeriesHealthRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  notifyOfapiLinkStatsPageIncident,
  OFAPI_LINK_STATS_PAGE_UNMAPPED_SUBKEY,
  OFAPI_LINK_STATS_SERIES_STALE_SUBKEY,
  ofapiLinkStatsPageIncidentKey,
  resolveOfapiLinkStatsPageIncident,
  type OfapiLinkStatsPageSubKey,
} from "./notification-incidents.ts";
import {
  nextOfapiLinkStatsWindowAt,
  OFAPI_LINK_STATS_WINDOW_INTERVAL_MS,
  ofapiLinkStatsWindowAt,
  previousOfapiLinkStatsWindowAt,
} from "./ofapi-link-stats-windows.ts";

const HOUR_MS = 60 * 60 * 1000;

/** A window's retries run 15 min, 45 min and 2 h after one another: a result
 * can land up to three hours into its window. */
const RETRY_ALLOWANCE_MS = 3 * HOUR_MS;

/** "Not written for two windows and more": two intervals between windows plus
 * the retries of the second — 15 hours at four windows a day, 27 at two. */
export const OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS =
  2 * OFAPI_LINK_STATS_WINDOW_INTERVAL_MS + RETRY_ALLOWANCE_MS;

/** How far back the monitor looks for windows without an attempt. Three days
 * at four windows: a worker that was down over a weekend still marks every
 * window it missed; beyond that the hole stays unmarked (the stale latch has
 * been open all along). */
const WINDOW_MISSED_LOOKBACK_WINDOWS = 12;

export interface LinkStatsStalePair {
  linkKind: LinkStatKind;
  /** The latest usable result, or — for a pair that never had one — the
   * first attempt: the moment since which the series has had nothing. */
  since: Date;
  neverHadResult: boolean;
  lastAttemptAt: Date | null;
  lastAttemptStatus: string | null;
  lastAttemptReason: string | null;
}

/** Which of a page's kinds are stale at `now`. Pure. A pair nothing was ever
 * attempted for has no baseline to measure from and stays quiet (a page that
 * was just added); one with attempts and no result is measured from its first
 * attempt. */
export function findStaleLinkStatPairs(
  rows: readonly LinkStatSeriesHealthRow[],
  now: Date,
  staleAfterMs = OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS,
): LinkStatsStalePair[] {
  const stale: LinkStatsStalePair[] = [];
  for (const row of rows) {
    const since = row.lastUsableAt ?? row.firstAttemptAt;
    if (since === null || now.getTime() - since.getTime() <= staleAfterMs) {
      continue;
    }
    stale.push({
      linkKind: row.linkKind,
      since,
      neverHadResult: row.lastUsableAt === null,
      lastAttemptAt: row.lastAttemptAt,
      lastAttemptStatus: row.lastAttemptStatus,
      lastAttemptReason: row.lastAttemptReason,
    });
  }
  return stale;
}

/** The incident line for a page's stale kinds. Reason codes are spelled with
 * spaces: the incident sanitizer redacts anything shaped like an OFAPI key,
 * and codes such as `ofapi_mapping_changed` are. */
export function describeStaleLinkStatPairs(pairs: readonly LinkStatsStalePair[]): string {
  return pairs.map((pair) => {
    const since = pair.neverHadResult
      ? `no usable result since the first attempt at ${pair.since.toISOString()}`
      : `no usable result since ${pair.since.toISOString()}`;
    const reason = pair.lastAttemptReason === null
      ? ""
      : `: ${pair.lastAttemptReason.replaceAll("_", " ").slice(0, 80)}`;
    const last = pair.lastAttemptAt !== null && pair.lastAttemptStatus !== null &&
        pair.lastAttemptAt.getTime() > pair.since.getTime()
      ? `; last attempt ${pair.lastAttemptAt.toISOString()} ${pair.lastAttemptStatus}${reason}`
      : "; no attempt since";
    return `${pair.linkKind}: ${since}${last}`;
  }).join(" | ");
}

/** The closed windows the monitor answers for at `now`, oldest first: the
 * last WINDOW_MISSED_LOOKBACK_WINDOWS that have closed, from the first one
 * the series ever stamped. `stampedWindows` are the window_at values present
 * in the lookback. Pure.
 *
 * "From the first stamped window" keeps the monitor from marking windows
 * that predate the release which introduced `window_at`, or a change of the
 * schedule: a stamp that is not on today's grid is not a window of it. The
 * monitor's own rows are stamps too, so once it has marked a window the
 * chain continues through any outage of the reconcile. */
export function closedLinkStatWindowsToCheck(
  now: Date,
  stampedWindows: readonly Date[],
): Date[] {
  const onGrid = stampedWindows
    .map((stamp) => stamp.getTime())
    .filter((stampMs) => ofapiLinkStatsWindowAt(new Date(stampMs)).getTime() === stampMs);
  if (onGrid.length === 0) {
    return [];
  }
  const firstStampedMs = Math.min(...onGrid);
  const closed: Date[] = [];
  // The open window is the one `now` belongs to; everything before it closed.
  let windowAt = previousOfapiLinkStatsWindowAt(ofapiLinkStatsWindowAt(now));
  for (let step = 0; step < WINDOW_MISSED_LOOKBACK_WINDOWS; step += 1) {
    if (windowAt.getTime() < firstStampedMs) {
      break;
    }
    closed.push(windowAt);
    windowAt = previousOfapiLinkStatsWindowAt(windowAt);
  }
  return closed.reverse();
}

/** The oldest window the lookback can reach at `now`. */
function lookbackStart(now: Date): Date {
  let windowAt = ofapiLinkStatsWindowAt(now);
  for (let step = 0; step < WINDOW_MISSED_LOOKBACK_WINDOWS; step += 1) {
    windowAt = previousOfapiLinkStatsWindowAt(windowAt);
  }
  return windowAt;
}

function groupByPage(rows: readonly LinkStatSeriesHealthRow[]) {
  const pages = new Map<number, LinkStatSeriesHealthRow[]>();
  for (const row of rows) {
    const kinds = pages.get(row.platformAccountId) ?? [];
    kinds.push(row);
    pages.set(row.platformAccountId, kinds);
  }
  return pages;
}

/** Writes the `window_missed` rows. Returns how many it wrote. */
async function markMissedWindows(
  app: Pick<AppContext, "db" | "logger">,
  rows: readonly LinkStatSeriesHealthRow[],
  now: Date,
): Promise<number> {
  const attempts = await listLinkStatAttemptWindows(app.db, { since: lookbackStart(now) });
  const closed = closedLinkStatWindowsToCheck(now, attempts.map((attempt) => attempt.windowAt));
  if (closed.length === 0) {
    return 0;
  }
  const attempted = new Set(attempts.map((attempt) =>
    `${attempt.platformAccountId}:${attempt.linkKind}:${attempt.windowAt.getTime()}`));
  let written = 0;
  for (const windowAt of closed) {
    for (const row of rows) {
      // A page added while the window was open was not there to be read at
      // its opening; its first window is the next one.
      if (row.pageCreatedAt.getTime() > windowAt.getTime()) {
        continue;
      }
      if (attempted.has(`${row.platformAccountId}:${row.linkKind}:${windowAt.getTime()}`)) {
        continue;
      }
      const recorded = await recordLinkStatWindowMissed(app.db, {
        platformAccountId: row.platformAccountId,
        linkKind: row.linkKind,
        windowAt,
      });
      if (recorded) {
        written += 1;
        app.logger.warn({
          pageId: row.platformAccountId,
          pageLabel: row.pageLabel,
          linkKind: row.linkKind,
          windowAt: windowAt.toISOString(),
          closedAt: nextOfapiLinkStatsWindowAt(windowAt).toISOString(),
        }, "OFAPI link-stats window passed without an attempt; marked window_missed");
      }
    }
  }
  return written;
}

export interface OfapiLinkStatsSeriesMonitorResult {
  /** Pages whose `series_stale` latch the run opened or refreshed. */
  stalePages: number[];
  /** Pages whose `page_unmapped` latch the run opened or refreshed. */
  unmappedPages: number[];
  windowMissedRows: number;
}

/**
 * One run of the monitor. Never throws: a monitor that takes the minutely
 * sweep down with it would silence everything that runs after it.
 */
export async function runOfapiLinkStatsSeriesMonitor(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: {
    now: Date;
    /** Whether a page's OFAPI auth status is a dead session — the account
     * health module's own rule, passed in so the two cannot drift. */
    authNeedsAction: (status: string | null) => boolean;
  },
): Promise<OfapiLinkStatsSeriesMonitorResult> {
  const now = input.now;
  const result: OfapiLinkStatsSeriesMonitorResult = {
    stalePages: [],
    unmappedPages: [],
    windowMissedRows: 0,
  };
  // The series is switched off: nothing is expected of it, and the latches an
  // earlier run left are the owner's to close.
  if (app.config.ofapiLinkStatsReconcileEnabled !== true) {
    return result;
  }

  try {
    // First the rows, then the freshness: a window this run marks as missed
    // must not read as an attempt-free pair in the same run's message.
    const population = await listLinkStatSeriesHealth(app.db);
    result.windowMissedRows = await markMissedWindows(app, population, now);
    const health = result.windowMissedRows > 0
      ? await listLinkStatSeriesHealth(app.db)
      : population;

    const open = new Set(
      (await listNotificationIncidents(app.db, { status: "open" }))
        .filter((incident) => incident.kind === "ofapi_link_stats_reconcile_failed")
        .map((incident) => incident.incidentKey),
    );
    const settle = async (
      page: { id: number; label: string },
      subKey: OfapiLinkStatsPageSubKey,
      errorSummary: string | null,
    ) => {
      if (errorSummary !== null) {
        await notifyOfapiLinkStatsPageIncident(app, {
          subKey, pageId: page.id, pageLabel: page.label, errorSummary, occurredAt: now,
        });
        return true;
      }
      // Resolve only a latch that is open: a healthy fleet costs no write.
      if (open.has(ofapiLinkStatsPageIncidentKey({ subKey, pageId: page.id }))) {
        await resolveOfapiLinkStatsPageIncident(app, {
          subKey, pageId: page.id, pageLabel: page.label, recoveredAt: now,
        });
      }
      return false;
    };

    for (const [pageId, kinds] of groupByPage(health)) {
      const page = { id: pageId, label: kinds[0]!.pageLabel };

      const unmapped = kinds[0]!.ofapiAccountId === null;
      if (await settle(
        page,
        OFAPI_LINK_STATS_PAGE_UNMAPPED_SUBKEY,
        unmapped
          ? "The page has no OFAPI account mapping: its link series is skipped, and so is every "
            + "other OFAPI read of the page, until it is bound to an account."
          : null,
      )) {
        result.unmappedPages.push(pageId);
      }

      const stale = findStaleLinkStatPairs(kinds, now);
      const causeOwnedElsewhere = unmapped || input.authNeedsAction(kinds[0]!.ofapiAuthStatus);
      if (stale.length > 0 && causeOwnedElsewhere) {
        continue;
      }
      if (await settle(
        page,
        OFAPI_LINK_STATS_SERIES_STALE_SUBKEY,
        stale.length > 0 ? describeStaleLinkStatPairs(stale) : null,
      )) {
        result.stalePages.push(pageId);
      }
    }
  } catch (error) {
    app.logger.warn({ err: error }, "OFAPI link-stats series monitor failed; continuing");
  }
  return result;
}
