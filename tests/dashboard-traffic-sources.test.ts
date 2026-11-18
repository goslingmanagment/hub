import { describe, expect, it } from "vitest";
import type { OfLinkChannelsResponse } from "@agency_hub_core/contracts";

import { sourcesView } from "../apps/dashboard/src/pages/traffic/sourcesView.ts";

type Channel = OfLinkChannelsResponse["channels"][number];
type Segment = Channel["segments"][number];
type Day = NonNullable<Segment["days"]>[number];
type Term = Channel["contractors"][number];

// Today is Wednesday 18 Nov: the grid is Mon 9 … Sun 22, today is slot 9.
const TODAY = "2026-11-18";
const DATES = Array.from({ length: 10 }, (_, index) => `2026-11-${String(9 + index).padStart(2, "0")}`);

type Value = number | null | "no_baseline";

function days(fans: readonly Value[], clicks?: readonly (number | null)[]): Day[] {
  return DATES.map((businessDate, index) => {
    const value = fans[index] ?? null;
    if (value === "no_baseline") return { businessDate, clicks: 40, fans: 25, vendorNetMills: 1000, flags: ["no_baseline"] };
    const clicked = clicks ? clicks[index] ?? null : value === null ? null : value * 5;
    return { businessDate, clicks: clicked, fans: value, vendorNetMills: value === null ? null : value * 1000, flags: [] };
  });
}

function segment(name: string, fans: readonly Value[], channelKey: string | null = "reddit"): Segment {
  return {
    pageId: 1, pageLabel: "page", linkKind: "tracking", linkRef: name, name, linkCreatedAt: "2026-10-01T09:00:00.000Z", channelKey, contractorKey: null,
    startAt: "2026-11-08T21:00:00.000Z", endAt: "2026-11-18T09:00:00.000Z",
    startObservedAt: "2026-11-08T18:00:00.000Z", endObservedAt: "2026-11-18T06:00:00.000Z",
    clicks: 0, claims: null, subscribers: 0, fans: 0, vendorNetMills: 0, flags: [],
    days: days(fans),
  };
}

const hubMoney = {
  state: "no_data", reason: "not_computed", revenueBasis: "creator_net_after_platform_fee",
  attributionRule: "ofapi_subscription_period_equal_split.v1", netMills: null, pendingMills: null,
} as const;

function totals(values: { clicks?: number; fans?: number; vendorNetMills?: number } = {}): Channel["totals"] {
  return { linkCount: 1, clicks: values.clicks ?? 0, claims: 0, subscribers: 0, fans: values.fans ?? 0, vendorNetMills: values.vendorNetMills ?? 0, hubMoney };
}

function term(key: string, validFrom: string, validTo: string | null, vendorNetMills: number, flags: Term["flags"] = []): Term {
  return { contractorKey: key, contractorTitle: key, validFrom, validTo, validFromBasis: "confirmed", totals: totals({ vendorNetMills }), flags };
}

function channel(key: string | null, segments: Segment[], extra: Partial<Channel> = {}): Channel {
  return { channelKey: key, channelTitle: key, contractors: [], totals: totals(), flags: [], segments, ...extra };
}

function response(channels: Channel[], range = { from: "2026-11-09", to: TODAY }): OfLinkChannelsResponse {
  return {
    generatedAt: "2026-11-18T09:00:00.000Z", businessTimeZone: "Europe/Moscow", revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: null,
    range: { ...range, fromAt: "2026-11-08T21:00:00.000Z", toAt: "2026-11-18T09:00:00.000Z" },
    channels,
    contractors: [],
  };
}

const one = (segments: Segment[], extra: Partial<Channel> = {}) => response([channel("reddit", segments, extra)]);

