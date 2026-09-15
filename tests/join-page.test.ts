import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

// Decision 349, PR-1C. The api layer is mocked (@tanstack/react-query does not
// resolve from the root test suite), so these render the real page against
// hook states the kernel can actually produce.

const mocks = vi.hoisted(() => ({
  useInspectAccountLink: vi.fn(),
  useRedeemAccountLink: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class extends Error {
    constructor(message: string, _category: string, readonly status: number) { super(message); }
  },
}));

import { JoinPage } from "../apps/dashboard/src/pages/account/JoinPage.tsx";
import { KernelApiError } from "../apps/dashboard/src/api/sdk.ts";
import {
  clientOffersForPlatforms,
  passwordProblem,
  readLinkToken,
  redeemFailureMessage,
} from "../apps/dashboard/src/pages/account/accountView.ts";

const SECRET = "7f3a9c1e5b2d4a6f8c0e2a4b6d8f0a1c";

function inspectState(overrides: Record<string, unknown> = {}) {
  return { data: undefined, isError: false, error: null, isPending: false, mutate: vi.fn(), reset: vi.fn(), ...overrides };
}
function redeemState(overrides: Record<string, unknown> = {}) {
  return { data: undefined, isError: false, error: null, isPending: false, isSuccess: false, mutate: vi.fn(), reset: vi.fn(), ...overrides };
}

function renderJoin(hash = `#${SECRET}`) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [`/join${hash}`] },
    createElement(JoinPage),
  ));
}

beforeEach(() => {
  mocks.useInspectAccountLink.mockReset().mockReturnValue(inspectState());
  mocks.useRedeemAccountLink.mockReset().mockReturnValue(redeemState());
});

describe("readLinkToken", () => {
  it("reads the secret out of the URL fragment", () => {
    expect(readLinkToken(`#${SECRET}`)).toBe(SECRET);
    expect(readLinkToken(SECRET)).toBe(SECRET);
  });

  it("decodes a percent-encoded fragment", () => {
    expect(readLinkToken("#a%2Bb")).toBe("a+b");
  });

  it("has nothing to inspect when the fragment is missing or blank", () => {
    expect(readLinkToken("")).toBeNull();
    expect(readLinkToken("#")).toBeNull();
    expect(readLinkToken("#   ")).toBeNull();
  });
});

describe("passwordProblem", () => {
  it("accepts a long, unremarkable password", () => {
    expect(passwordProblem("лодка-под-мостом-7", "лодка-под-мостом-7")).toBeNull();
  });

  it("refuses a password shorter than the shared floor", () => {
    expect(passwordProblem("короткий", "короткий")).toContain("12");
  });

  it("refuses a password from the shared blacklist before the round trip", () => {
    // 12 characters, so length alone would pass — it fails on the list.
    expect(passwordProblem("1q2w3e4r5t6y", "1q2w3e4r5t6y")).toContain("слишком простой");
  });

  it("refuses a mistyped confirmation", () => {
    expect(passwordProblem("лодка-под-мостом-7", "лодка-под-мостом-8")).toBe("Пароли не совпадают.");
  });
});

describe("clientOffersForPlatforms", () => {
  it("offers only the clients the person's own pages need", () => {
    expect(clientOffersForPlatforms(["fansly"]).map((offer) => offer.platform)).toEqual(["fansly"]);
    expect(clientOffersForPlatforms(["onlyfans"]).map((offer) => offer.platform)).toEqual(["onlyfans"]);
    expect(clientOffersForPlatforms([]).length).toBe(0);
  });

  it("keeps a stable order and does not repeat a platform", () => {
    expect(clientOffersForPlatforms(["onlyfans", "fansly", "fansly"]).map((offer) => offer.platform))
      .toEqual(["fansly", "onlyfans"]);
  });
});

describe("redeemFailureMessage", () => {
  it("reads a refused password as a password problem", () => {
    expect(redeemFailureMessage({ status: 400 })).toContain("пароль");
  });

  it("reads a spent or unknown link as the single ask-the-owner line", () => {
    expect(redeemFailureMessage({ status: 409 })).toBe("Ссылка недействительна. Попроси новую у владельца.");
    expect(redeemFailureMessage({ status: 404 })).toBe("Ссылка недействительна. Попроси новую у владельца.");
  });
});

describe("JoinPage", () => {
  it("greets the invited person by login and asks for the password twice", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    const html = renderJoin();
    expect(html).toContain("Привет, grisha! Придумай пароль для ChatGoose");
    expect(html).toContain("join-password");
    expect(html).toContain("join-password-again");
  });

  it("never puts the secret on the page", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    expect(renderJoin()).not.toContain(SECRET);
  });

  it("says one honest thing about a link that can no longer be used", () => {
    for (const state of ["used", "expired", "revoked"] as const) {
      mocks.useInspectAccountLink.mockReturnValue(inspectState({ data: { state } }));
      expect(renderJoin()).toContain("Ссылка недействительна. Попроси новую у владельца.");
    }
  });

  it("says the same thing for an unknown link and for a missing fragment", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      isError: true,
      error: new KernelApiError("not found", "not_found", 404),
    }));
    expect(renderJoin()).toContain("Ссылка недействительна. Попроси новую у владельца.");

    mocks.useInspectAccountLink.mockReturnValue(inspectState());
    expect(renderJoin("")).toContain("Ссылка недействительна. Попроси новую у владельца.");
  });

  it("tells a person resetting their password that the old sign-ins are over", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "password_reset", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    const html = renderJoin();
    expect(html).toContain("grisha, придумай новый пароль");
    expect(html).toContain("Все прежние входы завершены");
  });

  it("ends on the login and only the clients that person needs", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    mocks.useRedeemAccountLink.mockReturnValue(redeemState({ isSuccess: true, data: { username: "grisha" } }));
    const html = renderJoin();
    expect(html).toContain("Готово");
    expect(html).toContain("grisha");
    expect(html).toContain("Установить расширение для Fansly");
    expect(html).not.toContain("Скачать приложение для OnlyFans");
    expect(html).toContain("https://ext.gosling-agency.ru/start.html");
  });

  it("offers both clients to someone with pages on both platforms", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly", "onlyfans"] },
    }));
    mocks.useRedeemAccountLink.mockReturnValue(redeemState({ isSuccess: true, data: { username: "grisha" } }));
    const html = renderJoin();
    expect(html).toContain("https://ext.gosling-agency.ru/install.html");
    expect(html).toContain("https://ext.gosling-agency.ru/desktop/");
  });

  it("shows a password the kernel refused as a password problem, not a broken link", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    mocks.useRedeemAccountLink.mockReturnValue(redeemState({
      isError: true,
      error: new KernelApiError("weak", "validation", 400),
    }));
    const html = renderJoin();
    expect(html).toContain("Такой пароль не подходит");
    expect(html).not.toContain("Ссылка недействительна");
  });
});
