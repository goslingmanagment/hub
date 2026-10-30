import { createHash } from "node:crypto";

import { millsFromInteger, sanitizePostgresText, type Mills } from "@agency_hub_core/shared";

// The page's own profile on Fansly, read out of `/account/me` (0337): what a
// creator sees on her profile and in its editor — the display name, the bio,
// the location, the social links, the badges Fansly awarded (the leaderboard's
// «Top 500 Jun '26»), the pinned posts, the walls — and the counters under it.
//
// The answer is journaled first (kind `account_me`, every hour by
// `account.poll`, more often by the page browser's own site); this module
// only reads it. Two shapes come out of one answer:
//
// - the profile's CONTENT: everything a person sets or Fansly awards, never a
//   counter. Its sha256 is the version's identity: the same content seen again
//   only widens its first/last seen, so an apply is idempotent in any order
//   (a re-apply from the journal, the backfill of old answers);
// - the day's COUNTERS: followers, subscribers, likes, the media counts of the
//   timeline, stories, the stream's status and the earnings balance — the last
//   answer of a UTC day wins.
//
// Left out on purpose: the e-mail, the wallets but the earnings balance, the
// online status and last-seen instant, `containingLists` (the agency's own
// lists of this account) and the stream's playback data.

/** One social link of the profile. */
export interface PageProfileSocial {
  providerId: string;
  handle: string;
}

/** One badge Fansly awarded the page (`badgeType` 1002: a leaderboard). */
export interface PageProfileBadge {
  badgeRef: string;
  badgeType: number | null;
  /** `metadata.badge_title` («Top 500 Jun '26»); the badge's HTML is dropped. */
  title: string | null;
  description: string | null;
  /** ISO instant of `createdAt`: when it was awarded. */
  awardedAt: string | null;
}

/** One pinned post of the profile, in its wall. */
export interface PageProfilePinnedPost {
  postRef: string;
  wallRef: string | null;
  pos: number | null;
  /** ISO instant of `createdAt`: when it was pinned. */
  pinnedAt: string | null;
}

/** One wall of the profile. */
export interface PageProfileWall {
  wallRef: string;
  pos: number | null;
  name: string | null;
  description: string | null;
  private: boolean;
  mainWall: boolean;
  defaultWall: boolean;
}

/** What a person sets on the profile or Fansly awards it: never a counter. */
export interface PageProfileContent {
  username: string | null;
  displayName: string | null;
  about: string | null;
  location: string | null;
  avatarMediaRef: string | null;
  bannerMediaRef: string | null;
  socials: PageProfileSocial[];
  badges: PageProfileBadge[];
  pinnedPosts: PageProfilePinnedPost[];
  walls: PageProfileWall[];
  profileFlags: number | null;
  accountFlags: number | null;
  profileAccessFlags: number | null;
}

/** The counters under the profile at the answer's instant. */
export interface PageProfileCounters {
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
  /** `streaming.channel.status` as served (null: no channel). */
  streamStatus: number | null;
  earningsBalanceMills: Mills | null;
}

export interface PageProfileAnswer {
  accountRef: string;
  content: PageProfileContent;
  /** sha256 hex over the content, keys in a fixed order. */
  contentSha256: string;
  counters: PageProfileCounters;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? sanitizePostgresText(value) : null;
}

