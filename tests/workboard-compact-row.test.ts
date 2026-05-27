import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { WorkboardCompactRow } from "../apps/dashboard/src/components/page/workboard/WorkboardCompactRow.tsx";
import type { WorkboardCardVm } from "../apps/dashboard/src/pages/workboard/viewModel.ts";

type SubscriberCardVm = Extract<WorkboardCardVm, { kind: "subscriber" }>;

function renderCompactRow(vm: WorkboardCardVm) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    undefined,
    createElement(
      "table",
      undefined,
      createElement(
        "tbody",
        undefined,
        createElement(WorkboardCompactRow, {
          vm,
          showTierColumn: vm.kind === "subscriber",
          onContacted: () => undefined,
          onSnooze: () => undefined,
          isSnoozePending: false,
        }),
      ),
    ),
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
    ltvMills: 160000000,
    ltvLabel: "$160.00",
    touchpointCode: "1d",
    touchpointLabel: "1d",
    overdueDays: 1,
    overdueSeverity: "normal",
    overdueLabel: "Просрочено 1д",
    whyNowLabel: "Подписка истекает через 1d — напишите",
    lastFanMessageLabel: "7h",
    lastModelMessageLabel: "3d",
    lastTransactionLabel: "40d",
    expiryLabel: "Mar 31",
    expiryRelativeLabel: "через 1д",
    autoRenew: false,
    autoRenewOffDetectedLabel: "Mar 20, 2026",
    tierName: "Master",
    tierShortName: "Master",
    canPreview: false,
    ...overrides,
  };
}

describe("WorkboardCompactRow", () => {
  it("renders a chat copy action when a Fansly chat URL is available", () => {
    const html = renderCompactRow(buildSubscriberVm());

    expect(html).toContain("Чат");
    expect(html).toContain("Скопировать ссылку на чат Fansly");
  });

  it("falls back to a profile copy action when chat is unavailable", () => {
    const html = renderCompactRow(buildSubscriberVm({
      platformConversationId: null,
      fanslyExternalUrl: "https://fansly.com/nymanoreus69",
      fanslyExternalKind: "profile",
    }));

    expect(html).toContain("Скопировать ссылку на профиль Fansly");
  });

  it("hides the copy action when no Fansly external URL is available", () => {
    const html = renderCompactRow(buildSubscriberVm({
      platformConversationId: null,
      fanslyExternalUrl: null,
      fanslyExternalKind: null,
    }));

    expect(html).not.toContain("Скопировать ссылку на чат Fansly");
    expect(html).not.toContain("Скопировать ссылку на профиль Fansly");
    expect(html).not.toContain("Чат");
  });
});
