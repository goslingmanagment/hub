// Decision 382: OFAPI custody continuity by creator identity.
//
// OFAPI's `acct_…` is the id of ONE connection; the OnlyFans creator behind it
// keeps a numeric user id across every re-connection. The roster (`GET
// /accounts`, a free read journaled as `ofapi_admin_accounts`) lists both, so
// custody no longer has to wait for an operator: every five minutes this job
// seeds the creator id onto a page that has none, rebinds a page whose account
// died to the authenticated account of the same creator (through the SAME
// verified apply the owner route uses, with the roster capture as evidence),
// and attaches every other unowned account of the creator as historical
// custody so its journaled facts resolve and replay. It never touches a page
// whose identity disagrees with the roster and never moves custody between
// pages: those remain operator decisions (Decision 257).

import {
  applyVerifiedOfapiBinding,
  attachOfapiHistoricalBinding,
  findHistoricalPageByOfapiAccountId,
  listOfapiBindingPages,
  listOfapiBindingRecoveryCandidates,
  seedOfapiPageCreatorIdentity,
  type OfapiBindingReconcilePage,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { resolveOfapiAuthIncident } from "./notification-incidents.ts";
import { OFAPI_AUTH_ACTION_REQUIRED_STATUSES } from "./ofapi-account-health.ts";
import { recordOfapiBindingReplaced } from "./ofapi-binding-refresh.ts";
import type { OfapiAccountRecord } from "./ofapi.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OFAPI_BINDING_RECONCILE_QUEUE = "ofapi.binding.reconcile";
/** Five minutes: the roster read is free, and the window between a dead
 * account and its replacement is what the webhook family pays for. */
export const OFAPI_BINDING_RECONCILE_CRON = "*/5 * * * *";

export async function ensureOfapiBindingReconcileQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, OFAPI_BINDING_RECONCILE_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureOfapiBindingReconcileSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(OFAPI_BINDING_RECONCILE_QUEUE, OFAPI_BINDING_RECONCILE_CRON, null, { tz: "UTC" });
}

export interface OfapiBindingReconcileAction {
  pageId: number;
  label: string;
  action: "seed_identity" | "rebind" | "attach_historical";
  accountId: string;
  creatorId: string;
  previousAccountId: string | null;
  /** false in a dry run, or when the writer refused (state moved under us). */
  applied: boolean;
}

export interface OfapiBindingReconcileResult {
  /** null = the run inspected the roster; otherwise why it did not. */
  skipped: string | null;
  dryRun: boolean;
  rosterEvidence: { observationId: number; receivedAt: string } | null;
  pagesChecked: number;
  actions: OfapiBindingReconcileAction[];
  /** Pages whose current account is dead and cannot be rebound yet. */
  waiting: Array<{ pageId: number; label: string; accountId: string | null; reason: string }>;
  /** The page names one creator, the roster names another for its account. */
  identityMismatches: Array<{ pageId: number; label: string; accountId: string; pageCreatorId: string; rosterCreatorId: string }>;
  /** The creator is connected twice while the bound account still works —
   * the FAQ case ("added again instead of re-authenticated"). */
  duplicates: Array<{ pageId: number; label: string; currentAccountId: string; duplicateAccountId: string }>;
  /** Roster accounts no page or custody row knows and no creator id matched. */
  unownedRosterAccounts: Array<{ accountId: string; creatorId: string | null; username: string | null; authenticated: boolean }>;
}

export interface OfapiBindingReconcileOptions {
  /** Report every action without writing. */
  dryRun?: boolean;
  /** Run even when `ofapiBindingReconcileEnabled` is off (operator CLI). */
  force?: boolean;
}

function pageCreatorId(page: OfapiBindingReconcilePage): string | null {
  return [page.creator_id, page.metadata_creator_id].find((id): id is string => Boolean(id)) ?? null;
}

function isUsableIdentity(account: OfapiAccountRecord | null | undefined): account is OfapiAccountRecord & { onlyfansUserId: string } {
  return Boolean(account && account.onlyfansUserId && account.identityStatus !== "conflict");
}

