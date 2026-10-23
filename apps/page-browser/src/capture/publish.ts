// The stand's publish capture (docs/plans/2026-10-23-wall-posts, plan PR 0.1;
// only an image built with `--capture publish` runs it — capture/mode.ts):
// each of the site's requests on the publishing paths, with what it sent and
// what it got, in the operator's `publish` journal
// (/data/buffer/logs/publish-<day>.jsonl) — what fansly-publish-contract.md
// is written from (docs/plans/2026-10-23-wall-posts/stand-session-0.2.md).
// Hub's own requests are never followed here, and Hub sends no write in the
// capture: its engine on the stand issues none.
//
// What is followed (CDP's Network domain: every tab, frame and worker):
//   publish    what the map opens in the capture (policy/operations.ts
//              `PUBLISH_CAPTURE_ROWS`, a part's PUT), whether it went or the
//              rules extension blocked it — its bodies;
//   read       the reads that show an upload, a post, a story, the walls and
//              tiers (`CAPTURE_READS`), and every read of the upload host —
//              its bodies;
//   preflight  the CORS preflight of a publishing path, and every preflight
//              to a host that is not the API's (the upload host, a storage
//              host): headers, never a body;
//   write      every other write of the site's, to any host — a closed one
//              the extension blocked, a third party's: what it was and how
//              it ended, never its bodies.
// A part's bytes are never read, nor a multipart form's (the site's
// single-request upload carries the file): their size is the content-length
// Chrome sent.
// A body is kept when it is JSON of at most `CAPTURE_BODY_MAX` bytes; any
// other is its size and SHA-256. Everything goes through capture/redact.ts
// first (CDN signatures, URL signatures, secret fields, e-mails, header
// values), then through the journal's scrubber.

import { createHash } from "node:crypto";

import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import { API_BASE, API_HOST, captureRowOf, decide as mapDecide, parseTemplate, templateMatches, UPLOAD_HOST } from "../policy/operations.ts";
import { wallMs } from "../shared/util.ts";
import { bodyRedacted, headersRedacted, urlRedacted } from "./redact.ts";

/** A body is kept as JSON up to this many bytes; a larger one, its size and
 *  hash. */
export const CAPTURE_BODY_MAX = 512 * 1024;
/** Requests followed at once, at most (the oldest is written and let go). */
export const CAPTURE_KEPT = 1_024;

/** The API reads (from `API_BASE`) whose answers show what a publication
 *  made: an upload's media, a post, a story, the walls and tiers it names. */
export const CAPTURE_READS: readonly string[] = [
  "/post/scheduled",
  "/post",
  "/timelinenew/:accountId",
  "/mediastories",
  "/mediastoriesnew",
  "/account/media",
  "/account/media/bundle",
  "/media",
  "/media/vaultnew",
  "/vault/albumsnew",
  "/account/walls",
  "/subscriptions/tiers",
];
const READS = CAPTURE_READS.map((template) => parseTemplate(template));

export type CaptureClass = "publish" | "read" | "preflight" | "write";

/** What the capture makes of a request of the site's (null: not followed). */
export function captureClassOf(method: string, rawUrl: string, resourceType: string | undefined): { what: CaptureClass; rule: string | null } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const verb = method.toUpperCase();
  const verdict = mapDecide({ method: verb, url: url.href, ...(resourceType === undefined ? {} : { resourceType }) }, "automation", true);
  if (verdict.action === "capture") return { what: "publish", rule: verdict.rule };
  const host = url.hostname;
  const apiPath = url.pathname === API_BASE || url.pathname.startsWith(`${API_BASE}/`) ? url.pathname.slice(API_BASE.length) || "/" : null;
  if (verb === "OPTIONS") {
    if (host !== API_HOST) return { what: "preflight", rule: null };
    const of = apiPath === null ? null : (["POST", "GET"] as const).map((m) => captureRowOf(API_HOST, m, apiPath)).find((row) => row !== null) ?? null;
    return of === null ? null : { what: "preflight", rule: `capture: ${of.method} ${of.host}${of.template}` };
  }
  if (verb === "GET" || verb === "HEAD") {
    if (host === UPLOAD_HOST) return { what: "read", rule: verdict.action === "refuse" ? verdict.rule : null };
    if (host !== API_HOST || apiPath === null) return null;
    const parts = apiPath.replace(/\/$/, "").split("/").slice(1);
    return READS.some((template) => templateMatches(template, parts)) ? { what: "read", rule: null } : null;
  }
  // A publishing write the capture does not open as written (another
  // spelling, not a script's) is still one: kept as a publish to show it.
  const blockedPublish = verdict.action === "refuse" && verdict.rule.startsWith("capture:");
  return { what: blockedPublish ? "publish" : "write", rule: verdict.action === "refuse" ? verdict.rule : null };
}

