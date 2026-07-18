import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createElevenLabsVoiceProvider,
  type VoiceTtsProvider,
} from "../apps/runtime/src/services/voice-elevenlabs-provider.ts";

// Voice notes — the ElevenLabs TTS provider (non-platform vendor, direct
// egress). Every test drives the REAL provider through an injected fetch: the
// provider is under test, not a mock of it. Invariants exercised here:
// exactly one attempt (zero retries), the 4xx-refused vs 5xx/network/timeout
// indeterminate split, header capture, and that neither the script text nor the
// audio bytes ever leak into an error snippet.

const SCRIPT_TEXT = "SECRET_SCRIPT_hey babe this is my private voice note xoxo";

function synthInput(
  overrides: Partial<Parameters<VoiceTtsProvider["synthesize"]>[0]> = {},
): Parameters<VoiceTtsProvider["synthesize"]>[0] {
  return {
    voiceId: "voice_1",
    model: "eleven_multilingual_v2",
    settings: { stability: 0.5, similarity_boost: 0.8 },
    outputFormat: "mp3_44100_128",
    text: SCRIPT_TEXT,
    signal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ElevenLabs voice provider", () => {
  it("succeeds and captures every response header", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "character-cost": "42",
            "request-id": "req_abc",
            "x-trace-id": "trace_xyz",
            "x-region": "us-east-1",
          },
        }),
    );
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.from(result.audio)).toEqual(Buffer.from(bytes));
      expect(result.characterCost).toBe(42);
      expect(result.requestId).toBe("req_abc");
      expect(result.traceId).toBe("trace_xyz");
      expect(result.region).toBe("us-east-1");
    }
  });

  it("succeeds with absent headers, yielding nulls (never undefined)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array([9]), { status: 200 }),
    );
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.characterCost).toBeNull();
      expect(result.requestId).toBeNull();
      expect(result.traceId).toBeNull();
      expect(result.region).toBeNull();
    }
  });

  it("issues exactly one POST to the voice endpoint with the passed-through body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(), { status: 200 }),
    );
    const provider = createElevenLabsVoiceProvider({ apiKey: "secret-key", fetchImpl });

    await provider.synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice_1?output_format=mp3_44100_128",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("secret-key");
    expect(JSON.parse(init.body as string)).toEqual({
      text: SCRIPT_TEXT,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    });
  });

  it("omits voice_settings when the profile has no settings", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(), { status: 200 }),
    );
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    await provider.synthesize(synthInput({ settings: {} }));

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("voice_settings");
    expect(body).toEqual({ text: SCRIPT_TEXT, model_id: "eleven_multilingual_v2" });
  });

  it.each([401, 422, 404])(
    "treats HTTP %i as refused-before-billing with a bounded body snippet",
    async (status) => {
      const errorBody = JSON.stringify({ detail: { message: "invalid api key" } })
        + "z".repeat(500);
      const fetchImpl = vi.fn(async () => new Response(errorBody, { status }));
      const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

      const result = await provider.synthesize(synthInput());

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusedBeforeBilling).toBe(true);
        expect(result.status).toBe(status);
        expect(result.snippet).toContain("invalid api key");
        expect(result.snippet.length).toBeLessThanOrEqual(200);
        expect(result.snippet).not.toContain(SCRIPT_TEXT);
      }
    },
  );

  it("treats HTTP 500 as NOT refused (indeterminate) and never leaks the 5xx body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream boom detail leak", { status: 500 }),
    );
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusedBeforeBilling).toBe(false);
      expect(result.status).toBe(500);
      expect(result.snippet).not.toContain("upstream boom");
    }
  });

  it("treats a network throw as NOT refused with status 0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusedBeforeBilling).toBe(false);
      expect(result.status).toBe(0);
    }
  });

  it("aborts after the 60s timeout and reports indeterminate (status 0, not refused)", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const provider = createElevenLabsVoiceProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const promise = provider.synthesize(synthInput());
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusedBeforeBilling).toBe(false);
      expect(result.status).toBe(0);
    }
  });

  it("honors the caller's AbortSignal (composed with the timeout)", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const provider = createElevenLabsVoiceProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const promise = provider.synthesize(synthInput({ signal: caller.signal }));
    caller.abort(new Error("caller gave up"));
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusedBeforeBilling).toBe(false);
      expect(result.status).toBe(0);
    }
  });

  it("never lets the script text or audio bytes leak into any error result", async () => {
    // 4xx path (body excerpt surfaced) and network path (short reason) — the
    // request text must appear in NEITHER result.
    const refusedFetch = vi.fn(
      async () => new Response("bad request from vendor", { status: 422 }),
    );
    const refused = await createElevenLabsVoiceProvider({
      apiKey: "k",
      fetchImpl: refusedFetch,
    }).synthesize(synthInput());
    expect(JSON.stringify(refused)).not.toContain(SCRIPT_TEXT);

    const throwFetch = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const thrown = await createElevenLabsVoiceProvider({
      apiKey: "k",
      fetchImpl: throwFetch,
    }).synthesize(synthInput());
    expect(JSON.stringify(thrown)).not.toContain(SCRIPT_TEXT);
  });
});
