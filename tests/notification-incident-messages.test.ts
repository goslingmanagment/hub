import { describe, expect, it } from "vitest";

import { appendMissedAlertsLine, type NotificationPagingCandidate } from "@agency_hub_core/db";

import { describeClosedFanslyPage } from "../apps/runtime/src/services/fansly-send-guard/monitor.ts";
import {
  openMessageForIncident,
  resolveMessageForIncident,
} from "../apps/runtime/src/services/notification-incidents.ts";
import {
  MISSED_ALERTS_SUMMARY_MAX_CHARS,
  renderMissedAlertsHeader,
  renderMissedAlertsLine,
} from "../apps/runtime/src/services/notification-paging-sweep.ts";

// Review R2-7: the resolve-text ternary had explicit text for 8 of 12 kinds;
// golden_signal_lag auto-resolves TODAY and fell through to "OFAPI webhooks
// delivering again". The resolver must be exhaustive over the kind union.

describe("resolveMessageForIncident", () => {
  it("names resolved OFAPI custody conflicts", () => {
    expect(resolveMessageForIncident({ kind: "ofapi_binding_conflict", pageLabel: null, platform: null }))
      .toContain("OFAPI binding custody conflict cleared");
  });
  it("golden_signal_lag resolves with its own text, not the webhook fallthrough", () => {
    const message = resolveMessageForIncident({
      kind: "golden_signal_lag",
      pageLabel: null,
      platform: null,
    });
    expect(message).toContain("Golden-signal lag");
    expect(message).not.toContain("webhooks");
  });

  it("wrong_transactions_writer and read_gateway_capture have explicit texts", () => {
    expect(
      resolveMessageForIncident({ kind: "wrong_transactions_writer", pageLabel: "p1", platform: "onlyfans" }),
    ).toContain("writer");
    expect(
      resolveMessageForIncident({ kind: "read_gateway_capture", pageLabel: null, platform: null }),
    ).toContain("capture");
    // The stale-collection latch shares the kind, not the condition.
    const stale = resolveMessageForIncident({ kind: "read_gateway_capture", subKey: "collection_stale", pageLabel: "lora-of", platform: "onlyfans" });
    expect(stale).toContain("OnlyFans scheduled collection completing on schedule again: lora-of (onlyfans)");
    expect(stale).not.toContain("tee");
  });

  it("keeps the webhook text for the webhook-silence kind", () => {
    expect(
      resolveMessageForIncident({ kind: "ofapi_webhook_silence", pageLabel: null, platform: null }),
    ).toContain("OFAPI webhooks delivering again");
  });

  it("proxy_missing resolves with its own egress-restored text (W3.1)", () => {
    const message = resolveMessageForIncident({
      kind: "proxy_missing",
      pageLabel: "p1",
      platform: "fansly",
    });
    expect(message).toContain("Proxy assigned");
    expect(message).toContain("egress restored");
  });

  it("watchdog kinds resolve with their own texts (W5.2)", () => {
    expect(
      resolveMessageForIncident({ kind: "scheduler_silent", pageLabel: null, platform: null }),
    ).toContain("cron firing again");
    expect(
      resolveMessageForIncident({ kind: "ops_sampler_silent", pageLabel: null, platform: null }),
    ).toContain("sampler emitting again");
    expect(
      resolveMessageForIncident({ kind: "sync_silent", pageLabel: null, platform: null }),
    ).toBe("✅ Resolved\nFansly sync chunks starting again");
  });

  it("chargebacks reconcile resolves with its own recovery text", () => {
    expect(
      resolveMessageForIncident({
        kind: "ofapi_chargebacks_reconcile_failed",
        pageLabel: null,
        platform: null,
      }),
    ).toContain("chargebacks reconcile recovered");
  });

  it("link-stats reconcile resolves with its own recovery text", () => {
    expect(
      resolveMessageForIncident({
        kind: "ofapi_link_stats_reconcile_failed",
        pageLabel: null,
        platform: null,
      }),
    ).toContain("link-stats reconcile recovered");
  });

  // #222. Three conditions share the `capture_payload_parity` kind and none of
  // them shares a latch, so none of them may share a resolve line either: an
  // owner reading "copies match again" while a reference still points at
  // nothing would be reading an all-clear that nobody measured.
  it("each capture_payload_parity subKey resolves with its own text", () => {
    const parity = resolveMessageForIncident({
      kind: "capture_payload_parity",
      pageLabel: null,
      platform: null,
    });
    const collision = resolveMessageForIncident({
      kind: "capture_payload_parity",
      pageLabel: null,
      platform: null,
      subKey: "sha256_collision",
    });
    const dangling = resolveMessageForIncident({
      kind: "capture_payload_parity",
      pageLabel: null,
      platform: null,
      subKey: "dangling_reference",
    });

    expect(parity).toContain("copies match the inline facts again");
    expect(collision).toContain("sha256 collisions cleared");
    expect(dangling).toContain("references all resolve again");
    // …and each one says what it does NOT clear.
    expect(dangling).toContain("in the measured window");
    expect(new Set([parity, collision, dangling]).size).toBe(3);
  });

  // Plan §2.5/§10: the Fansly send guard's page latches share the Fansly-only
  // sync_silent kind with the deadman but resolve with their own lines.
  it("the send guard's page latches resolve with their own texts", () => {
    const closed = resolveMessageForIncident({
      kind: "sync_silent", pageLabel: "lilly-1", platform: "fansly", subKey: "send_guard_closed",
    });
    const pace = resolveMessageForIncident({
      kind: "sync_silent", pageLabel: "lilly-1", platform: "fansly", subKey: "pace_violation",
    });
    const deadman = resolveMessageForIncident({ kind: "sync_silent", pageLabel: null, platform: null });
    expect(closed).toBe("✅ Resolved\nFansly page open again: its request holder completed or was confirmed gone: lilly-1 (fansly)");
    expect(pace).toBe("✅ Resolved\nNo Fansly pace violation for an hour: lilly-1 (fansly)");
    expect(deadman).toContain("Fansly sync chunks starting again");
  });

  // A legacy stream's latch closed at the transition to the Fansly Sync
  // Engine is not a recovery: the resolve says it closed and why. A
  // resolution the vocabulary does not know changes nothing.
  it("a legacy stream latch closed because the engine owns the page says so, not 'recovered'", () => {
    expect(resolveMessageForIncident({
      kind: "stream_failed_threshold", pageLabel: "lilly-2", platform: "fansly", stream: "dm_conversations", resolution: "engine_owned",
    })).toBe("✅ Resolved\nStream dm_conversations closed: lilly-2 (fansly)\n"
      + "Reason: the page is owned by the Fansly Sync Engine; the legacy stream no longer runs");
    for (const resolution of [{}, { resolution: null }, { resolution: "unknown" }]) {
      expect(resolveMessageForIncident({
        kind: "stream_failed_threshold", pageLabel: "lilly-2", platform: "fansly", stream: "dm_conversations", ...resolution,
      })).toBe("✅ Resolved\nStream dm_conversations recovered: lilly-2 (fansly)");
    }
  });

  it("the send guard's closed-page message keeps the token to confirm", () => {
    const summary = describeClosedFanslyPage({
      pageId: 7, pageLabel: "lilly-1", holderToken: "33333333-3333-4333-8333-333333333333",
      holderSource: "targeted_backfill", holderOperation: "messages", holderHost: "a-rather-long-custom-hostname-xyz",
      holderPid: 123456, holderPidStart: null, holderPidNs: null, holderBootId: null, holderInstance: null,
      holderRole: "worker", capturedAt: new Date("2026-10-01T12:00:00Z"), leaseUntil: new Date("2026-10-01T12:01:15Z"),
      leaseExpired: true, lastCompletedAt: new Date("2026-10-01T11:59:00Z"), nextU: 0.1, closedReason: null,
      closedAt: null, ownerEngine: "legacy", engineSwitchedAt: null, dbNow: new Date("2026-10-01T12:02:00Z"),
    });
    const message = openMessageForIncident({
      kind: "sync_silent", pageLabel: "lilly-1", platform: "fansly", subKey: "send_guard_closed", errorSummary: summary,
    });
    expect(message.split("\n")[0]).toBe("🚨 Fansly page closed: a request overran its lease, nothing is sent for the page");
    // The summary is clamped at 240 characters; the command and its token come first.
    expect(message).toContain("fansly-send-guard confirm-terminated --holder-token 33333333-3333-4333-8333-333333333333");
    expect(message).toContain("Run fansly-send-guard status");
  });

  it("reader-first AI incident kinds have explicit recovery texts", () => {
    expect(
      resolveMessageForIncident({
        kind: "ai_provider_billing",
        pageLabel: null,
        platform: null,
      }),
    ).toContain("billing recovered");
    expect(
      resolveMessageForIncident({
        kind: "ai_provider_failed",
        pageLabel: "p1",
        platform: "onlyfans",
      }),
    ).toContain("generation recovered");
  });
});

