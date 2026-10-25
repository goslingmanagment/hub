import { describe, expect, it } from "vitest";

import type { OnlineCandidateRow } from "@agency_hub_core/db";

import { decideOnline, greetingNameOf, onlineRank, ONLINE_TEMPLATES } from "../apps/runtime/src/services/client-online-rules.ts";

// «Онлайн»: why to write to a fan seen online, with what, and when he is set
// aside — the reason most urgent first; Ping from 10 messages of the chat, the
// team's guide below that; a fan another chatter talks to, one the page wrote
// to within 48 hours, one the window wrote to within three weeks and one marked
// «Не предлагать» are set aside, never hidden.

const NOW = new Date(Date.UTC(2026, 9, 26, 18, 0));
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

const row = (over: Partial<OnlineCandidateRow> = {}): OnlineCandidateRow => ({
  fanId: 1,
  fanRef: "7001",
  conversationRef: "7001",
  username: "fan7001",
  displayName: null,
  alias: null,
  seenAt: minutesAgo(2),
  seenSource: "ofapi_last_seen",
  contactability: null,
  probeResolved: null,
  isSubscriber: true,
  lifetimeGrossMills: 0,
  last30GrossMills: 0,
  lastFanMessageAt: null,
  anyFanMessageAt: null,
  answeredAt: null,
  messageCount: 0,
  subscribedAt: daysAgo(60),
  subscriptionEndsAt: null,
  autoRenew: true,
  lastAttributionAt: null,
  lastSentAttemptAt: null,
  mark: null,
  ...over,
});

const decide = (over: Partial<OnlineCandidateRow>, others: { names: string[]; lastSentAt: Date } | null = null) =>
  decideOnline(row(over), { now: NOW, others });

describe("decideOnline", () => {
  it("answers who waits first, and a fan the page answered since is no longer waiting", () => {
    expect(decide({ lastFanMessageAt: minutesAgo(20), anyFanMessageAt: minutesAgo(20), answeredAt: minutesAgo(120) }))
      .toMatchObject({ reason: "waiting", act: "reply", aside: null, reasonAt: minutesAgo(20) });
    expect(decide({ lastFanMessageAt: minutesAgo(20), anyFanMessageAt: minutesAgo(20), answeredAt: minutesAgo(5) }).reason).toBe("none");
  });

  it("greets a new subscriber nobody wrote to; the platform's welcome within two minutes is no greeting", () => {
    const start = daysAgo(1);
    expect(decide({ subscribedAt: start })).toMatchObject({ reason: "new_unattended", act: "hi", aside: null });
    expect(decide({ subscribedAt: start, answeredAt: new Date(start.getTime() + 60_000) }).reason).toBe("new_unattended");
    expect(decide({ subscribedAt: start, answeredAt: new Date(start.getTime() + 30 * 60_000) }).reason).not.toBe("new_unattended");
    expect(decide({ subscribedAt: start, lastAttributionAt: new Date(start.getTime() + 60_000) }).reason).not.toBe("new_unattended");
  });

  it("pings from ten messages of the chat and takes the guide's A text below that", () => {
    const silent = { lifetimeGrossMills: 50_000, lastFanMessageAt: daysAgo(12), anyFanMessageAt: daysAgo(12), answeredAt: daysAgo(11) };
    expect(decide({ ...silent, messageCount: 10 })).toMatchObject({ reason: "silent", act: "ping" });
    expect(decide({ ...silent, messageCount: 3 })).toMatchObject({ reason: "silent", act: "template_a" });
    expect(decide({ ...silent, lifetimeGrossMills: 0, messageCount: 10 })).toMatchObject({ reason: "quiet", act: "ping" });
    // Talked four days ago: not quiet enough yet.
    expect(decide({ ...silent, answeredAt: daysAgo(4) }).reason).toBe("none");
  });

  it("tells an ending subscription without renewal, and a fan who never wrote gets the guide's B text", () => {
    expect(decide({ subscriptionEndsAt: new Date(NOW.getTime() + 2 * 86_400_000), autoRenew: false, anyFanMessageAt: daysAgo(30), lastFanMessageAt: daysAgo(31), messageCount: 10 }))
      .toMatchObject({ reason: "expiring", act: "ping" });
    expect(decide({ subscriptionEndsAt: new Date(NOW.getTime() + 2 * 86_400_000), autoRenew: true }).reason).toBe("never_wrote");
    expect(decide({})).toMatchObject({ reason: "never_wrote", act: "template_b", aside: null });
    // The page wrote to him yesterday: nothing to write about now.
    expect(decide({ answeredAt: daysAgo(1) })).toMatchObject({ reason: "none", act: "none" });
  });

  it("sets aside, never hides: «Не предлагать», the unreachable, another chatter's conversation", () => {
    expect(decide({ mark: { action: "dismissed", at: daysAgo(3), by: "anna" } }))
      .toMatchObject({ reason: "never_wrote", aside: "dismissed", asideBy: "anna", asideAt: daysAgo(3) });
    expect(decide({ mark: { action: "restored", at: daysAgo(1), by: "anna" } }).aside).toBeNull();
    expect(decide({ contactability: "blocked" }).aside).toBe("unreachable");
    expect(decide({ lastFanMessageAt: minutesAgo(3), anyFanMessageAt: minutesAgo(3) }, { names: ["Никита"], lastSentAt: minutesAgo(4) }))
      .toMatchObject({ reason: "waiting", aside: "in_conversation", asideBy: "Никита" });
  });

  it("sets aside who the page wrote to within 48 hours or the window within three weeks, unless he answered", () => {
    expect(decide({ subscriptionEndsAt: new Date(NOW.getTime() + 86_400_000), autoRenew: false, answeredAt: minutesAgo(600), anyFanMessageAt: daysAgo(20), lastFanMessageAt: daysAgo(20) }))
      .toMatchObject({ reason: "expiring", aside: "wrote_recently", asideAt: minutesAgo(600) });
    const tried = { lifetimeGrossMills: 50_000, lastFanMessageAt: daysAgo(30), anyFanMessageAt: daysAgo(30), answeredAt: daysAgo(10), messageCount: 10 };
    expect(decide({ ...tried, lastSentAttemptAt: daysAgo(9) })).toMatchObject({ reason: "silent", aside: "attempted_recently" });
    expect(decide({ ...tried, lastSentAttemptAt: daysAgo(25) }).aside).toBeNull();
  });
});

