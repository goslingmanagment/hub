// Which media object of a Fansly answer a look is about (owner 2026-11-11).
// Pure: the answers' own shapes, read the same way for every source of a look:
//
// - a post's files: its attachments in their `pos` order, an album (bundle)
//   replaced by its files in its order; other attachments (a poll, a goal) are
//   not files. The schedule's read carries them in a post template beside an
//   `aggregationData`; a post read by its id (`GET /post?ids=`) in the post
//   itself beside the answer's top-level `accountMedia` / `accountMediaBundles`;
// - a vault page (`GET /media/vaultnew`): its `media[]` are the files themselves.
//
// The media object is what the selector reads (`select.ts`); its owner is what
// keeps a fan's media out.

/** Fansly's attachment content types: one account media, a bundle (an album). */
const CONTENT_ACCOUNT_MEDIA = 1;
const CONTENT_BUNDLE = 2;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
}

export function idOf(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]{1,24}$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function posOf(row: Record<string, unknown>, fallback: number): number {
  return typeof row.pos === "number" && Number.isFinite(row.pos) ? row.pos : fallback;
}

/** Rows in their `pos` order (the served order where it is missing). */
function byPos(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => posOf(a.row, a.index) - posOf(b.row, b.index) || a.index - b.index)
    .map(({ row }) => row);
}

/** One file of an answer: the media object the selector reads, its id, and the account it belongs to. */
export interface AnswerFile {
  ok: true;
  mediaRef: string;
  /** As the answer names it (null: not named). */
  ownerAccountRef: string | null;
  media: Record<string, unknown>;
}

export type PostFileResolution =
  | (AnswerFile & { accountMediaRef: string })
  /** `attachment_not_found`: the post has no file at `index`; `media_not_in_read`:
   *  the answer does not carry that file (or an album before it). */
  | { ok: false; reason: "attachment_not_found" | "media_not_in_read" };

/** The file at `index` of a post's attachments, with the answer's account media and albums. */
export function postFileOf(
  input: { attachments: unknown; accountMedia: unknown; bundles: unknown },
  index: number,
): PostFileResolution {
  const accountMedia = new Map<string, Record<string, unknown>>();
  for (const row of records(input.accountMedia)) {
    const id = idOf(row.id);
    if (id !== null) accountMedia.set(id, row);
  }
  const bundles = new Map<string, string[]>();
  for (const row of records(input.bundles)) {
    const id = idOf(row.id);
    if (id === null) continue;
    const members = Array.isArray(row.accountMediaIds)
      ? row.accountMediaIds.map(idOf)
      : byPos(records(row.bundleContent)).map((member) => idOf(member.accountMediaId));
    if (members.every((member) => member !== null)) bundles.set(id, members as string[]);
  }

  // The post's files in order; an album the answer does not carry ends what can be counted.
  const files: string[] = [];
  let unknownFrom: number | null = null;
  for (const attachment of byPos(records(input.attachments))) {
    const contentId = idOf(attachment.contentId);
    const type = attachment.contentType;
    if (type === CONTENT_ACCOUNT_MEDIA && contentId !== null) {
      files.push(contentId);
    } else if (type === CONTENT_BUNDLE && contentId !== null) {
      const members = bundles.get(contentId);
      if (members === undefined) {
        unknownFrom = files.length;
        break;
      }
      files.push(...members);
    }
  }
  if (unknownFrom !== null && index >= unknownFrom) return { ok: false, reason: "media_not_in_read" };
  const accountMediaRef = files[index];
  if (accountMediaRef === undefined) return { ok: false, reason: "attachment_not_found" };
  const row = accountMedia.get(accountMediaRef);
  const media = asRecord(row?.media);
  const mediaRef = idOf(media?.id) ?? idOf(row?.mediaId);
  if (row === undefined || media === null || mediaRef === null) return { ok: false, reason: "media_not_in_read" };
  return { ok: true, accountMediaRef, mediaRef, ownerAccountRef: idOf(row.accountId) ?? idOf(media.accountId), media };
}

/** The file at `index` of a post read by its id (`GET /post?ids=`): the post
 *  among the answer's `posts`, its account media at the answer's top level. */
export function publishedPostFile(
  answer: unknown,
  postRef: string,
  index: number,
): PostFileResolution | { ok: false; reason: "post_not_in_answer" } {
  const response = asRecord(answer) ?? {};
  const post = records(response.posts).find((candidate) => idOf(candidate.id) === postRef);
  if (post === undefined) return { ok: false, reason: "post_not_in_answer" };
  const aggregation = asRecord(response.aggregationData) ?? {};
  return postFileOf({
    attachments: post.attachments,
    accountMedia: Array.isArray(response.accountMedia) ? response.accountMedia : aggregation.accountMedia,
    bundles: Array.isArray(response.accountMediaBundles) ? response.accountMediaBundles : aggregation.accountMediaBundles,
  }, index);
}

/** A vault file in a vault page (`GET /media/vaultnew`): one of its `media[]`. */
export function vaultPageFile(answer: unknown, mediaRef: string): AnswerFile | { ok: false; reason: "media_not_in_read" } {
  const media = records(asRecord(answer)?.media).find((candidate) => idOf(candidate.id) === mediaRef);
  if (media === undefined) return { ok: false, reason: "media_not_in_read" };
  return { ok: true, mediaRef, ownerAccountRef: idOf(media.accountId), media };
}
