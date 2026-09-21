import { describe, expect, it } from "vitest";

import {
  incidentTitleForKind,
  parseIncidentSubKey,
} from "../apps/runtime/src/services/notification-incidents.ts";
import {
  NOTIFICATION_PAGING_EXCLUDED_KINDS,
  NOTIFICATION_PAGING_POLICY_BY_KIND,
  decideNotificationPaging,
  formatDurationShort,
  notificationPagingPolicyFor,
  type NotificationPagingObservation,
} from "../apps/runtime/src/services/notification-paging-policy.ts";

// Decision 381: the decision table between a latch and the owner's phone.
// Measured on production 2026-09-15..21: 217 proxy_failed messages in seven
// days with a median open→resolve gap of 1.9 minutes, and every one of the 16
// scheduler_silent pairs was a ~5-minute deploy gap. These cases pin the rules
// that turn that stream into a handful of messages that mean something.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-09-21T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function observation(
  overrides: Partial<NotificationPagingObservation> = {},
): NotificationPagingObservation {
  return {
    status: "open",
    openedAt: T0,
    resolvedAt: null,
    paging: null,
    episodesInWindow: 1,
    earliestEpisodeInWindowAt: T0,
    manuallyResolvedSincePage: false,
    ...overrides,
  };
}

const proxy = notificationPagingPolicyFor("proxy_failed", null);
const auth = notificationPagingPolicyFor("auth_blocked", null);

describe("notification paging policy table", () => {
  it("covers every incident kind and keeps the AI critical pair out of the sweep", () => {
    for (const kind of NOTIFICATION_PAGING_EXCLUDED_KINDS) {
      expect(NOTIFICATION_PAGING_POLICY_BY_KIND[kind]).toBeDefined();
    }
    expect(NOTIFICATION_PAGING_EXCLUDED_KINDS).toEqual(["ai_provider_billing", "ai_provider_failed"]);
  });

  it("holds the flapping kinds and pages the hand-needed kinds at once", () => {
    expect(proxy.openHoldMs).toBe(15 * MINUTE);
    expect(proxy.recoveryHoldMs).toBe(30 * MINUTE);
    expect(proxy.flap).toEqual({ episodes: 5, windowMs: 6 * HOUR });
    // A deploy gap is ~5 min; the watchdog hold must sit above it.
    expect(notificationPagingPolicyFor("scheduler_silent", null).openHoldMs).toBeGreaterThan(6 * MINUTE);
    for (const kind of ["auth_blocked", "proxy_missing", "ofapi_auth", "wrong_transactions_writer"] as const) {
      expect(notificationPagingPolicyFor(kind, null).openHoldMs).toBe(0);
    }
  });

  it("gives the disk runway warning its own long holds without touching the critical latch", () => {
    expect(notificationPagingPolicyFor("db_disk_usage", "runway_warning").openHoldMs).toBe(6 * HOUR);
    expect(notificationPagingPolicyFor("db_disk_usage", "runway_critical").openHoldMs).toBe(0);
    expect(notificationPagingPolicyFor("db_disk_usage", null).openHoldMs).toBe(0);
  });
});

