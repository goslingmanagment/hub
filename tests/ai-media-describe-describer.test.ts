import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  MEDIA_DESCRIBE_DEFAULT_MODEL,
  MEDIA_DESCRIBE_MAX_TOKENS,
  MEDIA_DESCRIPTION_MAX_CHARS,
  buildMediaDescribeRequest,
  classifyMediaDescribeFailure,
  classifyMediaDescribeResponse,
  describeMedia,
  estimateImageTokens,
  estimateMediaDescribeReserveMicroUsd,
  type MediaDescribeClient,
  type MediaDescribeProviderMessage,
} from "../apps/runtime/src/services/ai-media-describe/describer.ts";

// The SDK is a runtime-package dependency (and import-banned outside the
// gateway provider); resolve it the way the runtime does, only to build errors.
// The ESM entry, so the error classes are the ones the runtime's import sees.
interface AnthropicErrorClasses {
  APIConnectionError: new (options: { cause?: Error }) => Error;
  APIConnectionTimeoutError: new () => Error;
  APIError: { generate(status: number, body: unknown, message: string, headers: Headers): Error };
}
const Anthropic = (await import(
  pathToFileURL(path.resolve("apps/runtime/node_modules/@anthropic-ai/sdk/index.mjs")).href
) as { default: AnthropicErrorClasses }).default;

const MODEL = MEDIA_DESCRIBE_DEFAULT_MODEL;
const PROXY = { url: "socks5://proxy.example:1080", username: "u", password: "p" };

function message(overrides: Partial<MediaDescribeProviderMessage> = {}): MediaDescribeProviderMessage {
  return {
    id: "msg_1",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "A mirror selfie of a person in a grey hoodie holding a phone." }],
    usage: { input_tokens: 1500, output_tokens: 20 },
    ...overrides,
  };
}

function scriptedClient(steps: Array<MediaDescribeProviderMessage | Error>) {
  const requests: unknown[] = [];
  const client: MediaDescribeClient = {
    async create(request) {
      requests.push(request);
      const step = steps.shift();
      if (!step) throw new Error("unexpected extra provider call");
      if (step instanceof Error) throw step;
      return step;
    },
    release: vi.fn(),
  };
  return { client, requests };
}

function connectError() {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  return new Anthropic.APIConnectionError({ cause });
}

function apiError(status: number) {
  return Anthropic.APIError.generate(status, { error: { type: "x", message: "m" } }, "m", new Headers());
}

describe("media describer request", () => {
  it("sends one base64 JPEG, no URL, thinking disabled, no sampling params", () => {
    const request = buildMediaDescribeRequest(MODEL, "QUJD");
    expect(request).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: MEDIA_DESCRIBE_MAX_TOKENS,
      thinking: { type: "disabled" },
    });
    expect(request).not.toHaveProperty("temperature");
    const serialized = JSON.stringify(request);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(request.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
    });
  });

  it("carries no policy workaround wording", () => {
    const text = JSON.stringify(buildMediaDescribeRequest(MODEL, "QUJD")).toLowerCase();
    for (const phrase of ["role-play", "roleplay", "pretend", "fictional", "hypothetical", "ignore previous", "for research"]) {
      expect(text).not.toContain(phrase);
    }
  });

  it("estimates reserve cost from image tokens and never below the real bill", () => {
    expect(estimateImageTokens(1024, 683)).toBe(37 * 25);
    const reserve = estimateMediaDescribeReserveMicroUsd(MODEL, { width: 1024, height: 1024 });
    const realWorst = classifyMediaDescribeResponse(MODEL, message({
      usage: { input_tokens: estimateImageTokens(1024, 1024) + 300, output_tokens: MEDIA_DESCRIBE_MAX_TOKENS },
    })).usage.costMicroUsd;
    expect(reserve).toBeGreaterThanOrEqual(realWorst);
    expect(reserve).toBeLessThan(10_000);
  });
});

