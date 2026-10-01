import {
  advanceFanslySendPaceCursor,
  findFanslySendPaceBatchEnd,
  findFanslySendPaceViolations,
  getNotificationIncidentByKey,
  listFanslySendGuards,
  readFanslySendPaceCursor,
  type FanslySendGuardRow,
  type FanslySendPaceViolation,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  FANSLY_PACE_VIOLATION_SUBKEY,
  FANSLY_SEND_GUARD_CLOSED_SUBKEY,
  incidentKey,
  notifyFanslyPaceViolationIncident,
  notifyFanslySendGuardClosedIncident,
  resolveFanslyPaceViolationIncident,
  resolveFanslySendGuardClosedIncident,
} from "../notification-incidents.ts";
import { settlesWithin } from "./index.ts";

// Plan §2.5 and §10 (alert 1: «страница остановлена или темп нарушен»), for the
// legacy engine's send guard. The api runs this every minute:
//
//   closed page — a guard row whose holder overran its lease and is neither
//     completed nor confirmed gone: nothing is sent for the page. The latch
//     opens within about a minute and says what to run; it resolves when the
//     page opens again (completion, a sweeper's confirmation, or
//     `fansly-send-guard confirm-terminated`).
//   pace violation — ANY two consecutive sends of one page (journal `sent_at`,
//     every source) closer than the pause setting in force for the later one.
//     This must never happen («проверка, а не вера»). The check walks the new
//     journal rows behind a durable cursor in bounded batches, so every send
//     is examined, across restarts too. The latch stays open for an hour
//     after the last violation found.

export const FANSLY_SEND_GUARD_MONITOR_INTERVAL_MS = 60_000;
/** Journal rows examined per pass at most (a backlog drains over passes). */
export const FANSLY_PACE_CHECK_BATCH_ROWS = 10_000;
/** A pace latch resolves once no violation was found for this long. */
export const FANSLY_PACE_VIOLATION_CLEAR_MS = 60 * 60_000;
/** Right after the api starts, a closed page opens no latch yet: a deploy that
 *  cut a request releases its holder by the deploy's confirmation a few
 *  minutes later. A page that opens again still resolves its latch. */
export const FANSLY_SEND_GUARD_MONITOR_BOOT_GRACE_MS = 5 * 60_000;
/** stop() waits this long for a pass in flight (inside the api's stop grace). */
export const FANSLY_SEND_GUARD_MONITOR_STOP_TIMEOUT_MS = 5_000;

type MonitorApp = Pick<AppContext, "db" | "logger">;

export interface FanslySendGuardMonitorResult {
  bootGrace: boolean;
  /** Pages whose closed latch this pass opened or refreshed. */
  closedPages: number[];
  /** Pages whose closed latch this pass resolved. */
  reopenedPages: number[];
  pace: {
    afterId: number;
    throughId: number;
    examined: number;
    violations: FanslySendPaceViolation[];
    /** False when an incident could not be written (the batch is examined
     *  again next pass) or another checker moved the cursor first. */
    advanced: boolean;
  };
  /** Pages whose pace latch this pass resolved. */
  paceCleared: number[];
}

function isoSeconds(value: Date | null): string {
  return value ? value.toISOString().replace(/\.\d{3}Z$/, "Z") : "?";
}

/** ≤ 240 characters (the incident summary is clamped there), command first:
 *  a clamp cuts the holder's description, never the token to confirm. */
export function describeClosedFanslyPage(row: FanslySendGuardRow): string {
  return `Run fansly-send-guard status; if the holder's process is gone: `
    + `fansly-send-guard confirm-terminated --holder-token ${row.holderToken ?? "?"}. `
    + `Holder: ${row.holderRole ?? "?"}@${row.holderHost ?? "?"} pid ${row.holderPid ?? "?"}, `
    + `${row.holderSource ?? "?"}/${row.holderOperation ?? "?"}, lease ended ${isoSeconds(row.leaseUntil)}`;
}

