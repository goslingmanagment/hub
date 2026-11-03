import type { FanslyWriteCommandRecord, FanslyWriteStep } from "@agency_hub_core/db";

// One new file's upload inside a publication's dispatch (wall posts PR 8, the
// contract §2), read from its commands alone: create → parts → complete →
// reads of its processing until its media is there. Both sides read it here:
// the Publications job, to queue what comes next (services/
// publications-fansly.ts), and the engine's derivation, to know which files of
// a vault album failed for themselves and go without them (derive.ts).
//
// A part is the one request of a publication that may go more than once
// (owner, 2026-11-03): a PUT of the same bytes to the same presigned S3 URL —
// S3 keeps the last PUT of a part, its ETag the bytes' MD5 — so a part whose
// answer was lost (a network error, a proxy hiccup: ari-1's proxy has ~200 a
// day) goes again, up to `FANSLY_PART_MAX_TRIES` in all. A later try is its
// own command, `media:N/part:K/try:T`. Every request to Fansly itself still
// goes once (spec §8.2): a lost create is the file that failed; a lost
// completion is settled by reads of the upload.
//
// A file fails for itself — Fansly or the storage refused a step, a part's
// answer lost on every try, its create's lost, its completion answered 500
// (bytes the account already has, the contract §12.7) or its processing never
// done — or the whole create ends because its window passed. A post goes no
// further either way; a vault album goes on with its other files.

/** Reads of an upload's processing, at most this many (the contract §2: a
 *  photo is done in seconds, a 45 MB video in ~20 s): the fast ones, then
 *  about half an hour of the slow ones for a long video. */
export const FANSLY_UPLOAD_STATUS_MAX_READS = 36;
/** A photo's first reads, each at least this long after the one before: the
 *  site's own pace (it polls every 2–3 s; owner, 2026-11-03)… */
export const FANSLY_UPLOAD_STATUS_GAP_MS = 3_000;
export const FANSLY_UPLOAD_STATUS_FAST_READS = 6;
/** …a video's, this long (its first: by its size, below)… */
export const FANSLY_UPLOAD_STATUS_VIDEO_GAP_MS = 10_000;
/** …and a file still processing after them is read once a minute. */
export const FANSLY_UPLOAD_STATUS_SLOW_GAP_MS = 60_000;
/** A video's processing, roughly (the contract §2: 45 MB in ~20 s): its first
 *  read comes when it is likely done, between 5 s and a minute. */
const VIDEO_PROCESSED_BYTES_PER_MS = 2_250;
const VIDEO_FIRST_READ_MIN_MS = 5_000;
const VIDEO_FIRST_READ_MAX_MS = 60_000;

/** A step refused before is queued again no sooner than this after its last
 *  refusal: its few tries take minutes, not the seconds of the follow loop. */
export const FANSLY_STEP_RETRY_GAP_MS = 60_000;
/** A step refused this many times for anything else (its request derived
 *  wrong, the browser would not let it go) is given up. */
export const FANSLY_STEP_MAX_REFUSALS = 3;

/** A part goes at most this many times in all (owner, 2026-11-03). */
export const FANSLY_PART_MAX_TRIES = 3;
/** A part whose answer was lost goes again this long after it: a proxy's
 *  hiccup passes. */
export const FANSLY_PART_RETRY_GAP_MS = 3_000;

/** Refusals that say a switch or a stop held the request back, not the
 *  request itself: the step is queued again, while its window lasts, once the
 *  guard lets it (the enqueue refuses before writing anything until then). */
export const SWITCH_REFUSAL = /^(publishing_off|page_publishing_off|route_unverified|page_stopped:.*)$/;

/** A request of an upload to queue: its step, its item, not before then
 *  (null: now). */
export interface FanslyUploadEnqueue {
  step: FanslyWriteStep;
  item: string;
  notBefore: Date | null;
}

/** How a file's upload, or the whole create, ends without its media. */
export interface FanslyUploadSettle {
  to: "rejected" | "missed";
  reason: string;
}

