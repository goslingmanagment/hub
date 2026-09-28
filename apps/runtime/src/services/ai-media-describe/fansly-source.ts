import {
  findLatestMediaOfferObservation,
  getFirstAiMediaDescriptionLink,
  requestAiMediaAcceleratorRead,
  requestPageSync,
  type AiMediaDescriptionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { loadObservationPayload } from "../payload-reader.ts";
import type { AiMediaSource, AiMediaSourceResolution } from "./worker.ts";

// Fansly source for the AI media describer (plan §4). The URL comes from the
// DM page the hub itself captured through the page proxy
// (`accountMedia[].media.variants[].locations`, CloudFront-signed for the
// proxy's /24, ~7 days). It is read from the journal at download time, held
// in memory only, and fetched from the CDN through the same page proxy — a
// CDN request, not a Fansly API call.

const EXPIRY_MARGIN_MS = 120_000;
/** Prefer the smallest image variant whose long edge still covers this. */
const TARGET_EDGE_PX = 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Top-level arrays, or the purchase-history `aggregationData` shape. */
function sidecars(payload: Record<string, unknown>) {
  const aggregation = asRecord(payload.aggregationData) ?? {};
  const media = records(payload.accountMedia).length > 0 ? records(payload.accountMedia) : records(aggregation.accountMedia);
  const bundles = records(payload.accountMediaBundles).length > 0
    ? records(payload.accountMediaBundles)
    : records(aggregation.accountMediaBundles);
  return { media, bundles };
}

/** Expiry of a CloudFront URL: `Expires=` (canned) or the custom `Policy`. */
export function cloudFrontExpiry(url: string): Date | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const expires = parsed.searchParams.get("Expires");
  if (expires && /^[0-9]+$/.test(expires)) {
    return new Date(Number(expires) * 1000);
  }
  const policy = parsed.searchParams.get("Policy");
  if (!policy) {
    return null;
  }
  try {
    const json = Buffer.from(policy.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64").toString("utf8");
    const statement = records(asRecord(JSON.parse(json))?.Statement)[0];
    const epoch = num(asRecord(asRecord(statement?.Condition)?.DateLessThan)?.["AWS:EpochTime"]);
    return epoch === null ? null : new Date(epoch * 1000);
  } catch {
    return null;
  }
}

function firstLocation(node: Record<string, unknown>): string | null {
  for (const location of records(node.locations)) {
    const url = text(location.location);
    if (url && url.startsWith("https://")) {
      return url;
    }
  }
  return null;
}

/** Variant type 3 is Fansly's blurred copy (it duplicates the smallest
 * resize, or the whole file when it is small): never something to describe. */
const BLURRED_VARIANT_TYPE = 3;

/**
 * The best still image of a Fansly media object, never a blurred copy: for a
 * photo the smallest of its resizes and the original that covers 1024 px,
 * else the largest of them (a small photo's original); for a video/GIF the
 * largest image variant (the platform's own poster). Never a video stream.
 */
export function pickFanslyImageLocation(media: Record<string, unknown>): string | null {
  const mime = text(media.mimetype) ?? "";
  const images = records(media.variants)
    .filter((variant) => (text(variant.mimetype) ?? "").startsWith("image/"))
    .filter((variant) => num(variant.type) !== BLURRED_VARIANT_TYPE && text(variant.type) !== String(BLURRED_VARIANT_TYPE))
    .map((variant) => ({
      edge: Math.max(num(variant.width) ?? 0, num(variant.height) ?? 0),
      url: firstLocation(variant),
    }))
    .filter((variant): variant is { edge: number; url: string } => variant.url !== null);
  if (mime.startsWith("image/") && mime !== "image/gif") {
    const original = firstLocation(media);
    const candidates = original === null
      ? images
      : [...images, { edge: Math.max(num(media.width) ?? 0, num(media.height) ?? 0), url: original }];
    // Ties go to the resize (listed first), which is never larger in bytes.
    const sorted = candidates
      .map((candidate, index) => ({ ...candidate, index }))
      .sort((left, right) => left.edge - right.edge || left.index - right.index);
    const covering = sorted.find((candidate) => candidate.edge >= TARGET_EDGE_PX);
    return covering?.url ?? sorted.at(-1)?.url ?? null;
  }
  return [...images].sort((left, right) => left.edge - right.edge).at(-1)?.url ?? null;
}

function hasPrice(row: Record<string, unknown>): boolean {
  const permissions = asRecord(row.permissions);
  for (const entry of records(permissions?.permissionFlags)) {
    if ((num(entry.price) ?? 0) > 0) return true;
  }
  return (num(row.price) ?? 0) > 0;
}

// Same classes as the extension's labels: any image (a GIF included) is a
// photo, so the variant keys agree ('full'); its first frame is described.
function kindOf(mime: string | null): "photo" | "video" | null {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  return null;
}

async function maybeAccelerate(app: AppContext, row: AiMediaDescriptionRow, groupRef: string | null, messageRef: string | null) {
  // Fallback trigger (plan §4): a media id the hub has not captured yet asks
  // for one head read of its conversation — only with the accelerator on.
  if (!groupRef || !messageRef) return;
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.aiMediaDescribeFanslyAcceleratorEnabled !== true) return;
  if (await requestAiMediaAcceleratorRead(app.db, { pageId: row.pageId, groupRef, messageRef, now: new Date() })) {
    await requestPageSync(app.db, { pageId: row.pageId, streams: ["dm_messages"], source: "event" });
  }
}

