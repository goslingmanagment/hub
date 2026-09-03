import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { MediaPlanePlatform } from "./media-plane.ts";

export interface UpsertCreatorRawMediaInput {
  pageId: number;
  platform: MediaPlanePlatform;
  mediaRef: string;
  ownerAccountRef: string | null;
  filename: string | null;
  mediaType: number | null;
  providerType: string | null;
  mimeType: string | null;
  durationMs: number | null;
  originalWidth: number | null;
  originalHeight: number | null;
  width: number | null;
  height: number | null;
  frameRateMilli: number | null;
  createdAtPlatform: Date | null;
  updatedAtPlatform: Date | null;
  sourceKind: string;
  firstOrigin: string;
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

// These identifiers are compile-time constants, never supplied by an API caller.
const HEAD_COLUMNS = {
  platform: "platform", ownerAccountRef: "owner_account_ref", filename: "filename",
  providerType: "provider_type", mediaType: "media_type", mimeType: "mime_type", durationMs: "duration_ms",
  originalWidth: "original_width", originalHeight: "original_height",
  width: "width", height: "height", frameRateMilli: "frame_rate_milli",
  createdAtPlatform: "created_at_platform", updatedAtPlatform: "updated_at_platform",
  sourceKind: "source_kind", contentHash: "content_hash", sourceEventId: "source_event_id",
  sourceObservationId: "source_observation_id", sourceAccountSeq: "source_account_seq",
} as const satisfies Partial<Record<keyof UpsertCreatorRawMediaInput, string>>;

// A sparse post sidecar is not evidence that Vault metadata was removed.
// Empty strings and zero are explicit values; only null means unavailable.
const NULLABLE_METADATA = new Set<string>([
  "owner_account_ref", "filename", "provider_type", "media_type", "mime_type", "duration_ms",
  "original_width", "original_height", "width", "height", "frame_rate_milli",
  "created_at_platform", "updated_at_platform",
]);

export async function upsertCreatorRawMedia(
  db: Database,
  input: UpsertCreatorRawMediaInput,
): Promise<{ applied: boolean }> {
  const fields = Object.entries(HEAD_COLUMNS) as Array<[keyof typeof HEAD_COLUMNS, string]>;
  const newer = sql`(excluded.last_observed_at, excluded.source_account_seq)
    > (creator_raw_media.last_observed_at, creator_raw_media.source_account_seq)`;
  const assignments = fields.map(([, column]) => {
    const name = sql.identifier(column);
    const incoming = NULLABLE_METADATA.has(column)
      ? sql`coalesce(excluded.${name}, creator_raw_media.${name})` : sql`excluded.${name}`;
    return sql`${name} = case when ${newer} then ${incoming} else creator_raw_media.${name} end`;
  });
  const result = await db.execute(sql`
    insert into creator_raw_media (
      page_id, media_ref, first_origin, first_observed_at, last_observed_at,
      ${sql.join(fields.map(([, column]) => sql.identifier(column)), sql`, `)}
    ) values (
      ${input.pageId}, ${input.mediaRef}, ${input.firstOrigin}, ${input.observedAt}, ${input.observedAt},
      ${sql.join(fields.map(([field]) => sql`${input[field]}`), sql`, `)}
    )
    on conflict (page_id, media_ref) do update set
      ${sql.join(assignments, sql`, `)},
      first_origin = case when excluded.first_observed_at < creator_raw_media.first_observed_at
        then excluded.first_origin else creator_raw_media.first_origin end,
      first_observed_at = least(creator_raw_media.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(creator_raw_media.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    where ${newer} or excluded.first_observed_at < creator_raw_media.first_observed_at
    returning media_ref
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}
