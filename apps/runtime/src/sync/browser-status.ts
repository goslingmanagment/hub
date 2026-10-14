import { listPageBrowsersOfPages, type Database, type PageBrowserOfPage, type SyncPageRow } from "@agency_hub_core/db";

import { holdSetOf, pageHoldsInForce } from "./engine/admission.ts";
import {
  browserBufferPercent,
  evaluateBrowserAlerts,
  SYNC_BROWSER_BUFFER_CAP,
} from "./engine/browser-alerts.ts";

// A page's browser on the status surfaces (Project Browser plan §4.11; stage
// 3 PR 17): the «Браузер» block of the «Синк» tab, `/api/v1/sync/pages`,
// `sync page status`, `sync browser status` and the agents' `hub
// sync-status` — one view, read in one place. Only a page with a browser
// profile bound to it has one: every other page's status is as it was.
//
// What it says: the page's transport and a leave pending; the operator's last
// word (its step, stop reason, next retry, exit, mode — and how old it is);
// the engine's link error; the owner's stop and a halt latched for his
// decision; whether a login is needed; the
// session (present or not, the account it named — never its token or
// fingerprint); the proxy as the browser meets it (the pinned exit IP and the
// one it saw; never the proxy's address or credentials); the buffer (its
// figures against its caps, a halted or undrained buffer); the delivery of
// its events; Chrome's and the operator's versions; the last self-test; the
// last alarm; and the browser's alerts that hold now
// (`engine/browser-alerts.ts`, the evaluator's own rule).

