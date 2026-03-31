import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { WorkboardCard } from "../apps/dashboard/src/components/page/workboard/WorkboardCard.tsx";
import type { WorkboardCardVm } from "../apps/dashboard/src/pages/workboard/viewModel.ts";

type SubscriberCardVm = Extract<WorkboardCardVm, { kind: "subscriber" }>;

function renderCard(vm: WorkboardCardVm) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    undefined,
    createElement(WorkboardCard, {
      vm,
      pageLabel: "lana",
      isExpanded: false,
      onToggle: () => undefined,
      onSnooze: () => undefined,
      isSnoozePending: false,
    }),
  ));
}

function buildSubscriberVm(overrides: Partial<SubscriberCardVm> = {}): SubscriberCardVm {
  return {
    kind: "subscriber",
    fanId: 101,
    fanLabel: "Dejan/Serbia",
    fanSubLabel: "@nymanoreus69",
    platformConversationId: "797139409953628160",
    profileHref: "/pages/lana/fans/fansly/fan-101",
    fanslyExternalUrl: "https://fansly.com/messages/797139409953628160",
    fanslyExternalKind: "chat",
    ltvLabel: "$160.00",
    touchpointCode: "1d",
    touchpointLabel: "1d",
    overdueDays: 1,
    overdueSeverity: "normal",
    overdueLabel: "Overdue 1d",
    whyNowLabel: "1d subscriber follow-up",
    lastFanMessageLabel: "7h",
    lastModelMessageLabel: "3d",
    lastTransactionLabel: "40d",
    expiryLabel: "Mar 31",
    expiryRelativeLabel: "in 1d",
    autoRenew: false,
    tierName: "Master",
    tierShortName: "Master",
    canPreview: false,
    ...overrides,
  };
}

describe("WorkboardCard", () => {
  it("renders a Copy chat action when a Fansly chat URL is available", () => {
    const html = renderCard(buildSubscriberVm());

    expect(html).toContain("Copy chat");
    expect(html).toContain("Copy Fansly chat link");
  });

  it("falls back to a profile copy action when chat is unavailable", () => {
    const html = renderCard(buildSubscriberVm({
      platformConversationId: null,
      fanslyExternalUrl: "https://fansly.com/nymanoreus69",
      fanslyExternalKind: "profile",
    }));

    expect(html).toContain("Copy profile");
    expect(html).toContain("Copy Fansly profile link");
  });

  it("hides the Copy action when no Fansly external URL is available", () => {
    const html = renderCard(buildSubscriberVm({
      platformConversationId: null,
      fanslyExternalUrl: null,
      fanslyExternalKind: null,
    }));

    expect(html).not.toContain("Copy Fansly chat link");
    expect(html).not.toContain("Copy Fansly profile link");
    expect(html).not.toContain("Copy chat");
    expect(html).not.toContain("Copy profile");
  });

  it("shows visible ranking cues directly on the card", () => {
    const html = renderCard(buildSubscriberVm());

    expect(html).toContain("Overdue 1d");
    expect(html).toContain("1d subscriber follow-up");
  });
});
