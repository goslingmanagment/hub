import type { PageBrowserRow, SyncPageRow } from "@agency_hub_core/db";

import { DEFAULT_PARAMS } from "../../services/egress/page-browser-protocol.ts";
import type { SyncEngineBrowserKind } from "../../services/notification-incidents.ts";
import { holdSetOf, pageHoldsInForce } from "./admission.ts";
import { ownerRunState } from "./status.ts";

// A page browser's alerts (Project Browser plan §4.9, §4.11; stage 3 PR 17):
// what the operator said of itself — its last `state` and its last `alarm`,
// kept on the profile's row by the engine that owns the page — judged into
// the kinds of the plan (`browser:<kind>` latches of `fansly_sync_engine`):
//
//   browser_down      the operator is silent (no `state` for 2 min while the
//                     page's owner runs), the engine cannot talk to it (its
//                     link refused: the token, the protocol), or the browser
//                     has not come up for 2 min for a reason no other kind
//                     names (Chrome crashed, the environment, a request that
//                     did not end, the socket guard, a start that hangs)
//   login_required    Fansly signed the browser out
//   proxy             the proxy unavailable or refusing its login, for 2 min
//   exit_ip_changed   the exit IP is not the pinned one: the page stands
//   buffer            the buffer full, the disk full, the buffer unopenable,
//                     or past 50 % of a cap (plan §4.4, spec §5)
//   selftest_failed   a guard of the self-test did not hold
//   protocol_changed  an unknown socket message that stopped the page (one
//                     that cut a tunnel alone is `socket_cut`), request
//                     headers that differ from the site's (plan §4.7) —
//                     and, from minor 5, for
//                     as long as the operator says the transport refuses
//                     Hub's requests for it (`state.hubSend`: the site's
//                     fansly-client-check or fansly-client-ts computed
//                     another way; an operator before 2026-10-22 also a
//                     header parity broken until Chrome starts anew),
//                     whatever the alarm's age
//   cdp_lost          control of Chrome lost (CDP, the holder's overflow, the
//                     fallback release of owner decision №10)
//   site_unconfirmed  the oldest of the site's observations the operator
//                     keeps for Hub's word (minor 6) waits past
//                     `SYNC_BROWSER_SITE_UNCONFIRMED_MS`: the site's sends
//                     are not journaled, their 429 holds not set
//   socket_cut        the socket gate refused a record of the site's socket
//                     and cut that tunnel alone (`unknown_ws_message` of
//                     `scope: "tunnel"`): nothing left, the page goes on, the
//                     site reconnects. Its own latch, apart from
//                     `protocol_changed`: when the gate keeps refusing, the
//                     operator stops the page (`unknown_ws_message` with no
//                     scope), and that stop pages on its own, while the cuts
//                     before it may still hold their latch open
//
// A stop that holds until the owner decides pages at once — and stays so
// while the operator holds the halt on its volume until his start (Hub's
// mirror of it, `page_browsers.halt_reason`); a failure the
// operator retries by itself (its backoff, plan §4.1) pages only once the
// browser has stayed down for `SYNC_BROWSER_DOWN_MS`. An alarm holds its kind
// for the clean window after it (as of the alarm: its latch resolves 10 min
// after it). A page that says `ready` while Hub's requests stand for any
// other reason is `browser_down` once that lasted `SYNC_BROWSER_DOWN_MS`. What the owner does himself explains the browser being down —
// his stop (`sync browser stop`), his pause, his login (the manual login),
// a credentials hold (alert 1 pages that) — but never a guard that failed.
// Pure: the evaluator reads the facts, the status shows the same conditions.

/** No `state` from the operator for this long, while the page's owner runs:
 *  `browser_down` (plan §4.11). */
export const SYNC_BROWSER_STATE_SILENT_MS = 2 * 60_000;
/** A browser not up for this long, for a reason it retries by itself. */
export const SYNC_BROWSER_DOWN_MS = 2 * 60_000;
/** The oldest of the site's observations the operator keeps unconfirmed this
 *  long (minor 6; it tells them again every few seconds): `site_unconfirmed`. */
