import type { ClientBootstrapLimits } from "@agency_hub_core/contracts";
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
  freshTextMaxItems: 60,
  freshTextMaxChars: 5_000,
  feedMax: 100,
  // The archive readers' row cap today. The full Recap's deeper read raises it
  // behind its own setting, in the PR that ships that read.
  deepMax: ARCHIVE_AI_TRANSCRIPT_MAX_ROWS,
  audienceWindowHours: 720,
  claimLeaseSec: 120,
  claimRenewSec: 40,
  claimActivityWindowSec: 120,
  previewSendPerMinute: 6,
  navInsertTimeoutSec: 20,
  dispatchTicketSec: 10,
};
