import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, extname, join } from "node:path";

import { publicationFileUploadResponseSchema } from "@agency_hub_core/contracts";
import {
  detectPublicationFileMime,
  PUBLICATION_FILE_SNIFF_BYTES,
  type PublicationFileMimeType,
} from "@agency_hub_core/shared";
import { KernelApiError, kernelOperations, type KernelErrorCategory, type KernelOperationResponse } from "@kernel/sdk";

/**
 * Files from disk into Hub (`publication-file-upload`, `vault-album-draft`).
 *
 * THE ONE BODY THE SDK CANNOT SEND. The SDK speaks JSON; an upload's body is
 * the file's raw bytes, up to gigabytes (an iPhone video of a pack is ~560 MB).
 * So this module streams each file from disk into one request of its own,
 * Content-Length set, never holding a file in memory, and validates the answer
 * against the route's own contract schema, as the SDK would.
 *
 * WHY A RETRY IS SAFE. Hub keeps a file by its bytes: the same bytes for the
 * same model answer the same file row (services/publication-files.ts). A
 * resend after a cut-off upload can never make a second file.
 *
 * A FILE HUB WOULD REFUSE IS REFUSED HERE FIRST, by the same first-bytes check
 * Hub runs (`detectPublicationFileMime`), so a pack with a HEIC photo stops
 * before its first gigabyte goes up rather than after.
 */

/** A local path as the upload sees it. Injected, so the commands stay testable without a disk. */
export interface HubLocalFiles {
  /** Its kind and size (links followed), or null when it cannot be read. */
  stat(path: string): Promise<{ kind: "file" | "folder" | "other"; size: number } | null>;
  /** Up to `bytes` of its first bytes. */
  head(path: string, bytes: number): Promise<Uint8Array>;
  /** A folder's entry names, not recursive. */
  list(folder: string): Promise<string[]>;
}

export const nodeHubLocalFiles: HubLocalFiles = {
  async stat(path) {
    try {
      const info = await stat(path);
      return { kind: info.isFile() ? "file" : info.isDirectory() ? "folder" : "other", size: info.size };
    } catch {
      return null;
    }
  },
  async head(path, bytes) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  list: (folder) => readdir(folder),
};

/** One file ready to go up: what Hub will call it and what it is. */
export interface HubUploadItem {
  path: string;
  /** Its name in Hub and on the platform: the file's own name. */
  name: string;
  byteSize: number;
  mimeType: PublicationFileMimeType;
}

export type HubFileCheck =
  | { ok: true; item: HubUploadItem }
  | { ok: false; kind: "folder" | "other"; why: string };

const HUB_TYPES = "JPEG, PNG, GIF, WebP, MP4, MOV, WebM";

/** The upload's `name`: the file's own, composed as one character per letter (macOS may keep it decomposed). */
export function hubUploadName(path: string): string {
  return Array.from(basename(path).normalize("NFC")).slice(0, 255).join("");
}

function refusedTypeWhy(head: Uint8Array): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head.length >= 12 && ascii(4, 8) === "ftyp") {
    // The ISO media brands Hub refuses: pictures (HEIC, AVIF) and sound.
    const brand = ascii(8, 12);
    const what = /^(hei|hev|mif1|msf1)/.test(brand) ? "a HEIC photo"
      : brand.startsWith("avi") ? "an AVIF picture"
        : brand.startsWith("M4") ? "a sound file" : `a "${brand.trim()}" media file`;
    return `${what}: Hub takes ${HUB_TYPES}, so convert it first`;
  }
  return `not a photo or video Hub takes (${HUB_TYPES})`;
}