describe("media describer response classification", () => {
  it("returns a clamped, whitespace-normalized description", () => {
    const long = `${"A cat sitting on a sunny windowsill ".repeat(20)}`;
    const outcome = classifyMediaDescribeResponse(MODEL, message({ content: [{ type: "text", text: `  ${long}\n` }] }));
    expect(outcome.kind).toBe("described");
    if (outcome.kind !== "described") return;
    expect(outcome.description.length).toBeLessThanOrEqual(MEDIA_DESCRIPTION_MAX_CHARS);
    expect(outcome.description).not.toMatch(/\s{2,}/);
    expect(outcome.usage.costMicroUsd).toBeGreaterThan(0);
  });

  it.each([
    ["provider refusal", message({ stop_reason: "refusal", content: [] }), "provider_refusal"],
    ["sentinel", message({ content: [{ type: "text", text: "UNAVAILABLE" }] }), "unavailable_sentinel"],
    ["sentinel with tail", message({ content: [{ type: "text", text: "Unavailable." }] }), "unavailable_sentinel"],
    ["empty answer", message({ content: [{ type: "text", text: "   " }] }), "empty"],
  ])("treats %s as a terminal refusal", (_label, response, reason) => {
    expect(classifyMediaDescribeResponse(MODEL, response)).toMatchObject({ kind: "refused", reason });
  });
});

describe("media describer failure classification", () => {
  it("never retries a timeout or a drop after send", () => {
    expect(classifyMediaDescribeFailure(new Anthropic.APIConnectionTimeoutError())).toEqual({
      kind: "outcome_unknown",
      errorCode: "provider_timeout",
    });
    expect(classifyMediaDescribeFailure(new Anthropic.APIConnectionError({ cause: new Error("socket hang up") })))
      .toMatchObject({ kind: "outcome_unknown" });
  });

  it("retries a connect failure, 429 and 529", () => {
    expect(classifyMediaDescribeFailure(connectError())).toMatchObject({ kind: "retryable" });
    expect(classifyMediaDescribeFailure(apiError(429))).toMatchObject({ kind: "retryable", httpStatus: 429 });
    expect(classifyMediaDescribeFailure(apiError(529))).toMatchObject({ kind: "retryable", httpStatus: 529 });
  });

  it("stops the account lane on 401/403 and fails other rejections", () => {
    expect(classifyMediaDescribeFailure(apiError(401))).toMatchObject({ kind: "account_stop", httpStatus: 401 });
    expect(classifyMediaDescribeFailure(apiError(403))).toMatchObject({ kind: "account_stop", httpStatus: 403 });
    expect(classifyMediaDescribeFailure(apiError(400))).toMatchObject({ kind: "failed", httpStatus: 400 });
  });
});

describe("describeMedia retry policy", () => {
  it("retries at most twice, only after proven non-processing", async () => {
    const { client, requests } = scriptedClient([apiError(529), connectError(), message()]);
    const outcome = await describeMedia({
      model: MODEL,
      jpegBase64: "QUJD",
      proxy: PROXY,
      clientFactory: () => client,
      sleep: async () => undefined,
    });
    expect(outcome.kind).toBe("described");
    expect(requests).toHaveLength(3);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("gives up after two retries", async () => {
    const { client, requests } = scriptedClient([apiError(429), apiError(429), apiError(429)]);
    const outcome = await describeMedia({ model: MODEL, jpegBase64: "QUJD", proxy: PROXY, clientFactory: () => client, sleep: async () => undefined });
    expect(outcome).toMatchObject({ kind: "retryable" });
    expect(requests).toHaveLength(3);
  });

  it("sends exactly once on a refusal or a timeout", async () => {
    for (const step of [message({ stop_reason: "refusal", content: [] }), new Anthropic.APIConnectionTimeoutError()]) {
      const { client, requests } = scriptedClient([step]);
      await describeMedia({ model: MODEL, jpegBase64: "QUJD", proxy: PROXY, clientFactory: () => client, sleep: async () => undefined });
      expect(requests).toHaveLength(1);
    }
  });
});
