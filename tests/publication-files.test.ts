import { describe, expect, it } from "vitest";

import {
  detectPublicationFileMime,
  isPublicationFileDue,
  PUBLICATION_FINISHED_STATUSES,
  publicationFileLimitBytes,
  publicationFileRetainUntil,
  publicationFileUploadRefusal,
  type PublicationFileUse,
} from "@agency_hub_core/shared";

import { cleanPublicationFileName, publicationFilePath } from "../apps/runtime/src/services/publication-files.ts";

// Files of publications (docs/plans/2026-10-23-wall-posts, spec §7, plan PR 3):
// when Hub may delete a file's bytes, what a new upload may be, and the limits.
// The disk and row-lock half (upload, dedupe, deletion under the lock) is in
// publication-files.integration.test.ts.

const DAY = 24 * 60 * 60 * 1000;
const UPLOADED = new Date("2026-10-01T10:00:00Z");
const at = (days: number) => new Date(UPLOADED.getTime() + days * DAY);
const use = (status: PublicationFileUse["status"], days: number): PublicationFileUse => ({ status, statusChangedAt: at(days) });

describe("publication files: retention (spec §7)", () => {
  it("finished means a status nothing follows", () => {
    expect([...PUBLICATION_FINISHED_STATUSES].sort()).toEqual(
      ["cancelled", "missed", "not_published", "published", "rejected", "withdrawn"],
    );
  });

  it("a file no publication used goes 7 days after its upload", () => {
    expect(publicationFileRetainUntil({ storedAt: UPLOADED, uses: [] })).toEqual(at(7));
    expect(isPublicationFileDue({ storedAt: UPLOADED, uses: [] }, at(6.9))).toBe(false);
    expect(isPublicationFileDue({ storedAt: UPLOADED, uses: [] }, at(7))).toBe(true);
  });

  it("any publication that is not finished keeps the bytes, however old", () => {
    for (const status of ["draft", "approved", "submitting", "scheduled", "processing", "unknown"] as const) {
      const uses = [use("published", 1), use(status, 2)];
      expect(publicationFileRetainUntil({ storedAt: UPLOADED, uses })).toBeNull();
      expect(isPublicationFileDue({ storedAt: UPLOADED, uses }, at(400))).toBe(false);
    }
  });

  it("7 days after the last finished publication, not the first", () => {
    const uses = [use("published", 3), use("cancelled", 20), use("not_published", 10)];
    expect(publicationFileRetainUntil({ storedAt: UPLOADED, uses })).toEqual(at(27));
    expect(isPublicationFileDue({ storedAt: UPLOADED, uses }, at(26))).toBe(false);
    expect(isPublicationFileDue({ storedAt: UPLOADED, uses }, at(27))).toBe(true);
  });

  it("a new upload of the same bytes starts the 7 days again", () => {
    const uses = [use("published", 3)];
    expect(publicationFileRetainUntil({ storedAt: at(30), uses })).toEqual(at(37));
  });
});

describe("publication files: what an upload may be", () => {
  const bytes = (...values: Array<number | string>) => Uint8Array.from(values.flatMap((value) =>
    typeof value === "string" ? [...value].map((char) => char.charCodeAt(0)) : [value]));
  const ftyp = (brand: string) => bytes(0, 0, 0, 0x20, "ftyp", brand, 0, 0, 0, 0);

  it("reads the type from the bytes: photos and videos both platforms take", () => {
    expect(detectPublicationFileMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectPublicationFileMime(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(detectPublicationFileMime(bytes("GIF89a"))).toBe("image/gif");
    expect(detectPublicationFileMime(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image/webp");
    expect(detectPublicationFileMime(ftyp("isom"))).toBe("video/mp4");
    expect(detectPublicationFileMime(ftyp("qt  "))).toBe("video/quicktime");
    expect(detectPublicationFileMime(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video/webm");
  });

  it("refuses sound, HEIC/AVIF pictures, documents and the empty file", () => {
    expect(detectPublicationFileMime(ftyp("M4A "))).toBeNull();
    expect(detectPublicationFileMime(ftyp("heic"))).toBeNull();
    expect(detectPublicationFileMime(ftyp("avif"))).toBeNull();
    expect(detectPublicationFileMime(bytes("RIFF", 0, 0, 0, 0, "WAVE"))).toBeNull();
    expect(detectPublicationFileMime(bytes("ID3", 3, 0))).toBeNull();
    expect(detectPublicationFileMime(bytes("%PDF-1.7"))).toBeNull();
    expect(detectPublicationFileMime(bytes())).toBeNull();
  });

  it("keeps a person's file name for people only", () => {
    expect(cleanPublicationFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanPublicationFileName("clip\n01.mp4")).toBe("clip_01.mp4");
    expect(cleanPublicationFileName("   ")).toBeNull();
    expect(cleanPublicationFileName(undefined)).toBeNull();
  });

  it("puts bytes only under the root, by model and sha256", () => {
    const sha = "a".repeat(64);
    expect(publicationFilePath("/files", { modelId: 7, contentSha256: sha })).toBe(`/files/7/${sha}`);
    expect(() => publicationFilePath("/files", { modelId: 7, contentSha256: "../x" })).toThrow();
    expect(() => publicationFilePath("/files", { modelId: 0, contentSha256: sha })).toThrow();
  });
});

describe("publication files: limits", () => {
  const { fileMaxBytes, totalMaxBytes } = publicationFileLimitBytes({ fileMaxMb: 500, totalMaxGb: 20 });

  it("are decimal units", () => {
    expect(fileMaxBytes).toBe(500_000_000);
    expect(totalMaxBytes).toBe(20_000_000_000);
  });

  it("refuse a file over its limit, and a new one that would pass the total", () => {
    const base = { fileMaxBytes, totalMaxBytes, alreadyStored: false };
    expect(publicationFileUploadRefusal({ ...base, byteSize: 500_000_001, storedTotalBytes: 0 })).toBe("file_too_large");
    expect(publicationFileUploadRefusal({ ...base, byteSize: 500_000_000, storedTotalBytes: 0 })).toBeNull();
    expect(publicationFileUploadRefusal({ ...base, byteSize: 2, storedTotalBytes: totalMaxBytes - 1 })).toBe("storage_full");
    expect(publicationFileUploadRefusal({ ...base, byteSize: 1, storedTotalBytes: totalMaxBytes - 1 })).toBeNull();
  });

  it("let the same bytes in again when they are kept already: a duplicate adds nothing", () => {
    expect(publicationFileUploadRefusal({
      fileMaxBytes, totalMaxBytes, alreadyStored: true, byteSize: 100, storedTotalBytes: totalMaxBytes,
    })).toBeNull();
  });
});