export interface BrowserStatusView {
  profileId: string;
  container: string;
  transport: "node" | "browser";
  leavePendingSince: string | null;
  link: { lastStateAt: string | null; stateAgeMs: number | null; error: string | null };
  state: {
    step: string | null;
    stopReason: string | null;
    retryAt: string | null;
    exitOpen: boolean;
    mode: "automation" | "manual_login";
    downSince: string | null;
    stopSince: string | null;
  };
  ownerStop: { at: string; by: string; paused: boolean } | null;
  /** Stopped for the owner's decision, latched until `sync browser start`. */
  halt: { reason: string; at: string } | null;
  login: { needed: boolean; why: string | null };
  session: { present: boolean; accountId: string | null };
  proxy: { pinnedExitIp: string | null; pinnedAt: string | null; exitIp: string | null; matches: boolean | null; problem: string | null };
  buffer: {
    bytes: number | null;
    oldestAgeMs: number | null;
    percent: number | null;
    capBytes: number;
    capAgeMs: number;
    haltedReason: string | null;
    haltedAt: string | null;
    undrainedSince: string | null;
  };
  delivery: { lastEventAt: string | null; lastCommitAt: string | null; p50Ms: number | null; p95Ms: number | null; at: string | null };
  versions: { chrome: string | null; operator: string | null };
  selfTest: { ok: boolean | null; at: string | null; failed: string | null };
  alarm: { kind: string; at: string; detail: Record<string, string | number | boolean> } | null;
  alerts: Array<{ kind: string; detail: string; since: string | null }>;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The proxy's trouble as the operator met it (null: none it said). */
function proxyProblem(stopReason: string | null): string | null {
  switch (stopReason) {
    case "proxy_unavailable":
      return "unavailable";
    case "proxy_auth":
      return "auth";
    case "exit_ip_changed":
      return "exit_ip_changed";
    default:
      return null;
  }
}

/** The view of one page's browser (pure). */
export function buildBrowserStatus(
  input: PageBrowserOfPage & { page: Pick<SyncPageRow, "pageId" | "mode" | "pausedAll" | "holds" | "owner">; now: Date },
): BrowserStatusView {
  const { browser, page, now } = input;
  const held = pageHoldsInForce(holdSetOf(page.holds), now)?.credentials ?? null;
  const loginWhy = browser.stopReason === "login_required"
    ? "login_required"
    : held !== null && input.transport === "browser" ? held.kind : null;
  // The alerts hold only for a page that pages the owner and runs on its
  // browser (as the evaluator judges them).
  const judged = (page.mode === "live" || page.mode === "handover") && input.transport === "browser";
  const alerts = judged ? evaluateBrowserAlerts({ page, browser, now }) : [];
  return {
    profileId: browser.profileId,
    container: browser.container,
    transport: input.transport,
    leavePendingSince: iso(input.leaveSince),
    link: {
      lastStateAt: iso(browser.lastStateAt),
      stateAgeMs: browser.lastStateAt === null ? null : Math.max(0, now.getTime() - browser.lastStateAt.getTime()),
      error: browser.linkError,
    },
    state: {
      step: browser.step,
      stopReason: browser.stopReason,
      retryAt: iso(browser.retryAt),
      exitOpen: browser.exitOpen,
      mode: browser.mode,
      downSince: iso(browser.downSince),
      stopSince: iso(browser.stopSince),
    },
    ownerStop: browser.ownerStopAt === null
      ? null
      : { at: browser.ownerStopAt.toISOString(), by: browser.ownerStopBy ?? "", paused: input.browserStopPaused },
    halt: browser.haltReason === null || browser.haltAt === null ? null : { reason: browser.haltReason, at: browser.haltAt.toISOString() },
    login: { needed: loginWhy !== null, why: loginWhy },
    session: { present: browser.sessionFingerprint !== null, accountId: browser.accountId },
    proxy: {
      pinnedExitIp: browser.pinnedExitIp,
      pinnedAt: iso(browser.pinnedExitIpAt),
      exitIp: browser.exitIp,
      matches: browser.pinnedExitIp === null || browser.exitIp === null ? null : browser.pinnedExitIp === browser.exitIp,
      problem: proxyProblem(browser.stopReason),
    },
    buffer: {
      bytes: browser.bufferBytes,
      oldestAgeMs: browser.bufferOldestAgeMs,
      percent: browserBufferPercent(browser),
      capBytes: SYNC_BROWSER_BUFFER_CAP.bytes,
      capAgeMs: SYNC_BROWSER_BUFFER_CAP.ageMs,
      haltedReason: input.intake.halted?.reason ?? null,
      haltedAt: iso(input.intake.halted?.at ?? null),
      undrainedSince: iso(browser.bufferUndrainedSince),
    },
    delivery: {
      lastEventAt: iso(input.intake.lastEventAt),
      lastCommitAt: iso(input.intake.lastCommitAt),
      p50Ms: browser.deliveryP50Ms,
      p95Ms: browser.deliveryP95Ms,
      at: iso(browser.deliveryAt),
    },
    versions: { chrome: browser.chromeVersion, operator: browser.operatorVersion },
    selfTest: { ok: browser.selftestOk, at: iso(browser.selftestAt), failed: browser.selftestFailed },
    alarm: browser.alarmKind === null || browser.alarmAt === null
      ? null
      : { kind: browser.alarmKind, at: browser.alarmAt.toISOString(), detail: { ...(browser.alarmDetail ?? {}) } },
    alerts: alerts.map((alert) => ({ kind: alert.kind, detail: alert.detail, since: iso(alert.since) })),
  };
}

/** The browser of each page that has one (by page id); a page without a
 *  profile bound to it is absent. */
export async function readPageBrowserStatuses(
  db: Database,
  pages: ReadonlyArray<Pick<SyncPageRow, "pageId" | "mode" | "pausedAll" | "holds" | "owner" | "dbNow">>,
): Promise<Map<number, BrowserStatusView>> {
  if (pages.length === 0) return new Map();
  const byId = new Map(pages.map((page) => [page.pageId, page]));
  const rows = await listPageBrowsersOfPages(db, { pageIds: [...byId.keys()] });
  const views = new Map<number, BrowserStatusView>();
  for (const row of rows) {
    const page = byId.get(row.pageId);
    if (page !== undefined) views.set(row.pageId, buildBrowserStatus({ ...row, page, now: page.dbNow }));
  }
  return views;
}
