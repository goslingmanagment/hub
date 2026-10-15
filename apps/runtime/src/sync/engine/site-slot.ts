import {
  captureAttempt,
  clearPageHold,
  countSiteSendsSince,
  getSyncPage,
  insertSiteAdmission,
  lockOwnedPage,
  OwnershipLostError,
  setNetworkFailureStreak,
  setPageHold,
  settleAttemptWithoutCapture,
  writeSyncRouteState,
  type Database,
  type SyncPageRow,
} from "@agency_hub_core/db";

import { holdSetOf, whyHeld, type HoldSet } from "./admission.ts";
import { AdmissionHeldError, pageErrorState, type CaptureSend, type CommitDeps } from "./commit.ts";
import { onOutcome } from "./errors.ts";
import type { SlotGrant } from "./pacer.ts";
import type { SiteAdmissionPort, SiteRequestEnd } from "./ports.ts";
import { routeAdmissionView, type RouteClocks } from "./route-policy.ts";
import type { RouteKeySpec } from "./route-policy.ts";
import {
  decideSite,
  SITE_END_WAIT_MS,
  siteAnswerEffect,
  type ClassifiedSiteRequest,
  type SiteContext,
} from "./site-admission.ts";

// The slot of a page's own site request (Project Browser, plan §3.2; stage 3
// PR 8): the decision on the waiting requests, the admission (tx 1), the
// grant to the page's browser, the end it reports and the commit of that end
// (tx 2) by the engine's own outcome rules. The actor calls these; nothing
// here runs on a page without a browser (no `SiteAdmissionPort`).

const HOUR_MS = 3_600_000;

function inTx<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => body(tx as unknown as Database));
}

/** What holds the page for the site's requests: a credentials hold, or a
 *  hold that admits nothing. */
function pageHeldForSite(holds: HoldSet, now: Date): SiteContext["pageHeld"] {
  const held = whyHeld(holds, null, {}, now);
  if (held === null) return null;
  return held.scope === "credentials" ? { kind: "credentials" } : { kind: "closed", until: held.until };
}

/** The site's decision context at one instant. */
export async function siteContextOf(
  d: CommitDeps,
  input: {
    page: SyncPageRow;
    holds: HoldSet;
    clocks: RouteClocks | null;
    specs: readonly RouteKeySpec[];
    checksOnly: boolean;
    now: Date;
  },
): Promise<SiteContext> {
  const view = input.clocks === null ? null : routeAdmissionView(input.clocks, input.specs, input.now);
  const sendsLastHour = await countSiteSendsSince(d.db, { pageId: d.pageId, since: new Date(input.now.getTime() - HOUR_MS) });
  return {
    nowMono: d.clock.monoNow(),
    now: input.now,
    pausedAll: input.page.pausedAll,
    pageHeld: pageHeldForSite(input.holds, input.now),
    checksOnly: input.checksOnly,
    // A route state this build cannot read admits nothing: no route opens.
    routeOpensAt: (route) => {
      if (view === null) return { at: new Date(input.now.getTime() + 3_600_000) };
      const closure = view.routeOpensAt(route);
      return closure === null ? null : { at: closure.at };
    },
    sendsLastHour,
  };
}

/** Refuse what must be refused now; the admissible request, if any. */
export function settleSiteDecision(d: CommitDeps, site: SiteAdmissionPort, ctx: SiteContext, bootstrap = false): ClassifiedSiteRequest | null {
  const pending = site.pending();
  const decision = decideSite(bootstrap ? pending.filter((request) => request.host === "api" && request.method.toUpperCase() === "GET") : pending, ctx);
  for (const refusal of decision.refuse) {
    d.metrics.increment("sync_site_refused", { reason: refusal.reason });
    site.refuse(refusal.id, refusal.reason);
  }
  return decision.admit;
}

/**
 * The admission of one site request (tx 1): the page's final word under its
 * row lock — a hold written since the decision refuses here, the manual
 * login passing only a credentials hold and the owner's pause — then its
 * attempt. Throws `AdmissionHeldError` when a hold or the pause refuses it.
 */
export async function admitSite(
  d: CommitDeps,
  input: {
    classified: ClassifiedSiteRequest;
    grant: SlotGrant;
    intervals: { routeIntervalMs: number | null; familyIntervalMs: number | null };
  },
): Promise<{ attemptId: number }> {
  const { classified, grant } = input;
  const manual = classified.exempt;
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, {
      pageId: d.pageId,
      generation: d.generation,
      lock: "no_key_update",
      live: true,
      ...(d.pageTransport === undefined ? {} : { transport: d.pageTransport }),
    });
    const page = await getSyncPage(tx, d.pageId);
    if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
    if (page.pausedAll && !manual) throw new AdmissionHeldError("paused", null);
    const held = whyHeld(holdSetOf(page.holds), null, {}, d.clock.wallNow());
    if (held !== null && !(held.scope === "credentials" && manual)) throw new AdmissionHeldError(held.kind, held.until);
    const admitted = await insertSiteAdmission(tx, {
      pageId: d.pageId,
      generation: d.generation,
      origin: classified.origin,
      operation: classified.route,
      request: {
        method: classified.request.method.toUpperCase(),
        host: classified.request.host,
        // The path only: a query may carry what the journal must not keep.
        path: classified.request.path.split("?", 1)[0],
        siteRequestId: classified.request.id,
        manualLogin: manual,
      },
      browserRequestId: classified.request.id,
      settingMs: grant.settingMs,
      jitterU: grant.jitterU,
      pauseMs: grant.pauseMs,
      routeIntervalMs: input.intervals.routeIntervalMs,
      familyIntervalMs: input.intervals.familyIntervalMs,
    });
    return { attemptId: admitted.attemptId };
  });
}

