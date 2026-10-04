import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { CoveragePanel, engineStreamBadge } from "../apps/dashboard/src/components/analytics/CoveragePanel.tsx";
import { formatDateTime } from "../apps/dashboard/src/lib/format.ts";
import { engineWaitLabel } from "../apps/dashboard/src/pages/settings/engine/engineDisplay.ts";
import { getStreamLabel } from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";
import { WAITING_REASONS } from "../apps/runtime/src/sync/engine/status.ts";
import { FANSLY_LEVER_STREAMS } from "../apps/runtime/src/sync/fansly/registry.ts";

// The coverage panel's engine section and its floors (step 4, S4-18 and
// S4-34): what the Fansly Sync Engine reads for the page, stream by stream, in
// words that are true — "reading" only of a stream a host reads, a reason in
// the sync tabs' own dictionary and the panel's time, a floor with its year.

type Engine = NonNullable<StatsCoverageResponse["engine"]>;
type EngineStream = Engine["streams"][number];
type Floor = StatsCoverageResponse["planes"][number];

function stream(overrides: Partial<EngineStream> = {}): EngineStream {
  return {
    stream: "media_stats",
    resources: ["media-stats.walk"],
    succeededAt: "2026-10-03T09:00:00.000Z",
    nextDueAt: "2026-10-03T09:05:00.000Z",
    activeWork: 1,
    paused: false,
    needsAttention: false,
    reason: null,
    waiting: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

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
  return text(html.slice(start, next === -1 ? html.indexOf("Rows held") : next));
}

const badge = (html: string, name: string): string => card(html, name).split("\n")[2]!;

describe("the coverage panel's engine section", () => {
  it("shows each stream's last read, next due, keys and why it waits", () => {
    const html = render({
      engine: engine([stream({
        waiting: { resource: "media-stats.walk", reason: "not_due", until: "2026-10-03T09:05:00.000Z" },
      })]),
    });
    expect(html).toContain("Fansly Sync Engine — what it reads");
    const media = card(html, "media_stats");
    expect(media).toContain("Last read");
    expect(media).toContain("Next due");
    expect(media).toContain(`media-stats.walk: not due until ${formatDateTime("2026-10-03T09:05:00.000Z")}`);
    expect(media).toContain("media-stats.walk");
    expect(badge(html, "media_stats")).toBe("reading");
    // The retired lanes' vocabulary is gone.
    expect(html).not.toContain("Budget today");
    expect(html).not.toContain("ramped");
    expect(html).not.toContain("flag off");
  });

  it("says a paused stream is paused and a quarantined one needs attention, with its failures", () => {
    const html = render({
      engine: engine([
        stream({ stream: "notifications", resources: ["notifications.forward", "notifications.backfill"], paused: true }),
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
    expect(badge(html, "notifications")).toBe("paused");
    expect(badge(html, "catalog")).toBe("needs attention");
    const catalog = card(html, "catalog");
    expect(catalog).toContain("Failures");
    expect(catalog).toContain("1 quarantined (catalog.fixed); pnpm cli sync work list --page lilly-1 --state quarantined");
    expect(catalog).not.toContain("catalog.vault: not due");
  });

  it("says nothing reads the page when the engine does not own it", () => {
    expect(render({ engine: null })).toContain("The Fansly Sync Engine does not own this page: nothing reads its data.");
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
    expect(badge(html, "transactions")).toBe("reading");
    expect(badge(html, "top_spenders")).toBe("reading");
    expect(badge(html, "purchase_history")).toBe("idle");
    expect(badge(html, "followers_reconcile")).toBe("nothing asked yet");
    // The card that used to read "reading" over two dashes.
    const never = card(html, "followers_reconcile");
    expect(never).not.toContain("reading");
    expect(never.split("\n").filter((line) => line === "—")).toHaveLength(2);
    expect(html).not.toContain("data-engine-not-running");
  });

  it("no stream of a page no host owns reads 'reading', whatever its work says", () => {
    const streams = [
      stream({ stream: "light", waiting: { resource: "account.poll", reason: "ownership_unconfirmed", until: null } }),
      stream({ stream: "transactions", activeWork: 4 }),
      stream({ stream: "stats_snapshot", paused: true }),
      stream({ stream: "followers_reconcile", activeWork: 0, succeededAt: null, nextDueAt: null }),
      stream({
        stream: "subscribers",
        needsAttention: true,
        reason: "1 quarantined (subscribers.poll); pnpm cli sync work list --page lilly-1 --state quarantined",
      }),
    ];
    const html = render({ engine: engine(streams, { ownerRunning: false }) });
    for (const row of streams) expect(badge(html, row.stream), row.stream).toBe("not running: no owner");
    expect(text(html)).not.toContain("\nreading\n");
    expect(html).toContain("data-engine-not-running");
    expect(html).toContain("No sync host owns this page: none of the streams below is being read");
    // What a stream waits for and what needs the owner are still said.
    expect(card(html, "light")).toContain("account.poll: no owner");
    expect(card(html, "subscribers")).toContain("1 quarantined (subscribers.poll)");

    const handover = render({ engine: engine(streams, { mode: "handover", ownerRunning: false }) });
    for (const row of streams) expect(badge(handover, row.stream), row.stream).toBe("not running: switching");
    expect(handover).toContain("The page is switching to the engine (handover)");
  });

  it("puts the owner first, then the pause, then attention, then the work", () => {
    const owned = { mode: "live", ownerRunning: true } as const;
    const all = stream({ paused: true, needsAttention: true, activeWork: 2 });
    expect(engineStreamBadge({ mode: "live", ownerRunning: false }, all)).toMatchObject({ text: "not running: no owner", tone: "off" });
    expect(engineStreamBadge(owned, all)).toMatchObject({ text: "paused", tone: "off" });
    expect(engineStreamBadge(owned, { ...all, paused: false })).toMatchObject({ text: "needs attention", tone: "off" });
    expect(engineStreamBadge(owned, { ...all, paused: false, needsAttention: false })).toMatchObject({ text: "reading", tone: "on" });
    expect(engineStreamBadge(owned, { ...all, paused: false, needsAttention: false, activeWork: 0 })).toMatchObject({ text: "idle", tone: "on" });
  });
});

describe("why a stream waits, in the sync tabs' dictionary and the panel's time", () => {
  it("names every reason of the engine in words, never by its code", () => {
    for (const reason of WAITING_REASONS) {
      const words = engineWaitLabel(reason, "en");
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

  it("writes 'until' as the card writes its other times, not as UTC ISO", () => {
    const until = "2026-10-04T09:01:51.948Z";
    const html = text(render({
      engine: engine([stream({
        stream: "light",
        resources: ["account.poll"],
        nextDueAt: until,
        waiting: { resource: "account.poll", reason: "not_due", until },
      })]),
    }));
    const local = formatDateTime(until);
    expect(html).toContain(`\naccount.poll: not due until ${local}\n`);
    // "Next due" beside it reads the same instant the same way.
    expect(html.split(local)).toHaveLength(3);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
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
    expect(html.split("\nthis page\n")).toHaveLength(5);
    expect(html).toContain("\nsteady\n");
    expect(html).toContain("\n40\n");
    // Without the page's id nothing is guessed.
    expect(text(render({ planes: [floor({ scopeRef: "4" })] }))).toContain("\n4\n");
  });

  it("is a table where its columns fit and one labelled block per floor where they would run together", () => {
    const html = render({
      planes: [floor({ plane: "stats_account_hourly", scopeRef: "steady", status: "sampled", observedUniqueCount: 25 })],
    });
    const table = html.slice(html.indexOf('data-floors="table"'), html.indexOf('data-floors="list"'));
    const list = html.slice(html.indexOf('data-floors="list"'), html.indexOf("Fansly Sync Engine — what it reads"));
    // One of the two shows at any width of the panel.
    expect(html).toMatch(/<table class="hidden [^"]*@2xl:table[^"]*" data-floors="table"/);
    expect(html).toMatch(/<ul class="[^"]*@2xl:hidden[^"]*" data-floors="list"/);
    expect(html).toContain('class="@container');
    for (const part of [table, list]) {
      const read = text(part);
      for (const cell of ["stats_account_hourly", "steady", "sampled", "none", "25 / —"]) expect(read).toContain(`\n${cell}\n`);
    }
    // The table keeps its columns apart; the list labels each value.
    expect(table).toMatch(/<td class="py-2 pr-4 [^"]*whitespace-nowrap">stats_account_hourly<\/td>/);
    for (const label of ["Status", "Proof", "Reaches back to", "Seen / expected"]) {
      expect(text(list)).toContain(`\n${label}\n`);
    }
  });

  it("says the engine has recorded no floor, not that a lane claimed none", () => {
    const html = render({ engine: null });
    expect(html).toContain("No capture floors: the engine has recorded none for this page yet.");
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
