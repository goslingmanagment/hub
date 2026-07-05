import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import type { WorkboardV2Item, WorkboardV2Response } from "@agency_hub_core/contracts";

const queryMocks = vi.hoisted(() => ({
  useWorkboardV2: vi.fn(),
  useWorkboardV2Lists: vi.fn(),
  useWorkboardV2Contact: vi.fn(),
  useWorkboardV2Recompute: vi.fn(),
  useWorkboardV2Snooze: vi.fn(),
  useWorkboardV2Unsnooze: vi.fn(),
  useWorkboardV2UndoContact: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { WorkboardV2Page } from "../apps/dashboard/src/pages/WorkboardV2Page.tsx";

function buildItem(fanId: number): WorkboardV2Item {
  return {
    fanId,
    fan: {
      platformUserId: `fan-${fanId}`,
      pageAlias: null,
      username: `fan${fanId}`,
      displayName: `Fan ${fanId}`,
    },
    tab: "subscribers",
    massSubstate: null,
    value: { score: 50, tier: "payer", confidence: "high" },
    urgency: { score: 10, severity: "normal" },
    rankScore: 60,
    secondaryStatus: "need_reply",
    needsReply: true,
    needsHumanTriage: false,
    isPurchaseFollowup: false,
    whyNow: { code: null, value: null },
    reasonChips: [],
    quality: { qScore: null, qConfidence: "low" },
    closingVerdict: null,
    online: false,
    ltv: { creatorNetAmountMills: 25_000 },
    subscription: { expiresAt: null, autoRenew: null },
    conversation: {
      lastFanMessageAt: "2026-06-10T10:00:00.000Z",
      lastModelMessageAt: null,
      preview: null,
      coverageStatus: "complete",
      platformConversationId: null,
    },
    serviceReason: null,
  };
}

function buildResponse(input: { total: number; items: WorkboardV2Item[] }): WorkboardV2Response {
  return {
    tab: "subscribers",
    total: input.total,
    limit: 100,
    offset: 0,
    items: input.items,
    claims: [],
    counts: [{ tab: "subscribers", secondaryStatus: "need_reply", count: input.total }],
    oldMassBudget: null,
    aiCoverage: {
      enabled: false,
      classified: 0,
      closingsFound: 0,
      callsToday: 0,
      spenderTotal: 0,
      spenderDiagnosed: 0,
      spenderPending: 0,
    },
  } satisfies WorkboardV2Response;
}

function renderPage() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/pages/lana/workboard-v2"] },
    createElement(
      Routes,
      undefined,
      createElement(Route, {
        path: "/pages/:pageLabel/workboard-v2",
        element: createElement(WorkboardV2Page),
      }),
    ),
  ));
}

describe("WorkboardV2Page queue pagination (audit B9)", () => {
  beforeEach(() => {
    for (const mock of Object.values(queryMocks)) {
      mock.mockReset();
    }
    const idleMutation = { mutate: vi.fn(), isPending: false };
    queryMocks.useWorkboardV2Contact.mockReturnValue(idleMutation);
    queryMocks.useWorkboardV2Recompute.mockReturnValue(idleMutation);
    queryMocks.useWorkboardV2Snooze.mockReturnValue(idleMutation);
    queryMocks.useWorkboardV2Unsnooze.mockReturnValue(idleMutation);
    queryMocks.useWorkboardV2UndoContact.mockReturnValue(idleMutation);
    queryMocks.useWorkboardV2Lists.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
  });

  it("requests the queue with an explicit offset", () => {
    queryMocks.useWorkboardV2.mockReturnValue({
      data: buildResponse({ total: 1, items: [buildItem(1)] }),
      isLoading: false,
      isError: false,
    });

    renderPage();

    expect(queryMocks.useWorkboardV2).toHaveBeenCalledWith(
      "lana",
      { tab: "subscribers", limit: 100, offset: 0 },
      { enabled: true },
    );
  });

  it("shows pagination when the queue exceeds the page window", () => {
    queryMocks.useWorkboardV2.mockReturnValue({
      data: buildResponse({ total: 250, items: [buildItem(1), buildItem(2)] }),
      isLoading: false,
      isError: false,
    });

    const html = renderPage();

    // The badge advertises the full backlog, so the list must disclose the
    // window instead of silently cutting at 100 rows.
    expect(html).toContain("250 ждут ответа");
    expect(html).toContain("1–100 of 250");
    expect(html).toContain("Next");
  });

  it("hides pagination when everything fits in one page", () => {
    queryMocks.useWorkboardV2.mockReturnValue({
      data: buildResponse({ total: 2, items: [buildItem(1), buildItem(2)] }),
      isLoading: false,
      isError: false,
    });

    const html = renderPage();

    expect(html).not.toContain("of 2");
    expect(html).not.toContain("Next");
  });
});
