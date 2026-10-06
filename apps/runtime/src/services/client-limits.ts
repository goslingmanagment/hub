import {
  AI_LIVE_TEXT_MAX_CHARS,
  AI_LIVE_TEXT_MAX_ITEMS,
  CLIENT_FEED_MAX_LIMIT,
  type ClientBootstrapLimits,
} from "@agency_hub_core/contracts";
import { ARCHIVE_AI_TRANSCRIPT_MAX_ROWS } from "@agency_hub_core/db";

/**
 * The chat extension's limits as the bootstrap announces them. The routes that
 * enforce one read it from here, so the announced number and the enforced one
 * cannot drift apart.
 *
 * The receipt profiles of sending from the preview (X8) are not here: they are
 * the owner's setting, and none is admitted until the owner adds one.
 */
export const CLIENT_BOOTSTRAP_LIMITS: Readonly<Omit<ClientBootstrapLimits, "previewSendReceiptProfiles">> = {
  // The caps of `liveTextContext` in the AI stream's body schema.
  freshTextMaxItems: AI_LIVE_TEXT_MAX_ITEMS,
  freshTextMaxChars: AI_LIVE_TEXT_MAX_CHARS,
  // The cap of `limit` in the archive feed's query schema.
  feedMax: CLIENT_FEED_MAX_LIMIT,
  // The AI transcript readers' row cap: the resting value. The bootstrap
  // announces the owner's `aiTranscriptDeepMaxRows` in its place, the depth a
  // full Recap may read (ai-transcript-depth.ts).
  deepMax: ARCHIVE_AI_TRANSCRIPT_MAX_ROWS,
  audienceWindowHours: 720,
  claimLeaseSec: 120,
  claimRenewSec: 40,
  claimActivityWindowSec: 120,
  previewSendPerMinute: 6,
  navInsertTimeoutSec: 20,
  dispatchTicketSec: 10,
};
