import { describe, expect, it } from "vitest";

import {
  getEventDisplaySeverity,
  getEventRecommendation,
} from "../apps/dashboard/src/components/shared/EventDetailPanel.tsx";

describe("event detail display", () => {
  it("downgrades legacy after_ineffective errors with early stop evidence to warning", () => {
    expect(getEventDisplaySeverity({
      eventCode: "after_ineffective",
      severity: "error",
      details: {
        earlyStoppedBeyondBoundary: true,
      },
    })).toBe("warn");
  });

  it("shows a targeted recommendation for after_ineffective anomalies", () => {
    expect(getEventRecommendation("after_ineffective").text).toContain("provider ignored the lower-bound filter");
    expect(getEventRecommendation("after_ineffective").text).not.toContain("No automated recommendation");
  });
});
