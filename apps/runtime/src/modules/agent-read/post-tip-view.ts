import type { AgentFieldState, AgentGap } from "@agency_hub_core/contracts";

/**
 * The attribution facts person/timeline actually serve. The optional fan note
 * is intentionally absent: it stays on the verbatim-text dataset boundary and
 * therefore cannot silently widen these `read:money` views to transcript data.
 */
export const AGENT_POST_TIP_VIEW_CLAIM_FIELDS = [
  "postTipPostRef",
  "postTipRef",
  "postTipOccurredAt",
  "postTipAmountMills",
  "postTipGoalRef",
] as const;

type PostTipViewClaimField = (typeof AGENT_POST_TIP_VIEW_CLAIM_FIELDS)[number];

export function postTipParseDebtGaps(input: {
  topLevel: boolean;
  rejectedItems: boolean;
}): AgentGap[] {
  const gaps: AgentGap[] = [];
  const replay = {
    kind: "local_replay" as const,
    costClass: "free" as const,
    admissible: true,
    reason: null,
  };
  if (input.topLevel) {
    gaps.push({
      kind: "parse_debt",
      from: null,
      to: null,
      plane: "creator_post_tips",
      remedy: replay,
    });
  }
  if (input.rejectedItems) {
    gaps.push({
      kind: "rejected_rows",
      from: null,
      to: null,
      plane: "creator_post_tips",
      remedy: replay,
    });
  }
  return gaps;
}

export function postSnapshotParseDebtGaps(parseDebt: boolean): AgentGap[] {
  return parseDebt
    ? [{
        kind: "parse_debt",
        from: null,
        to: null,
        plane: "creator_posts",
        remedy: {
          kind: "local_replay",
          costClass: "free",
          admissible: true,
          reason: null,
        },
      }]
    : [];
}

/** Row states refine structural scope observability. A null post-tip goal ref
 * is affirmative direct-tip evidence: the canonicalizer proved that the
 * captured target list contained zero type-7100 targets. */
export function postTipViewFieldStates(input: {
  claimFields: readonly string[] | null;
  scopeFieldStates: Readonly<Record<string, AgentFieldState>>;
  values: Readonly<Record<PostTipViewClaimField, unknown>>;
}): Record<string, AgentFieldState> {
  const claimed = new Set(input.claimFields ?? []);
  const states: Record<string, AgentFieldState> = {};
  for (const field of AGENT_POST_TIP_VIEW_CLAIM_FIELDS) {
    if (!claimed.has(field)) {
      continue;
    }
    const scopeState = input.scopeFieldStates[field];
    if (scopeState === undefined) {
      continue;
    }
    states[field] = scopeState.state === "present" && input.values[field] === null
      ? {
        state: field === "postTipGoalRef" ? "observed_empty" : "source_did_not_provide",
        remedy: { kind: "none", reason: "no_remedy_exists" },
      }
      : scopeState;
  }
  return states;
}
