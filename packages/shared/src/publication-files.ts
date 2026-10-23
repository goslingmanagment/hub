// Files of publications (docs/plans/2026-10-23-wall-posts, spec §7, plan PR 3):
// what a new file may be, and how long Hub keeps its bytes. Pure and
// browser-safe: the dashboard may check a file's type before it uploads it.

import { PUBLICATION_STATUSES, PUBLICATION_TRANSITIONS, type PublicationStatus } from "./publications.ts";

/**
 * A publication that can no longer change: no status follows these
 * (published, not_published, rejected, missed, withdrawn, cancelled). Derived
 * from the transition table, so a new status cannot drift from it.
 */
export const PUBLICATION_FINISHED_STATUSES: readonly PublicationStatus[] = PUBLICATION_STATUSES.filter(
  (status) => Object.keys(PUBLICATION_TRANSITIONS[status]).length === 0,
);

/** Days Hub keeps a file's bytes after the last publication that used it finished (spec §7). */
export const PUBLICATION_FILE_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One publication that names the file, as the retention rule sees it. */
export interface PublicationFileUse {
  status: PublicationStatus;
  /** When it reached its status; for a finished one, when it finished. */
  statusChangedAt: Date;
}

/**
 * Until when Hub keeps a file's bytes (spec §7), or null while any
 * publication that uses it is not finished — a draft, an approved one, one on
 * its way or on the platform's schedule, or one whose outcome is unknown.
 * Otherwise 7 days after the later of its upload and the last finish; a file
 * no publication ever used goes 7 days after its upload. A new upload of the
 * same bytes counts as the upload (`storedAt`), so it starts the 7 days again.
 */
export function publicationFileRetainUntil(
  input: { storedAt: Date; uses: readonly PublicationFileUse[] },
  retentionDays: number = PUBLICATION_FILE_RETENTION_DAYS,
): Date | null {
  const finished = new Set<PublicationStatus>(PUBLICATION_FINISHED_STATUSES);
  if (input.uses.some((use) => !finished.has(use.status))) return null;
  const last = Math.max(input.storedAt.getTime(), ...input.uses.map((use) => use.statusChangedAt.getTime()));
  return new Date(last + retentionDays * DAY_MS);
}

/** Whether the bytes are due for deletion at `now`. */
export function isPublicationFileDue(
  input: { storedAt: Date; uses: readonly PublicationFileUse[] },
  now: Date,
  retentionDays: number = PUBLICATION_FILE_RETENTION_DAYS,
): boolean {
  const until = publicationFileRetainUntil(input, retentionDays);
  return until !== null && until.getTime() <= now.getTime();
}

/** The types a new file may have: what both platforms take for posts and stories. */
export const PUBLICATION_FILE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;
export type PublicationFileMimeType = (typeof PUBLICATION_FILE_MIME_TYPES)[number];

/** Bytes the type sniffer needs to decide. */
export const PUBLICATION_FILE_SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let index = from; index < to && index < bytes.length; index += 1) out += String.fromCharCode(bytes[index]!);
  return out;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

/** ISO base-media brands that are pictures or sound, not video: refused. */
const NOT_VIDEO_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "M4A ", "M4B ", "M4P "]);

/**
 * The file's type from its first bytes, never from its name or the declared
 * type; null when it is not an image or a video Hub publishes. The labels are
 * the ones OnlyFansAPI's uploader sniffs (services/ofapi-media-sources.ts
 * `detectOfapiUploadMime`) for the same bytes, except MOV, which it calls mp4.
 * HEIC/AVIF pictures and audio are refused: convert them first.
 */
export function detectPublicationFileMime(head: Uint8Array): PublicationFileMimeType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  const six = ascii(head, 0, 6);
  if (six === "GIF87a" || six === "GIF89a") return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (NOT_VIDEO_BRANDS.has(brand)) return null;
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

/** Defaults of the two size limits (config PUBLICATION_FILE_MAX_MB, PUBLICATION_FILES_MAX_TOTAL_GB). */
export const PUBLICATION_FILE_MAX_MB_DEFAULT = 500;
export const PUBLICATION_FILES_MAX_TOTAL_GB_DEFAULT = 20;

/** Decimal units, as the limits are written: 1 MB = 1 000 000 bytes. */
export function publicationFileLimitBytes(limits: { fileMaxMb: number; totalMaxGb: number }) {
  return { fileMaxBytes: limits.fileMaxMb * 1_000_000, totalMaxBytes: limits.totalMaxGb * 1_000_000_000 };
}

/**
 * Whether a new upload fits: under the per-file limit, and — when its bytes are
 * not on disk already — under the total with what is stored. A file whose
 * bytes are kept already adds nothing.
 */
export function publicationFileUploadRefusal(input: {
  byteSize: number;
  alreadyStored: boolean;
  storedTotalBytes: number;
  fileMaxBytes: number;
  totalMaxBytes: number;
}): "file_too_large" | "storage_full" | null {
  if (input.byteSize > input.fileMaxBytes) return "file_too_large";
  if (!input.alreadyStored && input.storedTotalBytes + input.byteSize > input.totalMaxBytes) return "storage_full";
  return null;
}
