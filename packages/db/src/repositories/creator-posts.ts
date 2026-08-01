// Current creator-post projection repository. Every raw response and material
// version lives upstream; this table keeps only the latest observed post head.
// account_seq orders ledger append, not provider observation time, so material
// freshness is observed_at first with account_seq only as the deterministic
// same-instant tie-break.

import type { Platform } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface UpsertCreatorPostInput {
  accountId: number;
  platform: Platform;
  platformPostId: string;
  textPlain: string;
  publishedAt: Date;
  observedAt: Date;
  contentHash: string;
  attachmentCount: number;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export interface UpsertCreatorPostResult {
  applied: boolean;
  id: number | null;
}

export async function upsertCreatorPost(
  db: Database,
  input: UpsertCreatorPostInput,
): Promise<UpsertCreatorPostResult> {
  const result = await db.execute<{ id: string }>(sql`
    insert into creator_posts (
      account_id,
      platform,
      platform_post_id,
      text_plain,
      published_at,
      first_observed_at,
      last_observed_at,
      content_hash,
      attachment_count,
      source_event_id,
      source_observation_id,
      source_account_seq,
      created_at,
      updated_at
    ) values (
      ${input.accountId},
      ${input.platform},
      ${input.platformPostId},
      ${input.textPlain},
      ${input.publishedAt},
      ${input.observedAt},
      ${input.observedAt},
      ${input.contentHash},
      ${input.attachmentCount},
      ${input.sourceEventId},
      ${input.sourceObservationId},
      ${input.sourceAccountSeq},
      now(),
      now()
    )
    on conflict (account_id, platform_post_id) do update set
      platform = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.platform
        else creator_posts.platform
      end,
      text_plain = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.text_plain
        else creator_posts.text_plain
      end,
      published_at = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.published_at
        else creator_posts.published_at
      end,
      first_observed_at = least(creator_posts.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(creator_posts.last_observed_at, excluded.last_observed_at),
      content_hash = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.content_hash
        else creator_posts.content_hash
      end,
      attachment_count = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.attachment_count
        else creator_posts.attachment_count
      end,
      source_event_id = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.source_event_id
        else creator_posts.source_event_id
      end,
      source_observation_id = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.source_observation_id
        else creator_posts.source_observation_id
      end,
      source_account_seq = case
        when excluded.last_observed_at > creator_posts.last_observed_at
          or (
            excluded.last_observed_at = creator_posts.last_observed_at
            and excluded.source_account_seq > creator_posts.source_account_seq
          )
        then excluded.source_account_seq
        else creator_posts.source_account_seq
      end,
      updated_at = now()
    where excluded.first_observed_at < creator_posts.first_observed_at
      or excluded.last_observed_at > creator_posts.last_observed_at
      or (
        excluded.last_observed_at = creator_posts.last_observed_at
        and excluded.source_account_seq > creator_posts.source_account_seq
      )
    returning id::text as id
  `);
  const row = result.rows[0];
  return {
    applied: row !== undefined,
    id: row === undefined ? null : Number(row.id),
  };
}
