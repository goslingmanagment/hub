
import { updatePageMetadata, upsertFanslyPageProfile, type Database } from "@agency_hub_core/db";
import type { FanslyAccountMe } from "@agency_hub_core/fansly";
import { millsFromInteger } from "@agency_hub_core/shared";

import { buildFanslyMetadata } from "../../../services/fansly.ts";
import type {
  ApplyInput,
  ApplyResult,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";
import { parsePageProfileAnswer } from "../lib/page-profile.ts";

// `account.poll`, `account.verify` (plan §5, design §5.1):
// one `GET /account/me` per step, journaled as `account_me` exactly as the
// legacy light stream journaled it.
//
// - poll (planned, hourly): the page's identity, counters, balance and
//   metadata (`updatePageMetadata` with `syncType: 'light'`: `last_verified_at`
//   and `last_light_sync_at` in one statement). It must stay ≤ 2 h: the
//   subscribers stated-empty rule and the followers head read its counters.
// - verify (urgent, the owner's "обновить сейчас" / page verify): the same
//   write, its answer as the work's result for the enqueue-and-wait caller.
//
// Either also writes the page's profile (0336, `lib/page-profile.ts`): the
// version of its content and the day's counters, from the journaled answer.
//
// An answer for another account (`PlatformAccountIdentity*Error` out of
// `updatePageMetadata`) is deterministic: the engine holds the page
// (`identity_mismatch`, until new credentials) and quarantines the step.

export type AccountVariant = "poll" | "verify";

export const ACCOUNT_ME_REQUEST: RequestPlan<"account.me"> = { spec: "account.me", params: {} };

/** What one applied `/account/me` told about the page. */
export interface AccountMeFacts {
  accountId: string;
  username: string | null;
  followCount: number | null;
  subscriberCount: number | null;
}

/**
 * Apply one accepted `/account/me` answer to the page — the write the legacy
 * light stream's metadata refresh made (deleted at step 4), minus its request
 * and journal: identity,
 * counters (a counter missing from the answer is cleared, never kept, so the
 * last 0 cannot look fresh), balance, metadata and `last_verified_at`. Throws
 * the identity errors of `updatePageMetadata` unchanged.
 */
export async function applyAccountMeToPage(
  tx: Database,
  input: {
    pageId: number;
    account: FanslyAccountMe["account"];
    syncType?: "light" | "followers";
    /** The journaled answer: given, the page's profile is written too. */
    observation?: { id: number; receivedAt: Date };
  },
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
  if (input.observation !== undefined) {
    await applyPageProfile(tx, { pageId: input.pageId, response: { account }, observation: input.observation });
  }
  return { accountId: account.id, username: account.username, followCount, subscriberCount };
}

/**
 * Write the profile one journaled `/account/me` answer shows (0336): its
 * content's version and its UTC day's counters. An answer naming no account
 * writes nothing. Idempotent: the journal's backfill and the poll may apply
 * the same answer twice, in any order.
 */
export async function applyPageProfile(
  tx: Database,
  input: { pageId: number; response: unknown; observation: { id: number; receivedAt: Date } },
): Promise<boolean> {
  const profile = parsePageProfileAnswer(input.response);
  if (profile === null) return false;
  await upsertFanslyPageProfile(tx, {
    pageId: input.pageId,
    observationId: input.observation.id,
    capturedAt: input.observation.receivedAt,
    contentSha256: profile.contentSha256,
    content: profile.content,
    counters: profile.counters,
  });
  return true;
}

function accountOf(parsed: unknown): FanslyAccountMe["account"] {
  return (parsed as FanslyAccountMe).account;
}

export function accountModule(variant: AccountVariant): ResourceModule {
  return {
    async plan(): Promise<StepPlan> {
      return { kind: "request", request: ACCOUNT_ME_REQUEST };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const account = accountOf(input.parsed);
      const facts = await applyAccountMeToPage(tx, { pageId: input.pageId, account, syncType: "light", observation: input.observation });
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
  };
}
