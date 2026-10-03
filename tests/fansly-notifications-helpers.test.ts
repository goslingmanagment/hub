// WP-F2 — the notification walk's pure rules (`sync/fansly/lib/notifications-rules.ts`),
// which the engine's notifications resource reads. No database.

import { describe, expect, it } from "vitest";

import { FANSLY_NOTIFICATION_DECLARED_TYPE_CSV } from "@agency_hub_core/shared";

import {
  classifyNotificationResponse,
  compareNotificationRefs,
  typesForFilterMode,
} from "../apps/runtime/src/sync/fansly/lib/notifications-rules.ts";
import { envelope, ref, row } from "./helpers/fansly-notifications-fixtures.ts";

describe("WP-F2 walk helpers", () => {
  it("refuses a non-empty page with no usable id, and tolerates one odd row", () => {
    expect(classifyNotificationResponse(envelope([]))).toBe("empty");
    expect(classifyNotificationResponse({ notifications: [null] })).toBe("invalid");
    expect(classifyNotificationResponse({ notifications: [{}] })).toBe("invalid");
    expect(classifyNotificationResponse({ notifications: [{ id: 7 }] })).toBe("invalid");
    expect(classifyNotificationResponse({})).toBe("invalid");
    // Per-row tolerance stays: one good id makes the page walkable.
    expect(classifyNotificationResponse({ notifications: [row(1), null, {}] })).toBe("nonempty");
    expect(classifyNotificationResponse({ notifications: [{ idString: ref(1) }] }))
      .toBe("nonempty");
  });

  it("orders snowflake refs by length first, then lexicographically", () => {
    expect(compareNotificationRefs("100", "99")).toBeGreaterThan(0);
    expect(compareNotificationRefs("100", "101")).toBeLessThan(0);
    expect(compareNotificationRefs("100", "100")).toBe(0);
  });

  it("maps each filter mode to the form it issues", () => {
    expect(typesForFilterMode("unfiltered", 0)).toBeNull();
    expect(typesForFilterMode("declared_csv", 0)?.join(","))
      .toBe(FANSLY_NOTIFICATION_DECLARED_TYPE_CSV);
    // The purchase group leads the iteration: money first on the degraded path.
    expect(typesForFilterMode("type_groups", 0)).toEqual([2007, 2008, 32007, 45012]);
  });
});