/** The end of an admitted request, or — when the page's browser says
 *  nothing in `SITE_END_WAIT_MS` — a request that may have gone out. */
export async function siteEnd(site: SiteAdmissionPort, id: string, signal: AbortSignal): Promise<SiteRequestEnd> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SITE_END_WAIT_MS);
  const both = AbortSignal.any([signal, timeout.signal]);
  try {
    return await site.end(id, both);
  } catch {
    return { kind: "transport_error", sent: true, message: timeout.signal.aborted ? "no end from the page browser" : "the end was not heard" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The commit of a site request's end (tx 2): the attempt — settled unsent,
 * or captured with its send instant (the pacer's completion fallback) and
 * status; nothing is journaled of its body here — and what the answer does
 * to the page's holds by the engine's own rules (`siteAnswerEffect`,
 * `onOutcome`): the route that answered a 429 waits, a 401/403 outside the
 * manual login holds the credentials.
 */
export async function commitSiteEnd(
  d: CommitDeps,
  input: { attemptId: number; send: CaptureSend; end: SiteRequestEnd; classified: Pick<ClassifiedSiteRequest, "route" | "exempt"> },
): Promise<void> {
  const { attemptId, send: armed, end, classified } = input;
  if (end.kind === "aborted_before_send") {
    d.metrics.increment("sync_site_not_sent", {});
    await inTx(d.db, async (tx) => {
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
      await settleAttemptWithoutCapture(tx, { attemptId, outcome: "aborted_before_send", errorClass: "not_sent:site" });
    });
    return;
  }
  const effect = siteAnswerEffect(end, classified.exempt);
  const now = d.clock.wallNow();
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    const captured = await captureAttempt(tx, {
      attemptId,
      pageId: d.pageId,
      outcome: end.kind === "response" ? "response" : "transport_error",
      sent: armed.sent,
      sentAt: armed.sentWall,
      sendMark: armed.sendMark,
      sendMonoOffsetMs: armed.sendMonoOffsetMs,
      gapPrevMs: armed.gapPrevMs,
      httpStatus: end.kind === "response" ? end.status : null,
      retryAfterMs: end.kind === "response" ? end.retryAfterMs : null,
      errorClass: end.kind === "response"
        ? (effect.kind === "route_limited" ? "rate_limit" : effect.kind === "auth" ? "auth" : end.status >= 400 ? `site:${end.status}` : null)
        : "site:transport_error",
      applyState: "none",
    });
    if (!captured.captured || effect.kind === "none") return;
    const page = await getSyncPage(tx, d.pageId);
    if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
    const holds = holdSetOf(page.holds);
    const decision = onOutcome({
      errorClass: effect.kind === "route_limited" ? "rate_limit" : "auth",
      now,
      resource: "site",
      subject: "",
      httpStatus: effect.httpStatus,
      retryAfterMs: effect.kind === "route_limited" ? effect.retryAfterMs : null,
      page: pageErrorState(page, holds),
      ...(holds.routes.ok
        ? {
          route: {
            route: classified.route,
            entry: holds.routes.state.routes[classified.route] ?? null,
            attemptId,
            jitter: () => d.rng.next(),
          },
        }
        : {}),
      subjectState: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
      subjectQueue: false,
      recentFailedSubjects: 0,
      attempt: { id: attemptId, sentAt: armed.sentWall },
    });
    const fenced = { pageId: d.pageId, generation: d.generation };
    if (decision.pageHold.action === "set") {
      await setPageHold(tx, { ...fenced, kind: decision.pageHold.kind, until: decision.pageHold.until, detail: decision.pageHold.detail });
    } else if (decision.pageHold.action === "clear") {
      await clearPageHold(tx, { ...fenced, kinds: decision.pageHold.kinds });
    }
    if (decision.networkFailureStreak !== null) {
      await setNetworkFailureStreak(tx, { ...fenced, streak: decision.networkFailureStreak });
    }
    if (decision.routeHold.action === "set") {
      const { entry } = decision.routeHold;
      const written = await writeSyncRouteState(tx, {
        ...fenced,
        route: decision.routeHold.route,
        expectRevision: decision.routeHold.expectRevision,
        entry: {
          holdUntil: entry.holdUntil === null ? null : new Date(entry.holdUntil),
          ladderStep: entry.ladderStep,
          effectivePerMin: entry.effectivePerMin,
          policyVersion: entry.policyVersion,
          last429AttemptId: entry.last429AttemptId,
          last429At: entry.last429At === null ? null : new Date(entry.last429At),
        },
      });
      if (written.kind === "stale") throw new Error(`route state of ${decision.routeHold.route} changed under the page lock`);
    }
    d.metrics.increment("sync_site_answer_held", { kind: effect.kind, route: classified.route });
  });
}
