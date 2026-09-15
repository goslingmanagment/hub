import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

// Decision 351, PR-1C. The api layer is mocked (@tanstack/react-query does not
// resolve from the root test suite), so these render the real page against
// hook states the kernel can actually produce.

const mocks = vi.hoisted(() => ({
  useInspectAccountLink: vi.fn(),
  useRedeemAccountLink: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class extends Error {
    constructor(
      message: string,
      _category: string,
      readonly status: number,
      _code: string | null = null,
      readonly body: unknown = null,
    ) { super(message); }
  },
}));

import { JoinPage } from "../apps/dashboard/src/pages/account/JoinPage.tsx";
import { KernelApiError } from "../apps/dashboard/src/api/sdk.ts";
import {
  clientOffersForPlatforms,
  passwordProblem,
  readErrorReason,
  readLinkToken,
  redeemFailureMessage,
} from "../apps/dashboard/src/pages/account/accountView.ts";
import { buildLoginRoute, resolveLoginReturnPath } from "../apps/dashboard/src/lib/navigation.ts";

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

describe("the invitation secret never reaches a query string", () => {
  // /join keeps its one-time secret in the URL fragment because a fragment is
  // not sent to the server. `next` is a query parameter — it lands in the hub's
  // request log and the host's access log — so the fragment is dropped before
  // any login route is built, centrally, where no caller can forget.
  it("drops the fragment from a login return path", () => {
    expect(resolveLoginReturnPath(`/join#${SECRET}`)).toBe("/join");
    const route = buildLoginRoute(`/join#${SECRET}`);
    expect(route).not.toContain(SECRET);
    expect(route).not.toContain("#");
    expect(route).not.toContain("%23");
  });

  it("keeps the path and the query of the join route, and sheds only the fragment", () => {
    expect(resolveLoginReturnPath(`/join?x=1#${SECRET}`)).toBe("/join?x=1");
    expect(resolveLoginReturnPath(`/JOIN#${SECRET}`)).toBe("/JOIN");
    expect(resolveLoginReturnPath(`/join/#${SECRET}`)).toBe("/join/");
  });

  it("leaves ordinary anchors alone — only the join route carries a secret there", () => {
    const anchored = "/settings?tab=configuration&feature=voice#config-voiceNotesEnabled";
    expect(resolveLoginReturnPath(anchored)).toBe(anchored);
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

describe("readErrorReason", () => {
  it("finds the machine reason in an error body and nothing else", () => {
    expect(readErrorReason({ error: "bad_request", reason: "common" })).toBe("common");
    expect(readErrorReason({ error: "bad_request" })).toBeNull();
    expect(readErrorReason({ reason: 7 })).toBeNull();
    expect(readErrorReason(null)).toBeNull();
    expect(readErrorReason("common")).toBeNull();
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

  it("names the rule when the kernel says which one was broken", () => {
    // Over HTTP only `common` arrives: the route schema rejects the length
    // cases first, as a plain validation 400 with no reason.
    expect(redeemFailureMessage({ status: 400, reason: "common" }))
      .toBe("Такой пароль слишком простой — его легко угадать. Придумай другой.");
    // And it is the same sentence the local check gives, so one rule never
    // shows a person two different wordings.
    expect(passwordProblem("1q2w3e4r5t6y", "1q2w3e4r5t6y"))
      .toBe(redeemFailureMessage({ status: 400, reason: "common" }));
  });

  it("keeps the general phrase for a 400 that names nothing", () => {
    expect(redeemFailureMessage({ status: 400, reason: null }))
      .toContain("слишком простой или слишком короткий");
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
      error: new KernelApiError("not found", "not_found", 404, "not_found", null),
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
      error: new KernelApiError("weak", "validation", 400, "bad_request", null),
    }));
    const html = renderJoin();
    expect(html).toContain("Такой пароль не подходит");
    expect(html).not.toContain("Ссылка недействительна");
  });

  it("says a common password is common, in the kernel's own words", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    mocks.useRedeemAccountLink.mockReturnValue(redeemState({
      isError: true,
      error: new KernelApiError("too common", "validation", 400, "bad_request", {
        error: "bad_request",
        message: "This password is too common; choose a less predictable one",
        statusCode: 400,
        reason: "common",
      }),
    }));
    const html = renderJoin();
    expect(html).toContain("слишком простой");
    expect(html).not.toContain("слишком короткий");
  });
});
