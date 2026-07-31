// Voice notes — the ElevenLabs TTS provider, behind the service-egress SOCKS5
// seam. Constructed at boot only when both ELEVENLABS_API_KEY and the complete
// proxy tuple exist; spend is gated live at admission (voiceNotesEnabled).
//
// Semantics the design mandates:
//   - EXACTLY ONE fetch per synthesize() — ZERO retries anywhere.
//   - 60s timeout via AbortSignal, composed with the caller's signal.
//   - refusedBeforeBilling is true ONLY for pre-synthesis rejections (HTTP 4xx:
//     auth / validation / not-found). 5xx, network errors, and timeouts are NOT
//     refused — the caller treats those as possibly-billed → indeterminate.
//   - NEVER log or return the script text or the audio bytes. The only body
//     excerpt surfaced is a bounded 4xx response snippet (never the request);
//     5xx / network / timeout carry a bounded, redacted reason.
//
// The API key is captured in the factory closure and never leaves it (mirrors
// the Anthropic provider's createSdkClient key encapsulation). Constructed at
// boot whenever the key + proxy tuple are set (independent of the live
// voiceNotesEnabled flag, which is the admission-time spend gate).

import {
  classifyTransportFailure,
  redactSensitiveText,
  sanitizeError,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import { fetchWithEgress } from "./egress/fetch.ts";

const ELEVENLABS_TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const SYNTHESIS_TIMEOUT_MS = 60_000;
const SNIPPET_MAX_CHARS = 200;
const SNIPPET_MAX_BYTES = 1024;

/**
 * Hard ceiling on a rendered artifact, in bytes (2 MiB) — the SINGLE source of
 * truth for the size cap, mirrored by the `voice_notes_audio_cap` DB CHECK in
 * migration 0109. The provider refuses an oversize body (never buffers it),
 * and the service guards `result.audio.byteLength` before the terminal settle,
 * so an oversize synthesis can never crash the CHECK and fall through to
 * indeterminate. Imported by the voice-notes service — never redeclared.
 */
export const VOICE_AUDIO_MAX_BYTES = 2_097_152;
/** voice_notes.billed_chars is PostgreSQL INTEGER. */
export const VOICE_CHARACTER_COST_MAX = 2_147_483_647;

export function isValidVoiceCharacterCost(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= VOICE_CHARACTER_COST_MAX;
}

export type VoiceTtsFailureKind =
  | "connect"
  | "timeout"
  | "transport"
  | "redirect"
  | "http_4xx"
  | "http_5xx"
  | "http_error"
  | "invalid_response";

export interface VoiceTtsProvider {
  synthesize(input: {
    voiceId: string;
    model: string;
    settings: Record<string, unknown>;
    outputFormat: string;
    text: string;
    signal: AbortSignal;
    dispatcher: Dispatcher;
  }): Promise<
    | {
        ok: true;
        audio: Buffer;
        characterCost: number | null;
        requestId: string | null;
        traceId: string | null;
        region: string | null;
      }
    | {
        ok: false;
        refusedBeforeBilling: boolean;
        status: number;
        snippet: string;
        failureKind: VoiceTtsFailureKind;
        detail: string;
      }
  >;
}

export interface CreateElevenLabsVoiceProviderOptions {
  apiKey: string;
  /** Test seam: replaces the global fetch. Defaults to the process fetch. */
  fetchImpl?: typeof fetch;
}

function parseNumberHeader(raw: string | null): number | null {
  if (raw == null || raw.trim().length === 0) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseCharacterCostHeader(raw: string | null): number | null {
  const value = parseNumberHeader(raw);
  return value !== null && isValidVoiceCharacterCost(value)
    ? value
    : null;
}

/** Read at most `maxBytes` from a response body. The reader is cancelled as
 * soon as the cap is crossed, so a chunked response can never be accumulated
 * without bound. */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Buffer; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: Buffer.alloc(0), exceeded: false };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return { bytes: Buffer.concat(chunks, total), exceeded: false };
      }
      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
        }
        await reader.cancel("response body exceeds configured size cap").catch(() => {});
        return { bytes: Buffer.concat(chunks, total), exceeded: true };
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

