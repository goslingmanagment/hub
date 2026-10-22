import {
  captureAttempt,
  clearPageHold,
  countSiteSendsSince,
  findObservedSiteRequest,
  getSyncPage,
  insertSiteAdmission,
  lockOwnedPage,
  OwnershipLostError,
  recordObservedSiteEnded,
  recordObservedSiteSent,
  reopenRecoveredObservedAttempt,
  setNetworkFailureStreak,
  setPageHold,
  settleAttemptWithoutCapture,
  writeSyncRouteState,
  type Database,
  type SyncPageRow,
} from "@agency_hub_core/db";
import { isCredentialsHoldKind } from "@agency_hub_core/shared";

import { SITE_OTHER_ROUTE } from "../fansly/route-match.ts";
import { isFanslyRoute, type FanslyRoute } from "../fansly/routes.ts";
import { holdSetOf, whyHeld, type HoldSet } from "./admission.ts";
import { AdmissionHeldError, observedHoldClearedWithin, pageErrorState, type CaptureSend, type CommitDeps } from "./commit.ts";
import { onOutcome } from "./errors.ts";
import type { SlotGrant } from "./pacer.ts";
import type { ObservedSiteKey, SiteAdmissionPort, SiteRequestEnd } from "./ports.ts";
import { routeAdmissionView, type RouteClocks } from "./route-policy.ts";
import type { RouteKeySpec } from "./route-policy.ts";
import {
  decideSite,
  isSiteSocket,
  SITE_END_WAIT_MS,
  siteAnswerEffect,
  type ClassifiedSiteRequest,
  type SiteAnswerEffect,
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
    bootstrapOnly?: boolean;
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
    bootstrapOnly: input.bootstrapOnly === true,
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
export function settleSiteDecision(d: CommitDeps, site: SiteAdmissionPort, ctx: SiteContext, urgentOnly = false): ClassifiedSiteRequest | null {
  const pending = site.pending();
  const decision = decideSite(urgentOnly ? pending.filter(isSiteSocket) : pending, ctx);
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

/**
 * Variant Б (plan-b §4.2.2): a send of the site's own the page's browser let
 * go and observed — never admitted, never refused. Its attempt is journaled
 * after the fact under this owner as a site row (`origin` site), with the
 * owner's minimum S and no jitter (nothing paced it), so the route clocks, the
 * takeover floor and the hour count see it. Its send instant and mark are
 * recorded immediately, even if its end never arrives. Its end goes through
 * `commitObservedSiteEnd` (`observedSend`): the site's 429 holds the
 * engine's own route as an admitted request's does; its 401 and 403 hold
 * the page's credentials until one verify of the stored ones settles it.
 *
 * Once per hop (minor 6, 0289): the hop's row keeps its attempt — a send told
 * again (the operator repeats what is not confirmed, and tells a new
 * connection what is still flying) finds it and journals nothing more
 * (`recorded: false`). The settings and the session it went under are kept
 * with it for an identity proof that comes later.
 */
export async function recordObservedSiteSend(
  d: CommitDeps,
  input: {
    id: string;
    key: ObservedSiteKey;
    method: string;
    host: string;
    path: string;
    route: string;
    settingMs: number;
    sentWall: Date;
    sessionFingerprint: string | null;
    credentialsGeneration: string | null;
  },
): Promise<{ attemptId: number; recorded: boolean }> {
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    const hop = { pageId: d.pageId, ...input.key };
    const known = await findObservedSiteRequest(tx, hop, { lock: true });
    if (known?.attemptId != null) return { attemptId: known.attemptId, recorded: false };
    const admitted = await insertSiteAdmission(tx, {
      pageId: d.pageId,
      generation: d.generation,
      origin: "site",
      operation: input.route,
      request: {
        method: input.method.toUpperCase(),
        host: input.host,
        // The path only: a query may carry what the journal must not keep.
        path: input.path.split("?", 1)[0],
        siteRequestId: input.id,
        observed: true,
      },
      browserRequestId: input.id,
      sentAt: input.sentWall,
      settingMs: input.settingMs,
      jitterU: 0,
      pauseMs: input.settingMs,
    });
    await recordObservedSiteSent(tx, {
      ...hop,
      browserRequestId: input.id,
      attemptId: admitted.attemptId,
      credentialsGeneration: input.credentialsGeneration,
      sessionFingerprint: input.sessionFingerprint,
    });
    return { attemptId: admitted.attemptId, recorded: true };
  });
}

