import { describe, expect, it } from "vitest";
import { buildLoginRoute, resolveLoginReturnPath } from "../apps/dashboard/src/lib/navigation.ts";

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