function contentTypeIsMp3(response: Response): boolean {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return contentType === "audio/mpeg";
}

function mp3FrameLength(bytes: Buffer, offset: number): number | null {
  if (bytes.byteLength < offset + 4) {
    return null;
  }
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
    return null;
  }
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  // MP3 is MPEG Audio Layer III; version 01 is reserved.
  if (version === 1 || layer !== 1) {
    return null;
  }
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) {
    return null;
  }
  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateKbps = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex];
  if (bitrateKbps === undefined || baseSampleRate === undefined) {
    return null;
  }
  const sampleRate = version === 3
    ? baseSampleRate
    : version === 2
      ? baseSampleRate / 2
      : baseSampleRate / 4;
  const padding = (b2 >> 1) & 0x01;
  return Math.floor(((version === 3 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
}

/** Validate enough MP3 structure to reject JSON/HTML, empty, ID3-only, and
 * truncated successful responses without trying to fully decode the take. */
function isMp3Artifact(bytes: Buffer): boolean {
  let frameOffset = 0;
  if (bytes.byteLength >= 3 && bytes.subarray(0, 3).equals(Buffer.from("ID3"))) {
    if (bytes.byteLength < 10) {
      return false;
    }
    const sizeBytes = bytes.subarray(6, 10);
    if ([...sizeBytes].some((value) => (value & 0x80) !== 0)) {
      return false;
    }
    const tagSize = ((sizeBytes[0]! << 21) | (sizeBytes[1]! << 14)
      | (sizeBytes[2]! << 7) | sizeBytes[3]!) >>> 0;
    const footerSize = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
    frameOffset = 10 + tagSize + footerSize;
  }
  const frameLength = mp3FrameLength(bytes, frameOffset);
  return frameLength !== null && bytes.byteLength >= frameOffset + frameLength;
}

/** Bounded excerpt of a 4xx response body — validation/auth detail, capped so a
 * verbose vendor body can never balloon a log line. Body-read failures fall
 * back to a status-only reason (never the request). */
async function readBoundedSnippet(response: Response): Promise<string> {
  try {
    const { bytes } = await readBoundedBody(response, SNIPPET_MAX_BYTES);
    const text = new TextDecoder().decode(bytes);
    return text.slice(0, SNIPPET_MAX_CHARS);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function sanitizeDetail(value: string, secrets: string[]): string {
  let detail = redactSensitiveText(value);
  for (const secret of secrets) {
    if (secret.length >= 4) {
      detail = detail.replaceAll(secret, "[REDACTED]");
    } else if (secret.length > 0) {
      // Test/misconfiguration keys can be very short. Replacing every character
      // would destroy useful diagnostics ("key" for a one-byte "k"), but a
      // standalone occurrence such as `key=k` still must be removed.
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      detail = detail.replace(
        new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "g"),
        (_match, prefix: string) => `${prefix}[REDACTED]`,
      );
    }
  }
  return detail.slice(0, SNIPPET_MAX_CHARS);
}

function failure(
  input: {
    refusedBeforeBilling: boolean;
    status: number;
    failureKind: VoiceTtsFailureKind;
    detail: string;
  },
) {
  return {
    ok: false as const,
    ...input,
    snippet: input.detail,
  };
}

export function createElevenLabsVoiceProvider(
  options: CreateElevenLabsVoiceProviderOptions,
): VoiceTtsProvider {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new Error("ElevenLabs voice provider requires an API key");
  }
  const doFetch: typeof fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async synthesize(input) {
      const url =
        `${ELEVENLABS_TTS_BASE}/${encodeURIComponent(input.voiceId)}`
        + `?output_format=${encodeURIComponent(input.outputFormat)}`;

      const requestBody: Record<string, unknown> = {
        text: input.text,
        model_id: input.model,
      };
      if (Object.keys(input.settings).length > 0) {
        requestBody.voice_settings = input.settings;
      }

      // One attempt, one deadline: an internal controller that aborts on EITHER
      // the 60s timeout OR the caller's signal. Zero retries — the caller owns
      // recovery.
      const controller = new AbortController();
      let timedOut = false;
      const onTimeout = () => {
        timedOut = true;
        controller.abort(new Error("ElevenLabs synthesis timed out after 60s"));
      };
      const onCallerAbort = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) {
        controller.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const timeout = setTimeout(onTimeout, SYNTHESIS_TIMEOUT_MS);
      try {
        const response = await fetchWithEgress(doFetch, input.dispatcher, url, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
          // A redirect would replay the custom API-key header and private script
          // body to the redirect target, and would violate the one-POST law.
          redirect: "error",
        });

        if (response.ok) {
          // Oversize guard, in two layers. (1) If the vendor advertises a
          // content-length over the cap, abort the body read entirely — never
          // buffer megabytes we will only discard. (2) Absent a content-length,
          // stream with the same hard cap. Either way an oversize body is a DEFINITE,
          // non-refused failure that keeps its HTTP status: the synthesis was
          // billed, so the caller settles failed_after_dispatch (billed-unknown)
          // rather than letting the DB CHECK crash the terminal settle.
          const advertised = parseNumberHeader(response.headers.get("content-length"));
          if (advertised != null && advertised > VOICE_AUDIO_MAX_BYTES) {
            await response.body?.cancel().catch(() => {});
            return failure({
              refusedBeforeBilling: false,
              status: response.status,
              failureKind: "invalid_response",
              detail: "audio exceeds size cap",
            });
          }
          if (!contentTypeIsMp3(response)) {
            await response.body?.cancel().catch(() => {});
            return failure({
              refusedBeforeBilling: false,
              status: response.status,
              failureKind: "invalid_response",
              detail: "unexpected audio content type",
            });
          }
          const body = await readBoundedBody(response, VOICE_AUDIO_MAX_BYTES);
          if (body.exceeded) {
            return failure({
              refusedBeforeBilling: false,
              status: response.status,
              failureKind: "invalid_response",
              detail: "audio exceeds size cap",
            });
          }
          const audio = body.bytes;
          if (!isMp3Artifact(audio)) {
            return failure({
              refusedBeforeBilling: false,
              status: response.status,
              failureKind: "invalid_response",
              detail: "invalid MP3 artifact",
            });
          }
          return {
            ok: true,
            audio,
            characterCost: parseCharacterCostHeader(response.headers.get("character-cost")),
            requestId: response.headers.get("request-id"),
            traceId: response.headers.get("x-trace-id"),
            region: response.headers.get("x-region"),
          };
        }

        // 4xx = a pre-synthesis rejection (auth / validation / not-found): the
        // vendor never began billing. Surface a bounded body excerpt.
        if (response.status >= 400 && response.status < 500) {
          const detail = sanitizeDetail(await readBoundedSnippet(response), [
            apiKey,
            input.text,
          ]);
          return failure({
            refusedBeforeBilling: true,
            status: response.status,
            failureKind: "http_4xx",
            detail,
          });
        }

        // 5xx (or any other non-ok): synthesis may have begun → possibly billed.
        // NOT refused, and the 5xx body is deliberately not surfaced.
        return failure({
          refusedBeforeBilling: false,
          status: response.status,
          failureKind: response.status >= 500 ? "http_5xx" : "http_error",
          detail: `HTTP ${response.status}`,
        });
      } catch (error) {
        // Network failure, caller abort, or the 60s timeout: no HTTP status, and
        // billing is indeterminate → NOT refused.
        const observed = sanitizeDetail(sanitizeError(error, { format: "chain" }).message, [
          apiKey,
          input.text,
        ]);
        const failureKind = timedOut
          ? "timeout"
          : observed.toLowerCase().includes("redirect")
            ? "redirect"
            : classifyTransportFailure(error);
        return failure({
          refusedBeforeBilling: false,
          status: 0,
          failureKind,
          detail: observed,
        });
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
