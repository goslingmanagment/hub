import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createElevenLabsVoiceProvider,
  VOICE_AUDIO_MAX_BYTES,
  type VoiceTtsProvider,
} from "../apps/runtime/src/services/voice-elevenlabs-provider.ts";

// Voice notes — the ElevenLabs TTS provider over mandatory service egress.
// Every test drives the REAL provider through an injected fetch: the
// provider is under test, not a mock of it. Invariants exercised here:
// exactly one attempt (zero retries), the 4xx-refused vs 5xx/network/timeout
// indeterminate split, header capture, and that neither the script text nor the
// audio bytes ever leak into an error snippet.

const SCRIPT_TEXT = "SECRET_SCRIPT_hey babe this is my private voice note xoxo";
const FAKE_DISPATCHER = {} as Parameters<VoiceTtsProvider["synthesize"]>[0]["dispatcher"];

// One complete MPEG-1 Layer III frame: 128 kbps, 44.1 kHz, no padding.
// The first-frame structural check deliberately does not require a decoder.
function validMp3Bytes(totalBytes = 417): Uint8Array<ArrayBuffer> {
  if (totalBytes < 417) {
    throw new Error("validMp3Bytes needs room for one complete frame");
  }
  const bytes = new Uint8Array(new ArrayBuffer(totalBytes));
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  return bytes;
}