describe("decideNotificationPaging", () => {
  it("pages an immediate kind on the first sweep that sees it open", () => {
    expect(decideNotificationPaging(observation(), auth, at(10_000))).toEqual({
      action: "page",
      mode: "immediate",
      transition: "opened",
      transitionAt: T0,
      coveredOpenedAt: T0,
    });
  });

  it("waits out the open hold for a sustained kind", () => {
    expect(decideNotificationPaging(observation(), proxy, at(14 * MINUTE))).toEqual({ action: "none" });
    expect(decideNotificationPaging(observation(), proxy, at(15 * MINUTE))).toMatchObject({
      action: "page",
      mode: "sustained",
      transitionAt: T0,
    });
  });

  it("never pages an episode that healed inside the hold", () => {
    const healed = observation({ status: "resolved", resolvedAt: at(2 * MINUTE) });
    expect(decideNotificationPaging(healed, proxy, at(3 * MINUTE))).toEqual({ action: "none" });
    expect(decideNotificationPaging(healed, proxy, at(3 * HOUR))).toEqual({ action: "none" });
  });

  it("pages a storm of short episodes as flapping, whether or not it is open right now", () => {
    const storm = observation({
      status: "resolved",
      openedAt: at(2 * HOUR),
      resolvedAt: at(2 * HOUR + MINUTE),
      episodesInWindow: 5,
      earliestEpisodeInWindowAt: T0,
    });
    const now = at(2 * HOUR + 2 * MINUTE);
    expect(decideNotificationPaging(storm, proxy, now)).toEqual({
      action: "page",
      mode: "flapping",
      transition: "opened",
      transitionAt: now,
      coveredOpenedAt: T0,
    });
    expect(decideNotificationPaging({ ...storm, episodesInWindow: 4 }, proxy, now)).toEqual({ action: "none" });
    // Immediate kinds carry no flap rule: they page per episode instead.
    expect(decideNotificationPaging({ ...storm, episodesInWindow: 50 }, auth, now)).toEqual({ action: "none" });
  });

  it("treats a reopen inside the recovery hold as the same incident", () => {
    const standing = {
      pagedAt: at(15 * MINUTE),
      pagedOpenedAt: T0,
      pagedMode: "sustained" as const,
      pagedResolvedAt: null,
    };
    // Resolved, but not quiet for long enough.
    expect(decideNotificationPaging(
      observation({ status: "resolved", resolvedAt: at(20 * MINUTE), paging: standing }),
      proxy,
      at(30 * MINUTE),
    )).toEqual({ action: "none" });
    // Reopened while the page stands: nothing, whatever the new opened_at.
    expect(decideNotificationPaging(
      observation({ status: "open", openedAt: at(25 * MINUTE), paging: standing, episodesInWindow: 2 }),
      proxy,
      at(26 * MINUTE),
    )).toEqual({ action: "none" });
    // Quiet for the whole hold: announce it, stamped with the latch's own time.
    expect(decideNotificationPaging(
      observation({ status: "resolved", resolvedAt: at(20 * MINUTE), paging: standing }),
      proxy,
      at(50 * MINUTE),
    )).toEqual({ action: "resolve", transitionAt: at(20 * MINUTE), silent: false });
  });

  it("records a manual resolve without announcing it twice", () => {
    const standing = {
      pagedAt: at(15 * MINUTE),
      pagedOpenedAt: T0,
      pagedMode: "sustained" as const,
      pagedResolvedAt: null,
    };
    expect(decideNotificationPaging(
      observation({
        status: "resolved",
        resolvedAt: at(20 * MINUTE),
        paging: standing,
        manuallyResolvedSincePage: true,
      }),
      proxy,
      at(21 * MINUTE),
    )).toEqual({ action: "resolve", transitionAt: at(20 * MINUTE), silent: true });
  });

  it("pages a fresh episode as reopened once the previous recovery was announced", () => {
    const announced = {
      pagedAt: at(15 * MINUTE),
      pagedOpenedAt: T0,
      pagedMode: "sustained" as const,
      pagedResolvedAt: at(50 * MINUTE),
    };
    expect(decideNotificationPaging(
      observation({ status: "open", openedAt: at(2 * HOUR), paging: announced }),
      proxy,
      at(2 * HOUR + 15 * MINUTE),
    )).toMatchObject({ action: "page", mode: "sustained", transition: "reopened", transitionAt: at(2 * HOUR) });
  });
});

describe("parseIncidentSubKey", () => {
  it("recovers the subKey for every stored key shape", () => {
    expect(parseIncidentSubKey({ incidentKey: "proxy_failed:12", kind: "proxy_failed", stream: "posts" })).toBeNull();
    expect(parseIncidentSubKey({
      incidentKey: "stream_failed_threshold:12:posts",
      kind: "stream_failed_threshold",
      stream: "posts",
    })).toBeNull();
    expect(parseIncidentSubKey({
      incidentKey: "golden_signal_lag:global:obs_backlog_pull_posts_v6",
      kind: "golden_signal_lag",
      stream: null,
    })).toBe("obs_backlog_pull_posts_v6");
    expect(parseIncidentSubKey({
      incidentKey: "db_disk_usage:global:runway_warning",
      kind: "db_disk_usage",
      stream: null,
    })).toBe("runway_warning");
    expect(parseIncidentSubKey({ incidentKey: "db_disk_usage:global", kind: "db_disk_usage", stream: null })).toBeNull();
    expect(parseIncidentSubKey({
      incidentKey: "ai_provider_failed:12:proxy",
      kind: "ai_provider_failed",
      stream: null,
    })).toBe("proxy");
  });
});

describe("incidentTitleForKind", () => {
  it("drops the siren and keeps the subKey-specific titles", () => {
    expect(incidentTitleForKind({ kind: "proxy_failed" })).toBe("Proxy failed");
    expect(incidentTitleForKind({ kind: "capture_payload_parity", subKey: "sha256_collision" }))
      .toBe("Capture payload sha256 collision");
  });
});

describe("formatDurationShort", () => {
  it("reads like a human wrote it", () => {
    expect(formatDurationShort(45_000)).toBe("45 s");
    expect(formatDurationShort(16 * MINUTE)).toBe("16 min");
    expect(formatDurationShort(HOUR + 12 * MINUTE)).toBe("1 h 12 min");
    expect(formatDurationShort(3 * HOUR)).toBe("3 h");
    expect(formatDurationShort(3 * 24 * HOUR + 4 * HOUR)).toBe("3 d 4 h");
    expect(formatDurationShort(13 * 24 * HOUR)).toBe("13 d");
  });
});