describe("Трафик → Источники: the day rules", () => {
  it("never counts a no_baseline day, keeps unknown days null, and draws nothing for days to come", () => {
    const view = sourcesView(one([segment("a", [null, null, "no_baseline", 2, 0, 1, 3, 0, 1, 0])]), undefined);
    const [row] = view.sources[0]!.rows;
    expect(row!.fans).toEqual([null, null, null, 2, 0, 1, 3, 0, 1, 0, null, null, null, null]);
    expect(row!.total).toBe(7);
    expect(row!.large).toBe(true);
    expect(view.sources[0]!.rows).toHaveLength(1);
  });

  it("counts the first read day of a link made inside the two weeks", () => {
    const young = segment("young", [null, null, null, null, null, null, "no_baseline", 0, 0, 0]);
    young.linkCreatedAt = "2026-11-14T10:00:00.000Z";
    const view = sourcesView(one([young]), undefined);
    expect(view.sources[0]!.rows[0]!.fans.slice(5, 10)).toEqual([null, 25, 0, 0, 0]);
  });

  it("builds the grid from the response's own range, not from the browser's today", () => {
    const view = sourcesView(response([channel("reddit", [segment("a", [1, 1, 0, 0, 0, 0, 0, 0, 0, 0])])], { from: "2026-11-02", to: "2026-11-11" }), undefined);
    expect(view.slots[0]!.date).toBe("2026-11-02");
    expect(view.slots.find((slot) => slot.when === "today")!.date).toBe("2026-11-11");
  });
});

describe("Трафик → Источники: rows", () => {
  it("makes a chart row only of a link that brought a fan; one such link is the large chart", () => {
    const clicksOnly = segment("clicks", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    clicksOnly.days = clicksOnly.days!.map((day) => ({ ...day, clicks: 3 }));
    const fresh = segment("fresh", [null, null, null, null, null, null, null, null, 0, 0]);
    fresh.linkCreatedAt = "2026-11-16T10:00:00.000Z";
    fresh.days = fresh.days!.map((day) => ({ ...day, clicks: day.fans === null ? null : 0 }));
    const source = sourcesView(one([segment("quiet", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), clicksOnly, fresh, segment("fans", [0, 4, 6, 0, 0, 0, 0, 0, 0, 0])]), undefined).sources[0]!;
    expect(source.rows.map((row) => [row.name, row.large])).toEqual([["fans", true]]);
    expect(source.noFans).toContain("clicks");
    expect(source.noFans).toContain("fresh");
    expect(source.noClicks).toContain("quiet");
    expect(source.noClicks).not.toContain("clicks");
  });

  it("with two links of fans puts «Всего» first, over every link of the source", () => {
    const rows = sourcesView(one([
      segment("a", [1, null, null, 2, 0, 0, 0, 0, 0, 0]),
      segment("b", [2, null, 3, "no_baseline", 0, 0, 0, 0, 0, 0]),
      segment("c", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]), undefined).sources[0]!.rows;
    expect(rows.map((row) => [row.name, row.large, row.link === null])).toEqual([["Всего", true, true], ["b", false, false], ["a", false, false]]);
    expect(rows[0]!.fans.slice(0, 10)).toEqual([3, 0, 3, 2, 0, 0, 0, 0, 0, 0]);
    expect(rows[0]!.total).toBe(8);
  });

  it("sums each week's known fans and marks the running week", () => {
    const source = sourcesView(one([segment("a", [1, 2, null, 0, 0, 3, 0, 4, 1, null])]), undefined).sources[0]!;
    expect(source.weeks).toEqual([{ fans: 6, running: false }, { fans: 5, running: true }]);
  });
});

describe("Трафик → Источники: the attention note", () => {
  it("counts finished days only: today's unfinished zero never makes a quiet day", () => {
    // A fan on Sunday 15th, then Monday 16th known zero, Tuesday 17th unknown, today zero: one finished known day.
    expect(sourcesView(one([segment("a", [1, 0, 0, 0, 0, 0, 2, 0, null, 0])]), undefined).sources[0]!.attention).toBeNull();
    expect(sourcesView(one([segment("a", [1, 0, 0, 0, 0, 0, 2, 0, 0, 0])]), undefined).sources[0]!.attention).not.toBeNull();
  });

  it("puts a source with a note before one with more fans", () => {
    const view = sourcesView(response([
      channel("busy", [segment("a", [5, 5, 5, 5, 5, 5, 5, 5, 5, 0], "busy")]),
      channel("quiet", [segment("b", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], "quiet")]),
    ]), undefined);
    expect(view.sources.map((source) => source.key)).toEqual(["quiet", "busy"]);
  });
});

describe("Трафик → Источники: whose money «принесли» is", () => {
  it("is the open term's on this source, two weeks and all time, never the earlier contractor's", () => {
    const recent = one([segment("a", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0])], {
      contractors: [term("new", "2026-11-05T21:00:00.000Z", null, 139_200)],
      totals: totals({ vendorNetMills: 900_000 }),
    });
    const allTime = one([segment("a", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0])], {
      contractors: [
        term("old", "2026-01-01T21:00:00.000Z", "2026-11-05T21:00:00.000Z", 16_000_000),
        term("new", "2026-11-05T21:00:00.000Z", null, 200_000, ["money_unknown"]),
      ],
      totals: totals({ vendorNetMills: 16_200_000 }),
    });
    const source = sourcesView(recent, allTime).sources[0]!;
    expect(source.money).toEqual({ recentMills: 139_200, allMills: 200_000, partial: true });
    expect(source.contractor).toContain("new");
  });

  it("is absent when no term is open", () => {
    const source = sourcesView(one([segment("a", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0])], {
      contractors: [term("old", "2026-01-01T21:00:00.000Z", "2026-11-05T21:00:00.000Z", 5_000)],
    }), undefined).sources[0]!;
    expect(source.money).toBeNull();
    expect(source.contractor).toBeNull();
  });
});

