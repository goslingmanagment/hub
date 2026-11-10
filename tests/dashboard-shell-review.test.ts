import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLoginRoute, resolveLoginReturnPath, resolveRoleHome } from "../apps/dashboard/src/lib/navigation.ts";
import { CHATTER_SITE_ORIGIN } from "../packages/ui/src/sites.ts";

describe("login recovery", () => {
  it("preserves a scoped destination across expired-session login", () => {
    const destination = "/settings?tab=configuration&feature=voice#config-voiceNotesEnabled";
    const login = new URL(buildLoginRoute(destination), "https://hub.invalid");
    expect(login.pathname).toBe("/login");
    expect(resolveLoginReturnPath(login.searchParams.get("next"))).toBe(destination);
  });
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/login"])("refuses an unsafe or recursive destination %s", (target) => {
    expect(resolveLoginReturnPath(target)).toBe("/");
  });
});

// Where the sign-in sends a person back to (LoginPage: `resolveRoleHome(role, resolveLoginReturnPath(next))`).
// A chatter has a part of Workboard of their own (owner, 2026-11-10): a `next` into it is kept; any other is the cabinet.
describe("the way back after the sign-in", () => {
  const home = (role: string, next: string | null) => resolveRoleHome(role, resolveLoginReturnPath(next));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes a chatter back to Workboard", () => {
    expect(home("chatter", "/workboard/my/reports")).toBe("/workboard/my/reports");
    expect(home("chatter", "/workboard/my/reports?days=30")).toBe("/workboard/my/reports?days=30");
    expect(home("chatter", "/workboard/")).toBe("/workboard/");
  });

  it("takes a chatter without a way back, or with one into the console, to the cabinet", () => {
    expect(home("chatter", null)).toBe("/account");
    expect(home("chatter", "")).toBe("/account");
    expect(home("chatter", "/settings")).toBe("/account");
    expect(home("chatter", "/workboards")).toBe("/account");
  });

  it.each([
    "https://evil.example/workboard/my/reports",
    "//evil.example/workboard/my/reports",
    "/\\evil.example/workboard/my/reports",
    "/workboard/../settings",
    "/workboard/%2e%2e/settings",
    "/workboard/my reports",
  ])("refuses a chatter's off-host or malformed way back %s", (next) => {
    expect(home("chatter", next)).toBe("/account");
  });

  it("leaves the owner and a team lead where they were going", () => {
    for (const role of ["owner", "team_lead"]) {
      expect(home(role, "/workboard/payouts?week=2026-11-02")).toBe("/workboard/payouts?week=2026-11-02");
      expect(home(role, "/settings")).toBe("/settings");
      expect(home(role, null)).toBe("/");
      expect(home(role, "https://evil.example/workboard/")).toBe("/");
    }
  });

  it("on the chatters' site, keeps the cabinet the home of every other role and Workboard a chatter's", () => {
    vi.stubGlobal("window", { location: { origin: CHATTER_SITE_ORIGIN } });
    expect(home("chatter", "/workboard/my/reports")).toBe("/workboard/my/reports");
    expect(home("chatter", null)).toBe("/account");
    expect(home("owner", "/workboard/payouts")).toBe("/account");
    expect(home("team_lead", "/settings")).toBe("/account");
  });
});