/**
 * Variant Б: the end of an observed hop, committed with its send's attempt
 * (`commitSiteEnd`'s rules, `observedSend`: the site's 429 holds its route;
 * its 401 and 403 hold the page's credentials with no digest of their own —
 * one verify of the stored ones settles it — unless a proof answered the
 * site's last refusal within `SITE_REFUSALS_DISCOUNTED_MS`) and its row's end in one
 * transaction. `manualLogin`: the hop went under the manual login's browser
 * of a page still on Node (`LoginSitePort`) — a candidate session, not the
 * page's: its 401/403 holds nothing, its 429 holds its route as any. An end
 * told again changes nothing (its attempt is captured once; its row keeps
 * the first end). An end the operator kept across the engine's start finds
 * its attempt closed `unknown` by the start's recovery: reopened, it is
 * captured and holds as any. `send_not_journaled`: its send's attempt is not
 * journaled yet — nothing is committed, and the operator tells both again.
 */
export async function commitObservedSiteEnd(
  d: CommitDeps,
  input: {
    key: ObservedSiteKey;
    end: Extract<SiteRequestEnd, { kind: "response" | "transport_error" }>;
    error: string | null;
    settingMs: number;
    manualLogin?: boolean;
  },
): Promise<"committed" | "send_not_journaled"> {
  return inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    const hop = { pageId: d.pageId, ...input.key };
    const sent = await findObservedSiteRequest(tx, hop, { lock: true });
    if (sent?.attemptId == null || sent.sentAt === null) return "send_not_journaled";
    // A route the catalogue does not know is the site's other read.
    const route: FanslyRoute = sent.route !== null && isFanslyRoute(sent.route) ? sent.route : SITE_OTHER_ROUTE;
    if (sent.endedRecordedAt === null && await reopenRecoveredObservedAttempt(tx, { pageId: d.pageId, attemptId: sent.attemptId })) {
      d.metrics.increment("sync_site_observed_reopened", {});
    }
    await commitAnswerIn(tx, d, {
      attemptId: sent.attemptId,
      send: observedSend(sent.sentAt, input.settingMs),
      end: input.end,
      classified: { route, exempt: input.manualLogin === true },
      observed: true,
    });
    await recordObservedSiteEnded(tx, { ...hop, status: input.end.kind === "response" ? input.end.status : null, error: input.error });
    return "committed";
  });
}

/** The send facts of an observed site request for `commitSiteEnd`: it went,
 *  at the instant the browser reported. */
export function observedSend(sentWall: Date, settingMs: number): CaptureSend {
  return {
    sent: true,
    sentWall,
    sendMark: "transport_reported",
    sendMonoOffsetMs: null,
    gapPrevMs: null,
    durationMs: null,
    pauseMs: settingMs,
    settingMs,
  };
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
  input: { attemptId: number; send: CaptureSend; end: SiteRequestEnd; classified: Pick<ClassifiedSiteRequest, "route" | "exempt">; observed?: boolean },
): Promise<void> {
  const { attemptId, end } = input;
  if (end.kind === "aborted_before_send") {
    d.metrics.increment("sync_site_not_sent", {});
    await inTx(d.db, async (tx) => {
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
      await settleAttemptWithoutCapture(tx, { attemptId, outcome: "aborted_before_send", errorClass: "not_sent:site" });
    });
    return;
  }
  await inTx(d.db, async (tx) => {
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    await commitAnswerIn(tx, d, { ...input, end });
  });
}

