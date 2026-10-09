import {
  listNotificationIncidents,
  listOfapiCollectionScheduleHealth,
  type OfapiCollectionRunSummary,
} from "@agency_hub_core/db";
import type { OfapiCollectionCategory } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  notifyOfapiCollectionStaleIncident,
  ofapiCollectionStaleIncidentKey,
  OFAPI_COLLECTION_STALE_SUBKEY,
  resolveOfapiCollectionStaleIncident,
} from "./notification-incidents.ts";

// Traffic sources plan §2.8 п. 3 / §2.10: a scheduled collection category no
// run completed for more than two intervals is stale. The collection screen
// flags it from the same rule (`judgeOfapiCollectionSchedule`); this check
// keeps one digest-only incident per page open while any of its categories is
// stale, so a category that silently stopped is not left to someone opening
// the screen.

/** Why the newest scheduled run did not complete, in the incident's words
 * (the summary keeps 240 characters; a page can have several categories). */
export function describeStaleCollectionCause(run: OfapiCollectionRunSummary | null): string {
  if (run === null) return "no scheduled run yet";
  if (run.exhaustedLimit === "job_limit") {
    const step = run.stepsDone !== null && run.stepsTotal !== null && run.stepsDone < run.stepsTotal
      ? `, step ${run.stepsDone + 1}/${run.stepsTotal}`
      : "";
    switch (run.exhaustedCap) {
      case "calls": return `run hits its call cap ${run.usedCalls}/${run.maxCalls}${step}`;
      case "credits": return `run hits its credit cap ${run.usedCredits}/${run.maxCredits}${step}`;
      case "bytes": return `run hits its byte cap${step}`;
      // Admission does not say which ceiling refused; the counters single none out.
      default: return `run hits a job limit (calls ${run.usedCalls}/${run.maxCalls}, credits ${run.usedCredits}/${run.maxCredits})${step}`;
    }
  }
  if (run.exhaustedLimit === "daily_limit") return "run stops at the daily credit limit";
  if (run.exhaustedLimit !== null) return `run stops at ${run.exhaustedLimit}`;
  switch (run.state) {
    case "paused": return "run paused";
    case "queued": case "running": return "run in progress";
    case "completed": return "no run since the last completed one";
    default: return "last run failed";
  }
}

export function describeStaleCollection(
  categories: ReadonlyArray<{ category: OfapiCollectionCategory; lastRun: OfapiCollectionRunSummary | null }>,
): string {
  return `No scheduled run completed for 2+ intervals: ${categories
    .map(row => `${row.category} (${describeStaleCollectionCause(row.lastRun)})`)
    .join("; ")}`;
}

export interface OfapiCollectionStaleCheckResult {
  stalePages: number[];
  resolvedPages: number[];
}

/** One pass, from the minutely collection sweep. Never throws: a failure is
 * logged and the sweep goes on. */
export async function checkOfapiCollectionStaleness(
  app: Pick<AppContext, "db" | "logger">,
  now = new Date(),
): Promise<OfapiCollectionStaleCheckResult> {
  const result: OfapiCollectionStaleCheckResult = { stalePages: [], resolvedPages: [] };
  try {
    const health = await listOfapiCollectionScheduleHealth(app.db, now);
    const stale = new Map<number, { label: string; categories: Array<{ category: OfapiCollectionCategory; lastRun: OfapiCollectionRunSummary | null }> }>();
    for (const row of health) {
      if (!row.health.stale) continue;
      const page = stale.get(row.pageId) ?? { label: row.pageLabel, categories: [] };
      page.categories.push({ category: row.category, lastRun: row.health.lastRun });
      stale.set(row.pageId, page);
    }
    for (const [pageId, page] of stale) {
      await notifyOfapiCollectionStaleIncident(app, {
        pageId, pageLabel: page.label, errorSummary: describeStaleCollection(page.categories), occurredAt: now,
      });
      result.stalePages.push(pageId);
    }
    // Resolve only latches that are open: a healthy fleet costs no write. A
    // latch of a page that left the list (deleted, no longer stale) resolves too.
    const open = (await listNotificationIncidents(app.db, { status: "open" }))
      .filter(incident => incident.kind === "read_gateway_capture" && incident.platformAccountId !== null
        && incident.incidentKey === ofapiCollectionStaleIncidentKey(incident.platformAccountId));
    for (const incident of open) {
      const pageId = incident.platformAccountId!;
      if (stale.has(pageId)) continue;
      const metadata = incident.metadata as { pageLabel?: unknown } | null;
      await resolveOfapiCollectionStaleIncident(app, {
        pageId, pageLabel: typeof metadata?.pageLabel === "string" ? metadata.pageLabel : null, recoveredAt: now,
      });
      result.resolvedPages.push(pageId);
    }
  } catch (err) {
    app.logger.error({ err, subKey: OFAPI_COLLECTION_STALE_SUBKEY }, "Collection stale check failed");
  }
  return result;
}
