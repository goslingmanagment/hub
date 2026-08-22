// Current creator-post projection repository. Every raw response and material
// version lives upstream; this table keeps only the latest observed post head.
// account_seq orders ledger append, not provider observation time, so material
// freshness is observed_at first with account_seq only as the deterministic
// same-instant tie-break.

import type { Platform } from "@agency_hub_core/shared";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";

type LatestObservedProjectionTable = "creator_posts" | "creator_post_tips";

function newerWins(tableName: LatestObservedProjectionTable) {
  const currentTable = sql.identifier(tableName);
  const excluded = sql.identifier("excluded");
  const lastObservedAt = sql.identifier("last_observed_at");
  const sourceAccountSeq = sql.identifier("source_account_seq");

  return (columnName: string, newerValue?: SQL): SQL => {
    const column = sql.identifier(columnName);
    const winningValue = newerValue ?? sql`${excluded}.${column}`;
    return sql`case
      when ${excluded}.${lastObservedAt} > ${currentTable}.${lastObservedAt}
        or (
          ${excluded}.${lastObservedAt} = ${currentTable}.${lastObservedAt}
          and ${excluded}.${sourceAccountSeq} > ${currentTable}.${sourceAccountSeq}
        )
      then ${winningValue}
      else ${currentTable}.${column}
    end`;
  };
}

const newerCreatorPostValue = newerWins("creator_posts");
const newerCreatorPostTipValue = newerWins("creator_post_tips");

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Drizzle expands a bare JS array into a parameter LIST, so an empty one is a
 * runtime syntax error — and an EMPTY ref array is the normal case here
 * (`wallIds: []` is what `GET /post?ids=` served). NULL stays NULL: "the
 * response did not carry this field" is a different fact from "it carried it
 * empty", and the whole point of these columns is that the two never merge.
 */
function textArrayParam(values: readonly string[] | null): SQL {
  if (values === null) {
    return sql`null::text[]`;
  }
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}

export interface UpsertCreatorPostInput {
  accountId: number;
  platform: Platform;
  platformPostId: string;
  textPlain: string;
  publishedAt: Date;
  observedAt: Date;
  contentHash: string;
  attachmentCount: number;
  tipAmountMills: bigint | null;
  attachmentTipAmountMills: bigint | null;
  postTipTotalMills: bigint | null;
  tipGoalLinked: boolean | null;
  tipGoalRef: string | null;
  tipGoalLabel: string | null;
  tipGoalTargetMills: bigint | null;
  tipGoalCurrentMills: bigint | null;
  tipGoalAmountsHidden: boolean | null;
  // ── WP-F6 (migration 0139) ────────────────────────────────────────────────
  likeCount: bigint | null;
  mediaLikeCount: bigint | null;
  replyCount: bigint | null;
  fypFlags: number | null;
  expiresAt: Date | null;
  inReplyToRef: string | null;
  inReplyToRootRef: string | null;
  wallRefs: string[] | null;
  accountMentionRefs: string[] | null;
  hashtags: string[] | null;
  hashtagsNormalized: string[] | null;
  hashtagParserVersion: number | null;
  attachmentRefs: unknown[] | null;
  /** When the counters above were observed. Derived by the PROJECTOR from the
   *  event's own `observedAt`, so a rebuild reproduces it byte-for-byte. */
  engagementObservedAt: Date | null;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export interface UpsertCreatorPostResult {
  applied: boolean;
  id: number | null;
  /** WP-F6: the reply count this row held BEFORE the upsert, read inside the
   *  same transaction. `undefined` means there was no row (a first sighting,
   *  whose walk row is seeded never-visited and already top-priority). */
  priorReplyCount?: bigint | null;
  /** WP-F6: true when the head's `reply_count` moved and the `post_replies`
   *  walk row was marked dirty in this transaction. */
  replyCountChanged: boolean;
}

/**
 * The post head, AND — in the SAME TRANSACTION — the WP-F5 reply-walk queue row
 * and the WP-F6 engagement-refresh queue row for it.
 *
 * Why the two writes are one transaction. The walk queue is capture-plane
 * operational state (§3.4) keyed on the post ref, and its whole contract is
 * "every root this system knows about has a walk row". A post committed without
 * its queue row is a post the comment lane will never look at, and nothing
 * downstream would notice: the archive would simply be missing that post's
 * comments forever, with a healthy lane and a clean coverage row. Seeding on a
 * timer instead leaves the same hole for however long the timer is — and the
 * seeding sweep is itself bounded by a daily call budget, so "however long"
 * can be days.
 *
 * The queue insert is `ON CONFLICT DO NOTHING` and runs on every upsert, not
 * only on the applied ones: the head upsert is guarded (a replayed older
 * capture writes nothing), and a post whose head did not move still needs its
 * walk row to exist. It is a no-op the second time and every time after.
 *
 * FANSLY ONLY, decided in SQL rather than in TypeScript — `/post/{id}/replies`
 * is a Fansly route and an OnlyFans post has no walk to queue. The predicate
 * lives in the statement so the platform seam stays where the ratchet expects
 * it: no new strict platform comparison outside the adapter packages, which the
 * Stage 18 budget counts.
 */
export async function upsertCreatorPost(
  db: Database,
  input: UpsertCreatorPostInput,
): Promise<UpsertCreatorPostResult> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // WP-F6: read the reply count the head held BEFORE the upsert, inside this
    // transaction. `INSERT … ON CONFLICT DO UPDATE … RETURNING` returns the NEW
    // row and gives no access to the old one, so the comparison needs its own
    // (index-covered, single-row) read. It is the whole basis of the dirty
    // signal below: a reply count that moved is the only cheap evidence this
    // system gets that a post's comments changed.
    const prior = await database.execute<{ reply_count: string | null }>(sql`
      select reply_count::text as reply_count
        from creator_posts
       where account_id = ${input.accountId}
         and platform_post_id = ${input.platformPostId}
    `);
    const priorRow = prior.rows[0];
    const priorReplyCount = priorRow === undefined
      ? undefined
      : priorRow.reply_count === null
        ? null
        : BigInt(priorRow.reply_count);