/** A served id: a string, or a number Fansly sometimes sends for small ids. */
function ref(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function count(value: unknown): number | null {
  const n = int(value);
  return n === null || n < 0 ? null : n;
}

function iso(ms: unknown): string | null {
  const n = int(ms);
  return n === null || n <= 0 ? null : new Date(n).toISOString();
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function badgeTitle(metadata: unknown): string | null {
  if (typeof metadata !== "string" || metadata.length === 0) return null;
  try {
    return text(recordOf(JSON.parse(metadata))?.badge_title);
  } catch {
    return null;
  }
}

function contentOf(account: Record<string, unknown>): PageProfileContent {
  return {
    username: text(account.username),
    displayName: text(account.displayName),
    about: text(account.about),
    location: text(account.location),
    avatarMediaRef: ref(recordOf(account.avatar)?.id),
    bannerMediaRef: ref(recordOf(account.banner)?.id),
    socials: list(account.profileSocials)
      .map((item) => ({ providerId: ref(item.providerId) ?? "", handle: text(item.handle) ?? "" }))
      .filter((item) => item.providerId !== "" || item.handle !== ""),
    badges: list(account.profileBadges)
      .map((item) => ({
        badgeRef: ref(item.badgeId) ?? "",
        badgeType: int(item.badgeType),
        title: badgeTitle(item.metadata),
        description: text(item.badgeDescription),
        awardedAt: iso(item.createdAt),
      }))
      .filter((item) => item.badgeRef !== "")
      .sort((a, b) => (a.awardedAt ?? "").localeCompare(b.awardedAt ?? "") || a.badgeRef.localeCompare(b.badgeRef)),
    pinnedPosts: list(account.pinnedPosts)
      .map((item) => ({ postRef: ref(item.postId) ?? "", wallRef: ref(item.wallId), pos: int(item.pos), pinnedAt: iso(item.createdAt) }))
      .filter((item) => item.postRef !== "")
      .sort((a, b) => (a.wallRef ?? "").localeCompare(b.wallRef ?? "") || (a.pos ?? 0) - (b.pos ?? 0) || a.postRef.localeCompare(b.postRef)),
    walls: list(account.walls)
      .map((item) => ({
        wallRef: ref(item.id) ?? "",
        pos: int(item.pos),
        name: text(item.name),
        description: text(item.description),
        private: item.private === 1 || item.private === true,
        mainWall: item.mainWall === true,
        defaultWall: item.defaultWall === true,
      }))
      .filter((item) => item.wallRef !== "")
      .sort((a, b) => (a.pos ?? Number.MAX_SAFE_INTEGER) - (b.pos ?? Number.MAX_SAFE_INTEGER) || a.wallRef.localeCompare(b.wallRef)),
    profileFlags: int(account.profileFlags),
    accountFlags: int(account.flags),
    profileAccessFlags: int(account.profileAccessFlags),
  };
}

function countersOf(account: Record<string, unknown>): PageProfileCounters {
  const timeline = recordOf(account.timelineStats);
  const stories = recordOf(account.mediaStoryState);
  const channel = recordOf(recordOf(account.streaming)?.channel);
  const balance = int(recordOf(account.earningsWallet)?.balance);
  return {
    followers: count(account.followCount),
    subscribers: count(account.subscriberCount),
    postLikes: count(account.postLikes),
    mediaLikes: count(account.accountMediaLikes),
    images: count(timeline?.imageCount),
    videos: count(timeline?.videoCount),
    bundles: count(timeline?.bundleCount),
    bundleImages: count(timeline?.bundleImageCount),
    bundleVideos: count(timeline?.bundleVideoCount),
    stories: count(stories?.storyCount),
    hasActiveStories: typeof stories?.hasActiveStories === "boolean" ? stories.hasActiveStories : null,
    streamStatus: channel === null ? null : int(channel.status),
    earningsBalanceMills: balance === null ? null : millsFromInteger(balance),
  };
}

/** The content's identity: sha256 over its JSON (keys in the fixed order the
 *  content is built in, lists sorted). */
export function pageProfileContentSha256(content: PageProfileContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * Read the profile out of one `/account/me` answer (`{ account }`, the envelope's
 * `response`). Null when it names no account.
 */
export function parsePageProfileAnswer(response: unknown): PageProfileAnswer | null {
  const account = recordOf(recordOf(response)?.account);
  const accountRef = ref(account?.id);
  if (account === null || accountRef === null) return null;
  const content = contentOf(account);
  return { accountRef, content, contentSha256: pageProfileContentSha256(content), counters: countersOf(account) };
}
