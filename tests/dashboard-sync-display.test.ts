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
  it("hides healthy sync outside the sync workspace", () => {
    const summary = buildSyncUx();

    expect(getSyncUxDisplayMode(summary, "overview_row")).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "page_detail")).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "credentials")).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "crm_header", {
      hasIncompleteData: false,
    })).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "sync_settings")).toBe("home");
  });

  it("hides transient sync outside the sync workspace", () => {
    const summary = buildSyncUx({ state: "retrying" });

    expect(getSyncUxDisplayMode(summary, "overview_row")).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "page_detail")).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "credentials")).toBe("hidden");
    expect(getSyncUxDisplayMode(summary, "sync_settings")).toBe("home");
  });

  it("shows compact exceptions on product surfaces when action is required", () => {
    const summary = buildSyncUx({
      state: "attention",
      requiresAction: true,
    });

    expect(getSyncUxDisplayMode(summary, "overview_row")).toBe("exception");
    expect(getSyncUxDisplayMode(summary, "page_detail")).toBe("exception");
    expect(getSyncUxDisplayMode(summary, "credentials")).toBe("exception");
  });

  it("shows CRM explanations only for incomplete data or blocking states", () => {
    expect(getSyncUxDisplayMode(buildSyncUx({
      state: "retrying",
    }), "crm_header", {
      hasIncompleteData: false,
    })).toBe("hidden");
    expect(getSyncUxDisplayMode(buildSyncUx({
      state: "retrying",
    }), "crm_header", {
      hasIncompleteData: true,
    })).toBe("exception");
    expect(getSyncUxDisplayMode(buildSyncUx({
      state: "off",
    }), "crm_header", {
      hasIncompleteData: false,
    })).toBe("exception");
  });
});