describe("onlineRank", () => {
  it("orders by reason, the offered first, the fresh, the paid, the newest", () => {
    const item = (reason: string, over: Partial<{ aside: string | null; fresh: boolean; lifetimeGrossMills: number; seenAt: Date }> = {}) => ({
      reason, aside: null, fresh: true, lifetimeGrossMills: 0, seenAt: minutesAgo(1), ...over,
    });
    const list = [
      item("never_wrote"),
      item("silent", { lifetimeGrossMills: 10 }),
      item("silent", { lifetimeGrossMills: 500 }),
      item("silent", { lifetimeGrossMills: 900, fresh: false }),
      item("waiting", { aside: "in_conversation" }),
      item("waiting"),
    ].sort(onlineRank);
    expect(list.map((one) => [one.reason, one.aside, one.lifetimeGrossMills, one.fresh])).toEqual([
      ["waiting", null, 0, true],
      ["waiting", "in_conversation", 0, true],
      ["silent", null, 500, true],
      ["silent", null, 10, true],
      ["silent", null, 900, false],
      ["never_wrote", null, 0, true],
    ]);
  });
});

describe("greetingNameOf", () => {
  it("takes the profile's name or nick for «love», never a platform's generated id", () => {
    expect(greetingNameOf("Dixon/US/35", "dixon2good")).toBe("Dixon");
    expect(greetingNameOf(null, "matt84")).toBe("Matt");
    expect(greetingNameOf("🔥", "kyle.vaughn")).toBe("Kyle");
    expect(greetingNameOf(null, "u285080777")).toBeNull();
    expect(greetingNameOf("J", null)).toBeNull();
    expect(greetingNameOf("Алексей", null)).toBe("Алексей");
  });
});

describe("ONLINE_TEMPLATES", () => {
  it("carries the guide's eleven A texts and five B texts", () => {
    expect(ONLINE_TEMPLATES.filter((one) => one.group === "a").map((one) => one.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11"]);
    expect(ONLINE_TEMPLATES.filter((one) => one.group === "b").map((one) => one.id)).toEqual(["B1", "B2", "B3", "B4", "B5"]);
  });
});
