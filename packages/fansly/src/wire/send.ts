import { promisify } from "node:util";
import * as zlib from "node:zlib";

import type { Dispatcher } from "undici";

import { classifyTransportError, sanitizeError } from "@agency_hub_core/shared";

import {
  composeFanslySendCheck,
  findFanslySendRefusal,
  FanslySendRefusedError,
  type FanslySendCheck,
} from "../send-guard.ts";
import type { FanslyWireOutcome, FanslyWireRequest, FanslyWireSendHooks } from "./types.ts";

// The one place the engine's Fansly request leaves the process (plan §2.4).
// One call = one physical request: `Dispatcher.request` follows no redirect
// and re-sends nothing (a 3xx or a 421 is the answer, read as such); the send
// check is composed onto the page's dispatcher for THIS request only, closing
// over this admission (never an AsyncLocalStorage read inside the hook); and
// whatever the hook refuses never writes a byte.

/** A body larger than this is not read to the end: the request failed. */
export const FANSLY_WIRE_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Undici's own guard against a stack of content codings (decompression
 *  chains are a resource-exhaustion vector). */
const MAX_CONTENT_CODINGS = 5;

/** Statuses whose body is null by definition; their coding is never decoded. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The admission's check, made one-shot for this send: the first dispatch asks
 * `check`, any further dispatch of the same send (a redirect hop, a hidden
 * re-send — none exists on this path, which is why this is a belt) is refused
 * as `lease_used` without asking again. Records whether a dispatch reached the
 * check and whether the request went out.
 */
export function createOneShotSendCheck(check: FanslySendCheck): {
  readonly check: FanslySendCheck;
  /** A dispatch reached `onRequestStart`: from here undici owns the abort. */
  readonly asked: boolean;
  readonly sent: boolean;
  readonly refusal: FanslySendRefusedError | null;
} {
  let asked = false;
  let sent = false;
  let refusal: FanslySendRefusedError | null = null;
  return {
    check() {
      if (asked) {
        return new FanslySendRefusedError("lease_used");
      }
      asked = true;
      const verdict = check();
      if (verdict === null) {
        sent = true;
      } else {
        refusal = verdict;
      }
      return verdict;
    },
    get asked() {
      return asked;
    },
    get sent() {
      return sent;
    },
    get refusal() {
      return refusal;
    },
  };
}

/**
 * Send one Fansly request through `dispatcher` (the page's proxy dispatcher).
 * `req.timeoutMs` bounds the WHOLE call — connect and proxy tunnel, headers
 * and a drip-fed body alike (undici's own header/body timeouts are inactivity
 * timers of the origin request only). `signal` cancels it (shutdown) at once.
 * Never throws for a request outcome.
 */
export function sendFanslyWireRequest(
  dispatcher: Dispatcher,
  req: FanslyWireRequest,
  hooks: FanslyWireSendHooks,
  signal: AbortSignal,
): Promise<FanslyWireOutcome> {
  return sendOnce(dispatcher, { url: req.url, headers: req.headers, timeoutMs: req.timeoutMs }, hooks, signal, async (response) => {
    const raw = await readBoundedBody(response.body, FANSLY_WIRE_MAX_BODY_BYTES);
    if (raw === null) throw new Error(`Fansly response body exceeds ${FANSLY_WIRE_MAX_BODY_BYTES} bytes`);
    const headers = flattenHeaders(response.headers);
    const body = NULL_BODY_STATUSES.has(response.statusCode)
      ? raw
      : await decodeContent(raw, headers["content-encoding"]);
    return {
      status: response.statusCode,
      headers,
      bodyText: new TextDecoder("utf-8").decode(body),
      bodyBytes: raw.length,
    };
  });
}

/** The `accept` header of a media download, as the browser's image request
 *  sends it (and the legacy describer download always has). */
export const FANSLY_CDN_ACCEPT = "image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1";

/** The body of a non-2xx CDN answer is read at most this far, then dropped. */
const CDN_DISCARD_LIMIT_BYTES = 64 * 1024;

export interface FanslyCdnRequest {
  /** The signed CDN URL of this hop. The caller has checked its host. */
  url: string;
  /** Total budget of the hop, as for an API request. */
  timeoutMs: number;
  /** A body larger than this is not read to the end (`bodyOverflow`). */
  maxBytes: number;
}

/**
 * One hop of a media CDN download (`cdn.media`), the CDN twin of
 * `sendFanslyWireRequest`: the same one-shot send check composed onto the
 * page's dispatcher, the same total budget, `Dispatcher.request` (a 3xx is
 * the answer — the next hop is the next admission, never followed here), no
 * session headers and no cookies (a signed CDN URL authorizes itself), the
 * browser's image `accept`. The body of a 2xx is bounded while it streams
 * (and refused up front when its declared length is over the cap): an
 * oversized file is an answer (`bodyOverflow`), not a transport failure. The
 * bytes come back as `bodyBuffer`; nothing here keeps or logs the URL.
 */
