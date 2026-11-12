import {
  getOnlyfansVaultAlbumRun,
  getPagePublishingSettings,
  getPublication,
  type Database,
} from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig } from "./effective-config.ts";

// The last word before an OnlyFans vault album's write leaves (8-docs
// 2026-11-12-of-vault-album, plan §2.4). The common media sweep
// (ofapi-media-worker.ts) picks queued upload jobs by itself, and an owner
// action may wait a minute for the transport: whatever queued it, the write
// goes only while every switch is on, the album's approval still stands and
// its run still allows the spend. Kept apart from the executor so the upload
// runner (ofapi-capture-jobs.ts) can ask it without importing the executor.

/** An album's price may be passed by this many percent before its uploads stop (plan §2.1). */
export const ONLYFANS_VAULT_PRICE_TOLERANCE_PERCENT = 10;

/** The most an album may spend: its price kept with the run, and 10 % more (in whole credits). */
export function onlyfansVaultSpendCap(priceCredits: number): number {
  return Math.ceil((priceCredits * (100 + ONLYFANS_VAULT_PRICE_TOLERANCE_PERCENT)) / 100);
}

/** The switches every album write passes, as live settings say now: a reason they are off, or null. */
export function onlyfansVaultSwitchesHold(config: Pick<AppConfig, "publishingEnabled" | "publishingOnlyfansVaultEnabled">): string | null {
  if (config.publishingEnabled !== true) return "publishing_off";
  if (config.publishingOnlyfansVaultEnabled !== true) return "vault_albums_off";
  return null;
}

/**
 * Why an album's write must not leave now, or null. `revisionId` is the
 * approval it was made under. `upload`: an upload's, which may still spend
 * up to `credits` — it goes only while the run's uploads are not stopped and
 * the spend stays within the price kept with the run. The album's create and
 * its add go after a stop too (what went up is still added).
 */
export async function onlyfansVaultWriteHold(
  app: { db: Database; config: AppConfig },
  input: { publicationId: number; revisionId: number; upload: { credits: number } | null },
): Promise<string | null> {
  const config = await loadEffectiveConfig(app.db, app.config);
  const switches = onlyfansVaultSwitchesHold(config);
  if (switches) return switches;
  const [record, run] = await Promise.all([
    getPublication(app.db, input.publicationId),
    getOnlyfansVaultAlbumRun(app.db, input.publicationId),
  ]);
  if (record === null || record.kind !== "vault_album" || record.platform !== "onlyfans") return "not_an_album";
  if (record.status !== "submitting" || record.approvedRevisionId !== input.revisionId) return "approval_moved";
  if (run === null || run.revisionId !== input.revisionId || run.step === "done") return "album_not_running";
  const settings = await getPagePublishingSettings(app.db, record.pageId);
  if (!settings.enabled || settings.autostoppedAt !== null) return "page_publishing_off";
  if (input.upload === null) return null;
  if (run.step !== "uploads") return "album_not_uploading";
  if (run.stopReason !== null) return `uploads_stopped:${run.stopReason}`;
  if (run.spentCredits + input.upload.credits > onlyfansVaultSpendCap(run.priceCredits)) return "price_exceeded";
  return null;
}

/** The album a media upload job belongs to, from its frozen target; null: not an album's. */
export function onlyfansVaultUploadAlbum(target: Record<string, unknown>): { publicationId: number; revisionId: number } | null {
  const publicationId = target.publicationId;
  const revisionId = target.revisionId;
  if (typeof publicationId !== "number" || typeof revisionId !== "number") return null;
  if (!Number.isSafeInteger(publicationId) || !Number.isSafeInteger(revisionId)) return null;
  return { publicationId, revisionId };
}