/** Where one new file's upload stands. */
export type FanslyUploadNext =
  | { kind: "done" }
  /** Its create, parts or completion are queued or due (the next file waits). */
  | { kind: "blocking"; items: FanslyUploadEnqueue[] }
  /** Its bytes went; its processing is read until it is done. */
  | { kind: "processing"; items: FanslyUploadEnqueue[] }
  /** The file failed for itself: a post goes no further, a vault album on
   *  without it. */
  | { kind: "failed"; settle: FanslyUploadSettle }
  /** The create's window passed: nothing more of it goes. */
  | { kind: "window_passed"; reason: string };

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** `media:0/part:3`, `media:0/part:3/try:2`, `media:0/poll:1` → the file's
 *  item, the index and — a part's — its try (1: the first); null: not such
 *  an item. */
export function subItemOf(item: string, kind: "part" | "poll"): { base: string; index: number; attempt: number } | null {
  const match = kind === "part"
    ? /^((?:media|preview):[0-9]+)\/part:([0-9]+)(?:\/try:([23]))?$/.exec(item)
    : /^((?:media|preview):[0-9]+)\/poll:([0-9]+)$/.exec(item);
  return match === null ? null : { base: match[1]!, index: Number(match[2]), attempt: match[3] === undefined ? 1 : Number(match[3]) };
}

/** The item of a part's try (1: the first, as before 0347). */
export function fanslyPartItem(base: string, index: number, attempt = 1): string {
  return attempt <= 1 ? `${base}/part:${index}` : `${base}/part:${index}/try:${attempt}`;
}

/** Every command of one part of a file's upload, of any try. */
export function partCommands(commands: readonly FanslyWriteCommandRecord[], base: string, index: number): FanslyWriteCommandRecord[] {
  return commands.filter((command) => {
    if (command.step !== "upload_part") return false;
    const sub = subItemOf(command.item, "part");
    return sub !== null && sub.base === base && sub.index === index;
  });
}

