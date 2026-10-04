import { FANSLY_CDN_ACCEPT } from "@agency_hub_core/fansly";
import type { Dispatcher } from "undici";

import { fetchWithEgress } from "./fetch.ts";
import { isFanslyHost } from "./fansly-send-lease.ts";

// AI media describer downloads (docs/runbooks/ai-media-describe.md). The hub
// code that fetches chat media bytes of a page the Fansly Sync Engine does not
// run (OnlyFans). A Fansly page's actor downloads them as its own requests
// (`media-download.fetch`, under the same host policy: `isFanslyCdnUrl`). The
// bytes stay in this process's memory and go straight to the describer;
// nothing here writes a file, a row or a log line containing the URL.
//
// Rules: https only; a fixed host allowlist (the platforms' media CDNs and the
// OFAPI cache CDN); redirects followed by hand and only onto the same
// allowlist; no platform auth, no cookies; a hard byte cap enforced while
// streaming; one bounded timeout per hop.
//
// Plan §2.4: a Fansly CDN hop is a request of its page, and a page has one
// sender, its actor. This download never sends one: a Fansly host — the URL
// itself or a redirect onto one — is refused (`send_guard`) before anything is
// sent, and the row looks again later.

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

/** A URL the Fansly Sync Engine's CDN download may request: an allowed media
 *  host (https, no credentials, port 443) that is Fansly's — the engine's
 *  download is a request of a Fansly page (`media-download.fetch`). */
export function isFanslyCdnUrl(url: URL): boolean {
  return isAllowedMediaHost(url) && isFanslyHost(url.hostname);
}

export type MediaDownloadFailure =
  | "host_not_allowed"
  | "redirect_not_allowed"
  | "too_many_redirects"
  | "http_status"
  | "too_large"
  | "timeout"
  | "transport"
  /** Not sent: a hop only the page's own sender may make (a Fansly CDN host
   *  here; in the Sync Engine's download, a page that is held or switching). */
  | "send_guard";

export type MediaDownloadResult =
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; reason: MediaDownloadFailure; httpStatus: number | null };

export interface DownloadMediaInput {
  url: string;
  dispatcher: Dispatcher | null;
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
    if (isFanslyHost(current.hostname)) {
      // Never through a page's egress, or direct: only the page's actor sends
      // a Fansly request.
      return { ok: false, reason: "send_guard", httpStatus: null };
    }
    const step = await downloadHop(input, fetchImpl, current, { maxBytes, timeoutMs });
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

/** One physical request. */
async function downloadHop(
  input: DownloadMediaInput,
  fetchImpl: typeof fetch,
  url: URL,
  limits: { maxBytes: number; timeoutMs: number },
): Promise<HopResult> {
  try {
    const init: RequestInit = {
      method: "GET",
      redirect: "manual",
      // From the hop's start.
      signal: AbortSignal.timeout(limits.timeoutMs),
      // No credentials of any kind: CDN URLs are self-signed.
      credentials: "omit",
      headers: { accept: FANSLY_CDN_ACCEPT },
    };
    const response = input.dispatcher
      ? await fetchWithEgress(fetchImpl, input.dispatcher, url, init)
      : await fetchImpl(url, init);
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
    return { kind: "done", result: { ok: false, reason: isTimeout(error) ? "timeout" : "transport", httpStatus: null } };
  }
}
