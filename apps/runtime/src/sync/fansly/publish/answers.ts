import type { FanslyWriteStep } from "@agency_hub_core/db";
import { FANSLY_UPLOAD_PART_MAX_BYTES, FANSLY_UPLOAD_STATUS, isFanslyStorageHost } from "@agency_hub_core/fansly";

// What a write's 2xx answer gave (wall posts PR 6): the ids the next steps
// are derived from. Read from the journaled answer (the capture wrote it to
// `observations` before this runs). An answer without the id its step must
// give is no answer Hub can build on: the command ends `unknown` and a person
// looks at the journaled body — Hub never assumes it did or did not happen.
//
// The shapes are the contract's (docs/plans/2026-10-23-wall-posts/
// fansly-publish-contract.md): account media — an array of `accountMedia`;
// a bundle — `accountMediaBundles[0].id`; a post — `postId`; a story — `id`;
// a cancel — the schedule's list, the cancelled post at `status` 3; a delete
// — `response: null` (the read by its id after it says whether it is gone); a
// vault album — the album with its `id`; its media — one album entry per
// media asked (§13).

export type WriteAnswerRead =
  /** `secret`: an upload's signed part URLs, by index — sealed on its
   *  command by the apply, never in its result or the journal. */
  | { ok: true; result: Record<string, unknown>; secret?: { urls: string[] } }
  | { ok: false; reason: string };

/**
 * The journal's copy of a write's answer: an upload's part URLs without their
 * query — the signature of a signed S3 address (the contract §2: never
 * journaled, as the CDN's tokens are not). The apply right after the capture
 * reads the answer as served; one from the journal finds no signed URL, and
 * the upload ends unknown rather than send unsigned parts.
 */
export function journalWriteAnswer(response: unknown): unknown {
  if (!isRecord(response) || !Array.isArray(response.parts)) return response;
  return {
    ...response,
    parts: response.parts.map((part) => {
      if (!isRecord(part) || typeof part.uploadUrl !== "string") return part;
      try {
        const url = new URL(part.uploadUrl);
        return { ...part, uploadUrl: `${url.origin}${url.pathname}` };
      } catch {
        return { ...part, uploadUrl: "[unreadable]" };
      }
    }),
  };
}

/** The parts of an upload's create: each part's index, its storage host and
 *  path, and its signed URL — in order, every index from 0, on a storage host
 *  a part may go to, signed. Null: not such a list. */
