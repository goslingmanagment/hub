import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

import { PresencePanel } from "../apps/dashboard/src/components/page/workboard/PresencePanel.tsx";

function renderPanel(props: Partial<Parameters<typeof PresencePanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      undefined,
      createElement(PresencePanel, {
        isOpen: true,
        onToggle: () => {},
        updatedAt: null,
        loading: false,
        unavailable: false,
        activeNow: [],
        activeNowTotal: 0,
        recentlyActive: [],
        recentlyActiveTotal: 0,
        ...props,
      }),
    ),
  );
}

describe("PresencePanel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders inferred Fansly activity only when open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

    const html = renderPanel({
      updatedAt: "2026-03-30T11:58:00.000Z",
      activeNowTotal: 2,
      activeNow: [{
        fanId: 301,
        fanLabel: "Active Now Fan",
        fanSubLabel: "@active_now_fan",
        profileHref: "/pages/lana/fans/fansly/presence-301",
        fanslyExternalUrl: "https://fansly.com/chat?user=presence-301",
        fanslyExternalKind: "chat",
        ltvMills: 240000,
        ltvLabel: "$2400.00",
        presenceLabel: "10m ago",
        isSubscriber: true,
        lastTransactionLabel: "1h ago",
      }],
      recentlyActiveTotal: 1,
      recentlyActive: [{
        fanId: 302,
        fanLabel: "Recently Active Fan",
        fanSubLabel: "@recently_active_fan",
        profileHref: "/pages/lana/fans/fansly/presence-302",
        fanslyExternalUrl: null,
        fanslyExternalKind: null,
        ltvMills: 150000,
        ltvLabel: "$1500.00",
        presenceLabel: "1h ago",
        isSubscriber: false,
        lastTransactionLabel: null,
      }],
    });

    expect(html).toContain("Inferred from Fansly follower activity.");
    expect(html).toContain("Best effort");
    expect(html).toContain("Updated 2m ago");
    expect(html).toContain("Active now (2)");
    expect(html).toContain("Recently active (1)");
    expect(html).toContain("Subscriber");
    expect(html).toContain("Active Now Fan");
    expect(html).toContain("Recently Active Fan");
    expect(html).toContain("Скрыть");
  });

  it("shows an unavailable state when open and the query fails", () => {
    const html = renderPanel({
      unavailable: true,
    });

    expect(html).toContain("Presence unavailable right now.");
  });
});
