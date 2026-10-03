import { createHash } from "node:crypto";

import {
  findPageByLabel,
  isFanslyPageEngineOwned,
  lockFanslyCredentialsForSave,
  trustSyncPageCredentials,
  type Database,
} from "@agency_hub_core/db";
import type { AppConfig, FanslySessionBundle, ProxyConfig } from "@agency_hub_core/shared";

import type { IdentityCandidateSecret } from "../sync/fansly/transport.ts";
import { encryptSyncWorkSecret } from "../sync/requests/secret-params.ts";
import type { EnqueueAndWaitResult } from "../sync/requests/urgent.ts";
import { readFanslyPageGeneration } from "./egress/fansly-probe-context.ts";
import type { AppContext } from "../bootstrap.ts";
import { AppError, BadRequestError } from "./errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "./notification-incidents.ts";
import { FanslyPageSwitchingError } from "./sync-engine-guard.ts";

// The owner's `/account/me` senders on a page the Fansly Sync Engine owns
// (design step 3 §3.5 item 6, replacing S3-01's 409 for `live`). The API and
// the CLI never call Fansly for such a page: they put work on the page's queue
// and wait (≤ 30 s) for the actor's answer, paced like every request of the
// page.
//   - page verify ⇒ `account.verify`;
//   - a credentials or proxy change ⇒ `account.identity` with the candidate
//     session/proxy sealed in the work's secret, over the stored credentials
//     read at the enqueue (the base): checked against the page before
//     anything is stored, admitted even under an auth hold (the candidate is
//     not the session that failed, E16); once it matches, the caller stores
//     it and the engine trusts it in ONE transaction that is a CAS on the
//     exact pair the check proved (`saveVerifiedFanslyCredentials`, step 3b
//     ruling 5). Trusting lifts no hold: under a credentials hold the actor
//     then verifies the new stored credentials (A3), and that proof clears it.
// `handover` answers 409 `fansly_page_switching`; `off`/`shadow` (or no engine
// row) keep the legacy path. The engine's queue (`requests/urgent.ts`, which
// loads the whole registry) is loaded only when a live page needs it, so the
// legacy services that route here stay light.

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

/** Which engine answers the page's `/account/me` now. */
export type FanslyAccountRoute = "legacy" | "engine";

/** `legacy` for an `off`/`shadow` page (or one without an engine row),
 *  `engine` for a `live` one; a page being switched refuses (409). */
