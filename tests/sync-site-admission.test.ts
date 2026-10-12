import { describe, expect, it } from "vitest";

import type { PendingSiteRequest } from "../apps/runtime/src/sync/engine/ports.ts";
import {
  classifySiteRequest,
  decideSite,
  SITE_SENDS_PER_HOUR,
  SITE_TURN_EVERY,
  SITE_WAIT_MS,
  siteAnswerEffect,
  SiteTurns,
  transportOutcomeOfSite,
  type SiteContext,
} from "../apps/runtime/src/sync/engine/site-admission.ts";
import type { FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";

// The admission of a page's own site requests (Project Browser, spec §3,
// owner decision №3; stage 3 PR 8): which waiting request a slot admits,
// which are refused at once, the site's share of the slots, what an answer
// does to the page's holds.

const NOW = new Date("2026-10-12T12:00:00.000Z");
const NOW_MONO = 1_000_000;

function request(overrides: Partial<PendingSiteRequest> = {}): PendingSiteRequest {
  return { id: "r1", method: "GET", host: "api", path: "/api/v1/timeline/home", askedMono: NOW_MONO - 1_000, manualLogin: false, ...overrides };
}

function context(overrides: Partial<SiteContext> = {}): SiteContext {
  return { nowMono: NOW_MONO, now: NOW, pausedAll: false, pageHeld: null, checksOnly: false, routeOpensAt: () => null, sendsLastHour: 0, ...overrides };
}

describe("the route of a site request", () => {
  it("a catalogue read, a read outside it, a login operation", () => {
    expect(classifySiteRequest(request({ path: "/api/v1/messaging/groups?ngsw-bypass=true" }))).toMatchObject({ route: "messaging.groups", origin: "site" });
    expect(classifySiteRequest(request())).toMatchObject({ route: "site.other", origin: "site" });
    expect(classifySiteRequest(request({ method: "POST", path: "/api/v1/login", manualLogin: true }))).toMatchObject({ route: "auth.login", origin: "login" });
  });

  it("a login operation outside the manual login, and any other write, is refused", () => {
    expect(classifySiteRequest(request({ method: "POST", path: "/api/v1/login" }))).toEqual({ refuse: "mode" });
    expect(classifySiteRequest(request({ method: "POST", path: "/api/v1/message/ack", manualLogin: true }))).toEqual({ refuse: "write" });
    expect(classifySiteRequest(request({ method: "OPTIONS" }))).toEqual({ refuse: "method" });
  });
});

describe("the decision at a slot", () => {
  it("admits the oldest request its route admits now", () => {
    const decision = decideSite([
      request({ id: "new", askedMono: NOW_MONO - 100 }),
      request({ id: "old", askedMono: NOW_MONO - 5_000 }),
    ], context());
    expect(decision.admit?.request.id).toBe("old");
    expect(decision.refuse).toEqual([]);
  });

  it("passes over a request whose route opens later, and refuses one that cannot pass within its wait", () => {
    const closed = (route: FanslyRoute) => (route === "site.other" ? { at: new Date(NOW.getTime() + 2_000) } : null);
    const decision = decideSite([
      request({ id: "waits", askedMono: NOW_MONO - 1_000 }),
      request({ id: "groups", path: "/api/v1/messaging/groups", askedMono: NOW_MONO - 500 }),
      request({ id: "late", askedMono: NOW_MONO - (SITE_WAIT_MS - 1_000) }),
    ], context({ routeOpensAt: closed }));
    expect(decision.admit?.request.id).toBe("groups");
    // 2 s to its route's opening, 1 s left of its wait: refused at once.
    expect(decision.refuse).toEqual([{ id: "late", reason: "route_held" }]);
  });

  it("refuses a request that waited its whole wait", () => {
    expect(decideSite([request({ askedMono: NOW_MONO - SITE_WAIT_MS })], context())).toEqual({ admit: null, refuse: [{ id: "r1", reason: "waited_too_long" }] });
  });

  it("refuses the site's requests under the owner's pause, a credentials hold and checks-only", () => {
    for (const ctx of [context({ pausedAll: true }), context({ pageHeld: { kind: "credentials" } }), context({ checksOnly: true })]) {
      const decision = decideSite([request()], ctx);
      expect(decision.admit).toBeNull();
      expect(decision.refuse).toHaveLength(1);
      expect(["paused", "credentials"]).toContain(decision.refuse[0]!.reason);
    }
  });

  it("the manual login passes them, its reads and its login operation alike", () => {
    for (const ctx of [context({ pausedAll: true }), context({ pageHeld: { kind: "credentials" } }), context({ checksOnly: true })]) {
      expect(decideSite([request({ method: "POST", path: "/api/v1/login", manualLogin: true })], ctx).admit?.route).toBe("auth.login");
      expect(decideSite([request({ manualLogin: true })], ctx).admit?.route).toBe("site.other");
    }
  });

  it("a network hold holds the manual login too: it waits, or is refused when the hold outlasts its wait", () => {
    const soon = context({ pageHeld: { kind: "closed", until: new Date(NOW.getTime() + 5_000) } });
    expect(decideSite([request({ manualLogin: true })], soon)).toEqual({ admit: null, refuse: [] });
    const long = context({ pageHeld: { kind: "closed", until: new Date(NOW.getTime() + SITE_WAIT_MS) } });
    expect(decideSite([request({ manualLogin: true })], long).refuse).toEqual([{ id: "r1", reason: "held" }]);
    expect(decideSite([request()], context({ pageHeld: { kind: "closed", until: null } })).refuse).toEqual([{ id: "r1", reason: "held" }]);
  });

  it("the hour's ceiling refuses", () => {
    expect(decideSite([request()], context({ sendsLastHour: SITE_SENDS_PER_HOUR })).refuse).toEqual([{ id: "r1", reason: "hour_ceiling" }]);
    expect(decideSite([request()], context({ sendsLastHour: SITE_SENDS_PER_HOUR - 1 })).admit).not.toBeNull();
  });
});

describe("the site's share of the slots", () => {
  it("one slot after every cycle of engine admissions", () => {
    const turns = new SiteTurns();
    expect(turns.due()).toBe(true);
    turns.siteAdmitted();
    for (let i = 1; i < SITE_TURN_EVERY; i++) {
      turns.engineAdmitted();
      expect(turns.due()).toBe(false);
    }
    turns.engineAdmitted();
    expect(turns.due()).toBe(true);
  });
});

describe("an answer to a site request", () => {
  it("a 429 or a 5xx naming its deadline holds the route; a 401/403 the credentials, except in the manual login", () => {
    expect(siteAnswerEffect({ kind: "response", status: 429, retryAfterMs: null }, false)).toEqual({ kind: "route_limited", httpStatus: 429, retryAfterMs: null });
    expect(siteAnswerEffect({ kind: "response", status: 503, retryAfterMs: 30_000 }, false)).toEqual({ kind: "route_limited", httpStatus: 503, retryAfterMs: 30_000 });
    expect(siteAnswerEffect({ kind: "response", status: 401, retryAfterMs: null }, false)).toEqual({ kind: "auth", httpStatus: 401 });
    expect(siteAnswerEffect({ kind: "response", status: 401, retryAfterMs: null }, true)).toEqual({ kind: "none" });
    expect(siteAnswerEffect({ kind: "response", status: 500, retryAfterMs: null }, false)).toEqual({ kind: "none" });
    expect(siteAnswerEffect({ kind: "transport_error", sent: true, message: "x" }, false)).toEqual({ kind: "none" });
  });

  it("the pacer takes a request that may have gone out as sent at its completion", () => {
    expect(transportOutcomeOfSite({ kind: "response", status: 200, retryAfterMs: null })).toMatchObject({ kind: "response", status: 200, sendMark: "completion_fallback" });
    expect(transportOutcomeOfSite({ kind: "transport_error", sent: false, message: "x" })).toEqual({ kind: "transport_error", sent: false, message: "x" });
    expect(transportOutcomeOfSite({ kind: "aborted_before_send", reason: "x" })).toMatchObject({ kind: "aborted_before_send" });
  });
});
