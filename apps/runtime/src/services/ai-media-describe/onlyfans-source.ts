import {
  findPageById,
  listOfapiMediaLinks,
  listOfapiMediaLocators,
  type AiMediaDescriptionRow,
  type OfapiMediaLocatorRow,
} from "@agency_hub_core/db";

import { parseOfapiMediaUrl } from "../ofapi-media-locators.ts";
import type { AiMediaSource, AiMediaSourceResolution } from "./worker.ts";

// OnlyFans source for the AI media describer (plan §5). Built on the desktop
// images' locator layer (0210/0216) and FREE sources only:
//   - `expires` URLs from the messages.* webhooks (Expires-signed, no address
//     binding, ~23 h), with at least 120 s left;
//   - `fansapi` URLs (cdn.fansapi.com, OFAPI's cache) handed out by the
//     desktop resolve.
// `policy` URLs (address-bound to OFAPI's proxy) are ignored. ZERO OFAPI calls:
// no resolve, no HEAD, no message re-read — a locator lookup in the hub's own
// database is the whole source. No free URL → awaiting_source, looked at again
// after 1, 5 and 30 minutes and then every 6 hours until the 7-day expiry.

const MIN_REMAINING_MS = 120_000;
const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000];
const LATE_RETRY_MS = 6 * 60 * 60_000;

function usable(row: OfapiMediaLocatorRow, now: Date): boolean {
  if (!row.url) return false;
  const parsed = parseOfapiMediaUrl(row.url);
  if (!parsed) return false;
  const remaining = (row.expiresAt?.getTime() ?? parsed.expiresAt?.getTime() ?? 0) - now.getTime();
  if (row.sigKind === "expires") {
    return parsed.host === "onlyfans" && !parsed.ipBound && remaining > MIN_REMAINING_MS;
  }
  if (row.sigKind === "fansapi") {
    return parsed.host === "fansapi" && remaining > MIN_REMAINING_MS;
  }
  return false;
}

/** Variant preference: the mid-size `preview` first; a photo falls back to
 * `full`, a video/GIF poster to `thumb`. */
function preference(row: AiMediaDescriptionRow, mediaType: string | null): Array<OfapiMediaLocatorRow["variant"]> {
  const still = row.variant === "poster" || (mediaType !== null && mediaType !== "photo");
  return still ? ["preview", "thumb"] : ["preview", "full"];
}

function retryAt(row: AiMediaDescriptionRow, now: Date): Date {
  const step = RETRY_SCHEDULE_MS[Math.max(0, row.attempts - 1)] ?? LATE_RETRY_MS;
  return new Date(now.getTime() + step);
}

export const onlyfansAiMediaSource: AiMediaSource = {
  platform: "onlyfans",
  async resolve(app, row, context): Promise<AiMediaSourceResolution> {
    if (row.senderRole === "model" && row.variant !== "preview" && context.modelMedia !== "teasers+free") {
      return { kind: "skip", reason: "creator_media_off" };
    }
    const page = await findPageById(app.db, row.pageId);
    const ofapiAccountId = page?.page.ofapiAccountId ?? null;
    if (!ofapiAccountId) {
      return { kind: "unavailable", reason: "page_unmapped" };
    }
    const locators = await listOfapiMediaLocators(app.db, { ofapiAccountId, mediaId: row.mediaRef });
    if (locators.length === 0) {
      return { kind: "awaiting_source", retryAt: retryAt(row, context.now), reason: "no_locator" };
    }
    const links = await listOfapiMediaLinks(app.db, { ofapiAccountId, mediaId: row.mediaRef });
    if (links.length > 0 && links.every((link) => link.deleted)) {
      return { kind: "unavailable", reason: "deleted" };
    }
    // A teaser is visible to the fan; anything else the fan cannot view is a
    // locked body and never described.
    if (row.variant !== "preview" && locators.some((locator) => locator.canView === false)) {
      return { kind: "skip", reason: "locked" };
    }
    const mediaType = locators.find((locator) => locator.mediaType)?.mediaType ?? null;
    if (mediaType === "audio") {
      return { kind: "skip", reason: "audio" };
    }
    for (const variant of preference(row, mediaType)) {
      const candidates = locators
        .filter((locator) => locator.variant === variant && usable(locator, context.now))
        // A free webhook URL first, then the OFAPI cache.
        .sort((left, right) => (left.sigKind === right.sigKind ? 0 : left.sigKind === "expires" ? -1 : 1));
      const chosen = candidates[0];
      if (chosen?.url) {
        return { kind: "url", url: chosen.url, source: chosen.sigKind === "fansapi" ? "ofapi_fansapi" : "ofapi_expires" };
      }
    }
    return { kind: "awaiting_source", retryAt: retryAt(row, context.now), reason: "no_free_url" };
  },
};