export const SYNC_BROWSER_SITE_UNCONFIRMED_MS = 2 * 60_000;
/** An alarm holds its kind this long after it (the alerts' clean window). */
export const SYNC_BROWSER_ALARM_HOLD_MS = 10 * 60_000;
/** The buffer's caps (plan §4.14, spec §5): the operator's defaults — the
 *  engine's hello sends none of its own. */
export const SYNC_BROWSER_BUFFER_CAP = DEFAULT_PARAMS.bufferCap;

export interface BrowserAlertFacts {
  page: Pick<SyncPageRow, "pageId" | "mode" | "pausedAll" | "holds" | "owner">;
  /** The profile bound to the page (null: none). */
  browser: PageBrowserRow | null;
  now: Date;
}

export interface SyncBrowserAlertCondition {
  kind: SyncEngineBrowserKind;
  /** Why, in the operator's or the engine's words (a stop reason, an alarm
   *  kind, `no_state`, `link_<error>`, `buffer_<percent>`, `not_up:<step>`). */
  detail: string;
  since: Date | null;
  /** The newest instant the condition is known to hold: `now`, or an alarm's. */
  seenAt: Date;
  context?: Record<string, string | number | boolean | null>;
}

/** The stop reasons that page at once (the operator stands until the owner
 *  decides, or a guard did not hold), by kind. */
const STOP_KIND: Readonly<Record<string, SyncEngineBrowserKind>> = {
  login_required: "login_required",
  exit_ip_changed: "exit_ip_changed",
  selftest_failed: "selftest_failed",
  header_mismatch: "protocol_changed",
  unknown_ws_message: "protocol_changed",
  cdp_lost: "cdp_lost",
  holder_overflow: "cdp_lost",
  buffer_full: "buffer",
  disk_full: "buffer",
  buffer_unavailable: "buffer",
};

/** The stop reasons the operator retries by itself and that page only once
 *  the browser stayed down (`SYNC_BROWSER_DOWN_MS`). */
const RETRIED_KIND: Readonly<Record<string, SyncEngineBrowserKind>> = {
  proxy_unavailable: "proxy",
  proxy_auth: "proxy",
};

/** The reasons the transport itself refuses Hub's requests (`state.hubSend`,
 *  minor 5): `protocol_changed` while they hold. */
const HUB_SEND_PROTOCOL: ReadonlySet<string> = new Set(["header_parity", "client_check"]);

/** The operator's alarms, by kind (spec §6.1); an `unknown_ws_message`
 *  that cut one tunnel only is `socket_cut` (alarmKindOf). */
const ALARM_KIND: Readonly<Record<string, SyncEngineBrowserKind>> = {
  unknown_ws_message: "protocol_changed",
  header_mismatch: "protocol_changed",
  selftest_failed: "selftest_failed",
  overflow: "cdp_lost",
  cdp_lost: "cdp_lost",
  fallback_release: "cdp_lost",
  late_send: "browser_down",
  buffer: "buffer",
};

/** The kind of the operator's alarm: a socket's tunnel cut alone (`scope:
 *  "tunnel"`, the page goes on) is not the page stopped. */
function alarmKindOf(kind: string, detail: Record<string, string | number | boolean> | null): SyncEngineBrowserKind | undefined {
  if (kind === "unknown_ws_message" && detail?.scope === "tunnel") return "socket_cut";
  return ALARM_KIND[kind];
}

function msSince(at: Date | null, now: Date): number {
  return at === null ? Number.POSITIVE_INFINITY : now.getTime() - at.getTime();
}

function later(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** The buffer's fill against its caps, in percent of the fuller one (null:
 *  not said). */
export function browserBufferPercent(browser: Pick<PageBrowserRow, "bufferBytes" | "bufferOldestAgeMs">): number | null {
  const fill = bufferFill(browser);
  return fill === null ? null : Number((fill * 100).toFixed(1));
}

