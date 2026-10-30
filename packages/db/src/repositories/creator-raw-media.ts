import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";
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
  byteSize: number | null;
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
  platform: "platform",
  ownerAccountRef: "owner_account_ref",
  filename: "filename",
  providerType: "provider_type",
  mediaType: "media_type",
  mimeType: "mime_type",
  durationMs: "duration_ms",
  originalWidth: "original_width",
  originalHeight: "original_height",
  width: "width",
  height: "height",
  frameRateMilli: "frame_rate_milli",
  byteSize: "byte_size",
  createdAtPlatform: "created_at_platform",
  updatedAtPlatform: "updated_at_platform",
  sourceKind: "source_kind",
  contentHash: "content_hash",
  sourceEventId: "source_event_id",
  sourceObservationId: "source_observation_id",
  sourceAccountSeq: "source_account_seq",
} as const satisfies Partial<Record<keyof UpsertCreatorRawMediaInput, string>>;

// A sparse post sidecar is not evidence that Vault metadata was removed.
// Empty strings and zero are explicit values; only null means unavailable.
const NULLABLE_METADATA = new Set<string>([
  "owner_account_ref",
  "filename",
  "provider_type",
  "media_type",
  "mime_type",
  "duration_ms",
  "original_width",
  "original_height",
  "width",
  "height",
  "frame_rate_milli",
  "byte_size",
  "created_at_platform",
  "updated_at_platform",
]);

// Facts of the file itself that never change for one media id. An OLDER
// observation may still fill them while they are unknown: a replay of retained
// posts must not lose to a later sparse read that never carried them.
const IMMUTABLE_FILL = ["created_at_platform", "byte_size"] as const;

export async function upsertCreatorRawMedia(
  db: Database,
  input: UpsertCreatorRawMediaInput,
): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // The projector may have loaded its event before erasure deleted the ledger.
    // Serialize this check and write with erasure; throwing on contention keeps
    // the caller's projection watermark unchanged so the event remains retryable.
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.pageId))) {
      throw new Error("Raw media projection deferred during page erasure");
    }
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.pageId,
        platform: input.platform,
        refs: [],
        materialAt: input.observedAt,
      })
    ) {
      return { applied: false };
    }
    const fields = Object.entries(HEAD_COLUMNS) as Array<
      [keyof typeof HEAD_COLUMNS, string]
    >;
    const newer = sql`(excluded.last_observed_at, excluded.source_account_seq)
    > (creator_raw_media.last_observed_at, creator_raw_media.source_account_seq)`;
    const assignments = fields.map(([, column]) => {
      const name = sql.identifier(column);
      const incoming = NULLABLE_METADATA.has(column)
        ? sql`coalesce(excluded.${name}, creator_raw_media.${name})`
        : sql`excluded.${name}`;
      const kept = (IMMUTABLE_FILL as readonly string[]).includes(column)
        ? sql`coalesce(creator_raw_media.${name}, excluded.${name})`
        : sql`creator_raw_media.${name}`;
      return sql`${name} = case when ${newer} then ${incoming} else ${kept} end`;
    });
    const fills = sql.join(IMMUTABLE_FILL.map((column) => {
      const name = sql.identifier(column);
      return sql`(creator_raw_media.${name} is null and excluded.${name} is not null)`;
    }), sql` or `);
    const result = await database.execute(sql`
    insert into creator_raw_media (
      page_id, media_ref, first_origin, first_observed_at, last_observed_at,
      ${sql.join(
        fields.map(([, column]) => sql.identifier(column)),
        sql`, `,
      )}
    ) values (
      ${input.pageId}, ${input.mediaRef}, ${input.firstOrigin}, ${input.observedAt}, ${input.observedAt},
      ${sql.join(
        fields.map(([field]) => sql`${input[field]}`),
        sql`, `,
      )}
    )
    on conflict (page_id, media_ref) do update set
      ${sql.join(assignments, sql`, `)},
      first_origin = case when excluded.first_observed_at < creator_raw_media.first_observed_at
        then excluded.first_origin else creator_raw_media.first_origin end,
      first_observed_at = least(creator_raw_media.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(creator_raw_media.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    where ${newer} or excluded.first_observed_at < creator_raw_media.first_observed_at or ${fills}
    returning media_ref
  `);
    return { applied: (result.rowCount ?? 0) > 0 };
  });
}
