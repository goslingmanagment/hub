import { describe, expect, it } from "vitest";

import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";

describe("incidentKey", () => {
  it("preserves existing global, page, and stream shapes", () => {
    expect(incidentKey({
      kind: "ofapi_low_credit",
      platformAccountId: null,
    })).toBe("ofapi_low_credit:global");
    expect(incidentKey({
      kind: "proxy_failed",
      platformAccountId: 42,
    })).toBe("proxy_failed:42");
    expect(incidentKey({
      kind: "stream_failed_threshold",
      platformAccountId: 42,
      stream: "transactions",
    })).toBe("stream_failed_threshold:42:transactions");
  });

  it("preserves the existing global subKey shape", () => {
    expect(incidentKey({
      kind: "golden_signal_lag",
      platformAccountId: null,
      subKey: "capture",
    })).toBe("golden_signal_lag:global:capture");
  });

  it("includes subKey for page-scoped incidents", () => {
    expect(incidentKey({
      kind: "ai_provider_failed",
      platformAccountId: 42,
      subKey: "anthropic",
    })).toBe("ai_provider_failed:42:anthropic");
    expect(incidentKey({
      kind: "stream_failed_threshold",
      platformAccountId: 42,
      stream: "transactions",
      subKey: "anthropic",
    })).toBe("stream_failed_threshold:42:transactions:anthropic");
  });
});
