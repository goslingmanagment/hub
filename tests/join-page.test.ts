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
import {
  readLinkToken,
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
});

describe("JoinPage", () => {
  it("never puts the secret on the page", () => {
    mocks.useInspectAccountLink.mockReturnValue(inspectState({
      data: { state: "active", kind: "invite", username: "grisha", expiresAt: "2026-09-22T00:00:00.000Z", platforms: ["fansly"] },
    }));
    expect(renderJoin()).not.toContain(SECRET);
  });
});
