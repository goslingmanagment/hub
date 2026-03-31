import { describe, expect, it } from "vitest";

import {
  buildFanProfileNavigation,
  buildFanProfileRoute,
  buildPageRoute,
  buildPageSectionRoute,
  buildWorkboardRoute,
  resolveLegacyWorkboardRedirect,
  buildSettingsRoute,
  resolveSettingsTab,
  resolveFanProfileBackTarget,
} from "../apps/dashboard/src/lib/navigation.ts";

describe("fan profile navigation", () => {
  it("builds fan profile destinations with remembered source state", () => {
    const navigation = buildFanProfileNavigation(
      "lana",
      "fansly",
      "fan-001",
      buildPageSectionRoute("lana", "subscribers"),
    );

    expect(navigation).toEqual({
      to: buildFanProfileRoute("lana", "fansly", "fan-001"),
      state: {
        backTo: "/pages/lana/subscribers",
      },
    });
  });

  it("falls back to the page route when there is no remembered source", () => {
    expect(resolveFanProfileBackTarget(undefined, "lana")).toBe(buildPageRoute("lana"));
    expect(resolveFanProfileBackTarget({}, "lana")).toBe(buildPageRoute("lana"));
  });

  it("ignores unsafe remembered targets and preserves safe in-app ones", () => {
    expect(resolveFanProfileBackTarget({
      backTo: "/pages/lana/top-supporters",
    }, "lana")).toBe("/pages/lana/top-supporters");
    expect(resolveFanProfileBackTarget({
      backTo: "//evil.invalid",
    }, "lana")).toBe(buildPageRoute("lana"));
  });

  it("builds stable settings deep links and defaults unknown tabs safely", () => {
    expect(buildSettingsRoute("sync")).toBe("/settings?tab=sync");
    expect(resolveSettingsTab("users")).toBe("users");
    expect(resolveSettingsTab("missing")).toBe("credentials");
    expect(resolveSettingsTab(null)).toBe("credentials");
  });

  it("builds canonical workboard routes and preserves the legacy CRM redirect target", () => {
    expect(buildWorkboardRoute("lana")).toBe("/pages/lana/workboard");
    expect(resolveLegacyWorkboardRedirect("lana")).toBe("/pages/lana/workboard");
    expect(resolveLegacyWorkboardRedirect(undefined)).toBe("/");
  });
});