export async function fanslyAccountRoute(app: { db: Database }, page: { id: number; label: string }): Promise<FanslyAccountRoute> {
  const ownership = await isFanslyPageEngineOwned(app.db, page.id);
  if (!ownership.owned) return "legacy";
  if (ownership.mode === "handover") throw new FanslyPageSwitchingError(page.label);
  return "engine";
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

/** The non-secret name of a candidate: the sha256 of its ciphertext. */
function candidateGeneration(ciphertext: string): string {
  return createHash("sha256").update(ciphertext, "utf8").digest("hex");
}

/** Which request proved a candidate, over which stored credentials. */
export interface EngineIdentityProof {
  /** The check's attempt (`sync_attempts.id`). */
  attemptId: number;
  /** When it was sent. */
  sentAt: Date;
  /** The digest of the stored credentials the check stood on: the half the
   *  candidate does not replace is theirs. */
  base: string;
}

/** What one engine identity check answered. */
export interface EngineIdentityCheck {
  /** True: the candidate answered for the page's own account; false: for
   *  another; null: no account came back (refused, failed). */
  matches: boolean | null;
  accountId: string | null;
  username: string | null;
  /** Why the work closed (`identity_matches`, `subject_terminal:401`, …). */
  closeReason: string | null;
  /** Set when an answer came back. */
  proof: EngineIdentityProof | null;
}

/** A matching identity check, ready for the save. */
export interface EngineVerifiedCandidate extends EngineVerification {
  proof: EngineIdentityProof;
}

/** The stored credentials changed between the identity check and the save:
 *  the check proved another pair than the one that would be stored. */
export class FanslyCredentialsChangedError extends AppError {
  constructor(pageLabel: string) {
    super(
      `The stored credentials of ${pageLabel} changed during the identity check; nothing was stored — run the change again`,
      409,
      "fansly_credentials_changed",
    );
    this.name = "FanslyCredentialsChangedError";
  }
}

function proofOf(value: unknown): EngineIdentityProof | null {
  if (typeof value !== "object" || value === null) return null;
  const { attemptId, sentAt, base } = value as Record<string, unknown>;
  const at = typeof sentAt === "string" ? new Date(sentAt) : null;
  if (typeof attemptId !== "number" || at === null || Number.isNaN(at.getTime()) || typeof base !== "string") return null;
  return { attemptId, sentAt: at, base };
}

/** The digest of the page's stored credentials now (`readFanslyPageGeneration`). */
async function storedGeneration(db: Database, pageLabel: string): Promise<string> {
  return db.transaction(
    async (raw) => readFanslyPageGeneration(raw as unknown as Database, pageLabel),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * A candidate session and/or proxy checked against a live page through the
 * engine (`account.identity`, one admitted `/account/me` of this page with the
 * candidate, over the stored credentials read now — the transport refuses to
 * build it over any other). Throws 409 when no answer came within the wait (or
 * the page is being switched); every answer is returned.
 */
export async function runFanslyIdentityCheck(
  app: { db: Database; config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion"> },
  page: { id: number; label: string },
  candidate: { session?: FanslySessionBundle | null; proxy?: ProxyConfig | null },
): Promise<EngineIdentityCheck> {
  const secret: IdentityCandidateSecret = {
    ...(candidate.session === undefined || candidate.session === null ? {} : { session: candidate.session }),
    ...(candidate.proxy === undefined || candidate.proxy === null ? {} : { proxy: candidate.proxy }),
  };
  const ciphertext = encryptSyncWorkSecret(app.config, secret);
  const base = await storedGeneration(app.db, page.label);
  const { enqueueAndWait, UrgentWorkRefusedError } = await urgent();
  let waited: EnqueueAndWaitResult;
  try {
    waited = await enqueueAndWait({ db: app.db }, {
      pageId: page.id,
      resource: "account.identity",
      params: {
        candidate: {
          generation: candidateGeneration(ciphertext),
          base,
          session: secret.session !== undefined,
          proxy: secret.proxy !== undefined,
        },
      },
      secretParams: ciphertext,
      waitMs: ENGINE_ACCOUNT_WAIT_MS,
      reason: "owner_credentials",
    });
  } catch (error) {
    if (error instanceof UrgentWorkRefusedError && error.reason === "secret_busy") {
      throw new AppError(`Another credentials check of ${page.label} is still queued; wait for it`, 409, "fansly_sync_work_queued");
    }
    throw error;
  }
  const done = settledOrThrow(waited, page, "account.identity");
  const result = done.result as { accountId?: unknown; username?: unknown; matches?: unknown; proof?: unknown } | null;
  return {
    matches: typeof result?.matches === "boolean" ? result.matches : null,
    accountId: typeof result?.accountId === "string" ? result.accountId : null,
    username: typeof result?.username === "string" ? result.username : null,
    closeReason: done.closeReason,
    proof: proofOf(result?.proof),
  };
}

/** `runFanslyIdentityCheck` for a caller that stores the candidate next: a
 *  different account is a 400 naming it, a refused candidate a 400 with the
 *  engine's reason. */
export async function checkFanslyIdentityThroughEngine(
  app: { db: Database; config: Pick<AppConfig, "encryptionKey" | "encryptionKeyVersion"> },
  page: { id: number; label: string },
  candidate: { session?: FanslySessionBundle | null; proxy?: ProxyConfig | null },
): Promise<EngineVerifiedCandidate> {
  const checked = await runFanslyIdentityCheck(app, page, candidate);
  if (checked.matches === true && checked.accountId !== null && checked.proof !== null) {
    return { accountId: checked.accountId, username: checked.username, proof: checked.proof };
  }
  if (checked.matches === false) {
    throw new BadRequestError(
      `Credential identity mismatch for page "${page.label}": the session belongs to Fansly account ${checked.accountId ?? "?"}`,
    );
  }
  throw new BadRequestError(`The candidate credentials were refused (${checked.closeReason ?? "no answer"})`);
}

/**
 * Store what an identity check proved and trust it, in ONE transaction that
 * is a CAS on the exact session+proxy pair the check sent (step 3b ruling 5):
 * the rows that make the stored digest are locked first, the stored
 * credentials must still be the base the check stood on (the half the
 * candidate does not replace), then `store` writes the candidate's halves and
 * the engine trusts the digest of what is stored now — the pair proved. A
 * changed base stores nothing (409 `fansly_credentials_changed`). The trust
 * lifts no hold: a credentials hold clears by the verify of the new stored
 * credentials, which runs under it (A3).
 */
export async function saveVerifiedFanslyCredentials(
  app: { db: Database },
  page: { id: number; label: string },
  verified: EngineVerifiedCandidate,
  store: (tx: Database) => Promise<void>,
): Promise<string> {
  return app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockFanslyCredentialsForSave(tx, page.id);
    if ((await readFanslyPageGeneration(tx, page.label)) !== verified.proof.base) {
      throw new FanslyCredentialsChangedError(page.label);
    }
    await store(tx);
    const generation = await readFanslyPageGeneration(tx, page.label);
    await trustSyncPageCredentials(tx, {
      pageId: page.id,
      generation,
      accountId: verified.accountId,
      verifiedAt: verified.proof.sentAt,
    });
    return generation;
  });
}

/**
 * The owner's page verify (route and CLI) of a page the engine runs: the
 * verify goes through the page's actor and, once it answered, the
 * verification incidents resolve — the legacy streams' auth block is the
 * legacy engine's state and stays as it is (J5). Null: the legacy engine
 * owns the page (its own verify path runs). 409 while the page is switching.
 */
export async function verifyPageOnEngine(
  app: Pick<AppContext, "db" | "config" | "logger">,
  pageLabel: string,
): Promise<{ verified: true; username: string | null; platform: "fansly"; syncUnblocked: boolean } | null> {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored || stored.page.platform !== "fansly") return null;
  const page = { id: stored.page.id, label: stored.page.label };
  if ((await fanslyAccountRoute(app, page)) === "legacy") return null;
  const verified = await verifyFanslyPageThroughEngine(app, page);
  const recovery = await handleSuccessfulPageVerificationRecovery(app, {
    platformAccountId: page.id,
    pageLabel: page.label,
    platform: "fansly",
    recoveredAt: new Date(),
    unblockLegacyStreams: false,
  });
  return { verified: true, username: verified.username ?? stored.page.username, platform: "fansly", syncUnblocked: recovery.syncUnblocked };
}