/** The fuller cap's share, unrounded (null: not said). */
function bufferFill(browser: Pick<PageBrowserRow, "bufferBytes" | "bufferOldestAgeMs">): number | null {
  if (browser.bufferBytes === null && browser.bufferOldestAgeMs === null) return null;
  const bytes = (browser.bufferBytes ?? 0) / SYNC_BROWSER_BUFFER_CAP.bytes;
  const age = (browser.bufferOldestAgeMs ?? 0) / SYNC_BROWSER_BUFFER_CAP.ageMs;
  return Math.max(bytes, age);
}

/** What the owner did himself that explains the page's browser not being up
 *  (null: nothing). */
export function browserDownExplained(facts: BrowserAlertFacts): "owner_stop" | "paused" | "manual_login" | "credentials_hold" | null {
  const { page, browser, now } = facts;
  if (browser?.ownerStopAt != null || browser?.stopReason === "owner_stop") return "owner_stop";
  if (page.pausedAll) return "paused";
  if (browser?.mode === "manual_login") return "manual_login";
  if (pageHoldsInForce(holdSetOf(page.holds), now)?.credentials) return "credentials_hold";
  return null;
}

/** The conditions of a page's browser that hold now (pure), at most one per
 *  kind — the earliest-named reason of the kind wins. */