export const fanslyAiMediaSource: AiMediaSource = {
  platform: "fansly",
  async resolve(app, row, context): Promise<AiMediaSourceResolution> {
    if (row.senderRole === "model" && row.variant !== "preview" && context.modelMedia !== "teasers+free") {
      return { kind: "skip", reason: "creator_media_off" };
    }
    const link = await getFirstAiMediaDescriptionLink(app.db, row.id);
    const offered = await findLatestMediaOfferObservation(app.db, {
      pageId: row.pageId,
      messageRef: link?.messageRef ?? null,
      mediaOfferRef: row.mediaRef,
    });
    const observationId = Math.max(row.sourceObservationId ?? 0, offered ?? 0);
    if (observationId === 0) {
      await maybeAccelerate(app, row, link?.conversationRef ?? null, link?.messageRef ?? null);
      return { kind: "awaiting_source", retryAt: null, reason: "not_captured" };
    }
    const read = await loadObservationPayload(app, observationId);
    const payload = asRecord(read?.payload);
    if (!payload) {
      return { kind: "unavailable", reason: "capture_missing" };
    }
    const { media, bundles } = sidecars(payload);

    if (row.mediaKind === "bundle") {
      const bundle = bundles.find((candidate) => text(candidate.id) === row.mediaRef);
      if (!bundle) return { kind: "unavailable", reason: "bundle_not_in_capture" };
      const memberIds = Array.isArray(bundle.accountMediaIds)
        ? bundle.accountMediaIds.map(text).filter((id): id is string => id !== null)
        : records(bundle.bundleContent).map((entry) => text(entry.accountMediaId)).filter((id): id is string => id !== null);
      const members = memberIds.flatMap((id) => {
        const member = media.find((candidate) => text(candidate.id) === id);
        const kind = kindOf(text(asRecord(member?.media)?.mimetype));
        return member && kind ? [{ mediaRef: id, variant: kind === "photo" ? "full" as const : "poster" as const, mediaKind: kind }] : [];
      });
      return members.length > 0
        ? { kind: "expand", members, source: "fansly_capture" }
        : { kind: "unavailable", reason: "bundle_members_not_in_capture" };
    }

    const offer = media.find((candidate) => text(candidate.id) === row.mediaRef);
    if (!offer) {
      return { kind: "unavailable", reason: "media_not_in_capture" };
    }
    // Never the body of a paid PPV, whatever the row says (a fan cannot
    // price media, so no sender check): a priced file, or a file inside a
    // priced bundle of this capture.
    if (row.variant !== "preview" && (hasPrice(offer) || bundles.some((bundle) => hasPrice(bundle) && (
      (Array.isArray(bundle.accountMediaIds) && bundle.accountMediaIds.map(text).includes(row.mediaRef))
      || records(bundle.bundleContent).some((entry) => text(entry.accountMediaId) === row.mediaRef)
    )))) {
      return { kind: "skip", reason: "ppv_body" };
    }
    const node = row.variant === "preview" ? asRecord(offer.preview) : asRecord(offer.media);
    if (!node) {
      return { kind: "unavailable", reason: row.variant === "preview" ? "no_preview" : "no_media" };
    }
    const url = pickFanslyImageLocation(node);
    if (!url) {
      return { kind: "unavailable", reason: "no_image_location" };
    }
    const expiry = cloudFrontExpiry(url);
    if (expiry && expiry.getTime() - EXPIRY_MARGIN_MS <= context.now.getTime()) {
      return { kind: "unavailable", reason: "source_expired" };
    }
    return { kind: "url", url, source: "fansly_capture" };
  },
};
