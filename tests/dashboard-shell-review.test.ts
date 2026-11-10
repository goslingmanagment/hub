import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLoginRoute, cabinetRedirect, resolveLoginReturnPath, resolveRoleHome } from "../apps/dashboard/src/lib/navigation.ts";
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
// A chatter's home is Workboard's «Мои смены» (owner, 2026-11-10): a `next` into Workboard or to the account page is
// kept; any other, or none, is that home.
describe("the way back after the sign-in", () => {
  const home = (role: string, next: string | null) => resolveRoleHome(role, resolveLoginReturnPath(next));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes a chatter back to Workboard", () => {
    expect(home("chatter", "/workboard/my/shifts")).toBe("/workboard/my/shifts");
    expect(home("chatter", "/workboard/my/shifts?week=2026-11-02")).toBe("/workboard/my/shifts?week=2026-11-02");
    expect(home("chatter", "/workboard/")).toBe("/workboard/");
  });

  it("takes a chatter back to the account page, with what it carried", () => {
    expect(home("chatter", "/account")).toBe("/account");
    expect(home("chatter", "/account?tab=profile")).toBe("/account?tab=profile");
  });

  it("takes a chatter without a way back, or with one into the console, home to «Мои смены»", () => {
    expect(home("chatter", null)).toBe("/workboard/");
    expect(home("chatter", "")).toBe("/workboard/");
    expect(home("chatter", "/settings")).toBe("/workboard/");
    expect(home("chatter", "/workboards")).toBe("/workboard/");
    expect(home("chatter", "/accounts")).toBe("/workboard/");
    expect(home("chatter", "/account/../settings")).toBe("/workboard/");
  });

  it.each([
    "https://evil.example/workboard/my/shifts",
    "//evil.example/workboard/my/shifts",
    "/\\evil.example/workboard/my/shifts",
    "/workboard/../settings",
    "/workboard/%2e%2e/settings",
    "/workboard/my shifts",
    "https://evil.example/account",
  ])("refuses a chatter's off-host or malformed way back %s", (next) => {
    expect(home("chatter", next)).toBe("/workboard/");
  });

  it("leaves the owner and a team lead where they were going", () => {
    for (const role of ["owner", "team_lead"]) {
      expect(home(role, "/workboard/payouts?week=2026-11-02")).toBe("/workboard/payouts?week=2026-11-02");
      expect(home(role, "/settings")).toBe("/settings");
      expect(home(role, null)).toBe("/");
      expect(home(role, "https://evil.example/workboard/")).toBe("/");
    }
  });

  it("on the chatters' site, keeps the account page the home of every other role and Workboard a chatter's", () => {
    vi.stubGlobal("window", { location: { origin: CHATTER_SITE_ORIGIN } });
    expect(home("chatter", "/workboard/my/shifts")).toBe("/workboard/my/shifts");
    expect(home("chatter", null)).toBe("/workboard/");
    expect(home("owner", "/workboard/payouts")).toBe("/account");
    expect(home("team_lead", "/settings")).toBe("/account");
  });
});

// The cabinet keeps only the account; its old tabs of a chatter's shifts lead to «Мои смены» (AccountPage).
describe("the cabinet's old addresses", () => {
  const left = (search: string) => cabinetRedirect(new URLSearchParams(search));

  it("send the reports tab and the statistics to «Мои смены», with the window the app has", () => {
    expect(left("tab=report")).toBe("/workboard/my/shifts");
    expect(left("tab=report&days=30")).toBe("/workboard/my/shifts?days=30");
    expect(left("days=14")).toBe("/workboard/my/shifts?days=14");
    expect(left("days=7")).toBe("/workboard/my/shifts");
  });

  it("keep the account page itself", () => {
    expect(left("")).toBeNull();
    expect(left("tab=profile")).toBeNull();
    expect(left("tab=profile&days=30")).toBeNull();
  });
});
