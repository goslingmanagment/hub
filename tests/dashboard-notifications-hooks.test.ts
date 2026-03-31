import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard notifications hooks", () => {
  it("suppresses global error handling for notification settings updates", () => {
    const source = readFileSync(
      new URL("../apps/dashboard/src/api/adminNotifications.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("export function useUpdateNotificationsSettings()");
    expect(source).toContain("meta: { suppressGlobalError: true }");
  });
});
