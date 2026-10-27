// FANSLY BLOCKLIST (fan marks, 2026-10-27): the Fansly profiles a post of the
// Telegram group names. A post names a profile by its link —
// `https://fansly.com/<handle>`, often with `/posts` or `/media` after it, a
// query, no scheme or `www.`, glued to the next line's text — in its text or
// behind a word (a text link). Fansly's own pages (`/post/…`, `/explore`, …)
// name nobody. Pure.

/** First path segments of fansly.com that are Fansly's own pages, not a profile (lowercase). */
export const FANSLY_RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "about", "account", "api", "app", "application", "applications", "apps", "assets", "blog", "bookmarks", "cdn",
  "chat", "chats", "collection", "collections", "contact", "creator", "creators", "discover", "dmca", "earnings",
  "explore", "faq", "followers", "following", "foryou", "fyp", "help", "home", "legal", "list", "lists", "live",
  "login", "logout", "media", "mediaoffers", "message", "messages", "notes", "notifications", "password", "payments",
  "payouts", "polls", "post", "posts", "privacy", "profile", "purchases", "ref", "referral", "referrals", "register",
  "reset", "search", "settings", "signin", "signup", "static", "statistics", "stats", "stories", "story", "stream",
  "streaming", "subscribers", "subscription", "subscriptions", "support", "tag", "tags", "terms", "tips", "tos",
  "upload", "uploads", "vault", "verification", "verify", "wallet",
]);

/** A Fansly username as Hub matches it: letters, digits, `_`, `-`, and `.` inside. */
const HANDLE_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_-])?$/;

/**
 * A fansly.com link: not inside another host's name or an address
 * (`notfansly.com`, `x@fansly.com`), any scheme and case, then the first path
 * segment — it ends at the first character a username does not hold, and
 * never with a dot (a sentence's end).
 */
const LINK = /(?<![\w.@/-])(?:https?:\/\/)?(?:www\.)?fansly\.com\/@?([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?)/giu;

export interface BlocklistHandle {
  /** Lowercase: the match key. */
  key: string;
  /** As the post wrote it. */
  handle: string;
}

/** The match key of a username (`@name` taken as `name`), or null for one no link could name. */
export function blocklistHandleKey(username: string): string | null {
  const name = username.trim().replace(/^@/, "");
  return HANDLE_PATTERN.test(name) && !FANSLY_RESERVED_SEGMENTS.has(name.toLowerCase()) ? name.toLowerCase() : null;
}

/**
 * The profiles a post names, in the order it names them, each once (by key):
 * the links in its text, then the text links' targets (`urls`, a
 * MessageEntityTextUrl's `url`).
 */
export function parseBlocklistHandles(text: string, urls: readonly string[] = []): BlocklistHandle[] {
  const found = new Map<string, BlocklistHandle>();
  for (const source of [text, ...urls]) {
    for (const match of source.matchAll(LINK)) {
      const handle = match[1]!;
      const key = blocklistHandleKey(handle);
      if (key !== null && !found.has(key)) found.set(key, { key, handle });
    }
  }
  return [...found.values()];
}