export async function runOfapiBindingReconcile(
  app: AppContext,
  options: OfapiBindingReconcileOptions = {},
): Promise<OfapiBindingReconcileResult> {
  const dryRun = options.dryRun === true;
  const result: OfapiBindingReconcileResult = {
    skipped: null, dryRun, rosterEvidence: null, pagesChecked: 0,
    actions: [], waiting: [], identityMismatches: [], duplicates: [], unownedRosterAccounts: [],
  };
  if (!app.config.ofapiBindingReconcileEnabled && options.force !== true) {
    result.skipped = "disabled";
    return result;
  }
  const client = app.ofapi;
  if (!client?.listAccountsSnapshot || !client.getCredentialPreflight) {
    result.skipped = "client_unavailable";
    return result;
  }
  const credential = await client.getCredentialPreflight();
  if (credential.status !== "verified") {
    result.skipped = `credential_${credential.status}`;
    return result;
  }
  const snapshot = await client.listAccountsSnapshot();
  if (!snapshot.evidence) {
    // Without the journaled roster there is nothing to cite as proof.
    result.skipped = "roster_evidence_unavailable";
    return result;
  }
  const rosterEvidence = {
    observationId: snapshot.evidence.observationId,
    receivedAt: snapshot.evidence.receivedAt.toISOString(),
  };
  result.rosterEvidence = rosterEvidence;
  const accounts = snapshot.accounts;
  const byId = new Map(accounts.map(account => [account.id, account] as const));
  const pages = await listOfapiBindingPages(app.db);
  /** Accounts this run already decided about — a creator is one page. */
  const claimed = new Set<string>();
  const evidenceBase = {
    source: "roster_reconcile", decision: 382, rosterEvidence,
    credentialFingerprint: credential.credentialFingerprint,
  };

  for (const page of pages) {
    // A page that was never mapped belongs to onboarding, not to repair.
    if (!page.account_id) continue;
    result.pagesChecked += 1;
    claimed.add(page.account_id);
    const current = byId.get(page.account_id) ?? null;
    let creatorId = pageCreatorId(page);

    if (isUsableIdentity(current)) {
      if (creatorId !== null && creatorId !== current.onlyfansUserId) {
        result.identityMismatches.push({
          pageId: page.id, label: page.label, accountId: page.account_id,
          pageCreatorId: creatorId, rosterCreatorId: current.onlyfansUserId,
        });
        app.logger.error({ pageId: page.id, accountId: page.account_id, pageCreatorId: creatorId, rosterCreatorId: current.onlyfansUserId },
          "OFAPI binding reconcile: page identity disagrees with the roster; page left untouched");
        continue;
      }
      if (creatorId === null) {
        const rosterCreatorId = current.onlyfansUserId;
        const claimant = pages.find(other => other.id !== page.id && pageCreatorId(other) === rosterCreatorId);
        if (claimant) {
          // Another page already IS this creator: that is a custody question
          // for an operator (Decision 257), never an anchor to rebind on.
          result.identityMismatches.push({
            pageId: page.id, label: page.label, accountId: page.account_id,
            pageCreatorId: `page:${claimant.id}`, rosterCreatorId,
          });
          app.logger.error({ pageId: page.id, accountId: page.account_id, claimantPageId: claimant.id, rosterCreatorId },
            "OFAPI binding reconcile: the roster names a creator another page already carries; page left untouched");
          continue;
        }
        const applied = dryRun ? false : await seedOfapiPageCreatorIdentity(app.db, {
          pageId: page.id, expectedAccountId: page.account_id, creatorId: rosterCreatorId,
          evidence: { ...evidenceBase, action: "seed_identity" },
        });
        result.actions.push({
          pageId: page.id, label: page.label, action: "seed_identity", accountId: page.account_id,
          creatorId: rosterCreatorId, previousAccountId: null, applied,
        });
        if (!dryRun && !applied) {
          result.waiting.push({ pageId: page.id, label: page.label, accountId: page.account_id, reason: "creator_identity_conflict" });
          continue;
        }
        creatorId = rosterCreatorId;
      }
    }
    if (creatorId === null) {
      result.waiting.push({ pageId: page.id, label: page.label, accountId: page.account_id, reason: "creator_identity_unknown" });
      continue;
    }

    const currentDead = current === null || current.isAuthenticated !== true
      || (page.auth_status !== null && OFAPI_AUTH_ACTION_REQUIRED_STATUSES.has(page.auth_status));
    const unowned: OfapiAccountRecord[] = [];
    for (const account of accounts) {
      if (account.id === page.account_id || claimed.has(account.id)) continue;
      if (!isUsableIdentity(account) || account.onlyfansUserId !== creatorId) continue;
      // Custody never moves between pages: an account another page owns (or a
      // contested one, which the lookup also reports as no single owner but the
      // writers refuse) is not ours to attach.
      const owner = await findHistoricalPageByOfapiAccountId(app.db, account.id);
      if (owner === null) unowned.push(account);
    }
    const authenticated = unowned.filter(account => account.isAuthenticated === true);
    let rebound: string | null = null;

    if (currentDead) {
      if (authenticated.length === 1) {
        const candidate = authenticated[0]!;
        const applied = dryRun ? false : await rebind(app, page, candidate, creatorId, snapshot.evidence.receivedAt, {
          ...evidenceBase, action: "rebind", previousAccountId: page.account_id, previousAuthStatus: page.auth_status,
        });
        rebound = candidate.id;
        claimed.add(candidate.id);
        result.actions.push({
          pageId: page.id, label: page.label, action: "rebind", accountId: candidate.id,
          creatorId, previousAccountId: page.account_id, applied,
        });
      } else {
        result.waiting.push({
          pageId: page.id, label: page.label, accountId: page.account_id,
          reason: authenticated.length === 0 ? "no_authenticated_replacement" : "ambiguous_replacements",
        });
      }
    } else {
      for (const account of authenticated) {
        result.duplicates.push({ pageId: page.id, label: page.label, currentAccountId: page.account_id, duplicateAccountId: account.id });
        app.logger.warn({ pageId: page.id, currentAccountId: page.account_id, duplicateAccountId: account.id },
          "OFAPI binding reconcile: creator connected twice while the bound account works — re-authenticate the bound account instead of adding a new one");
      }
    }

    for (const account of unowned) {
      if (account.id === rebound) continue;
      const applied = dryRun ? false : await attachOfapiHistoricalBinding(app.db, {
        pageId: page.id, accountId: account.id, creatorId,
        evidence: { ...evidenceBase, action: "attach_historical", authenticated: account.isAuthenticated === true },
      });
      claimed.add(account.id);
      result.actions.push({
        pageId: page.id, label: page.label, action: "attach_historical", accountId: account.id,
        creatorId, previousAccountId: null, applied,
      });
    }
  }

  for (const account of accounts) {
    if (claimed.has(account.id)) continue;
    if ((await findHistoricalPageByOfapiAccountId(app.db, account.id)) !== null) continue;
    result.unownedRosterAccounts.push({
      accountId: account.id, creatorId: account.onlyfansUserId, username: account.username,
      authenticated: account.isAuthenticated === true,
    });
  }
  return result;
}

