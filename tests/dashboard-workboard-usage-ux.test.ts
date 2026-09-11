import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queries = vi.hoisted(() => ({
  useAdminChatterUsage: vi.fn(),
  useWorkboardV2: vi.fn(),
  useWorkboardV2Lists: vi.fn(),
  useWorkboardV2Contact: vi.fn(),
  useWorkboardV2Recompute: vi.fn(),
  useWorkboardV2Snooze: vi.fn(),
  useWorkboardV2Unsnooze: vi.fn(),
  useWorkboardV2UndoContact: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/src/components/page/workboard/v2/WorkboardV2Row.tsx", () => ({
  WorkboardV2Row: ({ item }: { item: { fanId: number } }) => createElement("div", { "data-fan-id": item.fanId }, `Fan ${item.fanId}`),
}));

import { UsagePage } from "../apps/dashboard/src/pages/UsagePage.tsx";
import { WorkboardV2Page, resolveWorkboardShortcut } from "../apps/dashboard/src/pages/WorkboardV2Page.tsx";

const usage = {
  range: { from: "2026-09-11", to: "2026-09-11", timeZone: "Europe/Moscow" },
  rows: [{
    userId: 7,
    username: "anton",
    totalGenerations: 2,
    tokenCounts: { input: 20, output: 10, cacheWrite: 0, cacheRead: 0, cacheTotal: 0 },
    cost: { microUsd: 1_000_000, approximate: false },
    gateway: { requestCount: 0, completedCount: 0, failedCount: 0, cancelledCount: 0, quotaDeniedCount: 0, openReservationCount: 0, providerBreakdown: [] },
    topFeature: null,
    featureBreakdown: [],
    regenerateRatePct: 0,
    warning: false,
  }],
};

const board = {
  counts: [{ tab: "subscribers", secondaryStatus: "need_reply", count: 1 }],
  items: [{ fanId: 7, secondaryStatus: "need_reply" }],
  total: 1,
  limit: 100,
  offset: 0,
};

function renderWorkboard() {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/pages/lora/workboard"] },
    createElement(Routes, null, createElement(Route, {
      path: "/pages/:pageLabel/workboard",
      element: createElement(WorkboardV2Page),
    })),
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.useAdminChatterUsage.mockReturnValue({ data: usage, isLoading: false, isError: false, refetch: vi.fn() });
  queries.useWorkboardV2.mockReturnValue({ data: board, isLoading: false, isError: false, refetch: vi.fn() });
  queries.useWorkboardV2Lists.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });
  for (const mutation of [queries.useWorkboardV2Contact, queries.useWorkboardV2Recompute,
    queries.useWorkboardV2Snooze, queries.useWorkboardV2Unsnooze, queries.useWorkboardV2UndoContact]) {
    mutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  }
});

describe("Workboard keyboard safety", () => {
  const plainEvent = {
    key: "s", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false,
  };

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey", "repeat", "isComposing", "defaultPrevented"] as const)(
    "does not turn %s + s into a snooze mutation", (flag) => {
      expect(resolveWorkboardShortcut({ ...plainEvent, [flag]: true }, false)).toBeNull();
    },
  );

  it.each(["s", "e", "Enter", "ArrowUp", "ArrowDown", "j", "k"])(
    "leaves %s to the focused interactive control", (key) => {
      expect(resolveWorkboardShortcut({ ...plainEvent, key }, true)).toBeNull();
    },
  );

  it("keeps unmodified board triage available outside interactive controls", () => {
    expect(resolveWorkboardShortcut(plainEvent, false)).toBe("snooze");
    expect(resolveWorkboardShortcut({ ...plainEvent, key: "e" }, false)).toBe("handled");
    expect(resolveWorkboardShortcut({ ...plainEvent, key: "Enter" }, false)).toBe("details");
    expect(resolveWorkboardShortcut({ ...plainEvent, key: "j" }, false)).toBe("next");
    expect(resolveWorkboardShortcut({ ...plainEvent, key: "ArrowUp" }, false)).toBe("previous");
    expect(resolveWorkboardShortcut({ ...plainEvent, key: "Escape" }, false)).toBeNull();
  });
});

describe("Workboard and Usage query recovery", () => {
  it.each([{ isLoading: true, isError: false }, { isLoading: false, isError: true }])(
    "keeps Usage period controls through initial query state %o", (state) => {
      queries.useAdminChatterUsage.mockReturnValue({ ...state, data: undefined, refetch: vi.fn() });
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsagePage)));
      expect(html).toContain(">Использование ИИ<");
      expect(html).toContain(">День<");
      expect(html).toContain(">Неделя<");
      expect(html).toContain(">Месяц<");
      expect(html).not.toContain("No activity");
      if (state.isError) expect(html).toContain("Повторить");
    },
  );

  it("keeps cached Usage rows visible and marks failed refresh", () => {
    queries.useAdminChatterUsage.mockReturnValue({ data: usage, isLoading: false, isError: true, refetch: vi.fn() });
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsagePage)));
    expect(html).toContain("anton");
    expect(html).toContain("$1.00");
    expect(html).toContain("ранее полученные данные");
    expect(html).toContain("Повторить");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("overflow-x-auto");
  });

  it("does not report an empty queue or zero counters before Workboard loads", () => {
    queries.useWorkboardV2.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    const html = renderWorkboard();
    expect(html).toContain("Не удалось загрузить Workboard");
    expect(html).toContain("Повторить");
    expect(html).toContain(">—<");
    expect(html).not.toContain("На сегодня всё");
    expect(html).not.toContain(">0<");
  });

  it("keeps cached Workboard rows while exposing failed refresh", () => {
    queries.useWorkboardV2.mockReturnValue({ data: board, isLoading: false, isError: true, refetch: vi.fn() });
    const html = renderWorkboard();
    expect(html).toContain("Fan 7");
    expect(html).toContain("ранее полученные данные");
    expect(html).toContain('aria-pressed="true"');
  });
});