/** Whether Hub would take the file, decided as Hub decides it: by its first bytes. */
export async function checkHubFile(files: HubLocalFiles, path: string): Promise<HubFileCheck> {
  const entry = await files.stat(path);
  if (entry === null) return { ok: false, kind: "other", why: "cannot be read" };
  if (entry.kind === "folder") return { ok: false, kind: "folder", why: "a folder" };
  if (entry.kind !== "file") return { ok: false, kind: "other", why: "not a regular file" };
  if (entry.size === 0) return { ok: false, kind: "other", why: "empty" };
  let head: Uint8Array;
  try {
    head = await files.head(path, PUBLICATION_FILE_SNIFF_BYTES);
  } catch {
    return { ok: false, kind: "other", why: "cannot be read" };
  }
  const mimeType = detectPublicationFileMime(head);
  if (mimeType === null) return { ok: false, kind: "other", why: refusedTypeWhy(head) };
  return { ok: true, item: { path, name: hubUploadName(path), byteSize: entry.size, mimeType } };
}

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Names as a person reads a folder: `IMG_2` before `IMG_10`; names equal to the collator keep a fixed order. */
export function hubNaturalOrder(names: readonly string[]): string[] {
  return [...names].sort((a, b) => NAME_ORDER.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Extensions of photos and videos: a file of a pack with one of these is meant for the album. */
const MEDIA_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".m4v", ".mov", ".webm",
  ".heic", ".heif", ".avif", ".dng", ".tif", ".tiff", ".bmp", ".mkv", ".avi", ".wmv", ".3gp", ".mts", ".m2ts",
]);

export interface HubAlbumFolder {
  /** The album's files, top first. */
  items: HubUploadItem[];
  /** Left out: subfolders and files that are not photos or videos (a sidecar, a note). */
  skipped: Array<{ name: string; why: string }>;
  /** Photos and videos Hub would refuse: the album would miss them, so nothing goes up. */
  refused: Array<{ name: string; why: string }>;
}

/**
 * A pack's folder as an album: its own files (not subfolders, not hidden
 * ones) in name order. A file Hub takes goes in, whatever its name says; one
 * that is not a photo or video (by its bytes and its extension) is skipped
 * and listed; a photo or video Hub would refuse is refused.
 */
export async function readHubAlbumFolder(files: HubLocalFiles, folder: string): Promise<HubAlbumFolder> {
  const names = hubNaturalOrder((await files.list(folder)).filter((name) => !name.startsWith(".")));
  const checks = await Promise.all(names.map((name) => checkHubFile(files, join(folder, name))));
  const out: HubAlbumFolder = { items: [], skipped: [], refused: [] };
  checks.forEach((check, index) => {
    const name = names[index]!;
    if (check.ok) {
      out.items.push(check.item);
    } else if (check.kind === "folder") {
      out.skipped.push({ name, why: "a subfolder: only the folder's own files go in" });
    } else if (MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) {
      out.refused.push({ name, why: check.why });
    } else {
      out.skipped.push({ name, why: check.why });
    }
  });
  return out;
}

/** Decimal units, as Hub writes its limits (1 MB = 1 000 000 bytes). */
export function formatHubBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// --- one upload -------------------------------------------------------------

export type HubFileUploadAnswer = KernelOperationResponse<"agentPublicationFileUpload">;

export interface HubFileUploadInput {
  pageLabel: string;
  item: HubUploadItem;
  /** This attempt's bytes read into the request so far. */
  onBytes(sent: number): void;
}

/** One attempt to send one file; a failure is a KernelApiError (metadata, never the body). */
export type HubFileUpload = (input: HubFileUploadInput) => Promise<HubFileUploadAnswer>;

/** No byte moved either way for this long: the attempt is dead. Hub's own work after the last byte (a hash, an fsync) is seconds. */
const UPLOAD_IDLE_MS = 120_000;
/** An error answer is a small JSON envelope; more than this is not read. */
const ANSWER_MAX_BYTES = 64 * 1024;
const UPLOAD_OPERATION = kernelOperations.agentPublicationFileUpload;

function categoryForStatus(status: number): KernelErrorCategory {
  if (status === 400) return "validation";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "http";
}

/** The answer as the SDK would read it: 200 validated against the contract, anything else the error envelope's code and message. */
function readAnswer(status: number, text: string): { answer: HubFileUploadAnswer } | { error: KernelApiError } {
  let body: unknown;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  const label = `${UPLOAD_OPERATION.method} ${UPLOAD_OPERATION.path}`;
  if (status === 200) {
    const parsed = publicationFileUploadResponseSchema.safeParse(body);
    return parsed.success
      ? { answer: parsed.data }
      : { error: new KernelApiError(`${label} response failed contract validation: ${parsed.error.message}`, "contract", status, "response_validation_failed", null) };
  }
  const envelope = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  return {
    error: new KernelApiError(
      typeof envelope.message === "string" ? envelope.message : `${label} failed with ${status}`,
      categoryForStatus(status),
      status,
      typeof envelope.error === "string" ? envelope.error : null,
      null,
    ),
  };
}