/** The part's answered try, if one is. */
export function answeredPart(commands: readonly FanslyWriteCommandRecord[], base: string, index: number): FanslyWriteCommandRecord | null {
  return partCommands(commands, base, index).find((command) => command.state === "answered") ?? null;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** When a request refused before may go again: a minute after its last
 *  refusal (null: none was refused, or that minute is over). */
export function fanslyRetryNotBefore(rows: readonly FanslyWriteCommandRecord[], now: Date): Date | null {
  const refusals = rows.filter((row) => row.state === "refused").map((row) => (row.settledAt ?? row.createdAt).getTime());
  if (refusals.length === 0) return null;
  const at = Math.max(...refusals) + FANSLY_STEP_RETRY_GAP_MS;
  return at > now.getTime() ? new Date(at) : null;
}

/** What the reads of a file's processing go by: its type and size. */
export interface FanslyUploadFile {
  mimeType: string | null;
  byteSize: number | null;
}

/** How long after the one before the `index`-th read of an upload's
 *  processing goes (0-based): a photo at the site's pace, a video first when
 *  it is likely done and then every 10 s, both once a minute after the fast
 *  reads. Without its file, as a photo. */
export function fanslyUploadStatusGapMs(index: number, file: FanslyUploadFile | null = null): number {
  if (index >= FANSLY_UPLOAD_STATUS_FAST_READS) return FANSLY_UPLOAD_STATUS_SLOW_GAP_MS;
  if (file?.mimeType?.startsWith("video/") !== true) return FANSLY_UPLOAD_STATUS_GAP_MS;
  if (index > 0) return FANSLY_UPLOAD_STATUS_VIDEO_GAP_MS;
  const processing = Math.round((file.byteSize ?? 0) / VIDEO_PROCESSED_BYTES_PER_MS);
  return Math.min(VIDEO_FIRST_READ_MAX_MS, Math.max(VIDEO_FIRST_READ_MIN_MS, processing));
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

/** Where one request of an upload stands: its live row, or what to do when
 *  none is (queue it — no sooner than `notBefore` when it was refused
 *  before —, or it failed, or its window passed). */
type StepState =
  | { kind: "answered" | "unknown"; row: FanslyWriteCommandRecord }
  | { kind: "in_flight" }
  | { kind: "enqueue"; item: string; notBefore: Date | null }
  | Extract<FanslyUploadNext, { kind: "failed" | "window_passed" }>;

const failed = (to: FanslyUploadSettle["to"], reason: string): Extract<FanslyUploadNext, { kind: "failed" }> => ({ kind: "failed", settle: { to, reason: reason.slice(0, 300) } });
const windowPassed = (reason = "window_passed"): Extract<FanslyUploadNext, { kind: "window_passed" }> => ({ kind: "window_passed", reason: reason.slice(0, 300) });

/** One request of a step and item: its rows, refused ones too. */
export function fanslyStepState(step: FanslyWriteStep, item: string, commands: readonly FanslyWriteCommandRecord[], now: Date, notAfter: Date): StepState {
  const rows = commands.filter((command) => command.step === step && command.item === item);
  const live = rows.find((command) => command.state !== "refused");
  if (live !== undefined) {
    switch (live.state) {
      case "queued":
      case "sending":
        return { kind: "in_flight" };
      case "answered":
      case "unknown":
        return { kind: live.state, row: live };
      case "rejected":
        return failed("rejected", `${step}:${live.stateReason ?? "rejected"}`);
      case "refused":
        break;
    }
  }
  return queueAgain(step, item, rows, now, notAfter);
}

/** Nothing of this request is queued or went: queue it, unless its window
 *  passed or it keeps being refused. */
function queueAgain(step: FanslyWriteStep, item: string, rows: readonly FanslyWriteCommandRecord[], now: Date, notAfter: Date): StepState {
  if (rows.some((command) => command.stateReason === "window_passed") || now.getTime() >= notAfter.getTime()) return windowPassed();
  const counted = rows.filter((command) => command.state === "refused" && !SWITCH_REFUSAL.test(command.stateReason ?? ""));
  if (counted.length >= FANSLY_STEP_MAX_REFUSALS) return failed("missed", `not_sent:${step}:${counted.at(-1)?.stateReason ?? "refused"}`);
  return { kind: "enqueue", item, notBefore: fanslyRetryNotBefore(rows, now) };
}

/** One part of an upload, over its tries: answered once is answered; a lost
 *  answer goes again (the same URL, the same bytes) until its tries are
 *  spent; the storage's refusal is the file that failed. */
function partState(base: string, index: number, commands: readonly FanslyWriteCommandRecord[], now: Date, notAfter: Date): StepState {
  const rows = partCommands(commands, base, index);
  const answered = rows.find((row) => row.state === "answered");
  if (answered !== undefined) return { kind: "answered", row: answered };
  if (rows.some((row) => row.state === "queued" || row.state === "sending")) return { kind: "in_flight" };
  const rejected = rows.find((row) => row.state === "rejected");
  if (rejected !== undefined) return failed("rejected", `upload_part:${rejected.stateReason ?? "rejected"}`);
  const lost = rows.filter((row) => row.state === "unknown");
  if (lost.length >= FANSLY_PART_MAX_TRIES) return failed("missed", `not_sent:upload_part_unknown:${lost.at(-1)?.stateReason ?? "unknown"}`);
  const item = fanslyPartItem(base, index, lost.length + 1);
  const next = queueAgain("upload_part", item, rows.filter((row) => row.item === item), now, notAfter);
  if (next.kind !== "enqueue" || lost.length === 0) return next;
  // A try after a lost answer: a moment after it.
  const lastLost = Math.max(...lost.map((row) => (row.settledAt ?? row.createdAt).getTime())) + FANSLY_PART_RETRY_GAP_MS;
  const at = Math.max(lastLost, next.notBefore?.getTime() ?? 0);
  return { ...next, notBefore: at > now.getTime() ? new Date(at) : null };
}

/**
 * One new file's upload (the contract §2): create → parts (in any order, each
 * of its tries) → complete → reads until done. `file` paces its reads
 * (`fanslyUploadStatusGapMs`).
 */
export function fanslyUploadNext(
  item: string,
  commands: readonly FanslyWriteCommandRecord[],
  now: Date,
  notAfter: Date,
  file: FanslyUploadFile | null = null,
): FanslyUploadNext {
  const enqueue = (step: FanslyWriteStep, at: string, notBefore: Date | null = null): FanslyUploadEnqueue => ({ step, item: at, notBefore });
  const reads = commands.filter((command) => command.step === "upload_status" && command.item.startsWith(`${item}/poll:`));
  // A read found its media: done, whatever else of it says.
  if (reads.some((read) => read.state === "answered" && read.result?.done === true && typeof read.result.mediaId === "string")) return { kind: "done" };
  const create = fanslyStepState("upload_create", item, commands, now, notAfter);
  switch (create.kind) {
    case "in_flight":
      return { kind: "blocking", items: [] };
    case "enqueue":
      return { kind: "blocking", items: [enqueue("upload_create", item, create.notBefore)] };
    case "failed":
    case "window_passed":
      return create;
    case "unknown":
      // No upload id to read it by: nothing of it went on.
      return failed("missed", `not_sent:upload_create_unknown:${create.row.stateReason ?? "unknown"}`);
    case "answered":
      break;
  }
  const partCount = create.row.result?.partCount;
  if (typeof partCount !== "number" || !Number.isSafeInteger(partCount) || partCount < 1) return failed("missed", "not_sent:upload_create_without_parts");
  const parts: FanslyUploadEnqueue[] = [];
  let pending = false;
  for (let index = 0; index < partCount; index += 1) {
    const part = partState(item, index, commands, now, notAfter);
    switch (part.kind) {
      case "answered":
        continue;
      case "unknown":
        // partState never answers it: a lost try goes again or fails.
        continue;
      case "failed":
      case "window_passed":
        return part;
      case "in_flight":
        pending = true;
        continue;
      case "enqueue":
        // Every part is queued at once; the page sends them as it can (one
        // at a time in its turn, or a few at once outside its pause).
        parts.push(enqueue("upload_part", part.item, part.notBefore));
        pending = true;
        continue;
    }
  }
  if (pending) return { kind: "blocking", items: parts };
  const complete = fanslyStepState("upload_complete", item, commands, now, notAfter);
  switch (complete.kind) {
    case "in_flight":
      return { kind: "blocking", items: [] };
    case "enqueue":
      return { kind: "blocking", items: [enqueue("upload_complete", item, complete.notBefore)] };
    case "failed":
    case "window_passed":
      return complete;
    case "answered":
    case "unknown":
      // Its answer lost: the reads of the upload by its id say whether it
      // completed (the contract §2), never a completion sent again.
      break;
  }
  const live = reads.filter((read) => read.state !== "refused");
  if (live.some((read) => read.state === "queued" || read.state === "sending")) return { kind: "processing", items: [] };
  // A completion Fansly answered 500 (the contract §12.7: so it answers bytes
  // the account already has, on every try): once a read says the upload is
  // not done, it never will be — the file failed.
  if (complete.kind === "unknown" && complete.row.httpStatus === 500 && live.some((read) => read.state === "answered")) {
    return failed("missed", "not_sent:upload_complete_500");
  }
  const lost = complete.kind === "unknown" ? `not_sent:upload_complete_unknown:${complete.row.stateReason ?? "unknown"}` : null;
  if (now.getTime() >= notAfter.getTime()) return windowPassed(lost ?? "window_passed");
  if (live.length >= FANSLY_UPLOAD_STATUS_MAX_READS) return failed("missed", lost ?? "not_sent:upload_processing_not_done");
  const refused = reads.filter((read) => read.state === "refused" && !SWITCH_REFUSAL.test(read.stateReason ?? ""));
  if (refused.length >= FANSLY_STEP_MAX_REFUSALS) return failed("missed", `not_sent:upload_status:${refused.at(-1)?.stateReason ?? "refused"}`);
  const last = Math.max(complete.row.settledAt?.getTime() ?? now.getTime(), ...live.map((read) => read.settledAt?.getTime() ?? 0));
  const at = Math.max(last + fanslyUploadStatusGapMs(live.length, file), fanslyRetryNotBefore(reads, now)?.getTime() ?? 0);
  return { kind: "processing", items: [enqueue("upload_status", `${item}/poll:${live.length}`, new Date(at))] };
}

/** Whether a file's upload failed for itself, by its commands alone (no
 *  window): the files a vault album goes without (derive.ts). */
export function fanslyUploadFailed(item: string, commands: readonly FanslyWriteCommandRecord[], now: Date): boolean {
  const begun = commands.some((command) => command.step === "upload_create" && command.item === item);
  return begun && fanslyUploadNext(item, commands, now, new Date(8.64e15)).kind === "failed";
}

// ---------------------------------------------------------------------------
// A vault album's cards
// ---------------------------------------------------------------------------

/** A file's name as a card of an album shows it (a person's name, as Hub
 *  keeps it: trimmed, at most 200 characters); null: none to give. */
export function fanslyCardName(originalName: string | null): string | null {
  const name = originalName?.trim() ?? "";
  return name === "" ? null : name.slice(0, 200);
}

/** Two names of one file, as Fansly may show it: the same but for the
 *  extension it gave the media (`t1.jpg` → `t1.jpeg`, the contract §13). */
export function sameCardName(shown: string, wanted: string): boolean {
  const stem = (name: string) => name.trim().replace(/\.[A-Za-z0-9]{1,5}$/, "").toLowerCase();
  return stem(shown) === stem(wanted);
}

/** What a done read of an upload showed of its media (0347): its name and
 *  when Fansly made it (ms). */
function shownMedia(commands: readonly FanslyWriteCommandRecord[], item: string): { filename: string | null; createdAtMs: number | null } | null {
  const done = commands.find((command) => command.step === "upload_status" && subItemOf(command.item, "poll")?.base === item
    && command.state === "answered" && command.result?.done === true);
  if (done === undefined) return null;
  const filename = typeof done.result?.filename === "string" && done.result.filename !== "" ? done.result.filename : null;
  const createdAtMs = typeof done.result?.mediaCreatedAtMs === "number" ? done.result.mediaCreatedAtMs : null;
  return { filename, createdAtMs };
}

/** A media made this long before its upload's create is one Fansly had. */
const OLD_MEDIA_MARGIN_MS = 10 * 60_000;

/**
 * The files of a vault album whose card is not named as the file (the
 * old-media case, owner 2026-11-03): bytes Fansly had already come back as
 * their old media under the old name, and the album shows that name. A file
 * of this dispatch's upload is judged by its done read (the name it showed;
 * without one, a media older than the upload); a file whose bytes the account
 * had before (`onAccount`, not uploaded again) by what the earlier read
 * showed — not known, renamed. A vault media (no file) and a file that failed
 * are never renamed.
 */
export function fanslyVaultRenames(input: {
  media: ReadonlyArray<{ role: "media" | "preview"; position: number; source: "vault" | "file"; fileId: number | null; fileSha256: string | null }>;
  commands: readonly FanslyWriteCommandRecord[];
  /** The file's name by its id. */
  names: ReadonlyMap<number, string | null>;
  /** The earlier media of bytes the account had, by sha256. */
  onAccount: ReadonlyMap<string, { filename: string | null }>;
  /** The files that failed. */
  failed: ReadonlySet<string>;
}): string[] {
  const renames: string[] = [];
  for (const media of input.media) {
    if (media.role !== "media" || media.source !== "file" || media.fileId === null) continue;
    const item = `media:${media.position}`;
    if (input.failed.has(item)) continue;
    const wanted = fanslyCardName(input.names.get(media.fileId) ?? null);
    if (wanted === null) continue;
    const created = input.commands.find((command) => command.step === "upload_create" && command.item === item && command.state === "answered");
    if (created !== undefined) {
      const shown = shownMedia(input.commands, item);
      if (shown === null) continue;
      if (shown.filename !== null) {
        if (!sameCardName(shown.filename, wanted)) renames.push(item);
        continue;
      }
      if (shown.createdAtMs === null || shown.createdAtMs < created.createdAt.getTime() - OLD_MEDIA_MARGIN_MS) renames.push(item);
      continue;
    }
    const before = media.fileSha256 === null ? undefined : input.onAccount.get(media.fileSha256);
    if (before === undefined) continue;
    if (before.filename === null || !sameCardName(before.filename, wanted)) renames.push(item);
  }
  return renames;
}
