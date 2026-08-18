import { describe, expect, it } from "vitest";

import { resolveMessageForIncident } from "../apps/runtime/src/services/notification-incidents.ts";

// Review R2-7: the resolve-text ternary had explicit text for 8 of 12 kinds;
// golden_signal_lag auto-resolves TODAY and fell through to "OFAPI webhooks
// delivering again". The resolver must be exhaustive over the kind union.

describe("resolveMessageForIncident", () => {
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
