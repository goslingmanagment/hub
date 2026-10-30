// Fansly page profile (0336): writers and the reader of the typed copy of
// `/account/me` (apps/runtime/src/sync/fansly/lib/page-profile.ts).
//
// A version row is keyed by its content: the same content seen again only
// widens first/last seen (and their observations), so applying answers in any
// order — the hourly poll, a re-apply from the journal, the backfill of old
// answers — gives the same rows. A day's counters are replaced only by an
// answer received at the same instant or later (`captured_at`, then
// `observation_id`).

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface FanslyPageProfileContentRow {
  username: string | null;
  displayName: string | null;
  about: string | null;
  location: string | null;
  avatarMediaRef: string | null;
  bannerMediaRef: string | null;
  socials: unknown[];
  badges: unknown[];
  pinnedPosts: unknown[];
  walls: unknown[];
  profileFlags: number | null;
  accountFlags: number | null;
  profileAccessFlags: number | null;
}

export interface FanslyPageProfileCountersRow {
  followers: number | null;
  subscribers: number | null;
  postLikes: number | null;
  mediaLikes: number | null;
  images: number | null;
  videos: number | null;
  bundles: number | null;
  bundleImages: number | null;
  bundleVideos: number | null;
  stories: number | null;
  hasActiveStories: boolean | null;
  streamStatus: number | null;
  earningsBalanceMills: bigint | null;
}

export interface UpsertFanslyPageProfileInput {
  pageId: number;
  observationId: number;
  capturedAt: Date;
  contentSha256: string;
  content: FanslyPageProfileContentRow;
  counters: FanslyPageProfileCountersRow;
}

/** The UTC day of an instant, `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Write one answer's profile version and its day's counters. */
export async function upsertFanslyPageProfile(db: Database, input: UpsertFanslyPageProfileInput): Promise<void> {
  const { content: c, counters: n } = input;
  await db.execute(sql`
    insert into fansly_page_profile_versions as t (
      page_id, content_sha256, first_seen_at, last_seen_at, first_observation_id, last_observation_id,
      username, display_name, about, location, avatar_media_ref, banner_media_ref,
      socials, badges, pinned_posts, walls, profile_flags, account_flags, profile_access_flags
    ) values (
      ${input.pageId}, ${input.contentSha256}, ${input.capturedAt}, ${input.capturedAt}, ${input.observationId}, ${input.observationId},
      ${c.username}, ${c.displayName}, ${c.about}, ${c.location}, ${c.avatarMediaRef}, ${c.bannerMediaRef},
      ${JSON.stringify(c.socials)}::jsonb, ${JSON.stringify(c.badges)}::jsonb, ${JSON.stringify(c.pinnedPosts)}::jsonb,
      ${JSON.stringify(c.walls)}::jsonb, ${c.profileFlags}, ${c.accountFlags}, ${c.profileAccessFlags}
    )
    on conflict (page_id, content_sha256) do update set
      first_observation_id = case when excluded.first_seen_at < t.first_seen_at then excluded.first_observation_id else t.first_observation_id end,
      first_seen_at = least(t.first_seen_at, excluded.first_seen_at),
      last_observation_id = case when excluded.last_seen_at > t.last_seen_at then excluded.last_observation_id else t.last_observation_id end,
      last_seen_at = greatest(t.last_seen_at, excluded.last_seen_at)
    where excluded.first_seen_at < t.first_seen_at or excluded.last_seen_at > t.last_seen_at
  `);
  await db.execute(sql`
    insert into fansly_page_profile_daily as t (
      page_id, day, followers, subscribers, post_likes, media_likes, images, videos, bundles,
      bundle_images, bundle_videos, stories, has_active_stories, stream_status, earnings_balance_mills,
      observation_id, captured_at
    ) values (
      ${input.pageId}, ${utcDay(input.capturedAt)}::date, ${n.followers}, ${n.subscribers}, ${n.postLikes}, ${n.mediaLikes},
      ${n.images}, ${n.videos}, ${n.bundles}, ${n.bundleImages}, ${n.bundleVideos}, ${n.stories}, ${n.hasActiveStories},
      ${n.streamStatus}, ${n.earningsBalanceMills === null ? null : n.earningsBalanceMills.toString()}::bigint,
      ${input.observationId}, ${input.capturedAt}
    )
    on conflict (page_id, day) do update set
      followers = excluded.followers, subscribers = excluded.subscribers, post_likes = excluded.post_likes,
      media_likes = excluded.media_likes, images = excluded.images, videos = excluded.videos, bundles = excluded.bundles,
      bundle_images = excluded.bundle_images, bundle_videos = excluded.bundle_videos, stories = excluded.stories,
      has_active_stories = excluded.has_active_stories, stream_status = excluded.stream_status,
      earnings_balance_mills = excluded.earnings_balance_mills, observation_id = excluded.observation_id,
      captured_at = excluded.captured_at
    where (excluded.captured_at, excluded.observation_id) >= (t.captured_at, t.observation_id)
  `);
}

