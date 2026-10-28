import type { Platform } from "./types.ts";

// How the hub reads the pages of each platform, said outright (chat-extension
// Telegram spec §5.3). Fansly's adapter declares no legacy stream either, so
// "no streams" is not the test of a platform the hub does not sync:
//   legacy  the page-sync executor (`services/sync/`): OnlyFans
//   engine  the Fansly Sync Engine (`apps/runtime/src/sync/`): Fansly
//   none    nothing: a Telegram page is a persona's own Telegram account the
//           chat extension reads in the chatter's browser; the hub holds no
//           credential of it, keeps no transactions and no archive.
// Health, the sync summary, the owner's overview, sync status and the agent
// fields skip every sync check of a `none` page and say it needs none; the
// revenue views leave it out.

export type PlatformSyncKind = "legacy" | "engine" | "none";

export const PLATFORM_SYNC_KIND = Object.freeze({
  onlyfans: "legacy",
  fansly: "engine",
  telegram: "none",
} as const satisfies Readonly<Record<Platform, PlatformSyncKind>>);

/** A platform whose pages the hub syncs (and keeps money, fans and an archive of). */
export type SyncedPlatform = {
  [P in Platform]: (typeof PLATFORM_SYNC_KIND)[P] extends "none" ? never : P;
}[Platform];

export function platformSyncKind(platform: Platform): PlatformSyncKind {
  return PLATFORM_SYNC_KIND[platform];
}

/** Whether the hub syncs pages of this platform at all. */
export function isSyncedPlatform(platform: Platform): platform is SyncedPlatform {
  return PLATFORM_SYNC_KIND[platform] !== "none";
}

/** The platforms the hub syncs, in the vocabulary's order. */
export const SYNCED_PLATFORMS: readonly SyncedPlatform[] = Object.freeze(
  (Object.keys(PLATFORM_SYNC_KIND) as Platform[]).filter(isSyncedPlatform),
);

/** The owner's words for a page that needs no sync (dashboard, health). */
export const SYNC_NOT_NEEDED_REASON_CODE = "sync_not_needed";
