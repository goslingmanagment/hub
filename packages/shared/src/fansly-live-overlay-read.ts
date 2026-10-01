import type { AppConfig } from "./config.ts";
import type { Platform } from "./types.ts";

// Fansly Sync Engine step 1, «показ читателям» (plan §7.11, §15 step 1): the
// per-page switch of the live overlay readers. A page in the list has its
// chatter routes (conversation messages and preview) and its AI kernel context
// read "REST store ∪ unconfirmed overlay"; every other reader, and every page
// outside the list, reads REST copies only. `none` is the overlay read
// kill-switch of the step-1 rollback: it restores the confirmed-only readers
// exactly. The key is live, so each read takes the value in force.

/** Only the Fansly account socket writes the overlay (`dm_live_messages`). */
const LIVE_OVERLAY_PLATFORMS: Readonly<Record<Platform, boolean>> = Object.freeze({
  fansly: true,
  onlyfans: false,
});

/** Whether pages of this platform have a live overlay at all; lets a caller
 * skip the config read for the others. */
export function platformHasLiveOverlay(platform: Platform): boolean {
  return LIVE_OVERLAY_PLATFORMS[platform];
}

export const FANSLY_LIVE_OVERLAY_READ_ALL = "all";
export const FANSLY_LIVE_OVERLAY_READ_NONE = "none";

/**
 * Whether this page's chatter routes and AI kernel context read the live
 * overlay. The list fails closed: unset, empty or `none` grants no page, and a
 * `none` anywhere in it wins over everything else (a kill-switch typed next to
 * a stale entry still kills). `all` grants every Fansly page; otherwise the
 * entries are exact page labels.
 */
export function readsFanslyLiveOverlay(
  config: Pick<AppConfig, "fanslyLiveOverlayReadPages">,
  page: { label: string; platform: Platform },
): boolean {
  if (!platformHasLiveOverlay(page.platform)) return false;
  const entries = (config.fanslyLiveOverlayReadPages ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.includes(FANSLY_LIVE_OVERLAY_READ_NONE)) return false;
  return entries.includes(FANSLY_LIVE_OVERLAY_READ_ALL) || entries.includes(page.label);
}
