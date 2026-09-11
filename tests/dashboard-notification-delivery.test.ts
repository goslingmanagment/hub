import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { describe, expect, it, vi } from "vitest";
import { KernelApiError } from "@agency_hub_core/contracts";
import { notificationDeliveryFailure, restoreNotificationDelivery, settleNotificationDelivery, type NotificationDelivery } from "../apps/dashboard/src/lib/notificationDelivery.ts";
import { NotificationDeliveryNotice } from "../apps/dashboard/src/pages/notifications/NotificationDeliveryNotice.tsx";

const pending: NotificationDelivery = { id: "40000000-0000-4000-8000-000000000001", ownerId: 7, kind: "report", recipient: "synthetic-original-chat", startedAt: "2026-09-11T10:00:00.000Z", phase: "sending", detail: "Sending", reportDate: null };
const serialized = (current: NotificationDelivery | null, history: NotificationDelivery[] = []) => JSON.stringify({ version: 1, ownerId: 7, current, history });
describe("manual Telegram delivery recovery", () => {
  it("restores only a real pending request as unknown and never restores sending consent", () => {
    expect(restoreNotificationDelivery(null, 7).current).toBeNull();
    expect(restoreNotificationDelivery(serialized(pending), 7).current).toMatchObject({ id: pending.id, phase: "unknown", recipient: pending.recipient, reportDate: null });
    expect(restoreNotificationDelivery(serialized({ ...pending, phase: "sent" }), 7).current?.phase).toBe("sent");
    expect(restoreNotificationDelivery(serialized(pending), 7, false).current?.phase).toBe("sending");
  });
  it("fails closed on another owner or a corrupted pending envelope", () => {
    expect(() => restoreNotificationDelivery(serialized(pending), 8)).toThrow();
    expect(() => restoreNotificationDelivery("{broken", 7)).toThrow();
    expect(() => restoreNotificationDelivery(serialized({ ...pending, startedAt: "invalid" }), 7)).toThrow();
  });
  it("places the late original receipt into history without altering the subsequent delivery", () => {
    const next = { ...pending, id: "40000000-0000-4000-8000-000000000002", recipient: "new-recipient" };
    const outcome = { ...pending, phase: "sent" as const, detail: "Confirmed" };
    const settled = settleNotificationDelivery({ current: next, history: [{ ...pending, phase: "unknown" }], storageError: "" }, outcome);
    expect(settled.current).toEqual(next); expect(settled.history).toEqual([outcome]);
  });
  it("distinguishes a definite refusal from a lost or malformed acknowledgement", () => {
    expect(notificationDeliveryFailure(new KernelApiError("Denied", "auth", 403, null, null)).phase).toBe("not_sent");
    expect(notificationDeliveryFailure(new Error("timeout")).phase).toBe("unknown");
    expect(notificationDeliveryFailure(new KernelApiError("Malformed success", "contract", 200, null, null)).phase).toBe("unknown");
  });
  it("shows the frozen recipient and keeps separate send unavailable until a fresh explicit acknowledgement", () => {
    const allow = vi.fn(); const refresh = vi.fn();
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NotificationDeliveryNotice, { current: { ...pending, phase: "unknown" }, history: [], error: "", pending: false, onRefresh: refresh, onAllowSeparate: allow })));
    expect(html).toContain("synthetic-original-chat"); expect(html).toContain("может появиться второе сообщение");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Разрешить отдельную новую отправку<\/button>/);
    expect(allow).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
});
