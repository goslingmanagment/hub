import type { Database } from "@agency_hub_core/db";

import {
  assertLegacyOwnsFanslyPageLabels,
  FanslyPageOnSyncEngineError,
  SYNC_ENGINE_HINTS,
} from "../../apps/runtime/src/services/sync-engine-guard.ts";

// Step-3 design §3.1 item 11: the operator scripts that open a page's socket
// or check its binding refuse a page the Fansly Sync Engine owns
// (`handover`/`live`) with a read-only check through the pool they open,
// before any egress is resolved or the page's send guard is touched.

export async function refuseEngineOwnedPage(db: Database, pageLabel: string): Promise<void> {
  await assertLegacyOwnsFanslyPageLabels({ db }, [pageLabel], SYNC_ENGINE_HINTS.socket);
}

/** The refusal's one-line reason for stderr (page label, mode and hint only;
 *  never credential or provider text), or null for any other error. */
export function engineOwnedRefusalLine(error: unknown): string | null {
  return error instanceof FanslyPageOnSyncEngineError ? `${error.message}\n` : null;
}
