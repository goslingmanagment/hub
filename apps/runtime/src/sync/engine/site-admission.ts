import { matchSiteRequest, SITE_OTHER_ROUTE } from "../fansly/route-match.ts";
import type { FanslyRoute } from "../fansly/routes.ts";
import type { PendingSiteRequest, SiteRefusalReason, SiteRequestEnd, TransportOutcome } from "./ports.ts";
import { CYCLE } from "./scheduler.ts";

// The admission of a page's own site requests (Project Browser, plan §3.2,
// spec §3, owner decision №3; stage 3 PR 8). The page's browser holds every
// request of its site paused and asks the engine; the engine admits them
// through the same pacer, route budgets and holds as its own sends and
// journals them in sync_attempts (origin `site` or `login`, class `site`).
//
// - Share: one slot in each cycle of the scheduler while the engine has work
//   (after every `SITE_TURN_EVERY` engine admissions), and any slot the engine
//   leaves empty. The cycle pointer itself is not touched.
// - Within the class, requests go by the time they were asked; one whose
//   route its budget keeps closed is passed over, not admitted out of turn.
// - A request waits at most `SITE_WAIT_MS`, and never past its own deadline
//   when the browser names one (`waitDeadlineMono`); it is refused at once
//   when it cannot pass within what is left of that wait: the page paused, a hold of
//   the page or of its route longer than the rest, a request no route
//   admits, the hour's ceiling reached.
// - The manual login (the operator's mode): the login operations and the
//   reads the site's interface makes — every API read the map opens (plan
//   §4.8 «разрешены вход, подтверждение 2FA и чтения, которые делает
//   интерфейс»; owner decision №2; PR 15) — pass the owner's pause, a
//   credentials hold and checks-only; the pacer, the budgets, the hour's
//   ceiling, the page's ownership and a network hold still hold. Writes stay
//   the login operations' alone, and the operator's map keeps the closed
//   reads closed. Outside it a login operation is refused, and under those
//   three every other request of the site is.

/** How long a site request may wait for its admission (spec §3). */
export const SITE_WAIT_MS = 60_000;
/** The page's site and login sends in a sliding hour (spec §3, owner
 *  decision №3). */
export const SITE_SENDS_PER_HOUR = 300;
/** The site's turn comes after this many engine admissions: one slot per
 *  cycle of the scheduler. */
export const SITE_TURN_EVERY = CYCLE.length;
/** How long the engine waits for an admitted request's end before it takes
 *  the request as possibly sent (the operator's own limits end it far
 *  earlier: 21 s from its last send). */
export const SITE_END_WAIT_MS = 60_000;

/** The API paths (from `/api/v1`) the login screens read, as the test
 *  account showed them (stage 1, sessions 1–5): the app's version, the
 *  third-party sign-in providers, the device id (the operator's map names
 *  them apart: the device id's answer is no platform data). In the manual
 *  login every read passes the owner's pause and a credentials hold with the
 *  login operations (PR 15), these among them. */
export const LOGIN_SCREEN_READS: ReadonlySet<string> = new Set(["/versioning", "/thirdpartyconnect/providers", "/device/id"]);

/** Only these automatic GETs can bootstrap a fresh Chrome's live session.
 *  The operator's map still decides first; this grants no additional route. */
export const BOOTSTRAP_SITE_READS: ReadonlySet<string> = new Set([...LOGIN_SCREEN_READS, "/account/me"]);

export function isBootstrapSiteRequest(request: PendingSiteRequest): boolean {
  const path = request.path.split("?", 1)[0]!.replace(/\/$/, "");
  return request.host === "api" && request.method.toUpperCase() === "GET"
    && BOOTSTRAP_SITE_READS.has(path.replace(/^\/api\/v1(?=\/)/, ""));
}

/** A site request the engine can admit: its route, whose it is, and whether
 *  the manual login's exemption covers it. */