/**
 * The transport: one POST per attempt, the file piped from disk. Hub may
 * answer before the whole file went (a refusal: the key, the page, the size);
 * then the rest is not sent and the answer is what counts, even when the
 * connection breaks right after it.
 */
export function createHubFileUpload(target: { baseUrl: string; token: string }): HubFileUpload {
  return ({ pageLabel, item, onBytes }) => new Promise<HubFileUploadAnswer>((resolve, reject) => {
    const url = new URL(`${target.baseUrl}${UPLOAD_OPERATION.path.replace(":pageLabel", encodeURIComponent(pageLabel))}`);
    url.searchParams.set("name", item.name);
    const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
    if (send === null) {
      reject(new KernelApiError(`the hub's URL must be http or https, got ${url.protocol}`, "network", null, "network_error", null));
      return;
    }
    const networkError = (error: Error, code = "network_error") => new KernelApiError(
      `Network error calling ${UPLOAD_OPERATION.method} ${UPLOAD_OPERATION.path}: ${error.message}`, "network", null, code, null,
    );
    const file = createReadStream(item.path, { start: 0, end: item.byteSize - 1, highWaterMark: 1 << 20 });
    let settled = false;
    let answered = false;
    const settle = (outcome: { answer: HubFileUploadAnswer } | { error: KernelApiError }) => {
      if (settled) return;
      settled = true;
      file.destroy();
      request.destroy();
      if ("answer" in outcome) resolve(outcome.answer);
      else reject(outcome.error);
    };
    const request = send(url, {
      method: "POST",
      // A connection per upload, closed after it: nothing keeps the process alive once the last answer is in.
      agent: false,
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/octet-stream",
        "content-length": String(item.byteSize),
        accept: "application/json",
      },
    }, (response) => {
      answered = true;
      file.unpipe(request);
      file.destroy();
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        if (length >= ANSWER_MAX_BYTES) return;
        chunks.push(chunk);
        length += chunk.length;
      });
      const read = () => settle(readAnswer(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
      // An answer cut off half-way is the network's failure (retried), not a contract breach.
      const cut = () => settle(response.complete ? readAnswer(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))
        : { error: networkError(new Error("the answer was cut off")) });
      response.on("end", read);
      response.on("close", cut);
      response.on("error", cut);
    });
    request.setTimeout(UPLOAD_IDLE_MS, () => settle({ error: networkError(new Error(`no progress for ${UPLOAD_IDLE_MS / 1000} s`), "timeout") }));
    request.on("error", (error) => {
      if (!answered) settle({ error: networkError(error) });
    });
    file.on("error", (error) => settle({ error: new KernelApiError(`cannot read ${item.path}: ${error.message}`, "network", null, "file_unreadable", null) }));
    let sent = 0;
    file.on("data", (chunk) => {
      sent += chunk.length;
      onBytes(sent);
    });
    file.pipe(request);
  });
}

// --- many uploads -----------------------------------------------------------

/** Tries per file: the first and three more. */
export const HUB_UPLOAD_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
/** At most one progress line this often, besides a line per finished file. */
const PROGRESS_EVERY_MS = 15_000;

/** A cut-off upload (400 "send it again"), the same bytes landing twice at once (409), a busy or broken hub, the network.
 *  Hub's room for files full (507) stays full: the body is not sent again. */
function retryable(error: unknown): boolean {
  if (!(error instanceof KernelApiError)) return false;
  if (error.category === "network") return error.code !== "file_unreadable";
  const status = error.status ?? 0;
  return status === 400 || status === 409 || status === 429 || (status >= 500 && status !== 507);
}

/** A refusal every other file would get too: the key, the page, Hub's room for files. */
function stopsTheRest(error: unknown): boolean {
  return error instanceof KernelApiError && [401, 403, 404, 507].includes(error.status ?? 0);
}

export type HubUploadOutcome =
  | { ok: true; item: HubUploadItem; answer: HubFileUploadAnswer; attempts: number }
  | { ok: false; item: HubUploadItem; error: unknown; attempts: number }
  | { ok: false; item: HubUploadItem; notTried: string; attempts: 0 };

