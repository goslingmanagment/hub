import { findPageByLabel, isFanslyPageEngineOwned, type Database } from "@agency_hub_core/db";

import type { EnqueueAndWaitResult } from "../sync/requests/urgent.ts";
import type { AppContext } from "../bootstrap.ts";
import { AppError, BadRequestError, LegacySyncRetiredError, NotFoundError } from "./errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "./notification-incidents.ts";
import { FanslyPageSwitchingError } from "./sync-engine-guard.ts";

// The owner's `/account/me` sender of a Fansly page (design step 3 §3.5
// item 6): page verify ⇒ `account.verify`. The API and the CLI never call
// Fansly for a page: they put work on the page's queue and wait (≤ 30 s) for
// the actor's answer, paced like every request of the page, through its
// browser: the session it sends with is its browser's.
// `handover` answers 409 `fansly_page_switching`. A Fansly page the engine does
// not run (`off`, `shadow` or no engine row) has no sender at all since step 4
// (S4-19 deleted the legacy `/account/me` fallbacks; every Fansly page is
// `live` and a new one is born `live`) and answers 409 `legacy_sync_retired`
// before anything is resolved, sent or stored. The engine's queue
// (`requests/urgent.ts`, which loads the whole registry) is loaded only when a
// live page needs it, so the services that route here stay light.

async function urgent() {
  return import("../sync/requests/urgent.ts");
}

/** The engine's answer did not come within the wait: the work stays queued. */
export class FanslySyncWorkQueuedError extends AppError {
  readonly statusUrl: string;
  readonly workId: number;

  constructor(input: { pageLabel: string; resource: string; workId: number; statusUrl: string }) {
    super(
      `${input.resource} for ${input.pageLabel} is queued on the Fansly Sync Engine (work ${input.workId}); `
        + `follow it at ${input.statusUrl}`,
      409,
      "fansly_sync_work_queued",
    );
    this.name = "FanslySyncWorkQueuedError";
    this.statusUrl = input.statusUrl;
    this.workId = input.workId;
  }
}

/** The engine answers a Fansly page's `/account/me` only for a page it runs
 *  (`live`): a page being switched refuses (409 `fansly_page_switching`), any
 *  other Fansly page refuses (409 `legacy_sync_retired`). */
export async function assertFanslyPageOnEngine(app: { db: Database }, page: { id: number; label: string }): Promise<void> {
  const ownership = await isFanslyPageEngineOwned(app.db, page.id);
  if (ownership.mode === "handover") throw new FanslyPageSwitchingError(page.label);
  if (!ownership.owned) throw new LegacySyncRetiredError({ pageLabel: page.label, platform: "fansly" });
}

/** The engine's wait of one owner action. */
export const ENGINE_ACCOUNT_WAIT_MS = 30_000;

function settledOrThrow(
  waited: EnqueueAndWaitResult,
  page: { label: string },
  resource: string,
): Extract<EnqueueAndWaitResult, { state: "done" }> {
  switch (waited.state) {
    case "done":
      return waited;
    case "queued":
      throw new FanslySyncWorkQueuedError({ pageLabel: page.label, resource, workId: waited.workId, statusUrl: waited.statusUrl });
    case "switching":
      throw new FanslyPageSwitchingError(page.label);
    case "not_live":
      // The page left `live` between the route check and the enqueue.
      throw new FanslyPageSwitchingError(page.label);
  }
}

export interface EngineVerification {
  accountId: string;
  username: string | null;
}

/** Page verify on a live page: one `account.verify` through the page's actor. */
export async function verifyFanslyPageThroughEngine(
  app: { db: Database },
  page: { id: number; label: string },
): Promise<EngineVerification> {
  const { enqueueAndWait } = await urgent();
  const waited = settledOrThrow(await enqueueAndWait({ db: app.db }, {
    pageId: page.id,
    resource: "account.verify",
    waitMs: ENGINE_ACCOUNT_WAIT_MS,
    reason: "owner_verify",
  }), page, "account.verify");
  const result = waited.result as { accountId?: unknown; username?: unknown } | null;
  if (!waited.satisfied || typeof result?.accountId !== "string") {
    throw new BadRequestError(`Page verification failed: the engine closed the check (${waited.closeReason ?? "no answer"})`);
  }
  return { accountId: result.accountId, username: typeof result.username === "string" ? result.username : null };
}

/**
 * The owner's page verify (route and CLI) of a Fansly page: the verify goes
 * through the page's actor and, once it answered, the verification incidents
 * resolve. Null: not a Fansly page (the caller answers that). 404 for an
 * unknown label; 409 while the page is switching or when the engine does not
 * run it.
 */
export async function verifyPageOnEngine(
  app: Pick<AppContext, "db" | "config" | "logger">,
  pageLabel: string,
): Promise<{ verified: true; username: string | null; platform: "fansly"; syncUnblocked: true } | null> {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) throw new NotFoundError(`Page "${pageLabel}" not found`);
  if (stored.page.platform !== "fansly") return null;
  const page = { id: stored.page.id, label: stored.page.label };
  await assertFanslyPageOnEngine(app, page);
  const verified = await verifyFanslyPageThroughEngine(app, page);
  await handleSuccessfulPageVerificationRecovery(app, {
    platformAccountId: page.id,
    pageLabel: page.label,
    platform: "fansly",
    recoveredAt: new Date(),
  });
  // `syncUnblocked` stays in the contract for its clients: nothing of the
  // legacy engine is left to unblock, and an engine hold clears by the engine's
  // own proof (A3), so a verified page is never "verified but still blocked".
  return { verified: true, username: verified.username ?? stored.page.username, platform: "fansly", syncUnblocked: true };
}
