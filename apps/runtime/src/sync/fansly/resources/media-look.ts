import { storeMediaLookSource } from "@agency_hub_core/db";

import { sniffImageFormat } from "../../../services/ai-media-describe/image.ts";
import { isFanslyCdnUrl } from "../../../services/egress/media-download.ts";
import type { ResourceModule } from "../../engine/resource.ts";
import { createMediaDownloadModule, type MediaDownloadPolicy, type MediaDownloadSink } from "./media-download.ts";

// `media-look.fetch` (owner 2026-11-11): the one image request of an agent's
// media look, as a request of the page — the same CDN transport, pacing and
// hops as the describer's `media-download.fetch` (./media-download.ts), with
// its own key, breaker and sink. The look's service (services/media-looks)
// asks for it through `enqueueAndWait` with the signed URL of a still image
// sealed in the work's secret: a video's thumbnail sheet or cover, a photo's
// resize — never a video stream, a playlist or a manifest. The work's subject
// is the look (`look:<id>`).
//
// - 2xx: an image's bytes go onto the look (`media_looks.source_bytes`,
//   transient, 0371) and the work closes with `{lookId, contentType, bytes,
//   hops}`; the API process cuts them into frames. A 2xx that is not an image
//   closes `not_an_image` and stores nothing;
// - 3xx: the redirect must be a Fansly media CDN URL of an image;
// - anything else closes the work with its failure, as the describer's does;
//   a 401/403 is the signed URL's, never the page session's.
//
// Nothing here writes, logs or returns the URL.

export const MEDIA_LOOK_KEY = "media-look.fetch";
/** The subject of a look's fetch: the look's row. */
export const MEDIA_LOOK_SUBJECT_PREFIX = "look:";

export function mediaLookSubject(lookId: number): string {
  return `${MEDIA_LOOK_SUBJECT_PREFIX}${lookId}`;
}

/** The look id of a fetch's subject, or null. */
export function lookIdOfSubject(subject: string): number | null {
  if (!subject.startsWith(MEDIA_LOOK_SUBJECT_PREFIX)) return null;
  const text = subject.slice(MEDIA_LOOK_SUBJECT_PREFIX.length);
  if (!/^[1-9][0-9]{0,15}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** A still image's path: a look never fetches a video, a playlist or a manifest. */
const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|avif)$/i;

/** A URL a look may request: a Fansly media CDN URL whose path is an image's. */
export function isMediaLookImageUrl(url: URL): boolean {
  return isFanslyCdnUrl(url) && IMAGE_PATH.test(url.pathname);
}

export const MEDIA_LOOK_POLICY: MediaDownloadPolicy = { urlAllowed: isMediaLookImageUrl };

/** Whether an answer's bytes are an image: its content type says so, or — none
 *  given, or a generic one — its first bytes do. A `video/*` never is. */
export function isMediaLookImageAnswer(contentType: string | null, bytes: Uint8Array): boolean {
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return true;
  if (type !== "" && type !== "application/octet-stream" && type !== "binary/octet-stream") return false;
  return sniffImageFormat(bytes) !== null;
}

export const MEDIA_LOOK_SINK: MediaDownloadSink = {
  subjectId: lookIdOfSubject,
  async store(tx, input) {
    if (!isMediaLookImageAnswer(input.contentType, input.bytes)) return { ok: false, failure: "not_an_image" };
    const stored = await storeMediaLookSource(tx, {
      pageId: input.pageId,
      lookId: input.subjectId,
      contentType: input.contentType,
      bytes: input.bytes,
    });
    // Erased, or settled meanwhile: nothing is stored for nobody.
    if (!stored) return { ok: false, failure: "look_gone" };
    return {
      ok: true,
      result: { lookId: input.subjectId, contentType: input.contentType, bytes: input.bytes.length, hops: input.hops },
    };
  },
};

export function createMediaLookModule(policy: MediaDownloadPolicy = MEDIA_LOOK_POLICY): ResourceModule {
  return createMediaDownloadModule(policy, MEDIA_LOOK_SINK);
}

export const mediaLookModule = createMediaLookModule();
