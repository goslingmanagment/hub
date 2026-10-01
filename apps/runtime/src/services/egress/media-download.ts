import type { FanslySendGuard, FanslySendLease } from "@agency_hub_core/fansly";
import type { Dispatcher } from "undici";

import { fetchWithEgress } from "./fetch.ts";
import { fanslySendFailureOutcome, isFanslyHost } from "./fansly-send-lease.ts";

// AI media describer downloads (docs/runbooks/ai-media-describe.md). The only
// hub code that fetches chat media bytes. The bytes stay in this process's
// memory and go straight to the describer; nothing here writes a file, a row
// or a log line containing the URL.
//
// Rules: https only; a fixed host allowlist (the platforms' media CDNs and the
// OFAPI cache CDN); redirects followed by hand and only onto the same
// allowlist; no platform auth, no cookies; a hard byte cap enforced while
// streaming; one bounded timeout per hop.
//
// Plan §2.4/§2.5: a Fansly CDN hop is a request of the page and goes through
// the page's send guard (source `media_download`): each physical hop is its
// own capture (a redirect is a new one), the hop's timeout runs from its
// capture, and the hop completes after its body was read or cancelled. A
// Fansly hop without a guard is refused before anything is sent.

export const MEDIA_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;

const ALLOWED_HOST_PATTERNS = [
  /^cdn[0-9a-z-]*\.fansly\.com$/,
  /^cdn[0-9a-z-]*\.onlyfans\.com$/,
  /^cdn\.fansapi\.com$/,
];

export function isAllowedMediaHost(url: URL) {
  return url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && (url.port === "" || url.port === "443")
    && ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname.toLowerCase()));
}

export type MediaDownloadFailure =
  | "host_not_allowed"
  | "redirect_not_allowed"
  | "too_many_redirects"
  | "http_status"
  | "too_large"
  | "timeout"
  | "transport"
  /** A Fansly hop with no send guard, or the page's guard refused it (the page
   *  is closed, or this process is shutting down). Nothing was sent. */
  | "send_guard";

export type MediaDownloadResult =
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; reason: MediaDownloadFailure; httpStatus: number | null };

export interface DownloadMediaInput {
  url: string;
  dispatcher: Dispatcher | null;
  /** The send guard of the page whose egress `dispatcher` is. Required for a
   *  Fansly CDN hop; other hosts never use it. */
  fanslySendGuard: FanslySendGuard | null;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  const body = response.body;
  if (!body) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export async function downloadMediaForDescribe(input: DownloadMediaInput): Promise<MediaDownloadResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxBytes = input.maxBytes ?? MEDIA_DOWNLOAD_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
  let current: URL;
  try {
    current = new URL(input.url);
  } catch {
    return { ok: false, reason: "host_not_allowed", httpStatus: null };
  }
  if (!isAllowedMediaHost(current)) {
    return { ok: false, reason: "host_not_allowed", httpStatus: null };
  }

  for (let hop = 0; ; hop += 1) {
    const guarded = isFanslyHost(current.hostname);
    if (guarded && (!input.fanslySendGuard || !input.dispatcher)) {
      // Never through a page's egress, or direct, without a capture.
      return { ok: false, reason: "send_guard", httpStatus: null };
    }
    let lease: FanslySendLease | null = null;
    if (guarded) {
      try {
        lease = await input.fanslySendGuard!.acquire({ operation: "media_download", requestTimeoutMs: timeoutMs });
      } catch {
        return { ok: false, reason: "send_guard", httpStatus: null };
      }
    }
    const step = await downloadHop(input, fetchImpl, current, lease, { maxBytes, timeoutMs });
    if (step.kind === "done") {
      return step.result;
    }
    if (hop >= MAX_REDIRECTS) {
      return { ok: false, reason: "too_many_redirects", httpStatus: step.httpStatus };
    }
    const next = new URL(step.location, current);
    if (!isAllowedMediaHost(next)) {
      return { ok: false, reason: "redirect_not_allowed", httpStatus: step.httpStatus };
    }
    current = next;
  }
}

type HopResult =
  | { kind: "done"; result: MediaDownloadResult }
  | { kind: "redirect"; location: string; httpStatus: number };

/** One physical request. With a lease, it is the lease's one request, and the
 *  lease completes when this returns (body read or cancelled, or failed). */
async function downloadHop(
  input: DownloadMediaInput,
  fetchImpl: typeof fetch,
  url: URL,
  lease: FanslySendLease | null,
  limits: { maxBytes: number; timeoutMs: number },
): Promise<HopResult> {
  let httpStatus: number | null = null;
  let failure: unknown = null;
  try {
    const init: RequestInit = {
      method: "GET",
      redirect: "manual",
      // From the capture (or the hop's start without a guard).
      signal: AbortSignal.timeout(limits.timeoutMs),
      // No credentials of any kind: CDN URLs are self-signed.
      credentials: "omit",
      headers: { accept: "image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1" },
    };
    const dispatcher = input.dispatcher && lease ? lease.bind(input.dispatcher) : input.dispatcher;
    const response = dispatcher
      ? await fetchWithEgress(fetchImpl, dispatcher, url, init)
      : await fetchImpl(url, init);
    httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        return { kind: "done", result: { ok: false, reason: "http_status", httpStatus: response.status } };
      }
      return { kind: "redirect", location, httpStatus: response.status };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "done", result: { ok: false, reason: "http_status", httpStatus: response.status } };
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "done", result: { ok: false, reason: "too_large", httpStatus: 200 } };
    }
    const bytes = await readBounded(response, limits.maxBytes);
    if (bytes === null) {
      return { kind: "done", result: { ok: false, reason: "too_large", httpStatus: 200 } };
    }
    return { kind: "done", result: { ok: true, bytes, contentType: response.headers.get("content-type") } };
  } catch (error) {
    failure = error;
    const refused = lease?.sendRefused === true && !lease.sent;
    return {
      kind: "done",
      result: {
        ok: false,
        reason: refused ? "send_guard" : isTimeout(error) ? "timeout" : "transport",
        httpStatus: null,
      },
    };
  } finally {
    await lease?.complete(httpStatus !== null
      ? { outcome: "response", httpStatus }
      : { outcome: fanslySendFailureOutcome(failure) });
  }
}
