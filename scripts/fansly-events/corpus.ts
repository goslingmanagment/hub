import { z } from "zod";

import { advanceDmShadow, type DmShadowConversation } from "../../apps/runtime/src/services/sync/dm-shadow.ts";
import { createDmShadowState, type DmShadowPolicy, type DmShadowState } from "../../apps/runtime/src/services/sync/dm-shadow-state.ts";
import type { ConversationHeadDiffReason } from "../../apps/runtime/src/services/sync/fansly-dm-head-diff.ts";

const headSchema = z.object({
  groupId: z.string().min(1),
  lastMessageId: z.string().nullable(),
  unreadCount: z.number().nullable(),
  flags: z.number().nullable(),
  lastUnreadMessageId: z.string().nullable(),
  subscriptionTierId: z.string().nullable(),
  embeddedId: z.string().nullable(),
  embeddedMatches: z.number().int().nonnegative(),
  timestamp: z.unknown(),
  senderId: z.string().nullable(),
});
export const dmShadowCorpusRecordSchema = z.object({
  id: z.number().int().positive(),
  pageLabel: z.string(),
  capturedAt: z.string().datetime({ offset: true }),
  offset: z.number().int().nonnegative(),
  limit: z.literal(100),
  sortOrder: z.literal(1),
  payloadAvailable: z.boolean(),
  dataValid: z.boolean().nullable(),
  total: z.number().int().nonnegative().nullable(),
  retainedJsonBytes: z.number().int().nonnegative().nullable(),
  runOutcome: z.string().nullable(),
  runFinishedAt: z.string().nullable(),
  certifiedAt: z.string().nullable(),
  heads: z.array(headSchema),
});
type RecordPage = z.infer<typeof dmShadowCorpusRecordSchema>;
type Head = z.infer<typeof headSchema>;

function timestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const result = value < 10_000_000_000 ? value * 1000 : value;
  return Number.isSafeInteger(result) ? result : null;
}

function compare(head: Head, previous?: Head): DmShadowConversation {
  const fields = [
    ["lastMessageId", "last_message_id"], ["unreadCount", "unread_count"],
    ["flags", "conversation_flags"], ["lastUnreadMessageId", "last_unread_message_id"],
    ["subscriptionTierId", "subscription_tier_id"], ["senderId", "last_message_sender_id"],
  ] as const;
  const reasons: ConversationHeadDiffReason[] = previous === undefined ? ["missing_row"]
    : fields.filter(([key]) => head[key] !== previous[key]).map(([, reason]) => reason);
  if (previous && timestamp(head.timestamp) !== timestamp(previous.timestamp)) reasons.push("last_message_at");
  return {
    reasons, listMessageId: head.lastMessageId, embeddedMessageId: head.embeddedId,
    timestampMs: timestamp(head.timestamp), previousTimestampMs: timestamp(previous?.timestamp),
    previousMessageId: previous?.lastMessageId ?? null,
    // Retained list pages cannot prove material or historical backlog.
    materialConfirmed: null, discoveryToCaptureMs: null, historyPending: false, lastHistorySyncAtMs: null,
  };
}

type Sweep = {
  firstId: number;
  expectedOffset: number;
  total: number | null;
  heads: Map<string, Head>;
  state: DmShadowState;
};
export type DmShadowCorpusResult = {
  pageLabel: string;
  firstId: number;
  status: "complete" | "incomplete" | "priming";
  reason: string | null;
  diagnostics: DmShadowState;
};

/** Raw-to-raw metadata comparison, not reconstruction of historical business
 * writes. Only a certified full predecessor supplies a boundary and baseline. */
export class DmShadowCorpusAnalyzer {
  private readonly previous = new Map<string, { heads: Map<string, Head>; boundaryMs: number }>();
  private readonly active = new Map<string, Sweep>();
  private readonly results: DmShadowCorpusResult[] = [];
  private invalidRecords = 0;

  constructor(private readonly policy: DmShadowPolicy) {}

  accept(value: unknown) {
    const parsed = dmShadowCorpusRecordSchema.safeParse(value);
    if (!parsed.success) {
      this.invalidRecords += 1;
      // An undecodable record has unknown scope; never bridge it silently.
      for (const label of this.active.keys()) this.finish(label, "incomplete", "invalid_record");
      this.previous.clear();
      return;
    }
    const page = parsed.data;
    const label = page.pageLabel;
    if (page.offset === 0) {
      this.finish(label, "incomplete", "restart_before_completion");
      this.active.set(label, {
        firstId: page.id, expectedOffset: 0, total: page.total, heads: new Map(),
        state: {
          ...createDmShadowState({ startedAtMs: Date.parse(page.capturedAt),
            boundaryMs: this.previous.get(label)?.boundaryMs ?? null,
            completeCoverage: true, policy: this.policy }),
          // These fields require the pre-apply runtime row, absent from this corpus.
          visibilityChangesBelowStop: null,
          unresolvedIdentityChangesBelowStop: null,
          exclusionReasonChangesBelowStop: null,
        },
      });
    }
    const sweep = this.active.get(label);
    if (!sweep) {
      this.invalidRecords += 1;
      this.previous.delete(label);
      return;
    }
    const invalid = this.invalidPage(page, sweep);
    if (invalid) {
      this.finish(label, "incomplete", invalid);
      this.previous.delete(label);
      return;
    }
    const baseline = this.previous.get(label);
    sweep.state = advanceDmShadow(sweep.state, {
      observedAtMs: Date.parse(page.capturedAt), responseBytes: page.retainedJsonBytes ?? 0,
      conversations: page.heads.map((head) => compare(head, baseline?.heads.get(head.groupId))),
    });
    for (const head of page.heads) sweep.heads.set(head.groupId, head);
    sweep.expectedOffset += page.limit;
    if (page.heads.length >= page.limit) return;
    const boundaryMs = page.certifiedAt === null ? Number.NaN : Date.parse(page.certifiedAt);
    if (!Number.isFinite(boundaryMs) || (page.total !== null && sweep.heads.size !== page.total)) {
      this.finish(label, "incomplete", "completion_unverified");
      this.previous.delete(label);
      return;
    }
    this.previous.set(label, { heads: sweep.heads, boundaryMs });
    this.finish(label, baseline ? "complete" : "priming", baseline ? null : "no_verified_predecessor");
  }

  private invalidPage(page: RecordPage, sweep: Sweep): string | null {
    if (!page.payloadAvailable || page.dataValid !== true) return "missing_body_or_data";
    if (!page.runFinishedAt || !["succeeded", "partial"].includes(page.runOutcome ?? "")) return "run_unverified";
    if (page.offset !== sweep.expectedOffset || page.total !== sweep.total) return "offset_or_total_drift";
    if (page.heads.some((head) => head.embeddedMatches !== 1)) return "ambiguous_or_missing_head_binding";
    const ids = page.heads.map((head) => head.groupId);
    if (new Set(ids).size !== ids.length || ids.some((id) => sweep.heads.has(id))) return "duplicate_or_overlap";
    return null;
  }

  private finish(pageLabel: string, status: DmShadowCorpusResult["status"], reason: string | null) {
    const sweep = this.active.get(pageLabel);
    if (!sweep) return;
    this.results.push({ pageLabel, firstId: sweep.firstId, status, reason,
      diagnostics: { ...sweep.state, completeCoverage: status === "complete" } });
    this.active.delete(pageLabel);
  }

  report() {
    for (const label of this.active.keys()) this.finish(label, "incomplete", "end_of_corpus");
    return { policy: this.policy, invalidRecords: this.invalidRecords, sweeps: this.results };
  }
}
