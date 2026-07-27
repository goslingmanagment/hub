import { describe, expect, it } from "vitest";

import { NOTIFICATION_OUTBOX_LEASE_MS } from "@agency_hub_core/db";

import { TELEGRAM_SEND_RETRY_WINDOW_MS } from "../apps/runtime/src/services/telegram.ts";

/**
 * The outbox lease and the Telegram sender live in different packages —
 * packages/db cannot import the runtime's sender — so nothing in the type
 * system stops the lease from being shortened below one physical send. That
 * combination is a silent duplicate-notification bug: the lease expires while
 * the row is still in flight, another runner reclaims it, and Telegram has no
 * idempotency primitive to collapse the second send.
 */
describe("notification outbox lease vs Telegram send window", () => {
  it("outlives the slowest possible single send", () => {
    expect(NOTIFICATION_OUTBOX_LEASE_MS).toBeGreaterThan(TELEGRAM_SEND_RETRY_WINDOW_MS);
  });

  it("keeps a margin for the surrounding database round trips", () => {
    // Lease and settlement each cost a transaction on either side of the send.
    expect(NOTIFICATION_OUTBOX_LEASE_MS - TELEGRAM_SEND_RETRY_WINDOW_MS)
      .toBeGreaterThanOrEqual(30_000);
  });
});