function validId3Mp3Bytes(): Uint8Array<ArrayBuffer> {
  const frame = validMp3Bytes();
  const bytes = new Uint8Array(new ArrayBuffer(10 + frame.byteLength));
  bytes.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  bytes.set(frame, 10);
  return bytes;
}

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
    dispatcher: FAKE_DISPATCHER,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ElevenLabs voice provider", () => {
  it("succeeds and captures every response header", async () => {
    const bytes = validMp3Bytes();
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
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

  it("succeeds with absent optional headers, yielding nulls (never undefined)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(validMp3Bytes(), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
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

  it("treats a blank character-cost header as unknown, never as zero", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(validMp3Bytes(), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "character-cost": "   " },
      }),
    );
    const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
      .synthesize(synthInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.characterCost).toBeNull();
    }
  });

  it.each(["-1", "1.5", "Infinity", "2147483648", "9007199254740992"])(
    "treats invalid character-cost %s as unknown",
    async (characterCost) => {
      const fetchImpl = vi.fn(
        async () => new Response(validMp3Bytes(), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "character-cost": characterCost },
        }),
      );
      const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
        .synthesize(synthInput());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.characterCost).toBeNull();
      }
    },
  );

  it("accepts a legitimate ID3-prefixed MP3 artifact", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(validId3Mp3Bytes(), {
        status: 200,
        headers: { "content-type": "Audio/MPEG; charset=binary" },
      }),
    );
    const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
      .synthesize(synthInput());
    expect(result.ok).toBe(true);
  });

  it("issues exactly one POST to the voice endpoint with the passed-through body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(), { status: 200 }),
    );
    const provider = createElevenLabsVoiceProvider({ apiKey: "secret-key", fetchImpl });

    await provider.synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit & { dispatcher: typeof FAKE_DISPATCHER },
    ];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice_1?output_format=mp3_44100_128",
    );
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.dispatcher).toBe(FAKE_DISPATCHER);
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
        expect(result.failureKind).toBe("http_4xx");
        expect(result.detail).toBe(result.snippet);
        expect(result.snippet).toContain("invalid api key");
        expect(result.snippet.length).toBeLessThanOrEqual(200);
        expect(result.snippet).not.toContain(SCRIPT_TEXT);
      }
    },
  );

  it("cancels an oversized 4xx body after a bounded snippet read", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("vendor error ".repeat(200)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 422 }));
    const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
      .synthesize(synthInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.snippet.length).toBeLessThanOrEqual(200);
    }
    expect(cancelled).toBe(true);
  });

  it("refuses an oversize body advertised via content-length WITHOUT buffering it", async () => {
    // A huge content-length header must short-circuit BEFORE arrayBuffer() — we
    // never allocate the megabytes. Prove it by making the body read explode: a
    // pre-buffer guard returns the size-cap failure, a post-buffer one would throw.
    const exploding = {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(VOICE_AUDIO_MAX_BYTES + 1),
        "content-type": "audio/mpeg",
      }),
      body: { cancel: async () => {} },
      arrayBuffer: async () => {
        throw new Error("body was buffered despite an over-cap content-length");
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => exploding);
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusedBeforeBilling).toBe(false); // possibly billed → indeterminate-ish
      expect(result.status).toBe(200); // keeps its HTTP status
      expect(result.snippet).toBe("audio exceeds size cap");
    }
  });

  it("refuses an oversize buffered body when no content-length is advertised", async () => {
    // No content-length header: buffer, then measure. An over-cap buffer is a
    // definite non-refused failure — never returned as ok:true audio. A stream
    // body carries no content-length, so this exercises the post-buffer guard.
    const bytes = validMp3Bytes(VOICE_AUDIO_MAX_BYTES + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusedBeforeBilling).toBe(false);
      expect(result.status).toBe(200);
      expect(result.snippet).toBe("audio exceeds size cap");
    }
  });

  it("accepts a body exactly at the size cap", async () => {
    const bytes = validMp3Bytes(VOICE_AUDIO_MAX_BYTES);
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    const provider = createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl });

    const result = await provider.synthesize(synthInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.audio.byteLength).toBe(VOICE_AUDIO_MAX_BYTES);
    }
  });

  it("rejects a successful response with the wrong MIME as possibly billed", async () => {
    const fetchImpl = vi.fn(async () => new Response(validMp3Bytes(), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
      .synthesize(synthInput());

    expect(result).toMatchObject({
      ok: false,
      refusedBeforeBilling: false,
      status: 200,
      snippet: "unexpected audio content type",
    });
  });

  it.each([
    ["empty", new Uint8Array()],
    ["JSON", new TextEncoder().encode('{"error":"upstream proxy page"}')],
    ["truncated MP3", new Uint8Array([0xff, 0xfb, 0x90, 0x64])],
  ])("rejects a successful audio/mpeg %s body as possibly billed", async (_name, bytes) => {
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
      .synthesize(synthInput());

    expect(result).toMatchObject({
      ok: false,
      refusedBeforeBilling: false,
      status: 200,
      snippet: "invalid MP3 artifact",
    });
  });

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
      expect(result.failureKind).toBe("http_5xx");
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
      expect(result.failureKind).toBe("transport");
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
      expect(result.failureKind).toBe("timeout");
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

  it("retains nested transport detail while redacting the key, script, and proxy credentials", async () => {
    const apiKey = "fake-elevenlabs-key";
    const credentialedProxyUrl =
      "socks5://fake-service-user:fake-service-password@proxy.example.internal:1080";
    const nested = Object.assign(new Error(
      `connect failed via ${credentialedProxyUrl} for ${apiKey} ${SCRIPT_TEXT}`,
    ), {
      name: "SocksClientError",
      code: "ECONNREFUSED",
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: nested });
    });

    const result = await createElevenLabsVoiceProvider({ apiKey, fetchImpl })
      .synthesize(synthInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      status: 0,
      failureKind: "connect",
    });
    expect(JSON.stringify(result)).toContain("cause(1)");
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("fake-service-user");
    expect(JSON.stringify(result)).not.toContain("fake-service-password");
    expect(JSON.stringify(result)).not.toContain(SCRIPT_TEXT);
  });

  it("redacts even an invalid one-character key when it appears as a standalone value", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("provider rejected api_key=k");
    });

    const result = await createElevenLabsVoiceProvider({ apiKey: "k", fetchImpl })
      .synthesize(synthInput());

    expect(JSON.stringify(result)).not.toContain("api_key=k");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });
});
