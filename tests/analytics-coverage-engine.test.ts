import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { CoveragePanel, engineStreamBadge } from "../apps/dashboard/src/components/analytics/CoveragePanel.tsx";
import { formatDateTime } from "../apps/dashboard/src/lib/format.ts";
import {
  engineReadingWords,
  engineWaitLabel,
  type EngineReadingState,
} from "../apps/dashboard/src/pages/settings/engine/engineDisplay.ts";
import { getStreamLabel } from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";
import { WAITING_REASONS } from "../apps/runtime/src/sync/engine/status.ts";
import { FANSLY_LEVER_STREAMS } from "../apps/runtime/src/sync/fansly/registry.ts";

// The coverage panel's engine section and its floors (step 4, S4-18, S4-34
// and S4-35): what the Fansly Sync Engine reads for the page, stream by
// stream, in words that are true — "reading" only of a stream a host reads
// and nothing stops, what stops it (the page's hold, a breaker, a 429's hold
// of its routes, the owner's pause) said in the panel's own words, a reason in
// the sync tabs' dictionary and the panel's time, a floor with its year.

type Engine = NonNullable<StatsCoverageResponse["engine"]>;
type EngineStream = Engine["streams"][number];
type EngineStop = EngineStream["stops"][number];
type Floor = StatsCoverageResponse["planes"][number];

