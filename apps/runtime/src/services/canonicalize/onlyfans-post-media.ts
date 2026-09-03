import { buildPostObservedDraft } from "./posts.ts";
import { onlyFansRawMediaDrafts } from "./raw-media.ts";
import { capturePayloadResponse, parseOfapiJsonBytes, parseStrictOfapiPostPage } from "../ofapi-capture-contract.ts";
import { isRecord, type CanonicalEventDraft, type CanonicalizableObservation, type CanonicalizeRunContext } from "./types.ts";

function retainedPostPage(observation: CanonicalizableObservation) {
  const response = capturePayloadResponse(observation.payload);
  if (observation.platform !== "onlyfans" || !response || response.status < 200 || response.status >= 300) return null;
  const decoded = parseOfapiJsonBytes(response.bodyBytes);
  if (!decoded.validJson) return null;
  const parsed = parseStrictOfapiPostPage(decoded.body, { requiredOverlapId: null, stopAtPostId: null });
  return parsed.accepted ? parsed : null;
}

export const canParseOnlyFansPostsObservation = (observation: CanonicalizableObservation) => retainedPostPage(observation) !== null;

export function canonicalizeOnlyFansPostsObservation(observation: CanonicalizableObservation, context?: CanonicalizeRunContext) {
  const parsed = retainedPostPage(observation);
  if (!parsed) return [];
  const accepted = context?.acceptedPostRefs;
  if (!accepted) throw new Error("OF replay requires the original governed acceptance boundary");
  const items = parsed.items.filter(item => accepted.has(String(item.id)));
  if (items.length !== accepted.size) throw new Error("OF accepted post ids cannot be reproduced from retained capture");
  return buildOnlyFansPostDrafts(observation, items);
}

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
