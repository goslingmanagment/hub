import { describe, expect, it } from "vitest";

import type {
  NotificationIncidentCycleWithPage,
  NotificationIncidentWithPage,
} from "@agency_hub_core/db";

import { renderAlertDigest } from "../apps/runtime/src/services/notification-digest.ts";

// Decision 381: the one daily line about alerting. It must say what is open
// and how many episodes healed on their own, and it must say nothing at all
// when there is nothing to say.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date("2026-09-22T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function openIncident(
  overrides: Partial<NotificationIncidentWithPage> & Pick<NotificationIncidentWithPage, "id" | "kind" | "incidentKey">,
): NotificationIncidentWithPage {
  return {
    pageLabel: null,
    platform: null,
    stream: null,
    status: "open",
    openedAt: ago(HOUR),
    lastSeenAt: NOW,
    resolvedAt: null,
    errorCode: null,
    errorSummary: null,
    notificationCount: 0,
    outboxState: null,
    outboxAttemptCount: null,
    outboxLastError: null,
    outboxSuppressionReason: null,
    ...overrides,
  };
}

function cycle(
  overrides: Partial<NotificationIncidentCycleWithPage> & Pick<NotificationIncidentCycleWithPage, "kind" | "incidentKey">,
): NotificationIncidentCycleWithPage {
  return {
    incidentId: 1,
    pageLabel: null,
    platform: null,
    stream: null,
    openedAt: ago(2 * HOUR),
    resolvedAt: ago(2 * HOUR - 2 * MINUTE),
    paged: false,
    ...overrides,
  };
}

describe("renderAlertDigest", () => {
  it("is silent when nothing is open and nothing happened", () => {
    expect(renderAlertDigest({ now: NOW, open: [], cycles: [] })).toBeNull();
  });

  it("lists standing incidents by age and groups the quiet episodes per subject", () => {
    const text = renderAlertDigest({
      now: NOW,
      open: [
        openIncident({
          id: 1,
          kind: "ofapi_chargebacks_reconcile_failed",
          incidentKey: "ofapi_chargebacks_reconcile_failed:global",
          openedAt: ago(13 * 24 * HOUR),
        }),
        openIncident({
          id: 2,
          kind: "proxy_failed",
          incidentKey: "proxy_failed:7",
          pageLabel: "lora-2",
          platform: "fansly",
          stream: "posts",
          openedAt: ago(3 * HOUR + 12 * MINUTE),
        }),
      ],
      cycles: [
        cycle({ kind: "proxy_failed", incidentKey: "proxy_failed:3", pageLabel: "lilly-1", platform: "fansly" }),
        cycle({
          kind: "proxy_failed",
          incidentKey: "proxy_failed:3",
          pageLabel: "lilly-1",
          platform: "fansly",
          openedAt: ago(5 * HOUR),
          resolvedAt: ago(5 * HOUR - 4 * MINUTE),
        }),
        cycle({ kind: "scheduler_silent", incidentKey: "scheduler_silent:global", resolvedAt: ago(2 * HOUR - 5 * MINUTE) }),
        cycle({ kind: "proxy_failed", incidentKey: "proxy_failed:7", pageLabel: "lora-2", platform: "fansly", paged: true }),
      ],
    });

    expect(text).toBe([
      "🩺 <b>Alerts · last 1 d</b>",
      "",
      "<b>Open now</b>",
      "• OFAPI chargebacks reconcile failed · 13 d",
      "• Proxy failed — lora-2 (fansly) · 3 h 12 min",
      "",
      "<b>Window</b>: 1 paged · 3 quiet episodes healed before paging",
      "• Proxy failed — lilly-1 (fansly): 2 episodes, longest 4 min",
      "• Scheduler heartbeat silent — cron is not firing: 1 episode, longest 5 min",
    ].join("\n"));
  });

  it("escapes HTML in labels and counts an episode that is still open against now", () => {
    const text = renderAlertDigest({
      now: NOW,
      open: [],
      cycles: [
        cycle({
          kind: "stream_failed_threshold",
          incidentKey: "stream_failed_threshold:9:posts",
          stream: "posts",
          pageLabel: "a<b>",
          platform: "onlyfans",
          openedAt: ago(30 * MINUTE),
          resolvedAt: null,
        }),
      ],
    });
    expect(text).toContain("• Stream sync failed — a&lt;b&gt; (onlyfans): 1 episode, longest 30 min");
    expect(text).not.toContain("Open now");
  });
});
