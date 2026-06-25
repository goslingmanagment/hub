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

describe("OFAPI account client", () => {
  it("maps account identity fields and keeps only portable avatar URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: "acct_lora",
        onlyfans_username: "loravie",
        display_name: "LoraVie FREE",
        onlyfans_user_data: {
          id: 123,
          name: "Lora Vie",
          avatar: "https://public.onlyfans.com/files/lora/avatar.jpg",
        },
      }, {
        id: "acct_signed",
        onlyfans_username: "signed",
        display_name: "Signed",
        onlyfans_user_data: {
          avatar: "https://public.onlyfans.com/files/signed/avatar.jpg?Policy=ip-locked&Signature=sig",
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    await expect(client.listAccounts()).resolves.toEqual([{
      id: "acct_lora",
      username: "loravie",
      displayName: "LoraVie FREE",
      onlyfansName: "Lora Vie",
      onlyfansUserId: "123",
      avatarUrl: "https://public.onlyfans.com/files/lora/avatar.jpg",
    }, {
      id: "acct_signed",
      username: "signed",
      displayName: "Signed",
      onlyfansName: null,
      onlyfansUserId: null,
      avatarUrl: null,
    }]);
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

  it("classifies a wrapper 4xx carrying an upstream 5xx as indeterminate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "ONLYFANS_COM_ERROR",
      message: "Bad Gateway from wrapped upstream",
      onlyfans_response: {
        status: 503,
        body: {
          error: { message: "secret command text may or may not have been delivered" },
        },
      },
    }), {
      status: 400,
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
    expect(error).toMatchObject({
      status: 400,
      upstreamStatus: 503,
      body: null,
    });
    expect(classifyOfapiCommandFailure(error)).toMatchObject({
      state: "indeterminate",
      errorCode: "ofapi_http_503",
      errorClass: "indeterminate",
      httpStatus: 503,
    });
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

describe("OFAPI media command client", () => {
  it("makes one paced POST with bounded media payload and reports spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 987654322,
        text: "<p>secret caption</p>",
        media: [{ id: 1 }],
      },
      _meta: {
        _credits: { used: 1, balance: 998 },
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

    await expect(client.sendMediaMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      {
        text: "secret caption",
        price: 25,
        mediaFiles: ["3866342509", "ofapi_media_abc123"],
        previews: ["3866342509"],
      },
    )).resolves.toEqual({ messageId: "987654322" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://ofapi.invalid/api/${ACCOUNT}/chats/${CONVERSATION}/messages`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "secret caption",
      price: 25,
      mediaFiles: [3866342509, "ofapi_media_abc123"],
      previews: [3866342509],
      lockedText: true,
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      operation: "ofapi_command_send_media",
      httpStatus: 200,
      credits: 1,
      estimated: false,
      balanceAfter: 998,
      pageId: 42,
      attemptNumber: 1,
    });
  });

  it("omits previews and lockedText for free captioned media sends", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 987654323 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    await expect(client.sendMediaMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      {
        text: "free caption",
        price: 0,
        mediaFiles: ["ofapi_media_abc123"],
        previews: [],
      },
    )).resolves.toEqual({ messageId: "987654323" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text: "free caption",
      price: 0,
      mediaFiles: ["ofapi_media_abc123"],
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

describe("OFAPI unsend command client", () => {
  it("makes one paced DELETE and reports page-attributed spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { success: true },
      _meta: {
        _credits: { used: 1, balance: 998 },
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

    await expect(client.unsendMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      "987654321",
    )).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://ofapi.invalid/api/${ACCOUNT}/chats/${CONVERSATION}/messages/987654321`,
    );
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      operation: "ofapi_command_unsend_message",
      httpStatus: 200,
      credits: 1,
      estimated: false,
      balanceAfter: 998,
      pageId: 42,
      attemptNumber: 1,
    });
  });

  it("never retries or retains a rejected unsend vendor body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "message 987654321 can no longer be unsent",
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

    const error = await client.unsendMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      "987654321",
    ).catch((caught) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(OfapiApiError);
    expect(error).toMatchObject({ status: 422, body: null });
    expect(JSON.stringify(error)).not.toContain("can no longer be unsent");
  });

  it("treats a 2xx response without success=true as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 987654321 },
    }), { status: 200 })));
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const error = await client.unsendMessage!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
      "987654321",
    ).catch((caught) => caught);

    expect(error).toMatchObject({ status: 200, body: null });
    expect(classifyOfapiCommandFailure(error)).toMatchObject({
      state: "indeterminate",
      errorCode: "ofapi_ambiguous_success",
    });
  });
});

describe("OFAPI mark-read command client", () => {
  it("makes one paced POST and reports page-attributed spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { success: true },
      _meta: {
        _credits: { used: 1, balance: 997 },
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

    await expect(client.markChatRead!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
    )).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://ofapi.invalid/api/${ACCOUNT}/chats/${CONVERSATION}/mark-as-read`,
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      operation: "ofapi_command_mark_chat_read",
      httpStatus: 200,
      credits: 1,
      estimated: false,
      balanceAfter: 997,
      pageId: 42,
      attemptNumber: 1,
    });
  });

  it("never retries or retains a rejected mark-read vendor body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "mark read rejected with vendor details",
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

    const error = await client.markChatRead!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
    ).catch((caught) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(OfapiApiError);
    expect(error).toMatchObject({ status: 422, body: null });
    expect(JSON.stringify(error)).not.toContain("vendor details");
  });

  it("treats a 2xx response without success=true as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 987654321 },
    }), { status: 200 })));
    const client = createOfapiClient({
      baseUrl: "https://ofapi.invalid/api",
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const error = await client.markChatRead!(
      { pageId: 42 },
      ACCOUNT,
      CONVERSATION,
    ).catch((caught) => caught);

    expect(error).toMatchObject({ status: 200, body: null });
    expect(classifyOfapiCommandFailure(error)).toMatchObject({
      state: "indeterminate",
      errorCode: "ofapi_ambiguous_success",
    });
  });
});