// Д2: a page that opened and resolved before Telegram accepted its alert is a
// line of one missed-alerts summary — no late "🚨", no "✅" without it.
describe("missed-alerts summary", () => {
  function candidate(overrides: Partial<NotificationPagingCandidate>): NotificationPagingCandidate {
    return {
      incidentId: 116,
      incidentKey: "fansly_sync_engine:10:freshness",
      kind: "fansly_sync_engine",
      platformAccountId: 10,
      pageLabel: "lilly-2",
      platform: "fansly",
      stream: null,
      status: "resolved",
      openedAt: new Date("2026-10-05T15:32:54Z"),
      lastSeenAt: new Date("2026-10-05T15:42:54Z"),
      resolvedAt: new Date("2026-10-05T15:42:54Z"),
      errorSummary: null,
      resolution: null,
      paging: null,
      ...overrides,
    };
  }

  it("names the episode, its page and the span it was open", () => {
    expect(renderMissedAlertsHeader())
      .toBe("📵 Not delivered in time — these alerts opened and resolved before Telegram accepted them:");
    expect(renderMissedAlertsLine({
      candidate: candidate({}),
      pagedOpenedAt: new Date("2026-10-05T15:32:54Z"),
      pagedMode: "immediate",
      resolvedAt: new Date("2026-10-05T15:42:54Z"),
    })).toBe("• Fansly Sync Engine freshness broken (messages, money or urgent work late) — lilly-2 (fansly)"
      + " · 10-05 15:32 → 15:42 UTC (10 min)");
    // A flapping page covered a storm, not one episode; a span past midnight
    // dates both ends; a global latch has no page.
    expect(renderMissedAlertsLine({
      candidate: candidate({ kind: "proxy_failed", incidentKey: "proxy_failed:7", pageLabel: "lora-2" }),
      pagedOpenedAt: new Date("2026-10-05T22:10:00Z"),
      pagedMode: "flapping",
      resolvedAt: new Date("2026-10-06T01:02:00Z"),
    })).toBe("• Proxy failed — lora-2 (fansly) · flapped 10-05 22:10 → 10-06 01:02 UTC (2 h 52 min)");
    expect(renderMissedAlertsLine({
      candidate: candidate({
        kind: "scheduler_silent", incidentKey: "scheduler_silent:global", platformAccountId: null, pageLabel: null, platform: null,
      }),
      pagedOpenedAt: null,
      pagedMode: "sustained",
      resolvedAt: new Date("2026-10-05T15:50:00Z"),
    })).toBe("• Scheduler heartbeat silent — cron is not firing · 10-05 15:32 → 15:50 UTC (17 min)");
  });

  it("stays under 3 500 characters: a line that would pass it starts a new summary", () => {
    expect(MISSED_ALERTS_SUMMARY_MAX_CHARS).toBe(3_500);
    const line = renderMissedAlertsLine({
      candidate: candidate({ pageLabel: "x".repeat(64) }),
      pagedOpenedAt: new Date("2026-10-05T15:32:54Z"),
      pagedMode: "immediate",
      resolvedAt: new Date("2026-10-05T15:42:54Z"),
    });
    let text = `${renderMissedAlertsHeader()}\n${line}`;
    let lines = 1;
    for (;;) {
      const appended = appendMissedAlertsLine(text, line, MISSED_ALERTS_SUMMARY_MAX_CHARS);
      if (appended === null) {
        break;
      }
      text = appended;
      lines += 1;
    }
    expect(text.length).toBeLessThanOrEqual(3_500);
    expect(text.length + 1 + line.length).toBeGreaterThan(3_500);
    expect(lines).toBeGreaterThan(10);
    // Telegram's own limit is 4 096 UTF-16 units; the margin is the point.
    expect(appendMissedAlertsLine("a".repeat(3_499), "b", 3_500)).toBeNull();
    expect(appendMissedAlertsLine("a".repeat(3_498), "b", 3_500)).toBe(`${"a".repeat(3_498)}\nb`);
  });
});