export interface FanslyPageProfileVersion extends FanslyPageProfileContentRow {
  contentSha256: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FanslyPageProfileDay {
  day: string;
  followers: number | null;
  subscribers: number | null;
  postLikes: number | null;
  mediaLikes: number | null;
  images: number | null;
  videos: number | null;
  bundles: number | null;
  stories: number | null;
  streamStatus: number | null;
  /** Mills (a balance is far below 2^53). */
  earningsBalanceMills: number | null;
  capturedAt: string;
}

export interface FanslyPageProfileRead {
  /** Every version, oldest first seen first; the current one is `current`. */
  versions: FanslyPageProfileVersion[];
  current: FanslyPageProfileVersion | null;
  /** The counters of the last `days` UTC days that have an answer, oldest first. */
  daily: FanslyPageProfileDay[];
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function jsonList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** The page's profile versions and the counters of its last `days` days. */
export async function readFanslyPageProfile(db: Database, pageId: number, options: { days: number }): Promise<FanslyPageProfileRead> {
  const versionRows = await db.execute(sql`
    select content_sha256, first_seen_at, last_seen_at, username, display_name, about, location,
           avatar_media_ref, banner_media_ref, socials, badges, pinned_posts, walls,
           profile_flags, account_flags, profile_access_flags
    from fansly_page_profile_versions
    where page_id = ${pageId}
    order by first_seen_at asc, content_sha256 asc
  `);
  const versions: FanslyPageProfileVersion[] = versionRows.rows.map((row) => ({
    contentSha256: String(row.content_sha256),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    username: row.username === null ? null : String(row.username),
    displayName: row.display_name === null ? null : String(row.display_name),
    about: row.about === null ? null : String(row.about),
    location: row.location === null ? null : String(row.location),
    avatarMediaRef: row.avatar_media_ref === null ? null : String(row.avatar_media_ref),
    bannerMediaRef: row.banner_media_ref === null ? null : String(row.banner_media_ref),
    socials: jsonList(row.socials),
    badges: jsonList(row.badges),
    pinnedPosts: jsonList(row.pinned_posts),
    walls: jsonList(row.walls),
    profileFlags: num(row.profile_flags),
    accountFlags: num(row.account_flags),
    profileAccessFlags: num(row.profile_access_flags),
  }));
  const current = versions.reduce<FanslyPageProfileVersion | null>(
    (best, version) => (best === null || version.lastSeenAt > best.lastSeenAt ? version : best),
    null,
  );
  const dayRows = await db.execute(sql`
    select day::text as day, followers, subscribers, post_likes, media_likes, images, videos, bundles,
           stories, stream_status, earnings_balance_mills, captured_at
    from fansly_page_profile_daily
    where page_id = ${pageId} and day > (now() at time zone 'utc')::date - ${options.days}::int
    order by day asc
  `);
  const daily: FanslyPageProfileDay[] = dayRows.rows.map((row) => ({
    day: String(row.day),
    followers: num(row.followers),
    subscribers: num(row.subscribers),
    postLikes: num(row.post_likes),
    mediaLikes: num(row.media_likes),
    images: num(row.images),
    videos: num(row.videos),
    bundles: num(row.bundles),
    stories: num(row.stories),
    streamStatus: num(row.stream_status),
    earningsBalanceMills: row.earnings_balance_mills === null ? null : Number(row.earnings_balance_mills),
    capturedAt: iso(row.captured_at),
  }));
  return { versions, current, daily };
}