    const upserted = await upsertCreatorPostHead(database, input);

    // BOTH per-subject planes are seeded here, in the projector's own
    // transaction. WP-F5's argument applies unchanged to WP-F6: a post
    // committed without its queue rows is a post the reply walk never reads and
    // the engagement refresh never re-reads, with a healthy lane, a clean
    // coverage row and nothing anywhere reporting a problem.
    //
    // FANSLY ONLY, decided in SQL and not in TypeScript — `/post/{id}/replies`
    // and `GET /post?ids=` are Fansly routes. The predicate lives in the
    // statement so the platform seam stays where the Stage 18 ratchet expects
    // it: no new strict platform equality outside the adapter packages.
    await database.execute(sql`
      insert into subject_refresh_state (
        page_id, plane, subject_ref, refresh_class, next_due_at
      )
      select ${input.accountId}, plane.name, ${input.platformPostId}, 'fresh',
             ${input.observedAt}
        from (values ('post_replies'), ('post_engagement')) as plane(name)
       where ${input.platform} = 'fansly'
      on conflict (page_id, plane, subject_ref) do nothing
    `);

    // WP-F6 → WP-F5 hook: a head whose `reply_count` MOVED marks the reply walk
    // dirty. Only on an existing row — a first sighting is already never-walked
    // and therefore already in the walk's top priority band, and marking it
    // dirty would demote it to band 1.
    //
    // An UPDATE rather than an upsert, deliberately: the walk row was just
    // ensured to exist for Fansly and only for Fansly, so an INSERT here could
    // manufacture a `post_replies` row for an OnlyFans post that has no such
    // route. The Fansly predicate rides along in the WHERE for the same reason
    // as above.
    const replyCountChanged = priorReplyCount !== undefined
      && input.replyCount !== null
      && priorReplyCount !== input.replyCount;
    if (replyCountChanged) {
      await database.execute(sql`
        update subject_refresh_state
           set refresh_class = 'dirty',
               dirty_reason = 'reply_count_changed',
               next_due_at = least(
                 coalesce(subject_refresh_state.next_due_at, ${input.observedAt}),
                 ${input.observedAt}
               ),
               updated_at = now()
         where page_id = ${input.accountId}
           and plane = 'post_replies'
           and subject_ref = ${input.platformPostId}
           and ${input.platform} = 'fansly'
      `);
    }

    return {
      ...upserted,
      ...(priorReplyCount === undefined ? {} : { priorReplyCount }),
      replyCountChanged,
    };
  });
}

