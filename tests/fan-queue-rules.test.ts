import { describe, expect, it } from "vitest";

import { agentFanQueueCreateBodySchema, fanQueueRuleSchema, fanQueueScenarioSchema } from "@agency_hub_core/contracts";
import type { OnlineCandidateRow } from "@agency_hub_core/db";

import {
  describeFanQueueRule,
  fanQueueFilterOf,
  fanQueueItemAct,
  judgeFanQueueItem,
} from "../apps/runtime/src/services/fan-queue-rules.ts";

// Fan queues: the rule the asker reads before «да» is Hub's own words for the
// filter Hub runs; a fan of a portion leaves the queue when he wrote, bought or
// was written to since he was queued, waits while someone talks to him or after
// a recent send, and goes out otherwise; neighbours get different guide texts.

const NOW = new Date(Date.UTC(2026, 9, 29, 15, 0));
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const QUEUED = { createdAt: minutesAgo(24 * 60) };

const row = (over: Partial<OnlineCandidateRow> = {}): OnlineCandidateRow => ({
  fanId: 1, fanRef: "8001", conversationRef: null, username: "mikedalt", displayName: "Mike Dalton", alias: null,
  seenAt: minutesAgo(180), seenSource: "fansly_followers_last_seen", contactability: null, probeResolved: null, isSubscriber: false,
  isFollower: true, subscriptionExpiresAt: null, publicFound: null,
  lifetimeGrossMills: 0, last30GrossMills: 0, lastFanMessageAt: null, anyFanMessageAt: null, answeredAt: null, personalAt: null,
  messageCount: 0, subscribedAt: null, subscriptionEndsAt: null, autoRenew: null, lastAttributionAt: null, lastSentAttemptAt: null,
  lastTransactionAt: null, followerSince: minutesAgo(200 * 24 * 60), mark: null,
  ...over,
});

describe("the rule", () => {
  it("says the owner's cold followers in Hub's words, with the marks it always leaves out", () => {
    const rule = fanQueueRuleSchema.parse({ audience: "followers", fanWrote: "never", lifetimeSpend: { max: 0 }, seen: { withinDays: 7 } });
    expect(describeFanQueueRule(rule, "fansly")).toEqual([
      "фолловеры страницы",
      "ни разу нам не писали",
      "не платили",
      "были на Fansly за последние 7 дней",
      "ему можно написать, без «Не предлагать» и без меток 💩, «бомж»",
      "сначала крупные траты, потом кто был недавно",
    ]);
  });

  it("turns days into moments and dollars into mills", () => {
    const filter = fanQueueFilterOf(fanQueueRuleSchema.parse({
      lifetimeSpend: { min: 20 }, lastPurchase: { olderThanDays: 30 }, otherPagesSpend: { max: 0 }, markers: { exclude: [] },
    }), NOW);
    expect(filter.lifetimeGross).toEqual({ min: 20_000, max: null });
    expect(filter.lastPurchase).toEqual({ before: minutesAgo(30 * 24 * 60), since: null });
    expect(filter.otherPagesGross).toEqual({ min: null, max: 0 });
    expect(filter.markersExclude).toEqual([]);
    expect(filter.order).toBe("spend");
  });

  it("refuses a batch that is not templates, a rule and a list together, and a standing queue without a rule", () => {
    expect(fanQueueScenarioSchema.safeParse({ action: "ping", sendMode: "batch" }).success).toBe(false);
    expect(fanQueueScenarioSchema.safeParse({ action: "template" }).success).toBe(false);
    const base = { name: "q", scenario: { action: "ping" }, requestedBy: "dima", idempotencyKey: "key-00001" };
    expect(agentFanQueueCreateBodySchema.safeParse({ ...base, rule: {}, fans: [{ ref: "1" }] }).success).toBe(false);
    expect(agentFanQueueCreateBodySchema.safeParse({ ...base, kind: "standing", fans: [{ ref: "1" }] }).success).toBe(false);
    expect(agentFanQueueCreateBodySchema.safeParse({ ...base, rule: {} }).success).toBe(true);
  });
});

