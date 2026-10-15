import { describe, expect, it } from "vitest";

import { Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
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
import { FakeClock, FakeOwnership, FakePauseSource, ScriptedRng } from "./helpers/sync-fakes.ts";

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
  it("socket admission precedes older API reads and bypasses only their hour ceiling, never pause or identity gates", () => {
    const pending = [request({ id: "read", askedMono: NOW_MONO - 5000 }), request({ id: "socket", host: "ws", path: "/", askedMono: NOW_MONO - 100 })];
    expect(decideSite(pending, context()).admit?.request.id).toBe("socket");
    expect(decideSite(pending, context({ sendsLastHour: SITE_SENDS_PER_HOUR }))).toMatchObject({ admit: { request: { id: "socket" } }, refuse: [{ id: "read", reason: "hour_ceiling" }] });
    expect(decideSite([pending[1]!], context({ pausedAll: true })).refuse).toEqual([{ id: "socket", reason: "paused" }]);
    expect(decideSite([pending[1]!], context({ checksOnly: true })).refuse).toEqual([{ id: "socket", reason: "credentials" }]);
  });

  it("a fresh session admits only bootstrap GETs; their pause, budgets and checks-only still hold", () => {
    const reads = [request({ id: "data", path: "/api/v1/messaging/groups" }), request({ id: "identity", path: "/api/v1/account/me?x=1" })];
    const fresh = context({ bootstrapOnly: true });
    expect(decideSite(reads, fresh)).toMatchObject({ admit: { request: { id: "identity" } }, refuse: [{ id: "data", reason: "credentials" }] });
    expect(decideSite(reads, { ...fresh, pausedAll: true }).admit).toBeNull();
    expect(decideSite(reads, { ...fresh, checksOnly: true }).admit).toBeNull();
    expect(decideSite(reads, { ...fresh, routeOpensAt: () => ({ at: new Date(NOW.getTime() + SITE_WAIT_MS) }) }).admit).toBeNull();
    expect(decideSite(reads, { ...fresh, sendsLastHour: SITE_SENDS_PER_HOUR }).admit).toBeNull();
  });

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

  it("never admits past the browser's own deadline, however fresh the engine's wait (Astra PR 14, P2)", () => {
    // Asked just now, but its own wait (from the CONNECT) ended a moment ago.
    expect(decideSite([request({ askedMono: NOW_MONO, waitDeadlineMono: NOW_MONO - 1 })], context()))
      .toEqual({ admit: null, refuse: [{ id: "r1", reason: "waited_too_long" }] });
    // 1 s of its own wait left, its route opens in 2 s: refused at once.
    const closed = () => ({ at: new Date(NOW.getTime() + 2_000) });
    expect(decideSite([request({ askedMono: NOW_MONO, waitDeadlineMono: NOW_MONO + 1_000 })], context({ routeOpensAt: closed })))
      .toEqual({ admit: null, refuse: [{ id: "r1", reason: "route_held" }] });
    // Before it: admitted.
    expect(decideSite([request({ askedMono: NOW_MONO, waitDeadlineMono: NOW_MONO + 1_000 })], context()).admit?.request.id).toBe("r1");
  });

  it("refuses the site's requests under the owner's pause, a credentials hold and checks-only", () => {
    for (const ctx of [context({ pausedAll: true }), context({ pageHeld: { kind: "credentials" } }), context({ checksOnly: true })]) {
      const decision = decideSite([request()], ctx);
      expect(decision.admit).toBeNull();
      expect(decision.refuse).toHaveLength(1);
      expect(["paused", "credentials"]).toContain(decision.refuse[0]!.reason);
    }
  });

  it("the manual login passes them for its login operations and the reads its interface makes (PR 15), never another write", () => {
    for (const ctx of [context({ pausedAll: true }), context({ pageHeld: { kind: "credentials" } }), context({ checksOnly: true })]) {
      expect(decideSite([request({ method: "POST", path: "/api/v1/login", manualLogin: true })], ctx).admit?.route).toBe("auth.login");
      expect(decideSite([request({ path: "/api/v1/versioning?ngsw-bypass=true", manualLogin: true })], ctx).admit?.route).toBe("site.other");
      expect(decideSite([request({ path: "/api/v1/thirdpartyconnect/providers", manualLogin: true })], ctx).admit).not.toBeNull();
      // Every read of the interface in the manual login (plan §4.8 «чтения,
      // которые делает интерфейс»; the coordinator's decision on PR 15).
      expect(decideSite([request({ path: "/api/v1/account/me", manualLogin: true })], ctx).admit?.route).toBe("account.me");
      expect(decideSite([request({ path: "/api/v1/message?groupId=123", manualLogin: true })], ctx).admit?.route).toBe("messages.page");
      // Outside the manual login the same read is refused there.
      const outside = decideSite([request({ path: "/api/v1/message?groupId=123" })], ctx);
      expect(outside.admit).toBeNull();
      expect(["paused", "credentials"]).toContain(outside.refuse[0]?.reason);
      // A write that is not a login operation never passes.
      expect(decideSite([request({ method: "POST", path: "/api/v1/message", manualLogin: true })], ctx)).toMatchObject({ admit: null, refuse: [{ reason: "write" }] });
    }
  });

  it("the exemption is the manual login's alone", () => {
    expect(classifySiteRequest(request({ path: "/api/v1/versioning" }))).toMatchObject({ exempt: false });
    expect(classifySiteRequest(request({ path: "/api/v1/versioning", manualLogin: true }))).toMatchObject({ exempt: true });
    expect(classifySiteRequest(request({ path: "/api/v1/timeline/home" }))).toMatchObject({ exempt: false });
    expect(classifySiteRequest(request({ path: "/api/v1/timeline/home", manualLogin: true }))).toMatchObject({ exempt: true, origin: "site" });
    expect(classifySiteRequest(request({ method: "POST", path: "/api/v1/login/twofa", manualLogin: true }))).toMatchObject({ exempt: true, origin: "login" });
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

describe("the pacer's final check before a grant", () => {
  function armed(ownershipAlive = true) {
    const clock = new FakeClock();
    const ownership = new FakeOwnership();
    ownership.isAlive = ownershipAlive;
    const pacer = new Pacer({ clock, rng: new ScriptedRng([0]), pause: new FakePauseSource(2_500), ownership });
    pacer.initTakeover(0);
    const admission = pacer.arm({ settingMs: 2_500, jitterU: 0, pauseMs: 2_500, earliestMono: clock.monoNow() }, 1, clock.monoNow());
    return { clock, pacer, admission };
  }

  it("passes a live admission without a send mark, once", () => {
    const { pacer, admission } = armed();
    expect(pacer.checkRemoteGrant(admission)).toBeNull();
    expect(admission.sentMono).toBeNull();
    expect(pacer.checkRemoteGrant(admission)?.reason).toBe("lease_used");
  });

  it("refuses when the ownership is gone or the send window passed", () => {
    expect(armed(false).pacer.checkRemoteGrant(armed(false).admission)).not.toBeNull();
    const lost = armed(false);
    expect(lost.pacer.checkRemoteGrant(lost.admission)?.reason).toBe("lease_inactive");
    const late = armed();
    late.clock.advance(15_000);
    expect(late.pacer.checkRemoteGrant(late.admission)?.reason).toBe("send_deadline_passed");
  });

  it("the send then counts at the completion of a response", () => {
    const { clock, pacer, admission } = armed();
    expect(pacer.checkRemoteGrant(admission)).toBeNull();
    clock.advance(400);
    pacer.complete(admission, transportOutcomeOfSite({ kind: "response", status: 200, retryAfterMs: null }));
    expect(admission.sendMark).toBe("completion_fallback");
    expect(admission.sentMono).toBe(clock.monoNow());
  });

  it("the send counts at the instant the browser reported, when it reported one (PR 12)", () => {
    const { clock, pacer, admission } = armed();
    expect(pacer.checkRemoteGrant(admission)).toBeNull();
    clock.advance(150);
    const leftAt = clock.monoNow();
    clock.advance(400);
    pacer.complete(admission, transportOutcomeOfSite({ kind: "response", status: 200, retryAfterMs: null, sentMono: leftAt }));
    expect(admission.sendMark).toBe("transport_reported");
    expect(admission.sentMono).toBe(leftAt);
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
    // The instant the browser reported, when it did (PR 12).
    expect(transportOutcomeOfSite({ kind: "response", status: 200, retryAfterMs: null, sentMono: 5 })).toMatchObject({ sendMark: "transport_reported", sentMono: 5 });
    expect(transportOutcomeOfSite({ kind: "transport_error", sent: true, message: "x", sentMono: 5 })).toEqual({ kind: "transport_error", sent: true, message: "x", sentMono: 5 });
    expect(transportOutcomeOfSite({ kind: "transport_error", sent: false, message: "x", sentMono: 5 })).toEqual({ kind: "transport_error", sent: false, message: "x" });
  });
});
