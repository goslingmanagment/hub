import { buildPostObservedDraft } from "./posts.ts";
import { onlyFansRawMediaDrafts } from "./raw-media.ts";
import { isRecord, type CanonicalEventDraft, type CanonicalizableObservation } from "./types.ts";

// The caller supplies ONLY items accepted by the governed capture contract.
export function buildOnlyFansPostDrafts(
  observation: CanonicalizableObservation, items: readonly Record<string, unknown>[],
): CanonicalEventDraft[] {
  return items.flatMap(item => {
    const postId = typeof item.id === "string" || typeof item.id === "number"
      ? String(item.id) : (() => { throw new Error("Strict OFAPI post lost its id"); })();
    const media: unknown[] = Array.isArray(item.media) ? item.media
      : Array.isArray(item.attachments) ? item.attachments : [];
    const post = buildPostObservedDraft({
      platform: "onlyfans", observationId: observation.id, postId,
      textPlain: typeof item.rawText === "string" ? item.rawText : typeof item.text === "string" ? item.text : "",
      publishedAt: new Date(item.postedAt as string), observedAt: observation.receivedAt,
      attachmentCount: media.length,
      attachmentRefs: media.map((row, pos) => ({ pos, contentType: null,
        contentId: isRecord(row) && (typeof row.id === "string" && row.id.length > 0
          || typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id >= 0) ? String(row.id) : null })),
    });
    return [post, ...onlyFansRawMediaDrafts(observation, media)];
  });
}
