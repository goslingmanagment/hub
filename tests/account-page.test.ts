import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatUsdFromMicroUsd } from "../packages/shared/src/money.ts";

// Decision 349, PR-1C. The cabinet renders against mocked api hooks; the money
// assertions go through the shared micro-USD constructor, never hand arithmetic.

const mocks = vi.hoisted(() => ({
  useAuthMe: vi.fn(),
  useMyDevices: vi.fn(),
  useRevokeMyDevice: vi.fn(),
  useRevokeMyDevices: vi.fn(),
  useChangeMyPassword: vi.fn(),
  useMyUsage: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class extends Error {
    constructor(message: string, _category: string, readonly status: number) { super(message); }
  },
}));

import { AccountPage } from "../apps/dashboard/src/pages/account/AccountPage.tsx";
import { KernelApiError } from "../apps/dashboard/src/api/sdk.ts";
import {
  groupPagesByPlatform,
  lastSeenLabel,
  roleLabel,
  usageWindow,
} from "../apps/dashboard/src/pages/account/accountView.ts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "../packages/shared/src/time.ts";

const TODAY = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);

function mutationState(overrides: Record<string, unknown> = {}) {
  return { isPending: false, isError: false, isSuccess: false, error: null, mutate: vi.fn(), reset: vi.fn(), ...overrides };
}

function usageResponse(overrides: Record<string, unknown> = {}) {
  return {
    range: { from: TODAY, to: TODAY, timeZone: MOSCOW_TIME_ZONE },
    row: {
      username: "grisha",
      totalGenerations: 412,
      tokenCounts: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cacheTotal: 0 },
      cost: { microUsd: 4_120_000, approximate: false },
      gateway: {
        requestCount: 412, completedCount: 410, failedCount: 2, cancelledCount: 0,
        quotaDeniedCount: 0, openReservationCount: 0, providerBreakdown: [],
      },
      topFeature: { feature: "fast-reply", requestCount: 300, sharePct: 72.8 },
      featureBreakdown: [
        {
          feature: "help-me", requestCount: 112, sharePct: 27.2,
          tokenCounts: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cacheTotal: 0 },
          costMicroUsd: 1_120_000, costApproximate: false, regenerateRatePct: 0,
        },
        {
          feature: "fast-reply", requestCount: 300, sharePct: 72.8,
          tokenCounts: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cacheTotal: 0 },
          costMicroUsd: 3_000_000, costApproximate: false, regenerateRatePct: 0,
        },
      ],
      regenerateRatePct: 1.5,
      warning: false,
    },
    daily: [{ date: TODAY, requestCount: 17, costMicroUsd: 230_000 }],
    ...overrides,
  };
}

function render() {
  return renderToStaticMarkup(createElement(AccountPage));
}

beforeEach(() => {
  mocks.useAuthMe.mockReset().mockReturnValue({
    data: {
      authMethod: "session",
      user: {
        id: 17,
        username: "grisha",
        role: "chatter",
        mustChangePassword: false,
        assignedPages: [
          { id: 1, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana" },
          { id: 2, label: "lora-of", platform: "onlyfans", modelSlug: "lora", modelName: "Lora" },
          { id: 3, label: "kira", platform: "fansly", modelSlug: "kira", modelName: "Kira" },
        ],
      },
    },
    isLoading: false,
    isError: false,
  });
  mocks.useMyDevices.mockReset().mockReturnValue({
    data: [{
      id: 5,
      label: "chatgoose-extension firefox",
      keyPrefix: "agency_hub_pending_device_XyZ",
      lastClientVersion: "2.3.0",
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: "2026-09-01T00:00:00.000Z",
    }],
    isLoading: false,
    isError: false,
  });
  mocks.useRevokeMyDevice.mockReset().mockReturnValue(mutationState());
  mocks.useRevokeMyDevices.mockReset().mockReturnValue(mutationState());
  mocks.useChangeMyPassword.mockReset().mockReturnValue(mutationState());
  mocks.useMyUsage.mockReset().mockReturnValue({ data: usageResponse(), isLoading: false, isError: false });
});

describe("groupPagesByPlatform", () => {
  it("groups without comparing platforms one by one", () => {
    const groups = groupPagesByPlatform([
      { platform: "fansly" as const, label: "lana" },
      { platform: "onlyfans" as const, label: "lora-of" },
      { platform: "fansly" as const, label: "kira" },
    ]);
    expect(groups.map((group) => group.platform)).toEqual(["fansly", "onlyfans"]);
    expect(groups[0]!.pages.map((page) => page.label)).toEqual(["lana", "kira"]);
    expect(groups[1]!.label).toBe("OnlyFans");
  });
});

describe("roleLabel", () => {
  it("names every role in Russian", () => {
    expect(roleLabel("chatter")).toBe("чаттер");
    expect(roleLabel("team_lead")).toBe("старший");
    expect(roleLabel("owner")).toBe("владелец");
  });
});

describe("lastSeenLabel", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  it("speaks about sign-ins, never about expiry", () => {
    expect(lastSeenLabel("2026-09-15T11:58:00.000Z", now)).toBe("вход только что");
    expect(lastSeenLabel("2026-09-15T09:00:00.000Z", now)).toBe("вход 3 ч назад");
    expect(lastSeenLabel("2026-09-12T12:00:00.000Z", now)).toBe("вход 3 дн назад");
    expect(lastSeenLabel(null, now)).toBe("ещё не входили");
  });
});