export function evaluateBrowserAlerts(facts: BrowserAlertFacts): SyncBrowserAlertCondition[] {
  const { page, browser, now } = facts;
  if (browser === null) return [];
  const found = new Map<SyncEngineBrowserKind, SyncBrowserAlertCondition>();
  const add = (condition: SyncBrowserAlertCondition) => {
    if (!found.has(condition.kind)) found.set(condition.kind, condition);
  };
  const explained = browserDownExplained(facts);
  const reason = browser.stopReason;
  // How long the browser has not been up (0: it is, or it never said).
  const downFor = browser.downSince === null || browser.step === "ready" ? 0 : msSince(browser.downSince, now);

  // The engine cannot talk to the operator, or hears nothing from it while
  // the page's owner runs (an owner that does not run is alert 1's).
  if (browser.linkError !== null) {
    add({ kind: "browser_down", detail: `link_${browser.linkError}`, since: null, seenAt: now });
  }
  const owner = ownerRunState({ mode: page.mode, owner: page.owner }, now);
  const heardSince = later(browser.lastStateAt, page.owner.acquiredAt);
  if (owner.running && msSince(heardSince, now) > SYNC_BROWSER_STATE_SILENT_MS) {
    add({
      kind: "browser_down",
      detail: "no_state",
      since: heardSince,
      seenAt: now,
      context: { lastStateAt: browser.lastStateAt?.toISOString() ?? null },
    });
  }

  // The halt the operator holds for the owner's decision (Hub's mirror of
  // it), whatever its step says now: until his start clears it.
  if (browser.haltReason !== null) {
    const kind = STOP_KIND[browser.haltReason] ?? "browser_down";
    if (!(kind === "login_required" && browser.mode === "manual_login")) {
      add({ kind, detail: browser.haltReason, since: browser.haltAt, seenAt: now, context: { latched: true } });
    }
  }

  // What the operator's state says.
  if (reason !== null) {
    const kind = STOP_KIND[reason];
    // The owner's login is a person at the login: no page for it.
    if (kind !== undefined && !(kind === "login_required" && browser.mode === "manual_login")) {
      add({ kind, detail: reason, since: browser.stopSince, seenAt: now });
    }
    const retried = RETRIED_KIND[reason];
    if (retried !== undefined && explained === null && downFor > SYNC_BROWSER_DOWN_MS) {
      add({ kind: retried, detail: reason, since: browser.downSince, seenAt: now });
    }
  }
  // Hub's requests refused, while the reason lives (minor 5): the transport's
  // own whatever the step; any other only while the page says it is ready.
  if (browser.hubSendAllowed === false && browser.hubSendBlockedReason !== null) {
    const blocked = browser.hubSendBlockedReason;
    const condition = {
      detail: `hub_send_blocked:${blocked}`,
      since: browser.hubSendBlockedSince,
      seenAt: now,
      context: { reason: blocked, step: browser.step, blockedSince: browser.hubSendBlockedSince?.toISOString() ?? null },
    };
    if (HUB_SEND_PROTOCOL.has(blocked)) add({ kind: "protocol_changed", ...condition });
    else if (browser.step === "ready" && explained === null && msSince(browser.hubSendBlockedSince, now) > SYNC_BROWSER_DOWN_MS) {
      add({ kind: "browser_down", ...condition });
    }
  }
  // The site's observations Hub has not confirmed (minor 6), by the oldest's
  // age — while the state saying it is fresh (a silent operator is
  // `browser_down`'s).
  if (browser.siteObservedUnconfirmed !== null && browser.siteObservedUnconfirmed > 0 && browser.siteObservedOldestAt !== null
    && msSince(browser.lastStateAt, now) <= SYNC_BROWSER_STATE_SILENT_MS && msSince(browser.siteObservedOldestAt, now) > SYNC_BROWSER_SITE_UNCONFIRMED_MS) {
    add({
      kind: "site_unconfirmed",
      detail: "site_unconfirmed",
      since: browser.siteObservedOldestAt,
      seenAt: now,
      context: { unconfirmed: browser.siteObservedUnconfirmed, dropped: browser.siteObservedDropped, oldestAt: browser.siteObservedOldestAt.toISOString() },
    });
  }
  if (browser.selftestOk === false) {
    add({ kind: "selftest_failed", detail: browser.selftestFailed ?? "selftest_failed", since: browser.selftestAt, seenAt: now });
  }
  const fill = bufferFill(browser);
  const alarmPercents = [...SYNC_BROWSER_BUFFER_CAP.alarmPercents].sort((a, b) => b - a);
  const crossed = fill === null ? undefined : alarmPercents.find((threshold) => fill * 100 >= threshold);
  if (crossed !== undefined) {
    add({ kind: "buffer", detail: `buffer_${crossed}`, since: null, seenAt: now, context: { percent: browserBufferPercent(browser) } });
  }

  // The operator's last alarm, for the clean window after it.
  if (browser.alarmKind !== null && browser.alarmAt !== null && msSince(browser.alarmAt, now) <= SYNC_BROWSER_ALARM_HOLD_MS) {
    const kind = alarmKindOf(browser.alarmKind, browser.alarmDetail);
    if (kind !== undefined && !(kind === "buffer" && bufferAlarmBelow(browser.alarmDetail))) {
      add({ kind, detail: `alarm_${browser.alarmKind}`, since: browser.alarmAt, seenAt: browser.alarmAt, context: { ...(browser.alarmDetail ?? {}) } });
    }
  }

  // Down for a reason no other kind names, or starting for too long.
  const covered = reason !== null && (STOP_KIND[reason] !== undefined || RETRIED_KIND[reason] !== undefined);
  if (explained === null && !covered && reason !== "owner_stop" && browser.haltReason === null && browser.lastStateAt !== null
    && downFor > SYNC_BROWSER_DOWN_MS) {
    add({
      kind: "browser_down",
      detail: reason ?? (browser.step === "site_loaded" && browser.sessionFingerprint === null ? "session_unknown" : `not_up:${browser.step ?? "unknown"}`),
      since: browser.downSince,
      seenAt: now,
      context: { step: browser.step, retryAt: browser.retryAt?.toISOString() ?? null },
    });
  }
  return [...found.values()];
}

/** A buffer alarm below the lowest alarm threshold (its own `percent`): no
 *  page for it. */
function bufferAlarmBelow(detail: Record<string, string | number | boolean> | null): boolean {
  if (detail === null) return false;
  if (detail.full === true || detail.unavailable === true) return false;
  const percent = detail.percent;
  return typeof percent === "number" && percent < Math.min(...SYNC_BROWSER_BUFFER_CAP.alarmPercents);
}