export function sendFanslyCdnRequest(
  dispatcher: Dispatcher,
  req: FanslyCdnRequest,
  hooks: FanslyWireSendHooks,
  signal: AbortSignal,
): Promise<FanslyWireOutcome> {
  if (!Number.isSafeInteger(req.maxBytes) || req.maxBytes <= 0) {
    throw new RangeError(`A CDN hop's byte cap must be a positive integer (got ${req.maxBytes})`);
  }
  return sendOnce(dispatcher, { url: req.url, headers: { accept: FANSLY_CDN_ACCEPT }, timeoutMs: req.timeoutMs }, hooks, signal, async (response) => {
    const headers = flattenHeaders(response.headers);
    const status = response.statusCode;
    const answer = (body: Buffer | null, bytes: number, overflow: boolean) => ({
      status,
      headers,
      bodyText: "",
      bodyBytes: bytes,
      ...(body === null ? {} : { bodyBuffer: body }),
      ...(overflow ? { bodyOverflow: true } : {}),
    });
    if (status < 200 || status > 299) {
      await response.body.dump({ limit: CDN_DISCARD_LIMIT_BYTES }).catch(() => undefined);
      return answer(null, 0, false);
    }
    const declared = Number(headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > req.maxBytes) {
      discard(response.body);
      return answer(null, 0, true);
    }
    const raw = await readBoundedBody(response.body, req.maxBytes);
    if (raw === null) return answer(null, req.maxBytes, true);
    const body = await decodeContent(raw, headers["content-encoding"]);
    return body.length > req.maxBytes ? answer(null, raw.length, true) : answer(body, raw.length, false);
  });
}

type ReadAnswer = (response: Dispatcher.ResponseData) => Promise<{
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyBytes: number;
  bodyBuffer?: Buffer;
  bodyOverflow?: boolean;
}>;

/** One physical GET through the one-shot check, under a total budget. */
async function sendOnce(
  dispatcher: Dispatcher,
  req: { url: string; headers: Record<string, string>; timeoutMs: number },
  hooks: FanslyWireSendHooks,
  signal: AbortSignal,
  read: ReadAnswer,
): Promise<FanslyWireOutcome> {
  const abort = new AbortController();
  let timedOut = false;

  // A cancelled or timed-out request can still reach `onRequestStart` once its
  // tunnel comes up (undici aborts it right there, before the headers): it
  // must not ask the admission, which would count a send that never happens.
  const gate = createOneShotSendCheck(() => {
    if (abort.signal.aborted) {
      return new FanslySendRefusedError(timedOut ? "send_deadline_passed" : "lease_inactive");
    }
    return hooks.check();
  });

  // Before `onRequestStart` undici only records an abort and applies it once
  // the connection — and the proxy's CONNECT — is up, which a proxy that
  // accepts TCP and never answers delays by minutes. So this call settles by
  // itself the moment its abort fires before the admission was asked. That is
  // final: from then on the gate above refuses every dispatch, so a tunnel
  // that comes up later carries no request byte; the abandoned dispatch
  // settles in the background and its result is dropped.
  let settleUnsent: (outcome: FanslyWireOutcome) => void = () => undefined;
  const unsent = new Promise<FanslyWireOutcome>((resolve) => {
    settleUnsent = resolve;
  });
  const onAbort = () => {
    if (gate.asked) return;
    settleUnsent(timedOut
      ? {
        kind: "timeout",
        sent: false,
        message: `TimeoutError: Fansly request exceeded its ${req.timeoutMs} ms budget before the transport was ready`,
      }
      : { kind: "aborted_before_send", refusal: "lease_inactive" });
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });

  // One controller per request, fed by the caller's signal and the total
  // budget; both listeners are dropped when the call settles, so a
  // long-lived shutdown signal accumulates nothing across requests.
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort(new DOMException(`Fansly request exceeded its ${req.timeoutMs} ms budget`, "TimeoutError"));
  }, req.timeoutMs);
  const onCancel = () => abort.abort(signal.reason);
  if (signal.aborted) onCancel();
  else signal.addEventListener("abort", onCancel, { once: true });

  const failed = (error: unknown): FanslyWireOutcome => {
    const refusal = findFanslySendRefusal(error) ?? gate.refusal;
    if (!gate.sent && refusal !== null) {
      return { kind: "aborted_before_send", refusal: refusal.reason };
    }
    const message = sanitizeError(error, { format: "chain" }).message;
    if (timedOut) {
      return { kind: "timeout", sent: gate.sent, message };
    }
    // The caller's cancel is not a timeout, whatever the error is named.
    if (signal.aborted) {
      return { kind: "transport_error", sent: gate.sent, message: `cancelled: ${message}` };
    }
    return classifyTransportError(error) === "timeout"
      ? { kind: "timeout", sent: gate.sent, message }
      : { kind: "transport_error", sent: gate.sent, message };
  };

  const exchange = async (): Promise<FanslyWireOutcome> => {
    try {
      const target = new URL(req.url);
      const response = await composeFanslySendCheck(dispatcher, gate.check).request({
        origin: target.origin,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: req.headers,
        signal: abort.signal,
        headersTimeout: req.timeoutMs,
        bodyTimeout: req.timeoutMs,
      });
      const answer = await read(response);
      return { kind: "response", ...answer, sendMark: gate.sent ? "request_start" : "completion_fallback" };
    } catch (error) {
      return failed(error);
    }
  };

  try {
    // A call cancelled before it started dispatches nothing: not even a tunnel.
    return await (abort.signal.aborted ? unsent : Promise.race([exchange(), unsent]));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCancel);
    abort.signal.removeEventListener("abort", onAbort);
  }
}