export function describeFanslyPaceViolations(violations: readonly FanslySendPaceViolation[]): string {
  const closest = violations.reduce((best, violation) => (violation.gapMs < best.gapMs ? violation : best));
  const gap = Math.max(0, Math.floor(closest.gapMs));
  return `${violations.length} pair(s) of sends closer than the setting; closest ${gap} ms apart `
    + `(setting ${closest.settingMs} ms) at ${closest.later.sentAt.toISOString()}: `
    + `${closest.earlier.source}@${closest.earlier.holderRole} then ${closest.later.source}@${closest.later.holderRole}. `
    + `See fansly-send-guard report --since ${isoSeconds(closest.earlier.sentAt)}`;
}

async function latchIsOpen(app: MonitorApp, pageId: number, subKey: string) {
  const incident = await getNotificationIncidentByKey(app.db, incidentKey({
    kind: "sync_silent",
    platformAccountId: pageId,
    subKey,
  }));
  return incident?.status === "open" ? incident : null;
}

async function checkClosedPages(
  app: MonitorApp,
  rows: readonly FanslySendGuardRow[],
  input: { now: Date; bootGrace: boolean },
) {
  const closedPages: number[] = [];
  const reopenedPages: number[] = [];
  for (const row of rows) {
    const closed = row.holderToken !== null && row.leaseExpired;
    if (closed) {
      if (input.bootGrace) continue;
      app.logger.error({
        component: "fansly_send_guard",
        pageId: row.pageId,
        pageLabel: row.pageLabel,
        holderToken: row.holderToken,
        holderHost: row.holderHost,
        holderPid: row.holderPid,
        holderRole: row.holderRole,
        holderSource: row.holderSource,
        leaseUntil: row.leaseUntil?.toISOString() ?? null,
      }, "Fansly page closed: its request holder overran the lease and is not confirmed terminated");
      if (await notifyFanslySendGuardClosedIncident(app, {
        pageId: row.pageId,
        pageLabel: row.pageLabel,
        errorSummary: describeClosedFanslyPage(row),
        occurredAt: input.now,
      })) {
        closedPages.push(row.pageId);
      }
      continue;
    }
    if (await latchIsOpen(app, row.pageId, FANSLY_SEND_GUARD_CLOSED_SUBKEY)) {
      await resolveFanslySendGuardClosedIncident(app, {
        pageId: row.pageId,
        pageLabel: row.pageLabel,
        recoveredAt: input.now,
      });
      reopenedPages.push(row.pageId);
    }
  }
  return { closedPages, reopenedPages };
}

async function checkPace(app: MonitorApp, input: { now: Date; batchRows: number }) {
  const cursor = await readFanslySendPaceCursor(app.db);
  const { throughId, examined } = await findFanslySendPaceBatchEnd(app.db, {
    afterId: cursor.afterId,
    limit: input.batchRows,
  });
  const result = {
    afterId: cursor.afterId,
    throughId,
    examined,
    violations: [] as FanslySendPaceViolation[],
    advanced: false,
  };
  if (throughId <= cursor.afterId) return result;

  result.violations = await findFanslySendPaceViolations(app.db, { afterId: cursor.afterId, throughId });
  const byPage = new Map<number, FanslySendPaceViolation[]>();
  for (const violation of result.violations) {
    app.logger.error({
      component: "fansly_send_guard",
      pageId: violation.pageId,
      pageLabel: violation.pageLabel,
      gapMs: violation.gapMs,
      settingMs: violation.settingMs,
      earlier: { ...violation.earlier, sentAt: violation.earlier.sentAt.toISOString() },
      later: { ...violation.later, sentAt: violation.later.sentAt.toISOString() },
    }, "Fansly pace violated: two sends of a page closer than the pause setting");
    const list = byPage.get(violation.pageId) ?? [];
    list.push(violation);
    byPage.set(violation.pageId, list);
  }
  let latched = true;
  for (const [pageId, violations] of byPage) {
    latched = await notifyFanslyPaceViolationIncident(app, {
      pageId,
      pageLabel: violations[0]?.pageLabel ?? null,
      errorSummary: describeFanslyPaceViolations(violations),
      occurredAt: input.now,
    }) && latched;
  }
  // A violation whose incident could not be written is examined again next
  // pass: the cursor stays.
  if (latched) {
    result.advanced = await advanceFanslySendPaceCursor(app.db, { fromId: cursor.afterId, toId: throughId });
  }
  return result;
}