async function upsertCreatorPostHead(
  db: Database,
  input: UpsertCreatorPostInput,
): Promise<{ applied: boolean; id: number | null }> {
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
      tip_amount_mills,
      attachment_tip_amount_mills,
      post_tip_total_mills,
      tip_goal_linked,
      tip_goal_ref,
      tip_goal_label,
      tip_goal_target_mills,
      tip_goal_current_mills,
      tip_goal_amounts_hidden,
      like_count,
      media_like_count,
      reply_count,
      fyp_flags,
      expires_at,
      in_reply_to_ref,
      in_reply_to_root_ref,
      wall_refs,
      account_mention_refs,
      hashtags,
      hashtags_normalized,
      hashtag_parser_version,
      attachment_refs,
      engagement_observed_at,
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
      ${input.tipAmountMills},
      ${input.attachmentTipAmountMills},
      ${input.postTipTotalMills},
      ${input.tipGoalLinked},
      ${input.tipGoalRef},
      ${input.tipGoalLabel},
      ${input.tipGoalTargetMills},
      ${input.tipGoalCurrentMills},
      ${input.tipGoalAmountsHidden},
      ${input.likeCount},
      ${input.mediaLikeCount},
      ${input.replyCount},
      ${input.fypFlags},
      ${input.expiresAt},
      ${input.inReplyToRef},
      ${input.inReplyToRootRef},
      ${textArrayParam(input.wallRefs)},
      ${textArrayParam(input.accountMentionRefs)},
      ${textArrayParam(input.hashtags)},
      ${textArrayParam(input.hashtagsNormalized)},
      ${input.hashtagParserVersion},
      ${input.attachmentRefs === null ? null : JSON.stringify(input.attachmentRefs)}::jsonb,
      ${input.engagementObservedAt},
      ${input.sourceEventId},
      ${input.sourceObservationId},
      ${input.sourceAccountSeq},
      now(),
      now()
    )
    on conflict (account_id, platform_post_id) do update set
      platform = ${newerCreatorPostValue("platform")},
      text_plain = ${newerCreatorPostValue("text_plain")},
      published_at = ${newerCreatorPostValue("published_at")},
      first_observed_at = least(creator_posts.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(creator_posts.last_observed_at, excluded.last_observed_at),
      content_hash = ${newerCreatorPostValue("content_hash")},
      attachment_count = ${newerCreatorPostValue("attachment_count")},
      tip_amount_mills = ${newerCreatorPostValue("tip_amount_mills")},
      attachment_tip_amount_mills = ${newerCreatorPostValue("attachment_tip_amount_mills")},
      post_tip_total_mills = ${newerCreatorPostValue("post_tip_total_mills")},
      tip_goal_linked = ${newerCreatorPostValue("tip_goal_linked")},
      tip_goal_ref = ${newerCreatorPostValue("tip_goal_ref")},
      tip_goal_label = ${newerCreatorPostValue("tip_goal_label")},
      tip_goal_target_mills = ${newerCreatorPostValue("tip_goal_target_mills")},
      tip_goal_current_mills = ${newerCreatorPostValue("tip_goal_current_mills")},
      tip_goal_amounts_hidden = ${newerCreatorPostValue("tip_goal_amounts_hidden")},
      like_count = ${newerCreatorPostValue("like_count")},
      media_like_count = ${newerCreatorPostValue("media_like_count")},
      reply_count = ${newerCreatorPostValue("reply_count")},
      fyp_flags = ${newerCreatorPostValue("fyp_flags")},
      expires_at = ${newerCreatorPostValue("expires_at")},
      in_reply_to_ref = ${newerCreatorPostValue("in_reply_to_ref")},
      in_reply_to_root_ref = ${newerCreatorPostValue("in_reply_to_root_ref")},
      wall_refs = ${newerCreatorPostValue("wall_refs")},
      account_mention_refs = ${newerCreatorPostValue("account_mention_refs")},
      hashtags = ${newerCreatorPostValue("hashtags")},
      hashtags_normalized = ${newerCreatorPostValue("hashtags_normalized")},
      hashtag_parser_version = ${newerCreatorPostValue("hashtag_parser_version")},
      attachment_refs = ${newerCreatorPostValue("attachment_refs")},
      -- The engagement instant only ever moves FORWARD, and it is its own
      -- clock: a later capture that carried no counters must not erase the
      -- moment the counters WERE last seen, and an out-of-order replay of an
      -- older sighting must not drag it backwards.
      engagement_observed_at = greatest(
        creator_posts.engagement_observed_at,
        excluded.engagement_observed_at
      ),
      source_event_id = ${newerCreatorPostValue("source_event_id")},
      source_observation_id = ${newerCreatorPostValue("source_observation_id")},
      source_account_seq = ${newerCreatorPostValue("source_account_seq")},
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

export interface UpsertCreatorPostTipInput {
  accountId: number;
  platform: Platform;
  platformPostId: string;
  platformTipId: string;
  tipSenderPlatformUserId: string;
  postTipAmountMills: bigint;
  occurredAt: Date;
  observedAt: Date;
  receiverTransactionRef: string | null;
  senderTransactionRef: string | null;
  tipGoalRef: string | null;
  /** `unknown` is an omission, not contradictory evidence: it must not erase
   * an exact goal ref captured by an earlier typed-target observation. */
  tipGoalAttribution: "goal" | "direct" | "unknown";
  tipMessageText: string | null;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export type UpsertCreatorPostTipResult =
  | { status: "applied"; applied: true; id: number }
  | { status: "unchanged" | "deferred" | "erasure_fenced"; applied: false; id: null };

export async function upsertCreatorPostTip(
  db: Database,
  input: UpsertCreatorPostTipInput,
): Promise<UpsertCreatorPostTipResult> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    // This projection is replayable from retained post-tip events. Serialize
    // its check+write with governed erasure so an event loaded before deletion
    // cannot restore the fan id or verbatim note after that deletion commits.
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.accountId))) {
      return { status: "deferred", applied: false, id: null } as const;
    }
    const materialAt = input.occurredAt < input.observedAt
      ? input.occurredAt
      : input.observedAt;
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.accountId,
        platform: input.platform,
        refs: [input.tipSenderPlatformUserId],
        materialAt,
      })
    ) {
      return { status: "erasure_fenced", applied: false, id: null } as const;
    }
    return upsertCreatorPostTipUnfenced(database, input);
  });
}

