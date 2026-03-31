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
    isSoftTouchpoint: false,
    overdueDays: 1,
    overdueSeverity: "normal",
    lastFanMessageLabel: "7h",
    lastFanMessageDaysAgo: 0,
    lastModelMessageLabel: "3d",
    lastModelMessageDaysAgo: 3,
    lastTransactionLabel: "40d",
    lastTransactionDaysAgo: 40,
    expiryLabel: "Mar 31",
    expiryRelativeLabel: "in 1d",
    autoRenew: false,
    tierName: "Master",
    tierShortName: "Master",
    subscribedMonths: 1,
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
});
