import { describe, expect, it } from "vitest";

import { providerStreamFailureFrame } from "../apps/runtime/src/services/ai-gateway.ts";
import { classifyProviderStreamFailure } from "../packages/shared/src/http-client.ts";
import {
  errorFromProviderHttpFixture,
  providerConnectFailureFixtures,
  providerHttpFailureFixtures,
  providerStreamInterruptionFixture,
} from "./fixtures/provider-failures.ts";

describe("current provider failure classification (Stage 1A characterization)", () => {
  it.each(providerHttpFailureFixtures)("$id remains in the generic stream bucket", (fixture) => {
    const error = errorFromProviderHttpFixture(fixture);

    expect(classifyProviderStreamFailure(error)).toBe("provider_stream_failed");
    expect(providerStreamFailureFrame(error)).toEqual({
      type: "error",
      code: "provider_stream_failed",
      message: "AI gateway provider stream failed",
      retryAfterMs: null,
    });
  });

  it.each(providerConnectFailureFixtures)("$id remains in the proxy-unreachable bucket", (fixture) => {
    const error = fixture.createError();

    expect(classifyProviderStreamFailure(error)).toBe("provider_proxy_unreachable");
    expect(providerStreamFailureFrame(error)).toEqual({
      type: "error",
      code: "provider_proxy_unreachable",
      message: "AI gateway could not reach the page's egress proxy",
      retryAfterMs: null,
    });
  });

  it("keeps an interruption after the first chunk generic and its frame message static", () => {
    const error = providerStreamInterruptionFixture.createError();
    const frame = providerStreamFailureFrame(error);

    expect(providerStreamInterruptionFixture.firstFrame.type).toBe("content_delta");
    expect(classifyProviderStreamFailure(error)).toBe("provider_stream_failed");
    expect(frame).toEqual({
      type: "error",
      code: "provider_stream_failed",
      message: "AI gateway provider stream failed",
      retryAfterMs: null,
    });
    expect(JSON.stringify(frame)).not.toContain(error.message);
  });

  it("pins the real Anthropic billing body shape without inventing a billing error type", () => {
    const billing = providerHttpFailureFixtures[0];

    expect(billing.status).toBe(400);
    expect(billing.body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    });
  });
});