function uploadParts(raw: unknown): Array<{ index: number; host: string; path: string; url: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: Array<{ index: number; host: string; path: string; url: string }> = [];
  for (const part of raw) {
    if (!isRecord(part) || typeof part.index !== "number" || !Number.isSafeInteger(part.index) || part.index < 0 || typeof part.uploadUrl !== "string") return null;
    let url: URL;
    try {
      url = new URL(part.uploadUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "" || url.search === "") return null;
    if (!isFanslyStorageHost(url.hostname)) return null;
    parts.push({ index: part.index, host: url.hostname, path: url.pathname, url: url.toString() });
  }
  parts.sort((a, b) => a.index - b.index);
  return parts.every((part, position) => part.index === position) ? parts : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/** The id of an answer that is the object itself or wraps it under `key`. */
function objectId(response: unknown, key: string): string | null {
  if (!isRecord(response)) return null;
  return idOf(response.id) ?? (isRecord(response[key]) ? idOf((response[key] as Record<string, unknown>).id) : null);
}

export function readWriteAnswer(step: FanslyWriteStep, response: unknown, params: unknown): WriteAnswerRead {
  switch (step) {
    case "upload_create": {
      if (!isRecord(response)) return { ok: false, reason: "answer_not_an_object" };
      const uploadId = idOf(response.id);
      const partSize = response.partSize;
      if (uploadId === null) return { ok: false, reason: "answer_without_upload_id" };
      if (typeof partSize !== "number" || !Number.isSafeInteger(partSize) || partSize <= 0) return { ok: false, reason: "answer_without_part_size" };
      if (partSize > FANSLY_UPLOAD_PART_MAX_BYTES) return { ok: false, reason: "answer_part_size_over_limit" };
      if (!Array.isArray(response.parts) || response.parts.length === 0) return { ok: false, reason: "answer_without_parts" };
      // The parts' storage URLs, signed (the contract §2): their host and
      // path in the result, the URLs themselves sealed on the command (the
      // apply), never journaled with their signature.
      const parts = uploadParts(response.parts);
      if (parts === null) return { ok: false, reason: "answer_parts_unsigned_or_unordered" };
      return {
        ok: true,
        result: {
          uploadId,
          partSize,
          partCount: parts.length,
          uploadType: typeof response.type === "number" && Number.isSafeInteger(response.type) && response.type > 0 ? response.type : null,
          parts: parts.map(({ index, host, path }) => ({ index, host, path })),
        },
        secret: { urls: parts.map((part) => part.url) },
      };
    }
    case "upload_part": {
      // The storage's receipt (the contract §2: the ETag is needed).
      const eTag = isRecord(response) && typeof response.eTag === "string" && response.eTag.trim() !== "" ? response.eTag : null;
      return eTag === null ? { ok: false, reason: "receipt_without_etag" } : { ok: true, result: { eTag } };
    }
    case "upload_complete": {
      if (!isRecord(response)) return { ok: false, reason: "answer_not_an_object" };
      // The contract §2: `status 3`, `mediaId null` — the media comes with
      // the upload's status read; one here is kept, never relied on.
      const mediaId = idOf(response.mediaId) ?? (isRecord(response.media) ? idOf(response.media.id) : null);
      return { ok: true, result: { mediaId, status: typeof response.status === "number" ? response.status : null } };
    }
    case "upload_status": {
      // `status 6` brings the media (the contract §2); before it, the upload
      // is still processing.
      if (!isRecord(response)) return { ok: false, reason: "answer_not_an_object" };
      const status = typeof response.status === "number" && Number.isSafeInteger(response.status) ? response.status : null;
      const mediaId = idOf(response.mediaId) ?? (isRecord(response.media) ? idOf(response.media.id) : null);
      return { ok: true, result: { status, mediaId, done: status !== null && status >= FANSLY_UPLOAD_STATUS.done && mediaId !== null } };
    }
    case "account_media": {
      const asked = isRecord(params) && Array.isArray(params.media) ? params.media.length : null;
      if (!Array.isArray(response)) return { ok: false, reason: "answer_not_a_list" };
      const ids = response.map((item) => (isRecord(item) ? idOf(item.id) : null));
      if (ids.some((id) => id === null)) return { ok: false, reason: "answer_without_account_media_id" };
      if (asked !== null && ids.length !== asked) return { ok: false, reason: "answer_count_differs" };
      return { ok: true, result: { accountMediaIds: ids as string[] } };
    }
    case "account_media_bundle": {
      const bundles = isRecord(response) && Array.isArray(response.accountMediaBundles) ? response.accountMediaBundles : null;
      const bundleId = bundles === null ? null : isRecord(bundles[0]) ? idOf(bundles[0].id) : null;
      return bundleId === null ? { ok: false, reason: "answer_without_bundle_id" } : { ok: true, result: { bundleId } };
    }
    case "post": {
      const postId = isRecord(response) ? idOf(response.postId) : null;
      return postId === null ? { ok: false, reason: "answer_without_post_id" } : { ok: true, result: { postId } };
    }
    case "story": {
      const storyId = objectId(response, "story") ?? objectId(response, "mediaStory");
      return storyId === null ? { ok: false, reason: "answer_without_story_id" } : { ok: true, result: { storyId } };
    }
    case "post_cancel": {
      // The schedule's list (the contract §5): the post taken off is there
      // with status 3. Not there, or another status: Fansly answered, and
      // the fresh read of the schedule decides (plan PR 9c).
      const asked = isRecord(params) && typeof params.postId === "string" ? params.postId : null;
      const list = isRecord(response) && Array.isArray(response.scheduledPosts) ? response.scheduledPosts : Array.isArray(response) ? response : [];
      const entry = list.find((item) => isRecord(item) && asked !== null && idOf(item.postId) === asked);
      const status = isRecord(entry) && typeof entry.status === "number" ? entry.status : null;
      return { ok: true, result: { cancelled: true, listedStatus: status } };
    }
    case "post_delete": {
      // `{success: true, response: null}` (the contract §5): Fansly said it
      // deleted the post; a fresh `GET /post?ids=` decides whether it is
      // gone (services/publications-fansly-delete.ts).
      const postId = isRecord(params) && typeof params.postId === "string" ? params.postId : null;
      return { ok: true, result: { deleted: true, postId, answer: response === null ? "null" : typeof response } };
    }
    case "album_create": {
      // The contract §13: the album itself, `{accountId, title, description, pos, id}`.
      const albumId = objectId(response, "album");
      return albumId === null ? { ok: false, reason: "answer_without_album_id" } : { ok: true, result: { albumId } };
    }
    case "album_media": {
      // The contract §13: one album entry per media asked, `{id, mediaId,
      // albumId, …}`, in the order asked. Every media asked must be there.
      const asked = isRecord(params) && Array.isArray(params.mediaIds) ? params.mediaIds.map(String) : null;
      if (!Array.isArray(response)) return { ok: false, reason: "answer_not_a_list" };
      const added = response.map((item) => (isRecord(item) ? idOf(item.mediaId) : null));
      if (added.some((id) => id === null)) return { ok: false, reason: "answer_without_media_id" };
      if (asked !== null && (added.length !== asked.length || asked.some((id) => !added.includes(id)))) return { ok: false, reason: "answer_media_differ" };
      const albumId = isRecord(params) && typeof params.albumId === "string" ? params.albumId : null;
      return { ok: true, result: { albumId, added: added.length } };
    }
  }
}