function short(error: unknown): string {
  if (error instanceof KernelApiError) {
    const text = `${error.status ?? error.code ?? error.category}: ${error.message}`;
    return text.length <= 200 ? text : `${text.slice(0, 200)}...`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every item up, `parallel` at a time, each retried; outcomes in the items'
 * order. A refusal every file would get (no capability, no page, Hub full)
 * stops new uploads; the files not started are listed as not tried.
 * Progress goes to `progress`, one line at a time.
 */
export async function uploadHubFiles(input: {
  pageLabel: string;
  items: readonly HubUploadItem[];
  parallel: number;
  upload: HubFileUpload;
  sleep(ms: number): Promise<void>;
  now(): number;
  progress(line: string): void;
}): Promise<{ outcomes: HubUploadOutcome[]; attempts: number }> {
  const { items, progress } = input;
  const total = items.reduce((sum, item) => sum + item.byteSize, 0);
  const sentOf = items.map(() => 0);
  const started = input.now();
  let sent = 0;
  let moved = 0;
  let finished = 0;
  let attempts = 0;
  let lastLine = started;
  let stopped: string | null = null;
  const outcomes: HubUploadOutcome[] = new Array(items.length);

  /** This attempt of file `index` has `bytes` in the request (0: it starts again, or failed). */
  const track = (index: number, bytes: number) => {
    sent += bytes - sentOf[index]!;
    if (bytes > sentOf[index]!) moved += bytes - sentOf[index]!;
    sentOf[index] = bytes;
    const at = input.now();
    if (at - lastLine < PROGRESS_EVERY_MS) return;
    lastLine = at;
    const rate = moved / Math.max(1, (at - started) / 1000);
    const left = rate > 0 ? Math.ceil((total - sent) / rate / 60) : null;
    progress(`hub: ${formatHubBytes(sent)} of ${formatHubBytes(total)} (${Math.floor((sent / Math.max(1, total)) * 100)}%),`
      + ` ${finished} of ${items.length} files done, ${formatHubBytes(rate)}/s${left === null ? "" : `, about ${left} min left`}`);
  };

  const uploadOne = async (index: number): Promise<HubUploadOutcome> => {
    const item = items[index]!;
    for (let attempt = 1; ; attempt += 1) {
      track(index, 0);
      attempts += 1;
      try {
        const answer = await input.upload({ pageLabel: input.pageLabel, item, onBytes: (bytes) => track(index, bytes) });
        track(index, item.byteSize);
        finished += 1;
        progress(`hub: [${finished}/${items.length}] ${item.name} ${formatHubBytes(item.byteSize)}: `
          + `${answer.created ? "uploaded" : "already in Hub"}, file:${answer.file.id}`);
        return { ok: true, item, answer, attempts: attempt };
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay === undefined || attempt >= HUB_UPLOAD_ATTEMPTS || !retryable(error) || stopped !== null) {
          track(index, 0);
          finished += 1;
          progress(`hub: [${finished}/${items.length}] ${item.name}: FAILED (${short(error)})`);
          return { ok: false, item, error, attempts: attempt };
        }
        progress(`hub: ${item.name}: ${short(error)}; try ${attempt + 1} of ${HUB_UPLOAD_ATTEMPTS} in ${delay / 1000} s`);
        await input.sleep(delay);
      }
    }
  };

  progress(`hub: uploading ${items.length} ${items.length === 1 ? "file" : "files"}, ${formatHubBytes(total)},`
    + ` to ${input.pageLabel}, ${Math.min(input.parallel, items.length)} at a time`);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      if (stopped !== null) {
        outcomes[index] = { ok: false, item: items[index]!, notTried: stopped, attempts: 0 };
        continue;
      }
      const outcome = await uploadOne(index);
      outcomes[index] = outcome;
      if (stopped === null && !outcome.ok && "error" in outcome && stopsTheRest(outcome.error)) {
        stopped = `not tried: ${outcome.item.name} was refused (${short(outcome.error)})`;
        progress(`hub: stopping, ${stopped}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.parallel, items.length)) }, worker));
  return { outcomes, attempts };
}