/**
 * How long the site's own 401/403 are no evidence at all once an identity
 * proof answered one: after a proof cleared a credentials hold the site's
 * observed refusal had set, its next refusals hold nothing for an hour.
 * Otherwise a request the site repeats on its own and that is always refused
 * (a poll, a settings screen, a feature the account lacks) would stop the
 * page's own work and cost one `account.verify` per refusal, without bound —
 * the page stopping, and its alert flapping, every round. Meanwhile the
 * engine's own requests still hold the page on their refusal with their
 * digest, as ever: a session that really died in that hour is caught by the
 * next of them. After it, one verify is spent again — at most one an hour.
 */
export const SITE_REFUSALS_DISCOUNTED_MS = 60 * 60_000;

/** The instant of the proof that discounts the site's own refusal now
 *  (null: none) — no credentials hold is recorded, and within
 *  `SITE_REFUSALS_DISCOUNTED_MS` an identity proof cleared one the site's
 *  observed refusal had set. Under a recorded hold the refusal goes on as
 *  any: its digest stays the hold's. */
async function siteRefusalDiscountedSince(tx: Database, d: CommitDeps): Promise<Date | null> {
  const page = await getSyncPage(tx, d.pageId);
  if (page === null) throw new OwnershipLostError(d.pageId, d.generation, null);
  if (holdSetOf(page.holds).page.credentials !== null) return null;
  return observedHoldClearedWithin(tx, { pageId: d.pageId, withinMs: SITE_REFUSALS_DISCOUNTED_MS });
}

/** `commitSiteEnd`'s commit of an answer or a transport error, in the
 *  caller's transaction (the page locked). */
async function commitAnswerIn(
  tx: Database,
  d: CommitDeps,
  input: { attemptId: number; send: CaptureSend; end: Extract<SiteRequestEnd, { kind: "response" | "transport_error" }>; classified: Pick<ClassifiedSiteRequest, "route" | "exempt">; observed?: boolean },
): Promise<void> {
  const { attemptId, send: armed, end, classified } = input;
  const answered = siteAnswerEffect(end, classified.exempt);
  // The site's own refusal soon after a proof answered its last one holds
  // nothing, and is journaled as the site's answer, not as one that stops
  // the page (`SITE_REFUSALS_DISCOUNTED_MS`).
  const discountedSince = answered.kind === "auth" && input.observed === true ? await siteRefusalDiscountedSince(tx, d) : null;
  const effect: SiteAnswerEffect = discountedSince === null ? answered : { kind: "none" };
  const now = d.clock.wallNow();
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
  if (captured.captured && discountedSince !== null) {
    const status = end.kind === "response" ? end.status : null;
    d.metrics.increment("sync_site_refusal_discounted", { route: classified.route, status: String(status) });
    d.logger.info({ pageId: d.pageId, attemptId, route: classified.route, status, provedAt: discountedSince.toISOString() },
      "Fansly sync: the site's own refusal soon after a proof answered its last one holds nothing");
  }
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
    // An observed 401/403 of the site's own request is no proof that the
    // page's credentials fail: its refusal names no digest of its own, so
    // one verify of the stored credentials settles it (A3), and it is
    // ordered by its send instant. Admitted site requests (minor 1–3) keep
    // the engine's rule.
    observed: input.observed === true,
  });
  const fenced = { pageId: d.pageId, generation: d.generation };
  if (decision.pageHold.action === "set") {
    // Observed requests can end out of order. Their answers are all
    // captured above, but an older send must not move the latest refusal
    // back. Admitted site requests (minor 1–3) keep their existing rule.
    const failedAt = holds.page.credentials?.failure.at;
    const superseded = input.observed === true && isCredentialsHoldKind(decision.pageHold.kind)
      && failedAt != null && (armed.sentWall === null || failedAt.getTime() > armed.sentWall.getTime());
    if (!superseded) {
      await setPageHold(tx, { ...fenced, kind: decision.pageHold.kind, until: decision.pageHold.until, detail: decision.pageHold.detail });
    }
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
}
