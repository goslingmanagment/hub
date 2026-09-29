// §3.2a — which domain-event types are projection-only. A registry lookup,
// no database; the mixed append protocol itself is SQL and stays in
// domain-events-mixed-append.integration.test.ts.

import { describe, expect, it } from "vitest";

import { isProjectionOnlyDomainEventType } from "@agency_hub_core/db";

describe("§3.2a mixed domain-event append", () => {
  it("registers the four WP-F0(b) media-plane types as projection-only", () => {
    // Registering the type here and declaring `mixed: true` on the family are
    // ONE decision — a type missing from this set would replay to SSE clients
    // as business news.
    for (const type of [
      "message.attachments_observed",
      "media.observed",
      "media.order_observed",
      "message.material_observed",
    ]) {
      expect(isProjectionOnlyDomainEventType(type), type).toBe(true);
    }
    for (const type of ["message.received", "message.sent", "message.ppv_unlocked"]) {
      expect(isProjectionOnlyDomainEventType(type), type).toBe(false);
    }
  });
});
