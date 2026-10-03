import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { CoveragePanel } from "../apps/dashboard/src/components/analytics/CoveragePanel.tsx";

// The coverage panel's engine section (step 4, S4-18): what the Fansly Sync
// Engine reads for the page, per legacy stream — never the retired lanes'
// gates and budgets.

type EngineStream = NonNullable<StatsCoverageResponse["engine"]>["streams"][number];

function stream(overrides: Partial<EngineStream> = {}): EngineStream {
  return {
    stream: "media_stats",
    resources: ["media-stats.walk"],
    succeededAt: "2026-10-03T09:00:00.000Z",
    nextDueAt: "2026-10-03T09:05:00.000Z",
    paused: false,
    needsAttention: false,
    reason: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function render(engine: StatsCoverageResponse["engine"]): string {
  const data: StatsCoverageResponse = {
    page: { label: "lilly-1", platform: "fansly" },
    generatedAt: "2026-10-03T09:01:00.000Z",
    planes: [],
    engine,
    holdings: [],
  };
  return renderToStaticMarkup(createElement(CoveragePanel, {
    state: { status: "ready", data, refreshFailed: false },
    onRetry: () => {},
  }));
}

describe("the coverage panel's engine section", () => {
  it("shows each stream's last read, next due, keys and why it waits", () => {
    const html = render({
      mode: "live",
      streams: [stream({ reason: "media-stats.walk: pacer until 2026-10-03T09:05:00.000Z" })],
    });
    expect(html).toContain("Fansly Sync Engine — what it reads");
    expect(html).toContain("media_stats");
    expect(html).toContain("reading");
    expect(html).toContain("Last read");
    expect(html).toContain("Next due");
    expect(html).toContain("media-stats.walk: pacer until 2026-10-03T09:05:00.000Z");
    expect(html).toContain("media-stats.walk");
    // The retired lanes' vocabulary is gone.
    expect(html).not.toContain("Budget today");
    expect(html).not.toContain("ramped");
    expect(html).not.toContain("flag off");
  });

  it("says a paused stream is paused and a quarantined one needs attention, with its failures", () => {
    const html = render({
      mode: "live",
      streams: [
        stream({ stream: "notifications", resources: ["notifications.forward", "notifications.backfill"], paused: true }),
        stream({
          stream: "catalog",
          resources: ["catalog.fixed"],
          needsAttention: true,
          consecutiveFailures: 4,
          reason: "1 quarantined (catalog.fixed)",
        }),
      ],
    });
    expect(html).toContain("paused");
    expect(html).toContain("needs attention");
    expect(html).toContain("Failures");
    expect(html).toContain("1 quarantined (catalog.fixed)");
  });

  it("says nothing reads the page when the engine does not own it", () => {
    expect(render(null)).toContain("The Fansly Sync Engine does not own this page: nothing reads its data.");
  });
});