async function clearQuietPaceLatches(
  app: MonitorApp,
  rows: readonly FanslySendGuardRow[],
  input: { now: Date; flagged: ReadonlySet<number> },
) {
  const cleared: number[] = [];
  for (const row of rows) {
    if (input.flagged.has(row.pageId)) continue;
    const open = await latchIsOpen(app, row.pageId, FANSLY_PACE_VIOLATION_SUBKEY);
    if (!open || input.now.getTime() - open.lastSeenAt.getTime() < FANSLY_PACE_VIOLATION_CLEAR_MS) continue;
    await resolveFanslyPaceViolationIncident(app, {
      pageId: row.pageId,
      pageLabel: row.pageLabel,
      recoveredAt: input.now,
    });
    cleared.push(row.pageId);
  }
  return cleared;
}

/** One pass: the closed-page latches, the pace check over the new journal
 *  rows, and the pace latches that stayed quiet for an hour. */
export async function runFanslySendGuardMonitorPass(
  app: MonitorApp,
  options: { startedAtMs: number; now?: Date; batchRows?: number },
): Promise<FanslySendGuardMonitorResult> {
  const now = options.now ?? new Date();
  const bootGrace = now.getTime() - options.startedAtMs < FANSLY_SEND_GUARD_MONITOR_BOOT_GRACE_MS;
  const rows = await listFanslySendGuards(app.db);
  const closed = await checkClosedPages(app, rows, { now, bootGrace });
  const pace = await checkPace(app, { now, batchRows: options.batchRows ?? FANSLY_PACE_CHECK_BATCH_ROWS });
  const paceCleared = await clearQuietPaceLatches(app, rows, {
    now,
    flagged: new Set(pace.violations.map((violation) => violation.pageId)),
  });
  return { bootGrace, ...closed, pace, paceCleared };
}

export interface FanslySendGuardMonitor {
  /** Stops the ticks and waits for the pass in flight, bounded by
   *  FANSLY_SEND_GUARD_MONITOR_STOP_TIMEOUT_MS. */
  stop(): Promise<void>;
}

/** Started from the api runtime. Unref'd; passes never overlap. */
export function startFanslySendGuardMonitor(
  app: MonitorApp,
  options: { startedAtMs?: number; intervalMs?: number } = {},
): FanslySendGuardMonitor {
  const startedAtMs = options.startedAtMs ?? Date.now();
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = runFanslySendGuardMonitorPass(app, { startedAtMs })
      .then(() => undefined)
      .catch((error: unknown) => {
        app.logger.warn({ component: "fansly_send_guard", err: error }, "Fansly send guard monitor pass failed; retrying next tick");
      })
      .finally(() => {
        inFlight = null;
      });
  }, options.intervalMs ?? FANSLY_SEND_GUARD_MONITOR_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      const pass = inFlight;
      if (!pass) return;
      if (!await settlesWithin(pass, FANSLY_SEND_GUARD_MONITOR_STOP_TIMEOUT_MS)) {
        app.logger.warn(
          { component: "fansly_send_guard", timeoutMs: FANSLY_SEND_GUARD_MONITOR_STOP_TIMEOUT_MS },
          "Fansly send guard monitor stop timed out on a pass in flight; the next api repeats it",
        );
      }
    },
  };
}
