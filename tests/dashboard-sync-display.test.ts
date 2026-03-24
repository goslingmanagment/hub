import { describe, expect, it } from "vitest";

import { getSyncUxDisplayMode } from "../apps/dashboard/src/components/shared/syncUxDisplay.ts";

function buildSyncUx(
  overrides: Partial<{
    state: "healthy" | "syncing" | "catching_up" | "retrying" | "attention" | "setup" | "off";
    requiresAction: boolean;
  }> = {},
) {
  return {
    state: "healthy" as const,
    label: "Up to date",
    headline: "Up to date",
    detail: "All syncs are current.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-03-24T11:55:00.000Z",
    requiresAction: false,
    ...overrides,
  };
}

describe("dashboard sync display policy", () => {
  it("keeps healthy topbar and overview row states minimal", () => {
    const summary = buildSyncUx();

    expect(getSyncUxDisplayMode(summary, "topbar")).toBe("badge");
    expect(getSyncUxDisplayMode(summary, "overview_row")).toBe("badge");
    expect(getSyncUxDisplayMode(summary, "overview_banner")).toBe("hidden");
  });

  it("keeps healthy focused page state compact", () => {
    expect(getSyncUxDisplayMode(buildSyncUx(), "page_detail")).toBe("compact");
  });

  it("keeps credentials and sync settings compact until action is required", () => {
    expect(getSyncUxDisplayMode(buildSyncUx(), "credentials")).toBe("badge");
    expect(getSyncUxDisplayMode(buildSyncUx(), "sync_settings")).toBe("compact");
    expect(getSyncUxDisplayMode(buildSyncUx({
      state: "attention",
      requiresAction: true,
    }), "credentials")).toBe("full");
  });

  it("suppresses healthy CRM header chrome when coverage is complete", () => {
    expect(getSyncUxDisplayMode(buildSyncUx(), "crm_header", {
      hasIncompleteData: false,
    })).toBe("hidden");
    expect(getSyncUxDisplayMode(buildSyncUx({
      state: "retrying",
    }), "crm_header", {
      hasIncompleteData: true,
    })).toBe("compact");
  });
});
