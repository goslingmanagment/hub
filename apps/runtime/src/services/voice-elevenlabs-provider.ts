// Voice notes — the ElevenLabs TTS provider, behind the egress seam as a
// NON-platform vendor class (egress key "vendor:elevenlabs": direct, unpaced;
// never in PLATFORM_VENDORS / EGRESS_VENDOR_PROVIDERS). Constructed at boot when
// ELEVENLABS_API_KEY is set; spend is gated live at admission (voiceNotesEnabled).
//
// Semantics the design mandates:
//   - EXACTLY ONE fetch per synthesize() — ZERO retries anywhere.
//   - 60s timeout via AbortSignal, composed with the caller's signal.
//   - refusedBeforeBilling is true ONLY for pre-synthesis rejections (HTTP 4xx:
//     auth / validation / not-found). 5xx, network errors, and timeouts are NOT
//     refused — the caller treats those as possibly-billed → indeterminate.
//   - NEVER log or return the script text or the audio bytes. The only body
//     excerpt surfaced is a bounded 4xx response snippet (never the request);
//     5xx / network / timeout carry a short, text-free reason.
//
// The API key is captured in the factory closure and never leaves it (mirrors
// the Anthropic provider's createSdkClient key encapsulation). Constructed at
// boot whenever ELEVENLABS_API_KEY is set (independent of the live
// voiceNotesEnabled flag, which is the admission-time spend gate).

const ELEVENLABS_TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const SYNTHESIS_TIMEOUT_MS = 60_000;
const SNIPPET_MAX_CHARS = 200;

/**
 * Hard ceiling on a rendered artifact, in bytes (2 MiB) — the SINGLE source of
 * truth for the size cap, mirrored by the `voice_notes_audio_cap` DB CHECK in
 * migration 0106. The provider refuses an oversize body (never buffers it),
 * and the service guards `result.audio.byteLength` before the terminal settle,
 * so an oversize synthesis can never crash the CHECK and fall through to
 * indeterminate. Imported by the voice-notes service — never redeclared.
 */
export const VOICE_AUDIO_MAX_BYTES = 2_097_152;

export interface VoiceTtsProvider {
  synthesize(input: {
    voiceId: string;
    model: string;
    settings: Record<string, unknown>;
    outputFormat: string;
    text: string;
    signal: AbortSignal;
  }): Promise<
    | {
        ok: true;
        audio: Buffer;
        characterCost: number | null;
        requestId: string | null;
        traceId: string | null;
        region: string | null;
      }
    | { ok: false; refusedBeforeBilling: boolean; status: number; snippet: string }
  >;
}

export interface CreateElevenLabsVoiceProviderOptions {
  apiKey: string;
  /** Test seam: replaces the global fetch. Defaults to the process fetch. */
  fetchImpl?: typeof fetch;
}

function parseNumberHeader(raw: string | null): number | null {
  if (raw == null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Bounded excerpt of a 4xx response body — validation/auth detail, capped so a
 * verbose vendor body can never balloon a log line. Body-read failures fall
 * back to a status-only reason (never the request). */
async function readBoundedSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, SNIPPET_MAX_CHARS);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, SNIPPET_MAX_CHARS);
}

export function createElevenLabsVoiceProvider(
  options: CreateElevenLabsVoiceProviderOptions,
): VoiceTtsProvider {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new Error("ElevenLabs voice provider requires an API key");
  }
  // Direct, non-platform vendor egress — no page proxy / dispatcher to hide
  // behind, so the global fetch here is the one recorded raw-egress site for
  // this vendor (scripts/raw-fetch-budget.json).
  const doFetch: typeof fetch = options.fetchImpl
    ? options.fetchImpl
    : (input, init) => fetch(input, init);

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
      const onTimeout = () =>
        controller.abort(new Error("ElevenLabs synthesis timed out after 60s"));
      const onCallerAbort = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) {
        controller.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const timeout = setTimeout(onTimeout, SYNTHESIS_TIMEOUT_MS);

      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (response.ok) {
          // Oversize guard, in two layers. (1) If the vendor advertises a
          // content-length over the cap, abort the body read entirely — never
          // buffer megabytes we will only discard. (2) Absent a content-length,
          // buffer then measure. Either way an oversize body is a DEFINITE,
          // non-refused failure that keeps its HTTP status: the synthesis was
          // billed, so the caller settles failed_after_dispatch (billed-unknown)
          // rather than letting the DB CHECK crash the terminal settle.
          const advertised = parseNumberHeader(response.headers.get("content-length"));
          if (advertised != null && advertised > VOICE_AUDIO_MAX_BYTES) {
            await response.body?.cancel().catch(() => {});
            return {
              ok: false,
              refusedBeforeBilling: false,
              status: response.status,
              snippet: "audio exceeds size cap",
            };
          }
          const audio = Buffer.from(await response.arrayBuffer());
          if (audio.byteLength > VOICE_AUDIO_MAX_BYTES) {
            return {
              ok: false,
              refusedBeforeBilling: false,
              status: response.status,
              snippet: "audio exceeds size cap",
            };
          }
          return {
            ok: true,
            audio,
            characterCost: parseNumberHeader(response.headers.get("character-cost")),
            requestId: response.headers.get("request-id"),
            traceId: response.headers.get("x-trace-id"),
            region: response.headers.get("x-region"),
          };
        }

        // 4xx = a pre-synthesis rejection (auth / validation / not-found): the
        // vendor never began billing. Surface a bounded body excerpt.
        if (response.status >= 400 && response.status < 500) {
          return {
            ok: false,
            refusedBeforeBilling: true,
            status: response.status,
            snippet: await readBoundedSnippet(response),
          };
        }

        // 5xx (or any other non-ok): synthesis may have begun → possibly billed.
        // NOT refused, and the 5xx body is deliberately not surfaced.
        return {
          ok: false,
          refusedBeforeBilling: false,
          status: response.status,
          snippet: `HTTP ${response.status}`,
        };
      } catch (error) {
        // Network failure, caller abort, or the 60s timeout: no HTTP status, and
        // billing is indeterminate → NOT refused.
        return {
          ok: false,
          refusedBeforeBilling: false,
          status: 0,
          snippet: boundedReason(error),
        };
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