export interface CaptureBody {
  /** Bytes of the body (null: not known). */
  bytes: number | null;
  sha256: string | null;
  /** The body, redacted, when it is JSON of at most CAPTURE_BODY_MAX bytes. */
  json?: unknown;
  /** Why it is not here, when it is not. */
  note?: string;
}

export interface PublishLine {
  what: CaptureClass;
  /** The map's rule in the capture that decided it, when one did. */
  rule: string | null;
  /** CDP's request id, and the hop under it (each redirect the next). */
  id: string;
  hop: number;
  method: string;
  /** Its URL, the values of its signing params cut. */
  url: string;
  host: string;
  path: string;
  resourceType: string | null;
  startedAt: string;
  /** Chrome put its headers on the wire (null: it never did). */
  sentAt: string | null;
  endedAt: string;
  durationMs: number;
  status: number | null;
  /** Chrome's net error (null: an answer came). */
  error: string | null;
  /** The rules extension cancelled it. */
  blocked: boolean;
  /** Answered from a cache or the site's service worker, not the network. */
  source: "network" | "cache" | "service_worker";
  request: { headers: Record<string, string>; body: CaptureBody | null };
  response: { headers: Record<string, string>; encodedBytes: number | null; body: CaptureBody | null } | null;
}

interface Followed {
  id: string;
  hop: number;
  sessionId: string | null;
  what: CaptureClass;
  rule: string | null;
  method: string;
  url: string;
  resourceType: string | null;
  /** A part or a multipart form: its size only, never its bytes. */
  sizeOnly: boolean;
  startedWall: number;
  sentWall: number | null;
  requestHeaders: Record<string, string>;
  requestBody: Promise<CaptureBody | null>;
  status: number | null;
  responseHeaders: Record<string, string>;
  source: PublishLine["source"];
}

export interface PublishCaptureDeps {
  cdp: Pick<CdpPort, "on" | "send">;
  /** Network ids of Hub's own requests and the self-test's probes. */
  isOperatorRequest: (networkId: string) => boolean;
  write: (line: PublishLine) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function headerOf(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return String(value);
  return null;
}

/** A body as the capture keeps it: JSON, redacted, within the bound; else
 *  its size and hash. */
export function captureBody(data: Buffer | null, keep: boolean): CaptureBody | null {
  if (data === null) return null;
  const body: CaptureBody = { bytes: data.length, sha256: sha256(data) };
  if (!keep) return { ...body, note: "not kept: its bodies are not this request's to keep" };
  if (data.length > CAPTURE_BODY_MAX) return { ...body, note: `not kept: over ${CAPTURE_BODY_MAX} bytes` };
  try {
    return { ...body, json: bodyRedacted(JSON.parse(data.toString("utf8"))) };
  } catch {
    return { ...body, note: "not kept: not JSON" };
  }
}

export class PublishCapture {
  readonly #deps: PublishCaptureDeps;
  readonly #followed = new Map<string, Followed>();
  /** Lines written, by what they are (the operator's log at its stop). */
  readonly written: Record<CaptureClass, number> = { publish: 0, read: 0, preflight: 0, write: 0 };

