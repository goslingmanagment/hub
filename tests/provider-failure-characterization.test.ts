import { describe, expect, it } from "vitest";

import { providerStreamFailureFrame } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  classifyProviderStreamFailure,
  normalizeProviderStreamFailure,
  type AiProviderFailureCode,
} from "../packages/shared/src/http-client.ts";
import {
  errorFromProviderHttpFixture,
  providerConnectFailureFixtures,
  providerHttpFailureFixtures,
  providerStreamInterruptionFixture,
} from "./fixtures/provider-failures.ts";

const EXPECTED_HTTP_CODES = {
  "anthropic-billing-400": "provider_billing",
  "provider-auth-401": "provider_auth",
  "provider-unknown-400": "provider_stream_failed",
  "provider-auth-403": "provider_auth",
  "provider-rate-limit-429": "provider_rate_limited",
  "provider-overloaded-529": "provider_unavailable",
  "provider-internal-500": "provider_unavailable",
  "provider-unavailable-503": "provider_unavailable",
} as const satisfies Record<
  (typeof providerHttpFailureFixtures)[number]["id"],
  AiProviderFailureCode
>;

const EXPECTED_MESSAGES = {
  provider_billing: "AI provider billing requires attention",
  provider_auth: "AI provider authentication failed",
  provider_rate_limited: "AI provider rate limit reached",
  provider_unavailable: "AI provider is temporarily unavailable",
  provider_proxy_unreachable: "AI gateway could not reach the page's egress proxy",
  provider_stream_failed: "AI gateway provider stream failed",
} as const satisfies Record<AiProviderFailureCode, string>;

describe("provider failure classification (Stage 1B conscious diff)", () => {
  it.each(providerHttpFailureFixtures)("$id maps to its precise provider-response class", (fixture) => {
    const error = errorFromProviderHttpFixture(fixture);
    const classified = normalizeProviderStreamFailure(error, {
      provider: "anthropic",
      now: Date.parse("2026-07-24T10:00:00.000Z"),
    });
    const expectedCode = EXPECTED_HTTP_CODES[fixture.id];

    expect(classifyProviderStreamFailure(error, { provider: "anthropic" })).toBe(expectedCode);
    expect(classified).toEqual({
      code: expectedCode,
      failurePhase: "provider_response",
      providerHttpStatus: fixture.status,
      retryAfterMs: fixture.status === 429 ? 17_000 : null,
    });
    expect(providerStreamFailureFrame(classified)).toEqual({
      type: "error",
      code: expectedCode,
      message: EXPECTED_MESSAGES[expectedCode],
      retryAfterMs: fixture.status === 429 ? 17_000 : null,
    });
    expect(JSON.stringify(providerStreamFailureFrame(classified)))
      .not.toContain(fixture.body.error.message);
  });

  it.each(providerConnectFailureFixtures)("$id remains proxy-unreachable at connect phase", (fixture) => {
    const error = fixture.createError();
    const classified = normalizeProviderStreamFailure(error, { provider: "anthropic" });

    expect(classified).toEqual({
      code: "provider_proxy_unreachable",
      failurePhase: "connect",
      providerHttpStatus: null,
      retryAfterMs: null,
    });
    expect(providerStreamFailureFrame(classified)).toEqual({
      type: "error",
      code: "provider_proxy_unreachable",
      message: EXPECTED_MESSAGES.provider_proxy_unreachable,
      retryAfterMs: null,
    });
  });

  it("keeps an interruption after the first chunk generic and its frame message static", () => {
    const error = providerStreamInterruptionFixture.createError();
    const classified = normalizeProviderStreamFailure(error, {
      provider: "anthropic",
      failurePhase: "stream",
    });
    const frame = providerStreamFailureFrame(classified);

    expect(providerStreamInterruptionFixture.firstFrame.type).toBe("content_delta");
    expect(classified).toEqual({
      code: "provider_stream_failed",
      failurePhase: "stream",
      providerHttpStatus: null,
      retryAfterMs: null,
    });
    expect(frame).toEqual({
      type: "error",
      code: "provider_stream_failed",
      message: EXPECTED_MESSAGES.provider_stream_failed,
      retryAfterMs: null,
    });
    expect(JSON.stringify(frame)).not.toContain(error.message);
  });

  it("allows only the exact observed Anthropic low-credit 400 signature", () => {
    const billing = providerHttpFailureFixtures.find(
      (fixture) => fixture.id === "anthropic-billing-400",
    )!;
    const nearMiss = errorFromProviderHttpFixture({
      ...billing,
      body: {
        ...billing.body,
        error: {
          ...billing.body.error,
          message: `${billing.body.error.message} `,
        },
      },
    });

    expect(billing.status).toBe(400);
    expect(billing.body.error.type).toBe("invalid_request_error");
    expect(normalizeProviderStreamFailure(nearMiss, { provider: "anthropic" })).toEqual({
      code: "provider_stream_failed",
      failurePhase: "provider_response",
      providerHttpStatus: 400,
      retryAfterMs: null,
    });
  });

  it("prefers SDK class and typed body evidence over a contradictory status", () => {
    class RateLimitError extends Error {}
    const sdkClassError = Object.assign(new RateLimitError("provider text"), {
      status: 400,
      headers: { "retry-after": "2" },
      error: { type: "invalid_request_error", message: "provider text" },
    });
    const typedBodyError = Object.assign(new Error("provider text"), {
      status: 503,
      error: { type: "permission_error", message: "provider text" },
    });

    expect(normalizeProviderStreamFailure(sdkClassError, {
      provider: "anthropic",
    })).toEqual({
      code: "provider_rate_limited",
      failurePhase: "provider_response",
      providerHttpStatus: 400,
      retryAfterMs: 2_000,
    });
    expect(normalizeProviderStreamFailure(typedBodyError, {
      provider: "anthropic",
    })).toEqual({
      code: "provider_auth",
      failurePhase: "provider_response",
      providerHttpStatus: 503,
      retryAfterMs: null,
    });
  });
});
