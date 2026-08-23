import { describe, expect, it } from "vitest";

import {
  AGENT_OBSERVATION_PAYLOAD_ALLOWLIST,
  AGENT_OBSERVATION_PAYLOAD_DENYLIST,
  agentObservationPayloadAllowed,
} from "../apps/runtime/src/modules/agent-read/index.ts";
import { FANSLY_PAYOUTS_CANONICALIZED_KINDS } from "../apps/runtime/src/services/canonicalize/fansly-payouts.ts";

// WP-F7 — where "restricted class" is actually enforced, pinned.
//
// The payouts lane journals the creator's own payout CREDENTIALS: provider 2
// (Paxum) returns a full plaintext email address in `metadata`. DP 7 keeps that
// body for 100 years and nothing deletes it, which is right — the mask is a
// PROJECTION rule, and an over-eager scrubber at the journal would have
// destroyed the only copy of the fact. What has to be true instead is that no
// serving surface can ever hand the body back.
//
// The agent read plane's payload gate is an ALLOWLIST and it fails closed, so
// absence IS the enforcement. This file asserts the absence, because an absence
// nothing checks is an absence a well-meaning widening deletes.

describe("WP-F7 payout observation kinds stay off the agent read plane", () => {
  it("neither kind is on AGENT_OBSERVATION_PAYLOAD_ALLOWLIST", () => {
    for (const kind of FANSLY_PAYOUTS_CANONICALIZED_KINDS) {
      expect(AGENT_OBSERVATION_PAYLOAD_ALLOWLIST.has(kind), kind).toBe(false);
    }
    // The allowlist is exactly the reviewed contract appendix and nothing else.
    // Pinned as a whole, so a payout kind cannot arrive here as a one-word diff.
    expect([...AGENT_OBSERVATION_PAYLOAD_ALLOWLIST].sort()).toEqual([
      "account_stats",
      "dm_conversations",
      "dm_messages",
      "earnings_monthlystats_snapshot",
      "earnings_stats_snapshot",
      "earnings_transactions",
      "fan_earnings_monthly",
      "fan_earnings_stats",
      "media_offer_stats",
      "notifications",
      "purchase_history",
      "subscribers",
      "subscription_tiers",
      "tracking_links",
      "vault_albums",
    ]);
  });

  it("both kinds are ALSO named on the denylist, with their reason", () => {
    // Belt and braces, and the braces are the point: the allowlist already
    // refuses them, so the denylist entry exists purely so a future widening
    // has to delete a sentence that says why rather than add a word.
    for (const kind of FANSLY_PAYOUTS_CANONICALIZED_KINDS) {
      expect(AGENT_OBSERVATION_PAYLOAD_DENYLIST.has(kind), kind).toBe(true);
    }
  });

  it("the gate refuses both, and refuses their failure bodies too", () => {
    for (const kind of FANSLY_PAYOUTS_CANONICALIZED_KINDS) {
      expect(agentObservationPayloadAllowed(kind), kind).toBe(false);
      expect(agentObservationPayloadAllowed(`${kind}:failed`), kind).toBe(false);
    }
    // Non-vacuous: the gate does say yes to something, so a broken import or a
    // renamed export could not make this file pass by refusing everything.
    expect(agentObservationPayloadAllowed("dm_messages")).toBe(true);
  });
});