function stream(overrides: Partial<EngineStream> = {}): EngineStream {
  return {
    stream: "media_stats",
    resources: ["media-stats.walk"],
    succeededAt: "2026-10-03T09:00:00.000Z",
    nextDueAt: "2026-10-03T09:05:00.000Z",
    activeWork: 1,
    paused: false,
    stopped: "none",
    stops: [],
    needsAttention: false,
    reason: null,
    waiting: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** What the server says of a stream every key of which the owner paused. */
function pausedBy(resources: string[]): Pick<EngineStream, "paused" | "stopped" | "stops"> {
  return { paused: true, stopped: "all", stops: [{ reason: "paused", by: ["keys"], resources, until: null }] };
}

const stop = (reason: EngineStop["reason"], by: string[], resources: string[], until: string | null = null): EngineStop =>
  ({ reason, by, resources, until });

function engine(streams: EngineStream[], overrides: Partial<Engine> = {}): Engine {
  return { mode: "live", ownerRunning: true, streams, ...overrides };
}

function floor(overrides: Partial<Floor> = {}): Floor {
  return {
    plane: "media_stats",
    scopeRef: "",
    status: "in_progress",
    acquisitionMode: "forward_only",
    proof: "none",
    oldestCapturedAt: null,
    newestCapturedAt: null,
    expectedCount: null,
    observedUniqueCount: null,
    reasonCode: null,
    updatedAt: "2026-10-03T09:00:00.000Z",
    ...overrides,
  } as Floor;
}

function render(input: { engine?: StatsCoverageResponse["engine"]; planes?: Floor[]; pageId?: number | null }): string {
  const data: StatsCoverageResponse = {
    page: { label: "lilly-1", platform: "fansly" },
    generatedAt: "2026-10-03T09:01:00.000Z",
    planes: input.planes ?? [],
    engine: input.engine === undefined ? null : input.engine,
    holdings: [],
  };
  return renderToStaticMarkup(createElement(CoveragePanel, {
    state: { status: "ready", data, refreshFailed: false },
    pageId: input.pageId ?? null,
    onRetry: () => {},
  }));
}

/** What a person reads: the markup's text, without tags and attributes. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "\n").replace(/\n+/g, "\n");
}

/** The card of one stream. */
function card(html: string, name: string): string {
  const start = html.indexOf(`data-engine-stream="${name}"`);
  expect(start, name).toBeGreaterThan(-1);
  const next = html.indexOf("data-engine-stream=", start + 1);
  return text(html.slice(start, next === -1 ? html.indexOf("Глубина собранных данных") : next));
}

/** A stream badge's words: the engine dictionary's Russian for that state —
 *  the panel speaks the same words as the «Сбор данных» screens. */
const said = (state: EngineReadingState): string => engineReadingWords(state, "ru").text;
/** Why work waits, in the same dictionary. */
const waits = (reason: string): string => engineWaitLabel(reason, "ru");

const badge = (html: string, name: string): string => card(html, name).split("\n")[2]!;

/** A time as the panel writes it: with its year once that is not the current
 *  one. An expectation built without the rule holds only until New Year. */
const panelTime = (iso: string): string => formatDateTime(iso, { yearUnlessCurrent: true });

describe("the coverage panel's engine section", () => {
  it("shows each stream's last read, next due, keys and why it waits", () => {
    const html = render({
      engine: engine([stream({
        waiting: { resource: "media-stats.walk", reason: "not_due", until: "2026-10-03T09:05:00.000Z" },
      })]),
    });
    expect(html).toContain("Что сейчас собирается");
    const media = card(html, "media_stats");
    expect(media).toContain("Последний сбор");
    expect(media).toContain("Следующий сбор");
    expect(media).toContain(`media-stats.walk: ${waits("not_due")} до ${panelTime("2026-10-03T09:05:00.000Z")}`);
    expect(media).toContain("media-stats.walk");
    expect(badge(html, "media_stats")).toBe(said("reading"));
    // The retired lanes' vocabulary is gone.
    expect(html).not.toContain("Budget today");
    expect(html).not.toContain("ramped");
    expect(html).not.toContain("flag off");
  });

  it("says a paused stream is paused and a quarantined one needs attention, with its failures", () => {
    const html = render({
      engine: engine([
        stream({
          stream: "notifications",
          resources: ["notifications.forward", "notifications.backfill"],
          ...pausedBy(["notifications.forward", "notifications.backfill"]),
        }),
        stream({
          stream: "catalog",
          resources: ["catalog.fixed"],
          needsAttention: true,
          consecutiveFailures: 4,
          reason: "1 quarantined (catalog.fixed); pnpm cli sync work list --page lilly-1 --state quarantined",
          // What needs the owner is said, never why other work of the stream waits.
          waiting: { resource: "catalog.vault", reason: "not_due", until: null },
        }),
      ]),
    });
    expect(badge(html, "notifications")).toBe(said("paused"));
    expect(badge(html, "catalog")).toBe(said("attention"));
    const catalog = card(html, "catalog");
    expect(catalog).toContain("Ошибок подряд");
    expect(catalog).toContain("1 quarantined (catalog.fixed)");
    // The server's sentence is said; the terminal command it ends with is not
    // something this page asks the owner to run.
    expect(catalog).not.toContain("pnpm");
    expect(catalog).not.toContain(`catalog.vault: ${waits("not_due")}`);
  });

  it("says nothing reads the page when the engine does not own it", () => {
    expect(render({ engine: null })).toContain("Сбор данных Fansly не ведёт эту страницу: её данные никто не читает.");
  });
});

describe("the badge of a stream says what is true of it", () => {
  it("reading takes open work; a stream read before is idle; one nothing asked for says so", () => {
    const html = render({
      engine: engine([
        stream({ stream: "transactions", activeWork: 3 }),
        // A first read in flight: no last read yet, but something was asked.
        stream({ stream: "top_spenders", activeWork: 1, succeededAt: null, nextDueAt: null }),
        stream({ stream: "purchase_history", activeWork: 0, nextDueAt: null }),
        stream({ stream: "followers_reconcile", activeWork: 0, succeededAt: null, nextDueAt: null }),
      ]),
    });
    expect(badge(html, "transactions")).toBe(said("reading"));
    expect(badge(html, "top_spenders")).toBe(said("reading"));
    expect(badge(html, "purchase_history")).toBe(said("idle"));
    expect(badge(html, "followers_reconcile")).toBe(said("never_read"));
    // The card that used to read "reading" over two dashes.
    const never = card(html, "followers_reconcile");
    expect(never).not.toContain(said("reading"));
    expect(never.split("\n").filter((line) => line === "—")).toHaveLength(2);
    expect(html).not.toContain("data-engine-not-running");
  });

  it("no stream of a page no host owns reads 'reading', whatever its work says", () => {
    const streams = [
      stream({ stream: "light", waiting: { resource: "account.poll", reason: "ownership_unconfirmed", until: null } }),
      stream({ stream: "transactions", activeWork: 4 }),
      stream({ stream: "stats_snapshot", ...pausedBy(["media-stats.walk"]) }),
      stream({ stream: "followers_reconcile", activeWork: 0, succeededAt: null, nextDueAt: null }),
      stream({
        stream: "subscribers",
        needsAttention: true,
        reason: "1 quarantined (subscribers.poll); pnpm cli sync work list --page lilly-1 --state quarantined",
      }),
    ];
    const html = render({ engine: engine(streams, { ownerRunning: false }) });
    for (const row of streams) expect(badge(html, row.stream), row.stream).toBe(said("no_owner"));
    expect(text(html)).not.toContain(`\n${said("reading")}\n`);
    expect(html).toContain("data-engine-not-running");
    expect(html).toContain("Страницу не ведёт ни один обработчик сбора: ни один поток ниже сейчас не читается");
    // What a stream waits for and what needs the owner are still said.
    expect(card(html, "light")).toContain(`account.poll: ${waits("ownership_unconfirmed")}`);
    expect(card(html, "subscribers")).toContain("1 quarantined (subscribers.poll)");

    const handover = render({ engine: engine(streams, { mode: "handover", ownerRunning: false }) });
    for (const row of streams) expect(badge(handover, row.stream), row.stream).toBe(said("switching"));
    expect(handover).toContain("Страница переключается на новый сбор данных");
  });

  it("puts the owner first, then what stops every key, then attention, then a partial stop, then the work", () => {
    const owned = { mode: "live", ownerRunning: true } as const;
    const all = stream({ ...pausedBy(["media-stats.walk"]), needsAttention: true, activeWork: 2 });
    type Stopped = Pick<EngineStream, "paused" | "stopped" | "stops">;
    const free: Stopped = { paused: false, stopped: "none", stops: [] };
    const partly: Stopped = { paused: false, stopped: "some", stops: [stop("resource_hold", ["followers"], ["followers.head"])] };
    expect(engineStreamBadge({ mode: "live", ownerRunning: false }, all)).toMatchObject({ text: said("no_owner"), tone: "off" });
    expect(engineStreamBadge(owned, all)).toMatchObject({ text: said("paused"), tone: "off" });
    expect(engineStreamBadge(owned, { ...all, ...free })).toMatchObject({ text: said("attention"), tone: "off" });
    // Work that needs the owner is said before a stop of some of the keys.
    expect(engineStreamBadge(owned, { ...all, ...partly })).toMatchObject({ text: said("attention"), tone: "off" });
    expect(engineStreamBadge(owned, { ...all, ...partly, needsAttention: false })).toMatchObject({ text: said("partly_held"), tone: "off" });
    expect(engineStreamBadge(owned, { ...all, ...free, needsAttention: false })).toMatchObject({ text: said("reading"), tone: "on" });
    expect(engineStreamBadge(owned, { ...all, ...free, needsAttention: false, activeWork: 0 })).toMatchObject({ text: said("idle"), tone: "on" });
  });
});

// S4-35: seen on the stand — every stream of a page held for its credentials
// read "reading" beside "account.poll: page held"; "Followers [reading] …
// resource held until …"; "Message history [reading]" while its only route was
// held by a 429. The badge follows the server's verdict over the stream's
// keys (`stopped`, `stops`: the engine's own hold evaluator and the owner's
// pauses), for a stream whose work is per chat as for any other.
describe("held is not reading", () => {
  const owned = { mode: "live", ownerRunning: true } as const;
  const pageHold = (resources: string[]) => stop("page_hold", ["auth"], resources);

  it("no stream of a page held for its credentials reads 'reading', and each says what holds the page", () => {
    const streams = [
      stream({
        stream: "light", resources: ["account.poll"], stopped: "all", stops: [pageHold(["account.poll"])],
        waiting: { resource: "account.poll", reason: "page_hold", until: null },
      }),
      // Work per chat: no page-level row, so no waiting line — the badge still knows.
      stream({
        stream: "dm_messages", resources: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"], activeWork: 12,
        stopped: "all", stops: [pageHold(["dm-messages.head", "dm-messages.catchup", "dm-messages.history"])],
      }),
      stream({ stream: "posts", resources: ["posts.refresh"], activeWork: 0, succeededAt: null, stopped: "all", stops: [pageHold(["posts.refresh"])] }),
    ];
    const html = render({ engine: engine(streams) });
    for (const row of streams) {
      expect(badge(html, row.stream), row.stream).toBe(said("page_held"));
      expect(card(html, row.stream), row.stream).toContain("Удержание страницы: Fansly не принимает данные входа — до новых данных входа");
    }
    expect(text(html)).not.toContain(`\n${said("reading")}\n`);
    // The stop says it for every key: the one row's "page held" is not repeated.
    expect(card(html, "light")).not.toContain(`account.poll: ${waits("page_hold")}`);
    expect(engineStreamBadge(owned, streams[1]!)).toMatchObject({ text: said("page_held"), tone: "off" });
  });

  it("a stream whose only route a 429 holds is held until the hold's end, not reading", () => {
    const until = "2026-10-04T19:59:42.000Z";
    const history = stream({
      stream: "dm_messages",
      resources: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"],
      activeWork: 4,
      nextDueAt: null,
      stopped: "all",
      stops: [stop("route_hold", ["messages.page"], ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"], until)],
    });
    const html = render({ engine: engine([history]) });
    expect(badge(html, "dm_messages")).toBe(said("held"));
    const read = card(html, "dm_messages");
    expect(read).toContain(`\nУдержание эндпоинта messages.page (429) до ${panelTime(until)}\n`);
    // Open work that is held has no next read.
    expect(read.split("\n").slice(read.split("\n").indexOf("Следующий сбор"))[1]).toBe("—");
    expect(read).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  // Seen in review: "Posts [reading]" and "Follower reconcile [reading]"
  // above "…: endpoint held (429) until …". A key that reads several routes
  // is stopped by a hold of one of them once the hold has put its work off
  // (the server's verdict reads that row): the badge says held, and the hold
  // is said once — by the stop, with every key it stops.
  it("work a 429's hold of one of its routes put off is held, not reading", () => {
    const until = "2026-10-04T19:59:42.000Z";
    const posts = stream({
      stream: "posts",
      resources: ["posts.refresh", "posts.backfill", "posts.engagement"],
      activeWork: 2,
      nextDueAt: null,
      stopped: "some",
      stops: [stop("route_hold", ["posts.timeline"], ["posts.refresh", "posts.backfill"], until)],
      reason: `posts.refresh: route_hold until ${until}`,
      waiting: { resource: "posts.refresh", reason: "route_hold", until },
    });
    const reconcile = stream({
      stream: "followers_reconcile",
      resources: ["followers.reconcile", "fan-profiles.lookup"],
      nextDueAt: null,
      stopped: "some",
      stops: [stop("route_hold", ["followers.page"], ["followers.reconcile"], until)],
      waiting: { resource: "followers.reconcile", reason: "route_hold", until },
    });
    // A stream of one key: all of it is held.
    const earnings = stream({
      stream: "fan_earnings",
      resources: ["fan-earnings.roster"],
      nextDueAt: null,
      stopped: "all",
      stops: [stop("route_hold", ["earnings.monthly_accounts"], ["fan-earnings.roster"], until)],
      waiting: { resource: "fan-earnings.roster", reason: "route_hold", until },
    });
    const html = render({ engine: engine([posts, reconcile, earnings]) });
    expect(text(html)).not.toContain(`\n${said("reading")}\n`);
    expect(badge(html, "posts")).toBe(said("partly_held"));
    expect(badge(html, "followers_reconcile")).toBe(said("partly_held"));
    expect(badge(html, "fan_earnings")).toBe(said("held"));
    for (const row of [posts, reconcile, earnings]) expect(engineStreamBadge(owned, row).tone, row.stream).toBe("off");
    const read = card(html, "posts");
    expect(read).toContain(`\nУдержание эндпоинта posts.timeline (429) до ${panelTime(until)}: posts.refresh, posts.backfill\n`);
    expect(card(html, "followers_reconcile")).toContain(`\nУдержание эндпоинта followers.page (429) до ${panelTime(until)}: followers.reconcile\n`);
    expect(card(html, "fan_earnings")).toContain(`\nУдержание эндпоинта earnings.monthly_accounts (429) до ${panelTime(until)}\n`);
    // The row's own wait would only repeat the stop for one of its keys, and
    // held work has no next read.
    expect(text(html)).not.toContain(`: ${waits("route_hold")}`);
    for (const name of ["posts", "followers_reconcile", "fan_earnings"]) {
      const lines = card(html, name).split("\n");
      expect(lines[lines.indexOf("Следующий сбор") + 1], name).toBe("—");
    }
    expect(html.match(/data-engine-stop/g)).toHaveLength(3);
  });

  it("a breaker of one of its files holds a part of a stream: the keys it stops are named", () => {
    const until = "2026-10-04T18:08:42.000Z";
    const followers = stream({
      stream: "followers",
      resources: ["followers.head", "fan-profiles.lookup"],
      stopped: "some",
      stops: [stop("resource_hold", ["followers"], ["followers.head"], until)],
      waiting: { resource: "followers.head", reason: "resource_hold", until },
    });
    const html = render({ engine: engine([followers]) });
    expect(badge(html, "followers")).toBe(said("partly_held"));
    const read = card(html, "followers");
    expect(read).toContain(`\nУдержание ресурса followers после ошибок до ${panelTime(until)}: followers.head\n`);
    expect(read).not.toContain(`followers.head: ${waits("resource_hold")}`);
  });

  it("a pause of some keys is a partial pause; of the page, a pause that names the page", () => {
    const some = stream({
      stream: "dm_conversations",
      resources: ["dm-conversations.head", "dm-conversations.full", "fan-profiles.probe"],
      stopped: "some",
      stops: [stop("paused", ["keys"], ["dm-conversations.full", "fan-profiles.probe"])],
      waiting: { resource: "dm-conversations.head", reason: "not_due", until: null },
    });
    const whole = stream({ stream: "posts", resources: ["posts.refresh"], paused: true, stopped: "all", stops: [stop("paused", ["page"], ["posts.refresh"])] });
    const requests = stream({
      stream: "dm_messages", resources: ["dm-messages.head", "dm-messages.history"], stopped: "some",
      stops: [stop("paused", ["requests"], ["dm-messages.history"])],
    });
    const html = render({ engine: engine([some, whole, requests]) });
    expect(badge(html, "dm_conversations")).toBe(said("partly_paused"));
    expect(card(html, "dm_conversations")).toContain("\nПауза владельца: dm-conversations.full, fan-profiles.probe\n");
    // Why the keys that are read wait is still said.
    expect(card(html, "dm_conversations")).toContain(`\ndm-conversations.head: ${waits("not_due")}\n`);
    expect(badge(html, "posts")).toBe(said("paused"));
    expect(card(html, "posts")).toContain("\nПауза владельца: вся страница\n");
    expect(badge(html, "dm_messages")).toBe(said("partly_paused"));
    expect(card(html, "dm_messages")).toContain("\nПауза владельца: заявки на историю (dm-messages.history)\n");
  });

  it("says every stop of a stream, the pause before the hold it would leave", () => {
    const until = "2026-10-04T18:08:42.000Z";
    const both = stream({
      stream: "followers",
      resources: ["followers.head", "fan-profiles.lookup"],
      paused: false,
      stopped: "all",
      stops: [
        stop("paused", ["keys"], ["followers.head"]),
        stop("page_hold", ["network"], ["followers.head", "fan-profiles.lookup"], until),
      ],
    });
    const html = render({ engine: engine([both]) });
    expect(badge(html, "followers")).toBe(said("page_held"));
    const lines = card(html, "followers").split("\n");
    const paused = lines.indexOf("Пауза владельца: followers.head");
    expect(paused).toBeGreaterThan(-1);
    expect(lines[paused + 1]).toBe(`Удержание страницы: сеть до ${panelTime(until)}`);
    expect(html.match(/data-engine-stop/g)).toHaveLength(2);
  });

  it("a page nobody runs still says what would stop it once somebody does", () => {
    const html = render({
      engine: engine([stream({ stream: "light", resources: ["account.poll"], stopped: "all", stops: [pageHold(["account.poll"])] })], { ownerRunning: false }),
    });
    expect(badge(html, "light")).toBe(said("no_owner"));
    expect(card(html, "light")).toContain("Удержание страницы: Fansly не принимает данные входа");
  });
});

describe("why a stream waits, in the sync tabs' dictionary and the panel's time", () => {
  it("names every reason of the engine in words, never by its code", () => {
    for (const reason of WAITING_REASONS) {
      const words = engineWaitLabel(reason, "ru");
      expect(words, reason).not.toMatch(/_/);
      const html = text(render({
        engine: engine([stream({ waiting: { resource: "media-stats.walk", reason, until: null } })]),
      }));
      expect(html, reason).toContain(`\nmedia-stats.walk: ${words}\n`);
      if (reason.includes("_")) expect(html, reason).not.toContain(reason);
    }
    // The words of the examples the panel used to print raw.
    expect(engineWaitLabel("class_share", "en")).toBe("queued");
    expect(engineWaitLabel("subject_breaker", "en")).toBe("backing off");
    expect(engineWaitLabel("not_due", "en")).toBe("not due");
    // One dictionary, two languages: the «Синк» tab's own rows keep theirs.
    expect(engineWaitLabel("not_due")).toBe("ждёт срока");
    expect(engineWaitLabel("subject_breaker", "ru")).toBe("пауза после ошибок");
  });

  // The clock is pinned, so the year the suite runs in decides nothing: the
  // same card is read in the instant's own year and in a later one, where
  // both of its times carry the year.
  it.each([
    ["in the instant's own year", "2026-10-04T09:00:00.000Z", false],
    ["in a later year, with the year", "2027-01-15T12:00:00.000Z", true],
  ])("writes 'until' as the card writes its other times, not as UTC ISO (%s)", (_when, clock, withYear) => {
    const until = "2026-10-04T09:01:51.948Z";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(clock));
      const html = text(render({
        engine: engine([stream({
          stream: "light",
          resources: ["account.poll"],
          nextDueAt: until,
          waiting: { resource: "account.poll", reason: "not_due", until },
        })]),
      }));
      const local = panelTime(until);
      expect(local.includes("2026")).toBe(withYear);
      expect(html).toContain(`\naccount.poll: ${waits("not_due")} до ${local}\n`);
      // "Next due" beside it reads the same instant the same way.
      expect(html.split(local)).toHaveLength(3);
      expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("titles a card by the stream's name in the sync tabs, never by a raw key", () => {
    const names = FANSLY_LEVER_STREAMS.map((line) => line.stream);
    const html = render({ engine: engine(names.map((name) => stream({ stream: name }))) });
    const titles = names.map((name) => card(html, name).split("\n")[1]!);
    expect(titles).toEqual([
      "Connection", "Conversation sync", "Message history", "Transactions", "Top spenders", "Fan earnings",
      "Purchase history", "Payouts", "Subscribers", "Followers", "Follower reconcile", "Notifications", "Posts",
      "Post replies", "Catalog", "Media statistics", "Account statistics",
    ]);
    for (const name of names) {
      const label = getStreamLabel(name);
      expect(label, name).not.toMatch(/_/);
      expect(label, name).not.toBe("light");
    }
    // The raw keys are left to the markup (the hover title, the test hook).
    const read = text(html);
    expect(read).not.toMatch(/\n(light|stats_snapshot|dm_messages|media_stats)\n/);
  });
});

describe("the capture floors", () => {
  const thisYear = new Date().getFullYear();

  it("a floor of another year carries its year; one of this year does not", () => {
    const old = "2023-10-04T08:59:00.000Z";
    const recent = new Date(Date.UTC(thisYear, 5, 15, 12, 0, 0)).toISOString();
    const html = text(render({
      planes: [
        floor({ plane: "stats_earnings", scopeRef: "steady", oldestCapturedAt: old }),
        floor({ plane: "notifications", oldestCapturedAt: recent }),
      ],
    }));
    expect(formatDateTime(old, { yearUnlessCurrent: true })).toContain("2023");
    expect(html).toContain(`\n${formatDateTime(old, { yearUnlessCurrent: true })}\n`);
    expect(html).not.toContain(`\n${formatDateTime(old)}\n`);
    expect(formatDateTime(recent, { yearUnlessCurrent: true })).toBe(formatDateTime(recent));
    expect(html).toContain(`\n${formatDateTime(recent)}\n`);
    expect(formatDateTime(recent)).not.toContain(String(thisYear));
  });

  it("names a scope that is the page itself, and leaves every other scope as stored", () => {
    const html = text(render({
      pageId: 4,
      planes: [
        floor({ plane: "media_stats", scopeRef: "4" }),
        floor({ plane: "post_replies", scopeRef: "4" }),
        floor({ plane: "stats_account_daily", scopeRef: "steady" }),
        // Another plane's scope that is a number, but not this page's.
        floor({ plane: "catalog_vault_media", scopeRef: "40" }),
      ],
    }));
    expect(html).not.toContain("\n4\n");
    // Two floors, each in the table and in the phone's list.
    expect(html.split("\nэта страница\n")).toHaveLength(5);
    expect(html).toContain("\nсвежие данные\n");
    expect(html).toContain("\n40\n");
    // Without the page's id nothing is guessed.
    expect(text(render({ planes: [floor({ scopeRef: "4" })] }))).toContain("\n4\n");
  });

  it("is a table where its columns fit and one labelled block per floor where they would run together", () => {
    const html = render({
      planes: [floor({ plane: "stats_account_hourly", scopeRef: "steady", status: "sampled", observedUniqueCount: 25 })],
    });
    const table = html.slice(html.indexOf('data-floors="table"'), html.indexOf('data-floors="list"'));
    const list = html.slice(html.indexOf('data-floors="list"'), html.indexOf("Хранится в Hub"));
    // One of the two shows at any width of the panel.
    expect(html).toMatch(/<table class="hidden [^"]*@2xl:table[^"]*" data-floors="table"/);
    expect(html).toMatch(/<ul class="[^"]*@2xl:hidden[^"]*" data-floors="list"/);
    expect(html).toContain('class="@container');
    for (const part of [table, list]) {
      const read = text(part);
      for (const cell of ["Статистика аккаунта по часам", "свежие данные", "выборочно", "нет", "25 / —"]) expect(read).toContain(`\n${cell}\n`);
    }
    // The table keeps its columns apart; the list labels each value. The raw
    // plane name is left to the hover title.
    expect(table).toMatch(/<td class="[^"]*whitespace-nowrap[^"]*" title="stats_account_hourly">Статистика аккаунта по часам<\/td>/);
    for (const label of ["Статус", "Подтверждение", "Собрано с", "Получено / ожидалось"]) {
      expect(text(list)).toContain(`\n${label}\n`);
    }
  });

  it("says the engine has recorded no floor, not that a lane claimed none", () => {
    const html = render({ engine: null });
    expect(html).toContain("Сведений о глубине сбора для этой страницы пока нет.");
    expect(html).not.toMatch(/\blanes?\b/i);
  });
});

// The proof of S4-34e, pinned: the analytics surface says nothing of the
// lanes, their caps and flags — code that went with the legacy engine.
//   rg -n -i "\blanes?\b|budget_deferred" apps/dashboard/src/components/analytics \
//     apps/dashboard/src/pages/AnalyticsPage.tsx apps/dashboard/src/api/insights.ts      (no hits)
//   rg -n "ENGINE_REASON_LABELS" apps/dashboard/src                                      (no hits)
describe("the analytics surface's words", () => {
  const SRC = path.resolve("apps/dashboard/src");
  const sources = (target: string): string[] => {
    const full = path.resolve(SRC, target);
    if (/\.tsx?$/.test(full)) return [full];
    return readdirSync(full, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() || /\.tsx?$/.test(entry.name) ? sources(path.join(target, entry.name)) : []));
  };

  it("name no lane and no daily cap", () => {
    const files = ["components/analytics", "pages/AnalyticsPage.tsx", "api/insights.ts"].flatMap(sources);
    expect(files.length).toBeGreaterThan(8);
    const hits = files.flatMap((file) => readFileSync(file, "utf8").split("\n")
      .map((line, index) => ({ line, at: `${path.relative(SRC, file)}:${index + 1}` }))
      .filter(({ line }) => /\blanes?\b|budget_deferred/i.test(line))
      .map(({ line, at }) => `${at}: ${line.trim()}`));
    expect(hits).toEqual([]);
  });

  it("keep no second list of the engine's reasons", () => {
    const hits = sources(".").filter((file) => readFileSync(file, "utf8").includes("ENGINE_REASON_LABELS"));
    expect(hits).toEqual([]);
  });
});
