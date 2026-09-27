import type { Dispatcher } from "undici";

import { fetchWithEgress } from "./fetch.ts";

// AI media describer downloads (docs/runbooks/ai-media-describe.md). The only
// hub code that fetches chat media bytes. The bytes stay in this process's
// memory and go straight to the describer; nothing here writes a file, a row
// or a log line containing the URL.
//
// Rules: https only; a fixed host allowlist (the platforms' media CDNs and the
// OFAPI cache CDN); redirects followed by hand and only onto the same
// allowlist; no platform auth, no cookies; a hard byte cap enforced while
// streaming; one bounded timeout for the whole download.

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
  | "transport";

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
  const signal = AbortSignal.timeout(input.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS);
  let current: URL;
  try {
    current = new URL(input.url);
  } catch {
    return { ok: false, reason: "host_not_allowed", httpStatus: null };
  }
  if (!isAllowedMediaHost(current)) {
    return { ok: false, reason: "host_not_allowed", httpStatus: null };
  }

  try {
    for (let hop = 0; ; hop += 1) {
      const init: RequestInit = {
        method: "GET",
        redirect: "manual",
        signal,
        // No credentials of any kind: CDN URLs are self-signed.
        credentials: "omit",
        headers: { accept: "image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1" },
      };
      const response = input.dispatcher
        ? await fetchWithEgress(fetchImpl, input.dispatcher, current, init)
        : await fetchImpl(current, init);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) {
          return { ok: false, reason: "http_status", httpStatus: response.status };
        }
        if (hop >= MAX_REDIRECTS) {
          return { ok: false, reason: "too_many_redirects", httpStatus: response.status };
        }
        const next = new URL(location, current);
        if (!isAllowedMediaHost(next)) {
          return { ok: false, reason: "redirect_not_allowed", httpStatus: response.status };
        }
        current = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "http_status", httpStatus: response.status };
      }
      const declared = Number(response.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large", httpStatus: 200 };
      }
      const bytes = await readBounded(response, maxBytes);
      if (bytes === null) {
        return { ok: false, reason: "too_large", httpStatus: 200 };
      }
      return { ok: true, bytes, contentType: response.headers.get("content-type") };
    }
  } catch (error) {
    return { ok: false, reason: isTimeout(error) ? "timeout" : "transport", httpStatus: null };
  }
}
