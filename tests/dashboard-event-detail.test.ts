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
    expect(getEventRecommendation("after_ineffective").text).toContain("Источник проигнорировал нижнюю границу фильтра");
    expect(getEventRecommendation("after_ineffective").text).not.toContain("Готовой рекомендации нет");
    expect(getEventRecommendation("an_unknown_code").text).toContain("Готовой рекомендации нет");
  });
});
