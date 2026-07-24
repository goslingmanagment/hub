import { describe, expect, it, vi } from "vitest";

import { reconcileAiProviderTerminalIncident } from "../apps/runtime/src/services/ai-gateway-incidents.ts";

describe("AI gateway incident producer isolation", () => {
  it("logs and swallows streak-query failures after terminal accounting", async () => {
    const producerFailure = new Error("incident database unavailable");
    const logger = { warn: vi.fn() };
    const db = {
      select() {
        throw producerFailure;
      },
    };

    await expect(reconcileAiProviderTerminalIncident({
      db: db as never,
      logger,
    }, {
      provider: "anthropic",
      outcome: "failed",
      pageId: 42,
      pageLabel: "lora-of",
      platform: "onlyfans",
      errorCode: "provider_stream_failed",
      failurePhase: "stream",
      providerHttpStatus: null,
      completedAt: new Date("2026-07-24T12:00:00.000Z"),
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 42,
        errorCode: "provider_stream_failed",
        err: producerFailure,
      }),
      "AI provider incident evaluation failed; continuing",
    );
  });
});
