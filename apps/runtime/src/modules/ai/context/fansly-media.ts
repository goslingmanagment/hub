// chat-extension R20 HF-7a: the media of a Fansly message in the transcript
// the hub loads itself (a request without clientContext). The labels are the
// Fansly extension's (fansly-chat 2.10.1, src/shared/transcript.ts
// `describeAttachment`): one per attachment in the message's order, `[Photo]`,
// `[Video]`, `[Audio]`, `[Media]` for a media of no known kind or one the
// page never served, `[Media Bundle: 2 Photos, 1 Video]` for a bundle (its
// photos and videos among the members the page served; `[Media Bundle]` when
// none or the bundle itself is unknown), and no label for an attachment that
// is not media (a tip, a story reply). The tip label stays the normalizer's
// (transcript/normalize.ts). A paid attachment's PPV mark is its own
// (context/fansly-ppv.ts, R20 HF-7в); only a message whose attachments the
// media plane has not recorded yet keeps the normalizer's message-level suffix.
//
// The sources, per arm of the transcript:
//  - a stored row: its `media_metadata` (id, MIME type, `bundle`, `other`);
//    the media plane (message_media_offers) gives the attachments' order and
//    tells an `other` media or bundle from a tip, and creator_media_bundles
//    with creator_media the members of a bundle;
//  - a socket message (the live overlay): its attachments' content types and
//    ids, the kinds from creator_media. Money stays REST-only (no PPV here).
//
// OnlyFans never reads this: its rows carry OFAPI's media list, which the
// normalizer reads as it always did.

