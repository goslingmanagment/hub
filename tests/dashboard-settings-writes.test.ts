import { describe, expect, it } from "vitest";

import { featureSettingPatch } from "../apps/dashboard/src/pages/settings/ai/featureSettingPatch.ts";
import { moscowHourFromUtc, utcHourFromMoscow } from "../apps/dashboard/src/pages/settings/notifications/notificationsView.ts";

// «Функции ИИ» writes one feature into a JSON object that holds every feature:
// a wrong patch would quietly change or wipe the other features' settings.
describe("featureSettingPatch", () => {
  const snapshot = {
    key: "aiFeatureEfforts",
    version: 9,
    source: "override" as const,
    value: JSON.stringify({ "fast-reply": "medium", ping: "medium", "hi-greeting": "low" }),
  };

  it("changes only its own feature and keeps the version it was opened with", () => {
    const body = featureSettingPatch(snapshot, "effort", "ping", "high");
    expect(body?.patches).toHaveLength(1);
    expect(body?.patches[0]?.key).toBe("aiFeatureEfforts");
    expect(body?.patches[0]?.expectedVersion).toBe(9);
    expect(JSON.parse(String(body?.patches[0]?.value))).toEqual({ "fast-reply": "medium", ping: "high", "hi-greeting": "low" });
  });

  it("«По умолчанию» deletes only its own key", () => {
    const body = featureSettingPatch(snapshot, "effort", "ping", null);
    expect(JSON.parse(String(body?.patches[0]?.value))).toEqual({ "fast-reply": "medium", "hi-greeting": "low" });
  });

  it("writes nothing when the stored value does not parse", () => {
    expect(featureSettingPatch({ ...snapshot, value: "{not json" }, "effort", "ping", "high")).toBeNull();
    expect(featureSettingPatch({ ...snapshot, value: JSON.stringify({ ping: "loud" }) }, "effort", "ping", "high")).toBeNull();
  });
});

// The report's hour is picked by Moscow and stored in UTC.
describe("report hour", () => {
  it("09:00 by Moscow is 6 UTC, and every hour goes there and back", () => {
    expect(utcHourFromMoscow(9)).toBe(6);
    expect(utcHourFromMoscow(1)).toBe(22);
    for (let hour = 0; hour < 24; hour += 1) {
      expect(moscowHourFromUtc(utcHourFromMoscow(hour))).toBe(hour);
      expect(utcHourFromMoscow(hour)).toBe((hour + 21) % 24);
    }
  });
});
