import { and, eq, ne } from "drizzle-orm";

import { pages, updatePageMetadata, type Database, type SyncWorkRow } from "@agency_hub_core/db";
import { parseFanslyAccountMe, type FanslyAccountMe } from "@agency_hub_core/fansly";
import { millsFromInteger } from "@agency_hub_core/shared";

import { buildFanslyMetadata } from "../../../services/fansly.ts";
import type {
  ApplyInput,
  ApplyResult,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";

// `account.poll`, `account.verify`, `account.identity` (plan §5, design §5.1):
// one `GET /account/me` per step, journaled as `account_me` exactly as the
// legacy light stream journals it.
//
// - poll (planned, hourly): the page's identity, counters, balance and
//   metadata (`updatePageMetadata` with `syncType: 'light'`: `last_verified_at`
//   and `last_light_sync_at` in one statement). It must stay ≤ 2 h: the
//   subscribers stated-empty rule and the followers head read its counters.
// - verify (urgent, the owner's "обновить сейчас" / page verify): the same
//   write, its answer as the work's result for the enqueue-and-wait caller.
// - identity (urgent, live only): a candidate session or proxy is checked
//   against the page before the caller commits it; nothing of the page is
//   written. The candidate itself rides in the work's `secret_params`, which
//   only the live transport reads (step 3).
//
// An answer for another account (`PlatformAccountIdentity*Error` out of
// `updatePageMetadata`) is deterministic: the engine holds the page
// (`identity_mismatch`, until new credentials) and quarantines the step.

export type AccountVariant = "poll" | "verify" | "identity";

export const ACCOUNT_ME_REQUEST: RequestPlan<"account.me"> = { spec: "account.me", params: {} };

/** What one applied `/account/me` told about the page. */
export interface AccountMeFacts {
  accountId: string;
  username: string | null;
  followCount: number | null;
  subscriberCount: number | null;
}

/**
 * Apply one accepted `/account/me` answer to the page — the write of the
 * legacy `refreshPageMetadata`, minus its request and journal: identity,
 * counters (a counter missing from the answer is cleared, never kept, so the
 * last 0 cannot look fresh), balance, metadata and `last_verified_at`. Throws
 * the identity errors of `updatePageMetadata` unchanged.
 */
export async function applyAccountMeToPage(
  tx: Database,
  input: { pageId: number; account: FanslyAccountMe["account"]; syncType?: "light" | "followers" },
): Promise<AccountMeFacts> {
  const facts = await readFanslyPageFacts(tx, input.pageId);
  if (facts === null) throw new Error(`Page ${input.pageId} is gone`);
  const account = input.account;
  const followCount = typeof account.followCount === "number" ? account.followCount : null;
  const subscriberCount = typeof account.subscriberCount === "number" ? account.subscriberCount : null;
  await updatePageMetadata(tx, input.pageId, {
    platformAccountIdValue: account.id,
    username: account.username,
    displayName: account.displayName,
    followerCount: followCount,
    subscriberCount,
    earningsBalanceMills: millsFromInteger(account.earningsWallet?.balance ?? 0),
    // The metadata builder reads the creation instant, walls and tiers only.
    metadata: buildFanslyMetadata({ ...account, followCount: followCount ?? 0, subscriberCount: subscriberCount ?? 0 }, facts.metadata),
    ...(input.syncType === undefined ? {} : { syncType: input.syncType }),
  });
  return { accountId: account.id, username: account.username, followCount, subscriberCount };
}

/** The candidate an identity check verifies: set by its caller together with
 *  the work's `secret_params` (the candidate session/proxy, ciphertext). */
function identityCandidate(work: SyncWorkRow): { generation: string } | null {
  const params = work.params;
  if (typeof params !== "object" || params === null) return null;
  const candidate = (params as Record<string, unknown>).candidate;
  if (typeof candidate !== "object" || candidate === null) return null;
  const generation = (candidate as Record<string, unknown>).generation;
  return typeof generation === "string" && generation.length > 0 ? { generation } : null;
}

/** Does `accountId` belong to this page: its own external id, or — for a
 *  page without one — an id no other page of its platform holds. */
async function judgeIdentity(tx: Database, pageId: number, accountId: string): Promise<boolean> {
  const page = await tx.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { platform: true, platformAccountId: true },
  });
  if (page === undefined) return false;
  if (page.platformAccountId !== null) return page.platformAccountId === accountId;
  const other = await tx.query.pages.findFirst({
    where: and(eq(pages.platform, page.platform), eq(pages.platformAccountId, accountId), ne(pages.id, pageId)),
    columns: { id: true },
  });
  return other === undefined;
}

function accountOf(parsed: unknown): FanslyAccountMe["account"] {
  return (parsed as FanslyAccountMe).account;
}

export function accountModule(variant: AccountVariant): ResourceModule {
  return {
    async plan(work): Promise<StepPlan> {
      if (variant === "identity" && identityCandidate(work) === null) {
        // Without a candidate the check would test the page's own
        // credentials and answer "matches" for nothing.
        return { kind: "quarantine", reason: "identity_candidate_missing" };
      }
      return { kind: "request", request: ACCOUNT_ME_REQUEST };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const account = accountOf(input.parsed);
      if (variant === "identity") {
        const matches = await judgeIdentity(tx, input.pageId, account.id);
        return {
          work: {
            satisfiesRevision: true,
            close: "done",
            closeReason: matches ? "identity_matches" : "identity_differs",
            result: { accountId: account.id, username: account.username, matches },
          },
          followups: [],
        };
      }
      const facts = await applyAccountMeToPage(tx, { pageId: input.pageId, account, syncType: "light" });
      return {
        work: {
          satisfiesRevision: true,
          close: "done",
          closeReason: variant === "verify" ? "verified" : "polled",
          result: { ...facts, verifiedAt: input.now.toISOString() },
        },
        followups: [],
        pageIdentity: { accountId: facts.accountId },
      };
    },

    async shadow() {
      return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
    },

    async replay(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
      const parsed = parseFanslyAccountMe(observation.payload);
      if (!parsed.ok) {
        return { kind: "mismatch", reason: "contract_refused", detail: { ...parsed.violation } };
      }
      const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
      if (facts === null || facts.externalId === null) return { kind: "not_replayable", reason: "page_without_identity" };
      return parsed.value.account.id === facts.externalId
        ? { kind: "match" }
        : { kind: "mismatch", reason: "account_differs", detail: { served: parsed.value.account.id, page: facts.externalId } };
    },
  };
}
