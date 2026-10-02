import { sql } from "drizzle-orm";

import { familyForObservation } from "../../../services/canonicalize/index.ts";
import { buildCanonicalDrafts } from "../../../services/canonicalize-drafts.ts";
import type { ReplayContext, ReplayObservation, ReplayVerdict } from "../../engine/resource.ts";
import { readFanslyPageFacts } from "./page-facts.ts";

// Replay of a journaled observation whose whole effect is its canonical events
// (the capture-only content lanes: notifications, posts, post tips, replies —
// design §5.14–§5.16, the shadow report's B5): the observation through its
// canonicalizer family (the pure seam the engine's apply and the minutely
// driver share), and every draft's dedup key looked up among the page's stored
// events. A match means legacy stored exactly what the engine's apply would
// have appended for the same body. Read-only.

/** At most this many missing keys are named in a mismatch. */
const EXAMPLES = 5;

export async function replayByCanonicalDrafts(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const family = familyForObservation({ source: "pull", kind: observation.kind, platform: "fansly" });
  if (family === null) return { kind: "not_replayable", reason: "no_canonicalizer_family" };
  const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
  const outcome = buildCanonicalDrafts(family, {
    id: observation.id,
    source: "pull",
    producer: "fansly-sync:replay",
    platform: "fansly",
    accountId: ctx.pageId,
    kind: observation.kind,
    payload: observation.payload,
    observedAt: null,
    receivedAt: observation.receivedAt,
  }, {
    nativeAccountRefByAccountId: new Map([[ctx.pageId, facts?.externalId ?? null]]),
    now: new Date(),
  });
  if (outcome.kind === "rejected") {
    return { kind: "mismatch", reason: "family_rejected", detail: { code: outcome.rejection.code ?? "unclassified" } };
  }
  const keys = [...new Set(outcome.drafts.map((draft) => draft.dedupKey))];
  if (keys.length === 0) return { kind: "match", detail: { drafts: 0 } };
  const stored = await ctx.db.execute<{ dedupKey: string }>(sql`
    select k.dedup_key as "dedupKey"
      from domain_event_keys k
     where k.account_id = ${ctx.pageId}
       and k.dedup_key = any(${sql.param(keys)}::text[])
  `);
  const present = new Set(stored.rows.map((row) => row.dedupKey));
  const missing = keys.filter((key) => !present.has(key));
  return missing.length === 0
    ? { kind: "match", detail: { drafts: keys.length } }
    : {
      kind: "mismatch",
      reason: "events_missing",
      detail: { drafts: keys.length, missing: missing.length, examples: missing.slice(0, EXAMPLES) },
    };
}
