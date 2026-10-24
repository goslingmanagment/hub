import type { FanslyWriteStep } from "@agency_hub_core/db";

// What a write's 2xx answer gave (wall posts PR 6): the ids the next steps
// are derived from. Read from the journaled answer (the capture wrote it to
// `observations` before this runs). An answer without the id its step must
// give is no answer Hub can build on: the command ends `unknown` and a person
// looks at the journaled body — Hub never assumes it did or did not happen.
//
// The shapes are the contract's (docs/plans/2026-10-23-wall-posts/
// fansly-publish-contract.md): account media — an array of `accountMedia`;
// a bundle — `accountMediaBundles[0].id`; a post — `postId`; a story — `id`;
// a cancel — the schedule's list, the cancelled post at `status` 3.

export type WriteAnswerRead =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: string };

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
      const parts = response.parts;
      if (uploadId === null) return { ok: false, reason: "answer_without_upload_id" };
      if (typeof partSize !== "number" || !Number.isSafeInteger(partSize) || partSize <= 0) return { ok: false, reason: "answer_without_part_size" };
      if (!Array.isArray(parts) || parts.length === 0) return { ok: false, reason: "answer_without_parts" };
      // The parts' storage URLs are signed: they stay in the journal only
      // (the upload of the bytes, PR 8, reads them there).
      return {
        ok: true,
        result: { uploadId, partSize, partCount: parts.length, uploadType: typeof response.type === "number" ? response.type : null },
      };
    }
    case "upload_complete": {
      if (!isRecord(response)) return { ok: false, reason: "answer_not_an_object" };
      // The media may come with the answer or only with the upload's status
      // read (PR 8): absent here is no failure.
      const mediaId = idOf(response.mediaId) ?? (isRecord(response.media) ? idOf(response.media.id) : null);
      return { ok: true, result: { mediaId } };
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
  }
}