export interface ClassifiedSiteRequest {
  request: PendingSiteRequest;
  route: FanslyRoute;
  origin: "site" | "login";
  /** A login operation, or a read the site's interface makes, in the
   *  manual login: it passes the owner's pause, a credentials hold,
   *  checks-only, and its 401/403 holds nothing. */
  exempt: boolean;
}

/** The route of a site request, or why no route admits it. */
export function classifySiteRequest(request: PendingSiteRequest): ClassifiedSiteRequest | { refuse: SiteRefusalReason } {
  const match = matchSiteRequest(request.host, request.method, request.path);
  // A read of the API in the manual login: the interface's (PR 15).
  const interfaceRead = request.manualLogin && request.method.toUpperCase() === "GET" && request.host === "api";
  switch (match.kind) {
    case "route":
      return { request, route: match.route, origin: "site", exempt: interfaceRead };
    case "site_other":
      return { request, route: SITE_OTHER_ROUTE, origin: "site", exempt: interfaceRead };
    case "login":
      // A login operation belongs to the owner's manual login only.
      return request.manualLogin ? { request, route: match.route, origin: "login", exempt: true } : { refuse: "mode" };
    case "refused":
      return { refuse: match.reason };
  }
}

/** What the decision needs to know about the page at one instant. */
export interface SiteContext {
  nowMono: number;
  now: Date;
  /** The owner's pause of the page. */
  pausedAll: boolean;
  /** What holds the page for an ordinary request: a credentials hold, or a
   *  hold that admits nothing (a network hold, rows this build cannot read);
   *  null: nothing does. */
  pageHeld: { kind: "credentials" } | { kind: "closed"; until: Date | null } | null;
  /** The stored credentials are not the verified ones: only identity checks
   *  go out (G2). */
  checksOnly: boolean;
  /** Unknown browser session: no ordinary data reads before it is seen. */
  bootstrapOnly?: boolean;
  /** When the route next admits a send (null: now), and whether a hold — not
   *  only its budget — keeps it closed. */
  routeOpensAt(route: FanslyRoute): { at: Date } | null;
  /** The page's site and login sends of the last hour. */
  sendsLastHour: number;
}

export interface SiteDecision {
  /** The oldest request that may be sent now; null: none. */
  admit: ClassifiedSiteRequest | null;
  /** The requests refused now, with why. */
  refuse: Array<{ id: string; reason: SiteRefusalReason }>;
}

/** Decide on the pending requests at one instant: which one the slot admits
 *  and which are refused now. The rest keep waiting. */
export function decideSite(pending: readonly PendingSiteRequest[], ctx: SiteContext): SiteDecision {
  const refuse: SiteDecision["refuse"] = [];
  let admit: ClassifiedSiteRequest | null = null;
  const ordered = [...pending].sort((a, b) => a.askedMono - b.askedMono);
  for (const request of ordered) {
    const leftMs = Math.min(
      SITE_WAIT_MS - (ctx.nowMono - request.askedMono),
      request.waitDeadlineMono === undefined ? Number.POSITIVE_INFINITY : request.waitDeadlineMono - ctx.nowMono,
    );
    if (leftMs <= 0) {
      refuse.push({ id: request.id, reason: "waited_too_long" });
      continue;
    }
    const classified = classifySiteRequest(request);
    if ("refuse" in classified) {
      refuse.push({ id: request.id, reason: classified.refuse });
      continue;
    }
    const manual = classified.exempt;
    if (ctx.bootstrapOnly && !manual && !isBootstrapSiteRequest(request)) {
      refuse.push({ id: request.id, reason: "credentials" });
      continue;
    }
    if (ctx.pausedAll && !manual) {
      refuse.push({ id: request.id, reason: "paused" });
      continue;
    }
    if ((ctx.pageHeld?.kind === "credentials" || ctx.checksOnly) && !manual) {
      refuse.push({ id: request.id, reason: "credentials" });
      continue;
    }
    if (ctx.pageHeld?.kind === "closed") {
      // A network hold holds the manual login too: it waits, if the hold ends
      // within what is left of its wait.
      const until = ctx.pageHeld.until;
      if (until === null || until.getTime() - ctx.now.getTime() >= leftMs) refuse.push({ id: request.id, reason: "held" });
      continue;
    }
    if (ctx.sendsLastHour >= SITE_SENDS_PER_HOUR) {
      refuse.push({ id: request.id, reason: "hour_ceiling" });
      continue;
    }
    const closed = ctx.routeOpensAt(classified.route);
    if (closed !== null) {
      if (closed.at.getTime() - ctx.now.getTime() >= leftMs) refuse.push({ id: request.id, reason: "route_held" });
      continue;
    }
    admit ??= classified;
  }
  return { admit, refuse };
}