describe("Трафик → Источники: what is not a source on the chart", () => {
  const zeros = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const open = term("open", "2026-10-01T21:00:00.000Z", null, 0);
  const closed = term("closed", "2026-01-01T21:00:00.000Z", "2026-10-01T21:00:00.000Z", 0);

  it("tells the silent, the linkless, the stopped and the unread apart, and lists the unbound links that moved", () => {
    const unread = segment("u", [null, null, null, null, null, null, null, null, null, null], "unread");
    const recent = response([
      channel("silent", [segment("s", zeros, "silent")], { contractors: [open], totals: totals({ vendorNetMills: 55_000 }) }),
      channel("linkless", [segment("l", zeros, "linkless")], { contractors: [open] }),
      channel("stopped", [segment("t", zeros, "stopped")], { contractors: [closed] }),
      channel("unread", [unread], { contractors: [open] }),
      channel(null, [segment("moved", [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], null), segment("still", zeros, null), segment("still2", zeros, null)]),
    ]);
    const allTime = response([
      channel("silent", [], { totals: totals({ clicks: 40 }) }),
      channel("linkless", [], { totals: totals({ clicks: 0 }) }),
      channel("stopped", [], { totals: totals({ clicks: 90, vendorNetMills: 2_000_000 }) }),
      channel("unread", [], { totals: totals({ clicks: 10 }) }),
      channel("gone", [], { contractors: [closed], totals: totals({ clicks: 5, vendorNetMills: 100_000 }) }),
    ]);
    const view = sourcesView(recent, allTime);
    expect(view.sources).toEqual([]);
    expect(view.silent.map((line) => line.key)).toEqual(["silent"]);
    expect(view.silent[0]!.figures).toHaveLength(2);
    expect(view.linkless.map((line) => line.key)).toEqual(["linkless"]);
    expect(view.stopped.map((line) => line.key)).toEqual(["gone", "stopped"]);
    expect(view.unread.map((line) => line.key)).toEqual(["unread"]);
    expect(view.unbound?.lines.map((line) => line.name)).toEqual(["moved"]);
    expect(view.unbound?.rest).toBe(2);
  });
});