import {
  listFanslyMessageOffers,
  readFanslyMediaKinds,
  type FanslyMediaKindRow,
  type FanslyMediaKinds,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../../bootstrap.ts";

/** What a platform's archive row keeps as its media list: OFAPI's own list
 *  (`ofapi`: the media types the normalizer reads, handed to it only by the
 *  union read), or the sync-pull material head's (`material_head`: the list
 *  this file reads). */
const ARCHIVE_MEDIA_LISTS: Readonly<Record<Platform, "ofapi" | "material_head">> = Object.freeze({
  onlyfans: "ofapi",
  fansly: "material_head",
});

/** Whether an archive row of this platform has its media labelled here. */
export function readsMaterialHeadMedia(platform: string): boolean {
  return (ARCHIVE_MEDIA_LISTS as Readonly<Record<string, string | undefined>>)[platform] === "material_head";
}

/** Fansly's attachment content types the transcript shows. */
const CONTENT_TYPE_MEDIA = 1;
const CONTENT_TYPE_BUNDLE = 2;

type MediaCategory = "photo" | "video" | "audio" | "other";

/** fansly-chat 2.10.1 `classifyMedia`: Fansly's media type first (1 photo,
 *  2 video, 3 audio), then the MIME family. */
export function fanslyMediaCategory(media: FanslyMediaKindRow): MediaCategory {
  if (media.mediaType === 1) return "photo";
  if (media.mediaType === 2) return "video";
  if (media.mediaType === 3) return "audio";
  const mime = media.mimeType ?? "";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "other";
}

const SINGLE_LABEL: Record<MediaCategory, string> = {
  photo: "Photo",
  video: "Video",
  audio: "Audio",
  other: "Media",
};

function pluralCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** fansly-chat 2.10.1 `describeBundle`: the photos and videos among the
 *  bundle's distinct members the page served. */
export function fanslyBundleBody(
  members: ReadonlyArray<{ ref: string; media: FanslyMediaKindRow | null }> | undefined,
): string {
  let photos = 0;
  let videos = 0;
  const seen = new Set<string>();
  for (const member of members ?? []) {
    if (seen.has(member.ref)) continue;
    seen.add(member.ref);
    if (member.media === null) continue;
    const category = fanslyMediaCategory(member.media);
    if (category === "photo") photos += 1;
    else if (category === "video") videos += 1;
  }
  const parts = [
    ...(photos > 0 ? [pluralCount(photos, "Photo")] : []),
    ...(videos > 0 ? [pluralCount(videos, "Video")] : []),
  ];
  return parts.length > 0 ? `Media Bundle: ${parts.join(", ")}` : "Media Bundle";
}

/** One attachment the transcript shows: a media (its kind when the source
 *  named it, else looked up by its id) or a bundle. */
export type FanslyTranscriptAttachment =
  | { ref: string; as: "media"; media: FanslyMediaKindRow | null }
  | { ref: string; as: "bundle" };

/** The attachment as the media plane recorded it: its place and content type
 *  (and, R20 HF-7в, the permission rows of its media or bundle). */
export interface FanslyRecordedOffer {
  ordinal: number;
  contentType: number | null;
  permissionEntries?: readonly unknown[];
}

/**
 * A stored row's attachments from its `media_metadata` (sync-pull material
 * head: `{id, type}` with type the MIME type, `bundle` or `other`), in the
 * message's order when the media plane recorded it (else the stored id order).
 * An `other` item is shown only when the media plane names it a media or a
 * bundle: otherwise it is a tip or another attachment that is not media.
 */
export function storedFanslyAttachments(
  mediaMetadata: ReadonlyArray<Record<string, unknown>>,
  offers: ReadonlyMap<string, FanslyRecordedOffer> | undefined,
): FanslyTranscriptAttachment[] {
  const placed = mediaMetadata.flatMap((item, index) => {
    const ref = typeof item.id === "string" && item.id.length > 0 ? item.id : null;
    if (ref === null) return [];
    const offer = offers?.get(ref);
    const type = typeof item.type === "string" && item.type !== "other" ? item.type : null;
    let attachment: FanslyTranscriptAttachment | null;
    if (type === "bundle") {
      attachment = { ref, as: "bundle" };
    } else if (type !== null) {
      attachment = { ref, as: "media", media: { mediaType: null, mimeType: type } };
    } else if (offer?.contentType === CONTENT_TYPE_MEDIA) {
      attachment = { ref, as: "media", media: null };
    } else if (offer?.contentType === CONTENT_TYPE_BUNDLE) {
      attachment = { ref, as: "bundle" };
    } else {
      attachment = null;
    }
    return attachment === null ? [] : [{ attachment, ordinal: offer?.ordinal ?? null, index }];
  });
  // The recorded position orders; an attachment without one keeps its stored
  // place after them (the sort is stable).
  return placed
    .sort((left, right) => (left.ordinal ?? Infinity) - (right.ordinal ?? Infinity) || left.index - right.index)
    .map(({ attachment }) => attachment);
}

/** A socket message's attachments, in the message's order: a media's kind is
 *  looked up by its id, a bundle's members by its. */
export function liveFanslyAttachments(
  attachments: ReadonlyArray<{ contentType: number; contentId: string }>,
): FanslyTranscriptAttachment[] {
  return attachments.flatMap((attachment): FanslyTranscriptAttachment[] => {
    if (attachment.contentType === CONTENT_TYPE_MEDIA) {
      return [{ ref: attachment.contentId, as: "media", media: null }];
    }
    if (attachment.contentType === CONTENT_TYPE_BUNDLE) {
      return [{ ref: attachment.contentId, as: "bundle" }];
    }
    return [];
  });
}

/** The label bodies of one message's attachments. */
export function fanslyAttachmentBodies(
  attachments: readonly FanslyTranscriptAttachment[],
  kinds: FanslyMediaKinds,
): string[] {
  return attachments.map((attachment) => {
    if (attachment.as === "bundle") {
      return fanslyBundleBody(kinds.bundles.get(attachment.ref));
    }
    const media = attachment.media ?? kinds.media.get(attachment.ref) ?? null;
    return SINGLE_LABEL[media === null ? "other" : fanslyMediaCategory(media)];
  });
}

/** An `other` item, or several, make the stored order and the content types
 *  worth a read; a single named item needs neither. */
function needsRecordedOffers(mediaMetadata: ReadonlyArray<Record<string, unknown>>): boolean {
  return mediaMetadata.length > 1
    || mediaMetadata.some((item) => typeof item.type !== "string" || item.type === "other");
}

/** The served Fansly messages a media read is asked about. */
export interface FanslyMediaReadInput {
  pageId: number;
  stored: ReadonlyArray<{ messageRef: string; mediaMetadata: ReadonlyArray<Record<string, unknown>> }>;
  live: ReadonlyArray<{ messageRef: string; attachments: ReadonlyArray<{ contentType: number; contentId: string }> }>;
}

/** What one media read found: each message's attachments, what the media
 *  plane recorded of the stored ones, and the kinds of their files. */
export interface FanslyMessageMedia {
  /** Message ref → its attachments the transcript shows, in order. */
  attachments: Map<string, FanslyTranscriptAttachment[]>;
  /** Stored message ref → content ref → the recorded attachment. */
  offers: Map<string, Map<string, FanslyRecordedOffer>>;
  kinds: FanslyMediaKinds;
}

/**
 * Reads what the served rows leave open: the recorded attachments (by
 * default only of a row whose order or kinds need them; `allStoredOffers`:
 * of every stored row with media, R20 HF-7в's per-attachment price) and the
 * kinds of the files no row named.
 */
export async function readFanslyMessageMedia(
  app: Pick<AppContext, "db">,
  input: FanslyMediaReadInput,
  options: { allStoredOffers?: boolean } = {},
): Promise<FanslyMessageMedia> {
  const stored = input.stored.filter((row) => row.mediaMetadata.length > 0);
  const live = input.live.filter((message) => message.attachments.length > 0);
  const offers = new Map<string, Map<string, FanslyRecordedOffer>>();
  if (stored.length === 0 && live.length === 0) {
    return { attachments: new Map(), offers, kinds: { bundles: new Map(), media: new Map() } };
  }

  const offerRows = await listFanslyMessageOffers(app.db, {
    pageId: input.pageId,
    messageRefs: stored
      .filter((row) => options.allStoredOffers === true || needsRecordedOffers(row.mediaMetadata))
      .map((row) => row.messageRef),
  });
  for (const row of offerRows) {
    const byRef = offers.get(row.messageRef) ?? new Map<string, FanslyRecordedOffer>();
    offers.set(row.messageRef, byRef);
    if (!byRef.has(row.contentRef)) {
      byRef.set(row.contentRef, {
        ordinal: row.ordinal,
        contentType: row.contentType,
        permissionEntries: row.permissionEntries,
      });
    }
  }

  const attachments = new Map<string, FanslyTranscriptAttachment[]>([
    ...stored.map((row) => [row.messageRef, storedFanslyAttachments(row.mediaMetadata, offers.get(row.messageRef))] as const),
    ...live.map((message) => [message.messageRef, liveFanslyAttachments(message.attachments)] as const),
  ]);
  const all = [...attachments.values()].flat();
  const bundleRefs = [...new Set(all.flatMap((item) => item.as === "bundle" ? [item.ref] : []))];
  const mediaRefs = [...new Set(all.flatMap((item) => item.as === "media" && item.media === null ? [item.ref] : []))];
  const kinds: FanslyMediaKinds = bundleRefs.length === 0 && mediaRefs.length === 0
    ? { bundles: new Map(), media: new Map() }
    : await readFanslyMediaKinds(app.db, { pageId: input.pageId, bundleRefs, mediaRefs });
  return { attachments, offers, kinds };
}

/** Message ref → its label bodies, for the messages with at least one. */
export function fanslyMediaLabelBodiesOf(media: FanslyMessageMedia): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  for (const [messageRef, items] of media.attachments) {
    if (items.length > 0) {
      bodies.set(messageRef, fanslyAttachmentBodies(items, media.kinds));
    }
  }
  return bodies;
}

/**
 * The media label bodies of the served Fansly messages, keyed by message ref
 * (only messages with at least one): the normalizer's
 * `mediaLabelBodiesByMessageId`, and the archive feed's captions. Reads the
 * media plane only for what the served rows leave open. No price or purchase
 * state: the transcript's are context/fansly-ppv.ts's.
 */
export async function loadFanslyMediaLabelBodies(
  app: Pick<AppContext, "db">,
  input: FanslyMediaReadInput,
): Promise<Map<string, string[]>> {
  return fanslyMediaLabelBodiesOf(await readFanslyMessageMedia(app, input));
}
