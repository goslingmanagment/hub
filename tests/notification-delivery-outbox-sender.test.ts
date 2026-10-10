// Д2: the outbox's own Telegram sender does not repeat a timed-out request
// inside its call — a timeout is an indeterminate outcome, and the row repeats
// itself after its backoff. `tests/telegram.test.ts` pins what the option does
// inside `sendTelegramMessage`; this pins that the outbox (worker and api
// fallback alike, both run the default sender) actually passes it. The db is
// mocked: only the control flow around the send is asserted here, the outbox
// semantics live in tests/notification-delivery-outbox.integration.test.ts.

import type * as DbModule from "@agency_hub_core/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTelegramSettings: vi.fn(),
  leaseNotificationDeliveryOutbox: vi.fn(),
  releaseNotificationDeliveryBackoff: vi.fn(),
  settleNotificationDeliveryOutboxAttempt: vi.fn(),
  suppressLeasedNotificationDelivery: vi.fn(),
  sendTelegramMessage: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  getTelegramSettings: mocks.getTelegramSettings,
  leaseNotificationDeliveryOutbox: mocks.leaseNotificationDeliveryOutbox,
  releaseNotificationDeliveryBackoff: mocks.releaseNotificationDeliveryBackoff,
  settleNotificationDeliveryOutboxAttempt: mocks.settleNotificationDeliveryOutboxAttempt,
  suppressLeasedNotificationDelivery: mocks.suppressLeasedNotificationDelivery,
}));

vi.mock("../apps/runtime/src/services/telegram.ts", () => ({
  sendTelegramMessage: mocks.sendTelegramMessage,
}));

const { runNotificationDeliveryOutbox } = await import(
  "../apps/runtime/src/services/notification-delivery-outbox.ts"
);

const app = {
  config: { telegramReportHourUtc: 9 },
  db: {},
  logger: { info: vi.fn(), warn: vi.fn() },
} as never;

function leasedRow(id: number, text: string) {
  return {
    id,
    state: "leased",
    leaseToken: `token-${id}`,
    messageText: text,
    idempotencyKey: `notification:${id}:opened:2026-10-05T15:30:00.000Z:telegram`,
    pagingPolicy: "sync_failure",
  };
}

describe("notification outbox default sender (Д2)", () => {
  beforeEach(() => {
    // Reset, not clear: a pass that stops early leaves queued `Once` leases.
    vi.resetAllMocks();
    mocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      syncFailureAlertsEnabled: true,
      aiCriticalAlertsEnabled: true,
    });
    mocks.releaseNotificationDeliveryBackoff.mockResolvedValue(0);
  });

  it("sends with retryTimeouts: false, and a timed-out send ends the pass", async () => {
    mocks.leaseNotificationDeliveryOutbox
      .mockResolvedValueOnce(leasedRow(1, "🚨 socket"))
      .mockResolvedValueOnce(leasedRow(2, "🚨 stopped"))
      .mockResolvedValue(null);
    mocks.sendTelegramMessage.mockResolvedValue({
      status: "failed",
      error: "Telegram API request timed out through the service proxy.",
    });
    mocks.settleNotificationDeliveryOutboxAttempt.mockResolvedValue({ id: 1, state: "pending" });

    const pass = await runNotificationDeliveryOutbox(app);

    expect(mocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendTelegramMessage).toHaveBeenCalledWith(app, {
      text: "🚨 socket",
      idempotencyKey: "notification:1:opened:2026-10-05T15:30:00.000Z:telegram",
      retryTimeouts: false,
    });
    expect(mocks.leaseNotificationDeliveryOutbox).toHaveBeenCalledTimes(1);
    expect(pass).toMatchObject({ leased: 1, retrying: 1, stoppedOnFailure: true });
  });

  it("every send of a pass carries the option, not only the first", async () => {
    mocks.leaseNotificationDeliveryOutbox
      .mockResolvedValueOnce(leasedRow(1, "🚨 socket"))
      .mockResolvedValueOnce(leasedRow(2, "🚨 stopped"))
      .mockResolvedValue(null);
    mocks.sendTelegramMessage.mockResolvedValue({ status: "sent", chatId: "1", messageId: 7 });
    mocks.settleNotificationDeliveryOutboxAttempt
      .mockResolvedValueOnce({ id: 1, state: "delivered" })
      .mockResolvedValueOnce({ id: 2, state: "delivered" });

    expect(await runNotificationDeliveryOutbox(app)).toMatchObject({ delivered: 2, stoppedOnFailure: false });
    expect(mocks.sendTelegramMessage.mock.calls.map(([, input]) => input.retryTimeouts)).toEqual([false, false]);
  });
});