/** The owner route's apply, minus the preview token: the roster capture is the
 * evidence and the receipt becomes `ofapi_auth_changed_at` (Decision 255). */
async function rebind(
  app: AppContext,
  page: OfapiBindingReconcilePage,
  candidate: OfapiAccountRecord,
  creatorId: string,
  authVerifiedAt: Date,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const recovery = await listOfapiBindingRecoveryCandidates(app.db, page.id, page.generation);
  const applied = await app.db.transaction(async tx => {
    const db = tx as AppContext["db"];
    const changed = await applyVerifiedOfapiBinding(db, {
      pageId: page.id, expectedAccountId: page.account_id, expectedGeneration: page.generation,
      accountId: candidate.id, creatorId, historicalAccountIds: [], recovery, authVerifiedAt, evidence,
    });
    if (!changed) return false;
    await recordOfapiBindingReplaced(db, {
      pageId: page.id, accountId: candidate.id, actorPrincipalId: null,
      audit: { ...evidence, pageId: page.id, expectedAccountId: page.account_id, expectedGeneration: page.generation,
        accountId: candidate.id, creatorId, recovery },
    });
    await resolveOfapiAuthIncident({ ...app, db }, {
      platformAccountId: page.id, pageLabel: page.label, platform: "onlyfans", recoveredAt: authVerifiedAt,
    });
    return true;
  });
  if (applied) {
    app.logger.info({ pageId: page.id, label: page.label, from: page.account_id, to: candidate.id, creatorId },
      "OFAPI binding reconcile: page rebound to the creator's authenticated account");
  } else {
    app.logger.warn({ pageId: page.id, from: page.account_id, to: candidate.id },
      "OFAPI binding reconcile: verified apply refused (binding or recovery state changed); retried next run");
  }
  return applied;
}
