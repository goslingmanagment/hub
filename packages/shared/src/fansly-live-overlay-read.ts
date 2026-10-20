import type { Platform } from "./types.ts";

// Fansly Sync Engine step 1, «показ читателям» (plan §7.11, §15 step 1): a
// Fansly page has its chatter routes (conversation messages and preview) and
// its AI kernel context read "REST store ∪ unconfirmed overlay"; every other
// reader reads REST copies only.

/** Only the Fansly account socket writes the overlay (`dm_live_messages`). */
const LIVE_OVERLAY_PLATFORMS: Readonly<Record<Platform, boolean>> = Object.freeze({
  fansly: true,
  onlyfans: false,
});

/** Whether pages of this platform read the live overlay. */
export function platformHasLiveOverlay(platform: Platform): boolean {
  return LIVE_OVERLAY_PLATFORMS[platform];
}