describe("usageWindow", () => {
  it("is 30 business days ending today, inclusive", () => {
    expect(usageWindow("2026-09-15")).toEqual({ from: "2026-08-17", to: "2026-09-15" });
  });
});

describe("formatUsdFromMicroUsd", () => {
  it("reads micro-USD without hand arithmetic at the call site", () => {
    expect(formatUsdFromMicroUsd(4_120_000)).toBe("$4.12");
    expect(formatUsdFromMicroUsd(0)).toBe("$0");
    expect(formatUsdFromMicroUsd(2_500)).toBe("< $0.01");
    expect(formatUsdFromMicroUsd(1_500_000, { approximate: true })).toBe("~$1.50");
  });
});

describe("AccountPage", () => {
  it("answers who I am, in Russian, with my pages grouped by platform", () => {
    const html = render();
    expect(html).toContain("Кто я");
    expect(html).toContain("grisha");
    expect(html).toContain("чаттер");
    expect(html).toContain("Fansly");
    expect(html).toContain("OnlyFans");
    expect(html).toContain("lora-of");
  });

  it("shows a device by its label, client version and last sign-in only", () => {
    const html = render();
    expect(html).toContain("chatgoose-extension firefox");
    expect(html).toContain("версия 2.3.0");
    expect(html).toContain("вход 3 дн назад");
    expect(html).toContain("Выйти с этого устройства");
    expect(html).toContain("Выйти на всех устройствах");
    // §2: the machinery behind a sign-in never reaches the screen.
    expect(html).not.toContain("agency_hub_pending_device_XyZ");
    expect(html).not.toContain("2026-12-01");
  });

  it("explains an empty device list instead of showing nothing", () => {
    mocks.useMyDevices.mockReturnValue({ data: [], isLoading: false, isError: false });
    expect(render()).toContain("Пока ни одного устройства");
  });

  it("asks for the current password before changing it", () => {
    const html = render();
    expect(html).toContain("Текущий пароль");
    expect(html).toContain("Новый пароль");
    expect(html).toContain("Повтори новый пароль");
  });

  it("says a mistyped current password was wrong instead of dropping the form", () => {
    mocks.useChangeMyPassword.mockReturnValue(mutationState({
      isError: true,
      error: new KernelApiError("invalid", "auth", 401),
    }));
    expect(render()).toContain("Текущий пароль не подошёл.");
  });

  it("after a password change, says every previous sign-in is over", () => {
    mocks.useChangeMyPassword.mockReturnValue(mutationState({ isSuccess: true }));
    const html = render();
    expect(html).toContain("Все прежние входы завершены");
    expect(html).toContain("Войти заново");
  });

  it("reports my own spend today and over the window, and by feature", () => {
    const html = render();
    expect(html).toContain("Мои AI-траты");
    expect(html).toContain("Сегодня");
    expect(html).toContain("30 дней");
    expect(html).toContain("$4.12");
    expect(html).toContain("412 запросов");
    expect(html).toContain("17 запросов");
    expect(html).toContain("$0.23");
    // Feature rows, most expensive first, in words a chatter uses.
    expect(html.indexOf("Быстрый ответ")).toBeLessThan(html.indexOf("Подсказка"));
    expect(html).toContain("$3.00");
  });

  it("asks for the last 30 business days ending today", () => {
    render();
    expect(mocks.useMyUsage).toHaveBeenCalledWith(usageWindow(TODAY));
  });

  it("says so when the spend report fails rather than showing a zero", () => {
    mocks.useMyUsage.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const html = render();
    expect(html).toContain("Не удалось посчитать траты");
    expect(html).not.toContain("$0");
  });
});
