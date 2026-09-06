// File identity is independent of commerce offers and album membership.
// This allowlist deliberately never copies locations, variants, or arbitrary
// metadata into domain events. The untouched provider body stays in capture.
import { createHash } from "node:crypto";

import { isRecord, type CanonicalEventDraft, type CanonicalizableObservation } from "./types.ts";

function ref(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
}

function scaled(value: unknown, scale: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * scale);
  return Number.isSafeInteger(result) ? result : null;
}

export const mediaDurationMs = (value: unknown) => scaled(value, 1000);

function timestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function metadata(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const decoded: unknown = JSON.parse(value);
    return isRecord(decoded) ? decoded : {};
  } catch {
    return {};
  }
}

export const mediaDurationFromMetadata = (value: unknown) => mediaDurationMs(metadata(value).duration);

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function buildRawMediaDraft(
  observation: CanonicalizableObservation,
  material: Record<string, unknown> & { mediaRef: string },
): CanonicalEventDraft {
  const contentHash = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return {
    type: "media.file_observed",
    occurredAt: observation.receivedAt,
    schemaVersion: 1,
    data: { ...material, contentHash },
    // Re-observation advances freshness, while retries of one observation do
    // not. A changed parser output from retained raw also gets a new key.
    dedupKey: `rawmedia:v1:${observation.accountId}:${material.mediaRef}:${contentHash}:obs:${observation.id}`,
  };
}

export function fanslyRawMediaDrafts(
  observation: CanonicalizableObservation,
  firstOrigin: "vault" | "post" = "vault",
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) return [];
  const payload = observation.payload;
  const aggregation = isRecord(payload.aggregationData) ? payload.aggregationData : {};
  const rows = [...records(payload.media), ...records(aggregation.media)];
  for (const offer of [...records(payload.accountMedia), ...records(aggregation.accountMedia)]) {
    if (isRecord(offer.media)) rows.push({ ...offer.media, id: offer.media.id ?? offer.mediaId });
  }
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const mediaRef = ref(row.id);
    if (mediaRef === null || seen.has(mediaRef)) return [];
    seen.add(mediaRef);
    const meta = metadata(row.metadata);
    return [buildRawMediaDraft(observation, {
      mediaRef,
      firstOrigin,
      ownerAccountRef: ref(row.accountId),
      filename: typeof row.filename === "string" ? row.filename : null,
      mediaType: integer(row.type),
      mimeType: typeof row.mimetype === "string" ? row.mimetype : null,
      durationMs: mediaDurationMs(meta.duration),
      originalWidth: integer(meta.originalWidth),
      originalHeight: integer(meta.originalHeight),
      width: integer(row.width),
      height: integer(row.height),
      // The dataset scalar vocabulary has integer technical measurements.
      // Milli-FPS preserves the observed fractional frame rate explicitly.
      frameRateMilli: scaled(meta.frameRate, 1000),
      createdAtPlatform: timestamp(row.createdAt),
      updatedAtPlatform: timestamp(row.updatedAt),
      sourceKind: observation.kind,
    })];
  });
}

/** OF media ids link posts directly to files. Technical values are copied only
 * from named scalar fields; delivery variants are never treated as originals. */
export function onlyFansRawMediaDrafts(
  observation: CanonicalizableObservation, media: readonly unknown[], firstOrigin: "vault" | "post" = "post",
): CanonicalEventDraft[] {
  return media.flatMap(row => {
    if (!isRecord(row)) return [];
    const mediaRef = ref(row.id);
    if (mediaRef === null) return [];
    return [buildRawMediaDraft(observation, {
      mediaRef, firstOrigin, ownerAccountRef: null,
      filename: typeof row.filename === "string" ? row.filename : null,
      // OF type names have no verified mapping to Fansly's numeric codes.
      mediaType: null, providerType: typeof row.type === "string" ? row.type : null,
      mimeType: typeof row.mimetype === "string" ? row.mimetype : null,
      durationMs: mediaDurationMs(row.duration), width: integer(row.width), height: integer(row.height),
      originalWidth: null, originalHeight: null, frameRateMilli: null,
      createdAtPlatform: null, updatedAtPlatform: null, sourceKind: observation.kind,
    })];
  });
}