/** The site's share of the slots: its turn comes after every
 *  `SITE_TURN_EVERY` engine admissions (and it takes any slot the engine
 *  leaves empty). Kept in memory: a restart only gives the site its turn
 *  earlier. */
export class SiteTurns {
  #engineSinceSite: number = SITE_TURN_EVERY;

  /** The site's turn has come. */
  due(): boolean {
    return this.#engineSinceSite >= SITE_TURN_EVERY;
  }

  snapshot(): { due: boolean; engineAdmissions: number } {
    return { due: this.due(), engineAdmissions: this.#engineSinceSite };
  }

  engineAdmitted(): void {
    this.#engineSinceSite += 1;
  }

  siteAdmitted(): void {
    this.#engineSinceSite = 0;
  }
}

/** The end of a site request as the pacer and the capture take it: the send
 *  counts at the instant the browser reported (`transport_reported`, stage 3
 *  PR 12); a request that may have gone out without one counts as sent at
 *  its completion, the safe upper bound. */
export function transportOutcomeOfSite(end: SiteRequestEnd): TransportOutcome {
  switch (end.kind) {
    case "response":
      return typeof end.sentMono === "number" && Number.isFinite(end.sentMono)
        ? { kind: "response", status: end.status, headers: {}, bodyText: "", bodyBytes: 0, sendMark: "transport_reported", sentMono: end.sentMono }
        : { kind: "response", status: end.status, headers: {}, bodyText: "", bodyBytes: 0, sendMark: "completion_fallback" };
    case "transport_error":
      return end.sent && typeof end.sentMono === "number" && Number.isFinite(end.sentMono)
        ? { kind: "transport_error", sent: true, message: end.message, sentMono: end.sentMono }
        : { kind: "transport_error", sent: end.sent, message: end.message };
    case "aborted_before_send":
      return { kind: "aborted_before_send", refusal: "lease_inactive" };
  }
}

/** What an answer to a site request does to the page's holds (the engine's
 *  own rules, `engine/errors.ts`): a 429 or a 5xx naming its own deadline
 *  holds the route that answered; a 401/403 holds the page's credentials —
 *  except in the manual login, whose requests answer 401 before the login
 *  by design. A network failure of the site's own request holds nothing:
 *  the site cancels its requests itself (a page left, a route changed). */
export type SiteAnswerEffect = { kind: "none" } | { kind: "route_limited"; httpStatus: number; retryAfterMs: number | null } | { kind: "auth"; httpStatus: number };

export function siteAnswerEffect(end: SiteRequestEnd, manualLogin: boolean): SiteAnswerEffect {
  if (end.kind !== "response") return { kind: "none" };
  if (end.status === 429 || (end.status >= 500 && end.retryAfterMs !== null)) {
    return { kind: "route_limited", httpStatus: end.status, retryAfterMs: end.retryAfterMs };
  }
  if ((end.status === 401 || end.status === 403) && !manualLogin) return { kind: "auth", httpStatus: end.status };
  return { kind: "none" };
}