describe("a fan of a portion", () => {
  it("leaves the queue when he wrote, was written to or bought since he was queued, or cannot be reached", () => {
    expect(judgeFanQueueItem(QUEUED, row({ anyFanMessageAt: minutesAgo(10) }), { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "drop", reason: "fan_wrote" });
    expect(judgeFanQueueItem(QUEUED, row({ lastAttributionAt: minutesAgo(10) }), { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "drop", reason: "messaged" });
    expect(judgeFanQueueItem(QUEUED, row({ lastTransactionAt: minutesAgo(10) }), { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "drop", reason: "bought" });
    expect(judgeFanQueueItem(QUEUED, row({ contactability: "blocked" }), { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "drop", reason: "unreachable" });
    expect(judgeFanQueueItem(QUEUED, undefined, { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "drop", reason: "unreachable" });
    expect(judgeFanQueueItem(QUEUED, row({ mark: { action: "dismissed", at: minutesAgo(5), by: "vanya" } }), { now: NOW, others: null, platform: "fansly" }))
      .toEqual({ kind: "drop", reason: "dismissed" });
  });

  it("leaves the queue when Fansly will not let the page write to him: no follow, no live subscription, no account", () => {
    const fansly = { now: NOW, others: null, platform: "fansly" };
    expect(judgeFanQueueItem(QUEUED, row({ isFollower: false }), fansly)).toEqual({ kind: "drop", reason: "unreachable" });
    expect(judgeFanQueueItem(QUEUED, row({ isFollower: false, isSubscriber: true, subscriptionExpiresAt: minutesAgo(60) }), fansly))
      .toEqual({ kind: "drop", reason: "unreachable" });
    expect(judgeFanQueueItem(QUEUED, row({ publicFound: false }), fansly)).toEqual({ kind: "drop", reason: "unreachable" });
    expect(judgeFanQueueItem(QUEUED, row({ isFollower: false, isSubscriber: true, subscriptionExpiresAt: minutesAgo(-60) }), fansly))
      .toEqual({ kind: "go" });
    // OnlyFans has no follow: an expired fan there is still written to.
    expect(judgeFanQueueItem(QUEUED, row({ isFollower: false }), { ...fansly, platform: "onlyfans" })).toEqual({ kind: "go" });
  });

  it("does not count a mass message as written to: only the archive's personal messages and the extension's sends", () => {
    // The chat summary's newest page message (a mass one) moves `answeredAt`, not `personalAt`.
    expect(judgeFanQueueItem(QUEUED, row({ answeredAt: minutesAgo(10) }), { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "go" });
  });

  it("waits while another chatter talks to him, and after a send he did not answer", () => {
    const talking = judgeFanQueueItem(QUEUED, row(), { now: NOW, others: { names: ["Ваня"], lastSentAt: minutesAgo(3) }, platform: "fansly" });
    expect(talking).toEqual({ kind: "wait", until: new Date(NOW.getTime() + 15 * 60_000) });
    const tried = judgeFanQueueItem({ createdAt: minutesAgo(30 * 24 * 60) }, row({ lastSentAttemptAt: minutesAgo(5 * 24 * 60) }), { now: NOW, others: null, platform: "fansly" });
    expect(tried).toEqual({ kind: "wait", until: new Date(minutesAgo(5 * 24 * 60).getTime() + 21 * 24 * 60 * 60_000) });
    expect(judgeFanQueueItem(QUEUED, row(), { now: NOW, others: null, platform: "fansly" })).toEqual({ kind: "go" });
  });

  it("gets the queue's act, and neighbours different guide texts", () => {
    const b = fanQueueScenarioSchema.parse({ action: "template", templates: "b", sendMode: "batch" });
    const texts = [0, 1, 2, 3, 4].map((rank) => fanQueueItemAct(b, row(), { now: NOW, rank, others: null }).templateId);
    expect(new Set(texts).size).toBe(5);
    const ping = fanQueueScenarioSchema.parse({ action: "ping" });
    expect(fanQueueItemAct(ping, row({ messageCount: 10 }), { now: NOW, rank: 0, others: null })).toEqual({ act: "ping", templateId: null });
    expect(fanQueueItemAct(ping, row({ messageCount: 3 }), { now: NOW, rank: 0, others: null }).act).toBe("template_a");
    const own = fanQueueScenarioSchema.parse({ action: "template", texts: ["hey {name}", "hi love"] });
    expect(fanQueueItemAct(own, row(), { now: NOW, rank: 3, others: null })).toEqual({ act: "template_q", templateId: "Q2" });
    const auto = fanQueueScenarioSchema.parse({ action: "auto" });
    expect(fanQueueItemAct(auto, row(), { now: NOW, rank: 0, others: null }).act).toBe("template_b");
  });
});