async function upsertCreatorPostTipUnfenced(
  db: Database,
  input: UpsertCreatorPostTipInput,
): Promise<UpsertCreatorPostTipResult> {
  const result = await db.execute<{ id: string }>(sql`
    insert into creator_post_tips (
      account_id,
      platform,
      platform_post_id,
      platform_tip_id,
      tip_sender_platform_user_id,
      post_tip_amount_mills,
      occurred_at,
      receiver_transaction_ref,
      sender_transaction_ref,
      tip_goal_ref,
      tip_message_text,
      first_observed_at,
      last_observed_at,
      content_hash,
      source_event_id,
      source_observation_id,
      source_account_seq,
      created_at,
      updated_at
    ) values (
      ${input.accountId},
      ${input.platform},
      ${input.platformPostId},
      ${input.platformTipId},
      ${input.tipSenderPlatformUserId},
      ${input.postTipAmountMills},
      ${input.occurredAt},
      ${input.receiverTransactionRef},
      ${input.senderTransactionRef},
      ${input.tipGoalRef},
      ${input.tipMessageText},
      ${input.observedAt},
      ${input.observedAt},
      ${input.contentHash},
      ${input.sourceEventId},
      ${input.sourceObservationId},
      ${input.sourceAccountSeq},
      now(),
      now()
    )
    on conflict (account_id, platform_tip_id, platform_post_id) do update set
      platform = ${newerCreatorPostTipValue("platform")},
      tip_sender_platform_user_id = ${newerCreatorPostTipValue(
        "tip_sender_platform_user_id",
      )},
      post_tip_amount_mills = ${newerCreatorPostTipValue("post_tip_amount_mills")},
      occurred_at = ${newerCreatorPostTipValue("occurred_at")},
      receiver_transaction_ref = ${newerCreatorPostTipValue("receiver_transaction_ref")},
      sender_transaction_ref = ${newerCreatorPostTipValue("sender_transaction_ref")},
      tip_goal_ref = ${newerCreatorPostTipValue(
        "tip_goal_ref",
        sql`case
          when ${input.tipGoalAttribution} = 'unknown'
            and creator_post_tips.tip_goal_ref is not null
          then creator_post_tips.tip_goal_ref
          else excluded.tip_goal_ref
        end`,
      )},
      tip_message_text = ${newerCreatorPostTipValue("tip_message_text")},
      first_observed_at = least(
        creator_post_tips.first_observed_at,
        excluded.first_observed_at
      ),
      last_observed_at = greatest(
        creator_post_tips.last_observed_at,
        excluded.last_observed_at
      ),
      content_hash = ${newerCreatorPostTipValue("content_hash")},
      source_event_id = ${newerCreatorPostTipValue("source_event_id")},
      source_observation_id = ${newerCreatorPostTipValue("source_observation_id")},
      source_account_seq = ${newerCreatorPostTipValue("source_account_seq")},
      updated_at = now()
    where excluded.first_observed_at < creator_post_tips.first_observed_at
      or excluded.last_observed_at > creator_post_tips.last_observed_at
      or (
        excluded.last_observed_at = creator_post_tips.last_observed_at
        and excluded.source_account_seq > creator_post_tips.source_account_seq
      )
    returning id::text as id
  `);
  const row = result.rows[0];
  return row === undefined
    ? { status: "unchanged", applied: false, id: null }
    : { status: "applied", applied: true, id: Number(row.id) };
}