  constructor(deps: PublishCaptureDeps) {
    this.#deps = deps;
    const cdp = deps.cdp;
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => this.#onExtraInfo(event));
    cdp.on("Network.responseReceived", (event) => this.#onResponse(event));
    cdp.on("Network.responseReceivedExtraInfo", (event) => this.#onResponseExtra(event));
    cdp.on("Network.loadingFinished", (event) => void this.#onFinished(event));
    cdp.on("Network.loadingFailed", (event) => void this.#onFailed(event));
  }

  /** Chrome went: what was followed ends unfinished, written as such. */
  reset(): void {
    const followed = [...this.#followed.values()];
    this.#followed.clear();
    for (const f of followed) void this.#end(f, { error: "followed no further: the page's browser went", status: f.status, encodedBytes: null, keepAnswer: false });
  }

  #onWillBeSent(event: CdpEvent): void {
    const p = event.params as {
      requestId?: string;
      type?: string;
      request?: { url?: string; method?: string; headers?: Record<string, string>; hasPostData?: boolean; postData?: string; postDataEntries?: Array<{ bytes?: string }> };
      redirectResponse?: { status?: number; headers?: Record<string, string> };
    };
    const id = p.requestId;
    if (typeof id !== "string") return;
    const previous = this.#followed.get(id);
    let hop = 0;
    if (previous !== undefined) {
      this.#followed.delete(id);
      hop = previous.hop + 1;
      if (typeof p.redirectResponse?.status === "number") previous.status = p.redirectResponse.status;
      previous.responseHeaders = { ...(p.redirectResponse?.headers ?? {}), ...previous.responseHeaders };
      void this.#end(previous, { error: null, status: previous.status, encodedBytes: null, keepAnswer: false });
    }
    if (this.#deps.isOperatorRequest(id)) return;
    const request = p.request ?? {};
    const method = (request.method ?? "GET").toUpperCase();
    const url = request.url ?? "";
    // The self-test's probes carry their marker (selftest/probes.ts).
    if (/[?&]pbst=/.test(url)) return;
    const resourceType = typeof p.type === "string" ? p.type : undefined;
    const kind = captureClassOf(method, url, resourceType);
    if (kind === null) return;
    const sizeOnly = method === "PUT" || /^multipart\//i.test(headerOf(request.headers ?? {}, "content-type") ?? "");
    const keep = (kind.what === "publish" || kind.what === "read") && !sizeOnly;
    const f: Followed = {
      id,
      hop,
      sessionId: event.sessionId ?? null,
      what: kind.what,
      rule: kind.rule,
      method,
      url,
      resourceType: resourceType ?? null,
      sizeOnly,
      startedWall: wallMs(),
      sentWall: null,
      requestHeaders: { ...(request.headers ?? {}) },
      requestBody: Promise.resolve(null),
      status: null,
      responseHeaders: {},
      source: "network",
    };
    f.requestBody = this.#requestBody(f, request, keep);
    this.#followed.set(id, f);
    if (this.#followed.size > CAPTURE_KEPT) {
      const oldest = this.#followed.values().next().value!;
      this.#followed.delete(oldest.id);
      void this.#end(oldest, { error: "followed no further: too many requests at once", status: oldest.status, encodedBytes: null, keepAnswer: false });
    }
  }

  /** What the request sent: a part's or a form's size only (its
   *  content-length, later); else the bytes Chrome gives, kept as the class
   *  allows. */
  async #requestBody(f: Followed, request: { hasPostData?: boolean; postData?: string; postDataEntries?: Array<{ bytes?: string }> }, keep: boolean): Promise<CaptureBody | null> {
    if (f.sizeOnly) return null;
    if (Array.isArray(request.postDataEntries) && request.postDataEntries.every((entry) => typeof entry.bytes === "string")) {
      return captureBody(Buffer.concat(request.postDataEntries.map((entry) => Buffer.from(entry.bytes!, "base64"))), keep);
    }
    if (typeof request.postData === "string") return captureBody(Buffer.from(request.postData, "utf8"), keep);
    if (request.hasPostData !== true) return null;
    if (!keep) return { bytes: null, sha256: null, note: "not read: its bodies are not this request's to keep" };
    try {
      const got = await this.#deps.cdp.send<{ postData?: string; base64Encoded?: boolean }>("Network.getRequestPostData", { requestId: f.id }, f.sessionId ?? undefined);
      return typeof got.postData === "string" ? captureBody(Buffer.from(got.postData, got.base64Encoded === true ? "base64" : "utf8"), keep) : null;
    } catch (error) {
      return { bytes: null, sha256: null, note: `not read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  #onExtraInfo(event: CdpEvent): void {
    const p = event.params as { requestId?: string; headers?: Record<string, string> };
    const f = typeof p.requestId === "string" ? this.#followed.get(p.requestId) : undefined;
    if (f === undefined) return;
    f.sentWall ??= wallMs();
    // The headers as they went: they take the place of the script's.
    f.requestHeaders = { ...f.requestHeaders, ...(p.headers ?? {}) };
  }

  #onResponse(event: CdpEvent): void {
    const p = event.params as { requestId?: string; response?: { status?: number; headers?: Record<string, string>; fromDiskCache?: boolean; fromServiceWorker?: boolean; fromPrefetchCache?: boolean } };
    const f = typeof p.requestId === "string" ? this.#followed.get(p.requestId) : undefined;
    if (f === undefined) return;
    const response = p.response ?? {};
    if (typeof response.status === "number") f.status ??= response.status;
    f.responseHeaders = { ...(response.headers ?? {}), ...f.responseHeaders };
    f.source = response.fromServiceWorker ? "service_worker" : response.fromDiskCache || response.fromPrefetchCache ? "cache" : "network";
  }

  #onResponseExtra(event: CdpEvent): void {
    const p = event.params as { requestId?: string; statusCode?: number; headers?: Record<string, string> };
    const f = typeof p.requestId === "string" ? this.#followed.get(p.requestId) : undefined;
    if (f === undefined) return;
    if (typeof p.statusCode === "number") f.status = p.statusCode;
    f.responseHeaders = { ...f.responseHeaders, ...(p.headers ?? {}) };
  }

  async #onFinished(event: CdpEvent): Promise<void> {
    const p = event.params as { requestId?: string; encodedDataLength?: number };
    const f = typeof p.requestId === "string" ? this.#followed.get(p.requestId) : undefined;
    if (f === undefined) return;
    this.#followed.delete(f.id);
    const keepAnswer = (f.what === "publish" || f.what === "read") && f.method !== "PUT" && f.status !== null;
    await this.#end(f, { error: null, status: f.status, encodedBytes: typeof p.encodedDataLength === "number" ? p.encodedDataLength : null, keepAnswer, sessionId: event.sessionId ?? f.sessionId });
  }

  async #onFailed(event: CdpEvent): Promise<void> {
    const p = event.params as { requestId?: string; errorText?: string; canceled?: boolean };
    const f = typeof p.requestId === "string" ? this.#followed.get(p.requestId) : undefined;
    if (f === undefined) return;
    this.#followed.delete(f.id);
    await this.#end(f, { error: p.canceled === true ? "canceled" : (p.errorText ?? "failed"), status: f.status, encodedBytes: null, keepAnswer: false });
  }

  async #end(f: Followed, end: { error: string | null; status: number | null; encodedBytes: number | null; keepAnswer: boolean; sessionId?: string | null }): Promise<void> {
    const endedWall = wallMs();
    let answer: CaptureBody | null = null;
    if (end.keepAnswer) {
      try {
        const got = await this.#deps.cdp.send<{ body?: string; base64Encoded?: boolean }>("Network.getResponseBody", { requestId: f.id }, end.sessionId ?? undefined);
        answer = typeof got.body === "string" ? captureBody(Buffer.from(got.body, got.base64Encoded === true ? "base64" : "utf8"), true) : null;
      } catch (error) {
        answer = { bytes: null, sha256: null, note: `not read: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const requestBody = await f.requestBody.catch(() => null);
    const length = headerOf(f.requestHeaders, "content-length");
    const sentBody = requestBody ?? (f.sizeOnly ? { bytes: length !== null && /^\d+$/.test(length) ? Number(length) : null, sha256: null, note: "a part's or a form's bytes: never read, its content-length only" } : null);
    let host = "";
    let path = "";
    try {
      const parsed = new URL(f.url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      // kept empty
    }
    const answered = end.status !== null;
    const line: PublishLine = {
      what: f.what,
      rule: f.rule,
      id: f.id,
      hop: f.hop,
      method: f.method,
      url: urlRedacted(f.url),
      host,
      path,
      resourceType: f.resourceType,
      startedAt: new Date(f.startedWall).toISOString(),
      sentAt: f.sentWall === null ? null : new Date(f.sentWall).toISOString(),
      endedAt: new Date(endedWall).toISOString(),
      durationMs: Math.max(0, endedWall - f.startedWall),
      status: end.status,
      error: end.error,
      blocked: end.error !== null && end.error.includes("ERR_BLOCKED_BY_CLIENT"),
      source: f.source,
      request: { headers: headersRedacted(f.requestHeaders), body: sentBody },
      response: answered || answer !== null ? { headers: headersRedacted(f.responseHeaders), encodedBytes: end.encodedBytes, body: answer } : null,
    };
    try {
      this.#deps.write(line);
      this.written[f.what] += 1;
    } catch (error) {
      this.#deps.log("publish_capture.unwritten", { id: f.id, why: error instanceof Error ? error.message : String(error) });
    }
  }
}
