import { describe, expect, it } from "vitest";

import type { UnboundOfLinkRow } from "@agency_hub_core/db";

import { linkUnboundItems, linkUnboundWaits, type UnboundLinkFacts } from "../apps/runtime/src/services/traffic-link-matters.ts";

// «Ждут вас» → Трафик: when a link without a source waits for one (its pure rule).

const NOW = new Date("2026-11-18T09:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const facts = (over: Partial<UnboundLinkFacts>): UnboundLinkFacts => ({
  linkCreatedAt: daysAgo(200), linkEndsAt: null, isFinished: null, fansNow: 40, fansThen: 40, ...over,
});

describe("linkUnboundWaits", () => {
  it("waits for a link made within 30 days, fans or not", () => {
    expect(linkUnboundWaits(facts({ linkCreatedAt: daysAgo(2), fansNow: 0, fansThen: 0 }), NOW)).toBe(true);
    expect(linkUnboundWaits(facts({ linkCreatedAt: daysAgo(30) }), NOW)).toBe(true);
    expect(linkUnboundWaits(facts({ linkCreatedAt: daysAgo(31) }), NOW)).toBe(false);
  });

  it("waits for an old link that got a fan within 14 days; an old dead one raises nothing", () => {
    expect(linkUnboundWaits(facts({ fansNow: 41, fansThen: 40 }), NOW)).toBe(true);
    expect(linkUnboundWaits(facts({ fansNow: 40, fansThen: 40 }), NOW)).toBe(false);
    expect(linkUnboundWaits(facts({ linkCreatedAt: null, fansNow: 3, fansThen: 3 }), NOW)).toBe(false);
    // Unknown is not a fan.
    expect(linkUnboundWaits(facts({ fansNow: null, fansThen: 2 }), NOW)).toBe(false);
  });

  it("does not wait for a link that ended or finished", () => {
    expect(linkUnboundWaits(facts({ linkCreatedAt: daysAgo(3), linkEndsAt: daysAgo(1) }), NOW)).toBe(false);
    expect(linkUnboundWaits(facts({ linkCreatedAt: daysAgo(3), isFinished: true }), NOW)).toBe(false);
    expect(linkUnboundWaits(facts({ linkCreatedAt: daysAgo(3), linkEndsAt: new Date(NOW.getTime() + DAY) }), NOW)).toBe(true);
  });
});

describe("linkUnboundItems", () => {
  const row = (over: Partial<UnboundOfLinkRow>): UnboundOfLinkRow => ({
    pageId: 7, pageLabel: "mia-of", linkKind: "tracking", linkRef: "123", name: "Twitter Rounds Two",
    linkCreatedAt: daysAgo(5), linkEndsAt: null, isFinished: null, firstObservedAt: daysAgo(5), fansNow: 9, fansThen: 0, ...over,
  });
  const vocabulary = [
    { key: "mia.twitter", title: "X (Twitter)", linkNames: [] },
    { key: "mia.reddit", title: "Reddit", linkNames: [] },
  ];

  it("one matter per link, keyed by page, kind and link, with the proposal; the link that no longer waits closes", () => {
    const items = linkUnboundItems([
      row({}),
      row({ linkRef: "456", name: "Осенняя акция", linkCreatedAt: daysAgo(90), fansNow: 12, fansThen: 10 }),
      row({ linkRef: "789", name: "Тест", linkCreatedAt: daysAgo(90), fansNow: 3, fansThen: 3 }),
    ], vocabulary, NOW);
    expect(items.map((item) => item.key)).toEqual(["traffic.link_unbound:7:tracking:123", "traffic.link_unbound:7:tracking:456"]);
    expect(items[0]!.evidence.proposedChannel).toEqual({ key: "mia.twitter", title: "X (Twitter)" });
    expect(items[0]!.evidence.since).toBe(daysAgo(5).toISOString());
    expect(items[0]!.link).toBe("/traffic/link/7/tracking/123");
    expect(items[1]!.evidence.proposedChannel).toBeNull();
    expect(items[1]!.evidence).not.toHaveProperty("since");
  });
});
