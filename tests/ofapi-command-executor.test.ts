import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyOfapiCommandFailure,
} from "../apps/runtime/src/services/ofapi-command-executor.ts";
import {
  createOfapiClient,
  OfapiApiError,
  type OfapiCreditSpendObservation,
} from "../apps/runtime/src/services/ofapi.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";
const CONVERSATION = "123456789";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OFAPI command failure classification", () => {
  it.each([
    [429, "failed_retryable", "ofapi_rate_limited"],
    [400, "failed_terminal", "ofapi_http_400"],
    [401, "failed_terminal", "ofapi_http_401"],
    [403, "failed_terminal", "ofapi_http_403"],
    [404, "failed_terminal", "ofapi_http_404"],
    [409, "failed_terminal", "ofapi_http_409"],
    [422, "failed_terminal", "ofapi_http_422"],
    [408, "indeterminate", "ofapi_http_408"],
    [500, "indeterminate", "ofapi_http_500"],
    [503, "indeterminate", "ofapi_http_503"],
    [200, "indeterminate", "ofapi_ambiguous_success"],
  ])("classifies HTTP %s as %s", (status, state, errorCode) => {
    expect(classifyOfapiCommandFailure(
      new OfapiApiError("sanitized", status, null),
    )).toMatchObject({ state, errorCode, httpStatus: status });
  });

  it("treats transport failures as indeterminate", () => {
    expect(classifyOfapiCommandFailure(new Error("socket closed"))).toEqual({
      state: "indeterminate",
      errorCode: "ofapi_transport_unknown",
      errorClass: "indeterminate",
      httpStatus: null,
    });
  });
});

describe("OFAPI text command client", () => {
  it("makes one paced POST, returns only message id, and reports page-attributed spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 987654321,
        text: "<p>secret command text</p>",
      },
      _meta: {
        _credits: { used: 1, balance: 999 },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const observations: OfapiCreditSpendObservation[] = [];
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
      onCreditSpend: (observation) => {
        observations.push(observation);
      },
    });

    await expect(client.sendTextMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      { text: "secret command text" },
    )).resolves.toEqual({ messageId: "987654321" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://ofapi.invalid/api/${ACCOUNT}/chats/${CONVERSATION}/messages`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "secret command text" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      operation: "ofapi_command_send_text",
      httpStatus: 200,
      credits: 1,
      estimated: false,
      balanceAfter: 999,
      pageId: 42,
      attemptNumber: 1,
    });
  });

  it("never retries or retains a rejected vendor body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "secret command text was invalid",
    }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const error = await client.sendTextMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      { text: "secret command text" },
    ).catch((caught) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(OfapiApiError);
    expect(error).toMatchObject({ status: 422, body: null });
    expect(JSON.stringify(error)).not.toContain("secret command text");
  });

  it("does not retry an unknown transport outcome", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const error = await client.sendTextMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      { text: "secret command text" },
    ).catch((caught) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: null, body: null });
    expect(classifyOfapiCommandFailure(error)).toMatchObject({
      state: "indeterminate",
    });
  });

  it("treats a 2xx response without message id as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { success: true },
    }), { status: 200 })));
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const error = await client.sendTextMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      { text: "secret command text" },
    ).catch((caught) => caught);

    expect(error).toMatchObject({ status: 200, body: null });
    expect(classifyOfapiCommandFailure(error)).toMatchObject({
      state: "indeterminate",
      errorCode: "ofapi_ambiguous_success",
    });
  });
});

describe("OFAPI typing command client", () => {
  it("makes one paced POST and reports zero fallback spend when _meta is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { success: true },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const observations: OfapiCreditSpendObservation[] = [];
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
      onCreditSpend: (observation) => {
        observations.push(observation);
      },
    });

    await expect(client.startTyping!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
    )).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://ofapi.invalid/api/${ACCOUNT}/chats/${CONVERSATION}/typing`,
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      operation: "ofapi_command_typing_active",
      httpStatus: 200,
      credits: 0,
      estimated: true,
      pageId: 42,
      attemptNumber: 1,
    });
  });

  it("never retries or retains a rejected typing vendor body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "typing rejected with vendor details",
    }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const error = await client.startTyping!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
    ).catch((caught) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(OfapiApiError);
    expect(error).toMatchObject({ status: 422, body: null });
    expect(JSON.stringify(error)).not.toContain("vendor details");
  });
});