/** Stop reading a body: its connection is dropped, and the abort undici
 *  reports for it is expected, not an error of anyone's. */
function discard(body: Dispatcher.ResponseData["body"]): void {
  body.on("error", () => undefined);
  body.destroy();
}

/** The body, or null when it passed `maxBytes` (the rest is not read). */
async function readBoundedBody(body: Dispatcher.ResponseData["body"], maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      discard(body);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function flattenHeaders(headers: Dispatcher.ResponseData["headers"]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

type Decoder = (input: Buffer) => Promise<Buffer>;

const gunzip = promisify(zlib.gunzip) as (input: Buffer, options: zlib.ZlibOptions) => Promise<Buffer>;
const inflate = promisify(zlib.inflate) as (input: Buffer, options: zlib.ZlibOptions) => Promise<Buffer>;
const inflateRaw = promisify(zlib.inflateRaw) as (input: Buffer, options: zlib.ZlibOptions) => Promise<Buffer>;
const brotliDecompress = promisify(zlib.brotliDecompress) as
  (input: Buffer, options: zlib.BrotliOptions) => Promise<Buffer>;
const zstdDecompress = typeof zlib.zstdDecompress === "function"
  ? promisify(zlib.zstdDecompress) as (input: Buffer, options: zlib.ZstdOptions) => Promise<Buffer>
  : null;

// The lenient flush modes of the browser-grade decoder (undici's fetch): a
// stream that ends without its trailer still yields what it carried.
const ZLIB_OPTIONS: zlib.ZlibOptions = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH,
  maxOutputLength: FANSLY_WIRE_MAX_BODY_BYTES,
};

/** One decoder per coding the browser decodes. `deflate` is the zlib wrapper
 *  when the first byte says so and a raw stream otherwise, as fetch reads it. */
function decoderFor(coding: string): Decoder | null {
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return (input) => gunzip(input, ZLIB_OPTIONS);
    case "deflate":
      return (input) => ((input[0] ?? 0) & 0x0f) === 0x08
        ? inflate(input, ZLIB_OPTIONS)
        : inflateRaw(input, ZLIB_OPTIONS);
    case "br":
      return (input) => brotliDecompress(input, {
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
        maxOutputLength: FANSLY_WIRE_MAX_BODY_BYTES,
      });
    case "zstd":
      return zstdDecompress === null
        ? null
        : (input) => zstdDecompress(input, {
          flush: zlib.constants.ZSTD_e_continue,
          finishFlush: zlib.constants.ZSTD_e_end,
          maxOutputLength: FANSLY_WIRE_MAX_BODY_BYTES,
        });
    default:
      return null;
  }
}

/**
 * Undo the response's content codings, last applied first, exactly where the
 * browser (and undici's `fetch`, which the legacy adapter used) would: the
 * request advertises the HAR's `accept-encoding`, so the answer may be
 * compressed. A coding the browser cannot decode leaves the whole body as
 * received (fetch does the same).
 */
async function decodeContent(raw: Buffer, contentEncoding: string | undefined): Promise<Buffer> {
  if (contentEncoding === undefined || raw.length === 0) {
    return raw;
  }
  const codings = contentEncoding.length === 0
    ? []
    : contentEncoding.toLowerCase().split(",").map((coding) => coding.trim());
  if (codings.length > MAX_CONTENT_CODINGS) {
    throw new Error(`Fansly response has ${codings.length} content codings (at most ${MAX_CONTENT_CODINGS})`);
  }
  const decoders: Decoder[] = [];
  for (const coding of [...codings].reverse()) {
    const decoder = decoderFor(coding);
    if (decoder === null) {
      return raw;
    }
    decoders.push(decoder);
  }
  let body = raw;
  for (const decoder of decoders) {
    body = await decoder(body);
  }
  return body;
}
