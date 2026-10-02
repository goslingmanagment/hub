import { FanslyApiError } from "@agency_hub_core/fansly";

import { FanslyPurchaseHistoryContractError } from "./errors.ts";
import { classifyFanslyResponse } from "./fansly-lane.ts";

type JsonRecord = Record<string, unknown>;

export type FanslyPurchaseHistoryTarget = {
  kind: "single" | "bundle";
  contentId: string;
};

export type FanslyPurchaseHistoryPendingTarget = FanslyPurchaseHistoryTarget & {
  /** Opaque order id passed back to Fansly as `before`. Null is page one. */
  before: string | null;
  /**
   * A rejected target re-queued ONCE after a rejection storm turned out to be
   * a repaired contract (Decision 358). Checkpoint reconciliation keeps a retry
   * even though its chain reads complete; a second rejection settles it.
   */
  retry?: true;
};

export type FanslyPurchaseHistoryCursorStateV2 = {
  version: 2;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryTarget[];
};

export type FanslyPurchaseHistoryCursorStateV3 = {
  version: 3;
  transactionCursorId: number;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryTarget[];
};

export type FanslyPurchaseHistoryCursorStateV4 = {
  version: 4;
  transactionCursorId: number;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryPendingTarget[];
};

export type FanslyPurchaseHistoryCursorStateV5 = {
  version: 5;
  transactionCursorId: number;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryPendingTarget[];
  utcDay: string;
  callsToday: number;
};

/**
 * Older cursor shapes remain readable so a deploy can resume in-flight work.
 * Parsed state is always normalized to v5: v4's per-target provider cursor,
 * plus the durable UTC-day attempt allowance shared by the other lanes. The
 * rejection streak (Decision 358) is deliberately NOT cursor state: it is
 * derived from the captures themselves, so a crash between a journaled
 * rejection and the checkpoint write cannot lose it.
 */
export type FanslyPurchaseHistoryCursorState =
  | FanslyPurchaseHistoryCursorStateV2
  | FanslyPurchaseHistoryCursorStateV3
  | FanslyPurchaseHistoryCursorStateV4
  | FanslyPurchaseHistoryCursorStateV5;

export type FanslyMessagePurchaseTargetSource = {
  rawType: string | number;
  correlationId: string | null;
};

export const FANSLY_PURCHASE_HISTORY_RESULT_LIMIT = 100;
export const FANSLY_PURCHASE_HISTORY_DAILY_ATTEMPT_CAP = 100;

/**
 * How many consecutive target-local rejections, PER REQUEST NAMESPACE (single
 * media vs bundle — different query parameters, so a break in one says
 * nothing about the other), the walk consumes on the provider's word alone.
 * At this streak the request contract must be proven against a target this
 * page already walked to completion and the provider actually served (the
 * "witness") before another target of that namespace is spent: a
 * request-shape break would otherwise be indistinguishable from a run of
 * deleted media and would walk the whole queue marking every target terminal,
 * quietly, at the daily cap's pace.
 */
export const FANSLY_PURCHASE_HISTORY_REJECTION_PROOF_THRESHOLD = 3;

/**
 * Witnesses tried per proof, most recently captured first. A witness the
 * creator has since deleted answers with a DIFFERENT status than the streak
 * (404 against a 422 streak) and is skipped, not counted — the provider
 * telling entities apart is evidence the contract works — so the pool has to
 * be wide enough to reach past a few deletions.
 */
export const FANSLY_PURCHASE_HISTORY_PROOF_WITNESS_LIMIT = 5;

/**
 * The proof's own journal endpoint (and therefore its `observations.kind`,
 * registered in services/observation-kinds.ts and canonicalized by the same
 * family as `purchase_history`: a witness page carries real order rows). A
 * witness page one is re-asked for at `before: null`; journaling it as a
 * `purchase_history` capture would fork that target's completed chain (a newer
 * page one with new orders reads as `cursor_conflict`) and block every later
 * run before egress. Kept apart, the proof is still captured verbatim, its
 * facts still canonicalize, and it never enters a chain.
 */
export const FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE = {
  endpoint: "purchase_history_contract_probe",
} as const;
export const FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT =
  FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE.endpoint;

/**
 * The storm's own verdict, journaled BEFORE the stream is blocked (raw-only
 * `observations.kind`, registered in services/observation-kinds.ts). Provider
 * answers alone cannot prove that a storm was raised and then lifted by the
 * owner: a run that died after its last witness voted — a crash, a failed
 * observation insert — is retried by the executor with no block and no
 * unblock in between, and would otherwise read as one. The evidence target
 * an unblock buys is granted only after this verdict, and a rejection after
 * it restarts the proof, so the next storm needs a verdict of its own.
 */
export const FANSLY_PURCHASE_HISTORY_CONTRACT_STORM = {
  endpoint: "purchase_history_contract_storm",
} as const;
export const FANSLY_PURCHASE_HISTORY_CONTRACT_STORM_ENDPOINT =
  FANSLY_PURCHASE_HISTORY_CONTRACT_STORM.endpoint;

export type FanslyPurchaseHistoryStormVerdict = {
  id: number;
  kind: FanslyPurchaseHistoryTarget["kind"];
  /** The run that declared it — the one whose block record vouches for it. */
  syncRunId: number | null;
};

export type FanslyPurchaseHistoryTargetRejection = {
  status: number;
  code: number | null;
  /** Fansly's `error.details` (or `error.message`) when the body parses; else null. */
  details: string | null;
  /** The redacted body prefix the adapter retained, verbatim. */
  body: string | null;
};

function fanslyErrorDetailsFromSnippet(snippet: string | null): string | null {
  if (snippet === null) {
    return null;
  }
  try {
    const envelope = asRecord(JSON.parse(snippet));
    const error = asRecord(envelope?.error);
    return asString(error?.details) ?? asString(error?.message);
  } catch {
    return null;
  }
}

/**
 * A provider HTTP answer for one media target, or null when the failure is not
 * an HTTP answer at all (transport, proxy refusal, budget). Whether that answer
 * is a fact about the TARGET or about the request contract is decided by
 * `classifyFanslyPurchaseHistoryCapture` on the durable payload this builds —
 * one rule for the live rejection and for every replay of it.
 */
export function fanslyPurchaseHistoryTargetRejection(
  error: unknown,
): FanslyPurchaseHistoryTargetRejection | null {
  if (!(error instanceof FanslyApiError) || typeof error.status !== "number") {
    return null;
  }
  const body = typeof error.responseSnippet === "string" && error.responseSnippet.length > 0
    ? error.responseSnippet
    : null;
  return {
    status: error.status,
    code: typeof error.code === "number" ? error.code : null,
    details: fanslyErrorDetailsFromSnippet(body),
    body,
  };
}

export function rejectedFanslyPurchaseHistoryPayload(
  rejection: FanslyPurchaseHistoryTargetRejection,
) {
  return {
    error: {
      status: rejection.status,
      code: rejection.code,
      details: rejection.details,
      body: rejection.body,
    },
  };
}

export type FanslyPurchaseHistoryCapture = {
  id: number | null;
  targetKey: string;
  /** The cursor used for this captured page. Null identifies page one. */
  requestBefore: string | null;
  statusCode: number | null;
  responsePayload: unknown;
};

export type FanslyPurchaseHistoryCaptureClassification =
  & FanslyPurchaseHistoryCapture
  & {
    contentId: string;
    captured: true;
    validatedPage: boolean;
    terminal: boolean;
    blocked: boolean;
    orderRows: number | null;
    nextBefore: string | null;
    outcome:
      | "continuation"
      | "terminal_empty"
      | "terminal_missing"
      | "terminal_rejected"
      | "contract_rejected"
      | "cursor_missing"
      | "cursor_repeated"
      | "cursor_conflict"
      | "http_rejected";
  };

export type FanslyPurchaseHistoryTargetChain = {
  target: FanslyPurchaseHistoryTarget;
  targetKey: string;
  firstCaptureId: number | null;
  /** The newest capture of this target, walked or not: its place in time. */
  lastCaptureId: number | null;
  /**
   * The status that newest capture carried (null: a served body). A target's
   * standing is its LAST answer: a chain served on page one and rejected on a
   * continuation is a rejection now, and a member of its namespace's streak.
   */
  lastStatusCode: number | null;
  /** The cursor that newest capture was asked at (null: page one). */
  lastRequestBefore: string | null;
  /** The newest capture the provider SERVED (a well-formed 2xx page). */
  lastServedCaptureId: number | null;
  /** How many times the provider rejected this target at that same cursor. */
  rejectionsAtLastCursor: number;
  orderRows: number;
  requestCursors: Array<string | null>;
  status: "complete" | "resumable" | "blocked";
  nextBefore: string | null;
  blockedCapture: FanslyPurchaseHistoryCaptureClassification | null;
  /** The provider served at least one page of this chain. */
  served: boolean;
};

/** A witness page the contract proof journaled under its own endpoint. */
export type FanslyPurchaseHistoryProbeOutcome = {
  id: number;
  kind: FanslyPurchaseHistoryTarget["kind"];
  targetKey: string;
  statusCode: number | null;
  /** A well-formed 2xx page: the provider served the namespace. */
  served: boolean;
  outcome: FanslyPurchaseHistoryCaptureClassification["outcome"];
};

export type FanslyPurchaseHistoryStreakMember = {
  target: FanslyPurchaseHistoryTarget;
  targetKey: string;
  /** The cursor the rejection was asked at — where a retry resumes. */
  before: string | null;
  status: number;
  /** Newest capture of the member; null for a rejection made in this run. */
  lastCaptureId: number | null;
};

export type FanslyPurchaseHistoryRetry = {
  target: FanslyPurchaseHistoryTarget;
  targetKey: string;
  before: string | null;
};

/**
 * One request namespace's EPOCH: everything since the provider last served
 * it — a served target page or a served witness, whichever is newer. The
 * rejections in it are the streak; the witnesses probed since the newest
 * rejection are the proof attempt in progress (a rejection restarts it).
 */
export type FanslyPurchaseHistoryRejectionStreak = {
  count: number;
  /** Every HTTP status the members carry; a witness rejected with any of them is a storm vote. */
  statuses: number[];
  /** Oldest first. */
  members: FanslyPurchaseHistoryStreakMember[];
  /** Witnesses probed since the newest rejection, served or not. */
  probedWitnessKeys: string[];
  /** Storm votes among them: rejected with a member's status, or a malformed body. */
  votes: number;
  /** The witnesses that cast those votes — what a storm names. */
  votedWitnessKeys: string[];
  /**
   * A storm vote was cast somewhere in this epoch — it survives the evidence
   * rejection that restarts the proof attempt. A served answer that closes an
   * epoch with this set is a REPAIR, and the epoch's members are then owed
   * one retry each.
   */
  stormVoted: boolean;
  /**
   * The lane journaled a storm verdict after the newest rejection. Whether
   * the executor then BLOCKED on it is that run's record to give
   * (`stormVerdictRunId`); with both, this run exists because the owner
   * lifted the block, which buys exactly one target of fresh evidence. A
   * rejection clears this.
   */
  stormDeclared: boolean;
  stormVerdictRunId: number | null;
  /**
   * Members of past epochs that a storm closed and a served answer then
   * repaired, still rejected exactly once at their cursor: owed one retry,
   * at that cursor. Served or rejected a second time, a retry is settled.
   */
  owedRetries: FanslyPurchaseHistoryRetry[];
};

export type FanslyPurchaseHistoryRejectionStreaks = Record<
  FanslyPurchaseHistoryTarget["kind"],
  FanslyPurchaseHistoryRejectionStreak
>;

export type FanslyPurchaseHistoryCaptureIndex = {
  captures: FanslyPurchaseHistoryCaptureClassification[];
  capturedTargetKeys: string[];
  capturedContentIds: string[];
  validatedCompleteTargetKeys: string[];
  validatedCompleteContentIds: string[];
  resumableTargets: FanslyPurchaseHistoryPendingTarget[];
  chains: FanslyPurchaseHistoryTargetChain[];
  blocked: FanslyPurchaseHistoryCaptureClassification[];
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const record = asRecord(item);
      return record ? [record] : [];
    })
    : [];
}

function hasPpvPermission(item: JsonRecord) {
  const permissions = asRecord(item.permissions);
  return records(permissions?.permissionFlags).some((permission) => {
    const flags = asNumber(permission.flags) ?? 0;
    return (flags & 1) === 1;
  });
}

export function fanslyPurchaseHistoryTargetKey(target: FanslyPurchaseHistoryTarget) {
  return `${target.kind}:${target.contentId}`;
}

function purchaseHistoryTargetFromTargetKey(
  targetKey: string,
): FanslyPurchaseHistoryTarget | null {
  if (targetKey.startsWith("single:") && targetKey.length > "single:".length) {
    return {
      kind: "single",
      contentId: targetKey.slice("single:".length),
    };
  }
  if (targetKey.startsWith("bundle:") && targetKey.length > "bundle:".length) {
    return {
      kind: "bundle",
      contentId: targetKey.slice("bundle:".length),
    };
  }
  return null;
}

/**
 * Extends the transaction-batch contract check across checkpoint/capture and
 * source boundaries. A content id is global, so observing it in both request
 * namespaces is ambiguous regardless of which chunk found each occurrence.
 */
export function assertFanslyPurchaseHistoryTargetKindsConsistent(
  targets: readonly FanslyPurchaseHistoryTarget[],
  knownTargetKeys: Iterable<string> = [],
) {
  const knownKinds = new Map<
    string,
    Set<FanslyPurchaseHistoryTarget["kind"]>
  >();
  for (const targetKey of knownTargetKeys) {
    const target = purchaseHistoryTargetFromTargetKey(targetKey);
    if (!target) {
      continue;
    }
    const kinds = knownKinds.get(target.contentId) ?? new Set();
    kinds.add(target.kind);
    knownKinds.set(target.contentId, kinds);
  }

  const observedKinds = new Map<string, FanslyPurchaseHistoryTarget["kind"]>();
  const record = (target: FanslyPurchaseHistoryTarget) => {
    const existingKind = observedKinds.get(target.contentId);
    if (existingKind && existingKind !== target.kind) {
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_target_kind_conflict",
        message:
          `Fansly content ${target.contentId} appeared as both ${existingKind} and ${target.kind}; refusing to guess the order-history parameter`,
      });
    }
    const capturedKinds = knownKinds.get(target.contentId);
    if (
      capturedKinds &&
      capturedKinds.size === 1 &&
      !capturedKinds.has(target.kind)
    ) {
      const [capturedKind] = capturedKinds;
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_target_kind_conflict",
        message:
          `Fansly content ${target.contentId} appeared as both ${capturedKind} and ${target.kind}; refusing to guess the order-history parameter`,
      });
    }
    observedKinds.set(target.contentId, target.kind);
  };

  for (const target of targets) {
    record(target);
  }
}

function purchaseHistoryTargetKindFromRawType(
  rawType: string | number,
): FanslyPurchaseHistoryTarget["kind"] | null {
  switch (String(rawType)) {
    case "2010":
    case "2110":
      return "single";
    case "2016":
    case "2116":
      return "bundle";
    default:
      return null;
  }
}

/**
 * Converts already-captured Fansly money facts into media-scoped discovery
 * targets. Duplicate sales of the same content collapse to one GET. The same
 * content id appearing in both media namespaces is contract drift: choosing a
 * request parameter would be a guess, so fail closed before provider egress.
 */
export function extractFanslyPurchaseHistoryTargetsFromTransactions(
  rows: readonly FanslyMessagePurchaseTargetSource[],
): FanslyPurchaseHistoryTarget[] {
  const targets = new Map<string, FanslyPurchaseHistoryTarget>();

  for (const row of rows) {
    const kind = purchaseHistoryTargetKindFromRawType(row.rawType);
    const contentId = typeof row.correlationId === "string"
      ? row.correlationId.trim()
      : "";
    if (!kind || !contentId) {
      continue;
    }

    const existing = targets.get(contentId);
    if (existing && existing.kind !== kind) {
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_target_kind_conflict",
        message:
          `Fansly content ${contentId} appeared as both ${existing.kind} and ${kind}; refusing to guess the order-history parameter`,
      });
    }
    if (!existing) {
      targets.set(contentId, { kind, contentId });
    }
  }

  return [...targets.values()];
}

function purchaseHistoryContentIdFromTargetKey(targetKey: string) {
  const separator = targetKey.indexOf(":");
  return separator >= 0 ? targetKey.slice(separator + 1) : targetKey;
}

/**
 * Finds PPV content ids from a captured Fansly /message page. The endpoint
 * contract is media-scoped: accountMediaId/accountMediaBundleId is required;
 * accountIds is only an optional buyer filter. We therefore walk observed PPV
 * media, never the cartesian product of every fan and every media item.
 */
export function extractFanslyPurchaseHistoryTargets(
  payloads: readonly unknown[],
): FanslyPurchaseHistoryTarget[] {
  // Fansly content ids are global, but historical DM payloads can describe a
  // bundle order through `accountMediaId` while the attachment and metadata
  // correctly identify the same id as a bundle. Keep one target per content
  // id and let concrete attachment/metadata evidence override the weaker
  // inline-order inference. Otherwise the same bundle is fetched once
  // correctly and then again as a single media item, which Fansly rejects.
  const targets = new Map<
    string,
    { target: FanslyPurchaseHistoryTarget; evidencePriority: number }
  >();
  const recordTarget = (
    target: FanslyPurchaseHistoryTarget,
    evidencePriority: number,
  ) => {
    const current = targets.get(target.contentId);
    if (!current || evidencePriority > current.evidencePriority) {
      targets.set(target.contentId, { target, evidencePriority });
    }
  };

  for (const payloadValue of payloads) {
    const payload = asRecord(payloadValue);
    if (!payload) {
      continue;
    }

    const mediaById = new Map(
      records(payload.accountMedia)
        .flatMap((item) => {
          const id = asString(item.id);
          return id ? [[id, item] as const] : [];
        }),
    );
    const bundlesById = new Map(
      records(payload.accountMediaBundles)
        .flatMap((item) => {
          const id = asString(item.id);
          return id ? [[id, item] as const] : [];
        }),
    );

    // An inline order is itself definitive evidence that the media target is
    // valid, even when the corresponding attachment/metadata was trimmed from
    // this particular DM page. Fetching that media recovers its other buyers.
    for (const order of records(payload.accountMediaOrders)) {
      const bundleId = asString(order.accountMediaBundleId);
      const mediaId = asString(order.accountMediaId);
      const target = bundleId
        ? { kind: "bundle" as const, contentId: bundleId }
        : mediaId
          ? {
            kind: bundlesById.has(mediaId) && !mediaById.has(mediaId)
              ? "bundle" as const
              : "single" as const,
            contentId: mediaId,
          }
          : null;
      if (target) {
        recordTarget(target, bundleId ? 3 : 1);
      }
    }

    for (const message of records(payload.messages)) {
      for (const attachment of records(message.attachments)) {
        const contentId = asString(attachment.contentId);
        if (!contentId) {
          continue;
        }

        const contentType = asNumber(attachment.contentType);
        const candidate = (() => {
          if (contentType === 1) {
            return mediaById.has(contentId)
              ? { kind: "single" as const, item: mediaById.get(contentId)! }
              : null;
          }
          if (contentType === 2) {
            return bundlesById.has(contentId)
              ? { kind: "bundle" as const, item: bundlesById.get(contentId)! }
              : null;
          }

          // Older payloads occasionally omit contentType. Resolve only when
          // the id exists in exactly one captured metadata map.
          const media = mediaById.get(contentId);
          const bundle = bundlesById.get(contentId);
          if (media && !bundle) {
            return { kind: "single" as const, item: media };
          }
          if (bundle && !media) {
            return { kind: "bundle" as const, item: bundle };
          }
          return null;
        })();

        if (!candidate || !hasPpvPermission(candidate.item)) {
          continue;
        }

        const target = { kind: candidate.kind, contentId };
        recordTarget(target, 2);
      }
    }
  }

  return [...targets.values()].map(({ target }) => target).sort((left, right) =>
    fanslyPurchaseHistoryTargetKey(left).localeCompare(
      fanslyPurchaseHistoryTargetKey(right),
      "en",
      { numeric: true },
    ));
}

export function parseFanslyPurchaseHistoryCursorState(
  value: unknown,
  now = new Date(),
): FanslyPurchaseHistoryCursorStateV5 | null {
  const state = asRecord(value);
  const version = asNumber(state?.version);
  if (version !== 2 && version !== 3 && version !== 4 && version !== 5) {
    return null;
  }
  const rawPayloadCursorId = asNumber(state?.rawPayloadCursorId);
  if (
    rawPayloadCursorId === null ||
    !Number.isSafeInteger(rawPayloadCursorId) ||
    rawPayloadCursorId < 0
  ) {
    return null;
  }
  const transactionCursorId = version === 2
    ? 0
    : asNumber(state?.transactionCursorId);
  if (
    transactionCursorId === null ||
    !Number.isSafeInteger(transactionCursorId) ||
    transactionCursorId < 0
  ) {
    return null;
  }

  const rawPendingTargets = state?.pendingTargets;
  if (!Array.isArray(rawPendingTargets)) {
    return null;
  }
  const pendingTargets = rawPendingTargets.flatMap<FanslyPurchaseHistoryPendingTarget>((item) => {
      const target = asRecord(item);
      const kind = target?.kind;
      const contentId = asString(target?.contentId);
      const rawBefore = version === 4 || version === 5 ? target?.before : null;
      const before = rawBefore === null ? null : asString(rawBefore);
      return (kind === "single" || kind === "bundle") && contentId &&
          (rawBefore === null || before !== null)
        ? [{ kind, contentId, before, ...(target?.retry === true ? { retry: true as const } : {}) }]
        : [];
    });
  if (pendingTargets.length !== rawPendingTargets.length) {
    return null;
  }
  if (
    new Set(pendingTargets.map(fanslyPurchaseHistoryTargetKey)).size !==
      pendingTargets.length
  ) {
    return null;
  }

  return {
    version: 5,
    transactionCursorId,
    rawPayloadCursorId,
    pendingTargets,
    utcDay: typeof state?.utcDay === "string"
      ? state.utcDay
      : now.toISOString().slice(0, 10),
    callsToday: Math.max(0, asNumber(state?.callsToday) ?? 0),
  };
}

function isRejectionOutcome(outcome: FanslyPurchaseHistoryCaptureClassification["outcome"]) {
  return outcome === "terminal_missing" || outcome === "terminal_rejected";
}

/** A 2xx body. The success journal path leaves the column null; a writer that
 *  records the literal 200 one day must not turn every served page into a
 *  rejection. */
export function isServedStatus(statusCode: number | null) {
  return statusCode === null || (statusCode >= 200 && statusCode < 300);
}

function fanslyPurchaseHistoryRows(payloadValue: unknown): unknown[] | null {
  const payload = asRecord(payloadValue);
  if (!payload) {
    return null;
  }
  if (Array.isArray(payload.accountMediaOrderHistory)) {
    return payload.accountMediaOrderHistory;
  }
  if (Array.isArray(payload.accountMediaOrders)) {
    return payload.accountMediaOrders;
  }
  const aggregation = asRecord(payload.aggregationData);
  if (Array.isArray(aggregation?.accountMediaOrders)) {
    return aggregation.accountMediaOrders;
  }
  return null;
}

export function classifyFanslyPurchaseHistoryResponse(payloadValue: unknown) {
  return classifyFanslyResponse(payloadValue, {
    isValid: (value) => {
      const rows = fanslyPurchaseHistoryRows(value);
      return rows !== null && rows.every((row) => asRecord(row) !== null);
    },
    isEmpty: (value) => fanslyPurchaseHistoryRows(value)?.length === 0,
  });
}

export function countFanslyPurchaseHistoryRows(payloadValue: unknown): number | null {
  return fanslyPurchaseHistoryRows(payloadValue)?.length ?? null;
}

/** The order rows of a purchase-history body (objects only); null when the
 *  body holds no order array (a refusal, a malformed page). */
export function fanslyPurchaseHistoryOrderRows(payloadValue: unknown): JsonRecord[] | null {
  const rows = fanslyPurchaseHistoryRows(payloadValue);
  return rows === null ? null : records(rows);
}

/**
 * Classifies a captured target entirely from its durable status and raw body.
 * The function deliberately has no checkpoint or provider dependency so a
 * parser repair can reclassify historical captures without another request.
 */
export function classifyFanslyPurchaseHistoryCapture(
  capture: FanslyPurchaseHistoryCapture,
): FanslyPurchaseHistoryCaptureClassification {
  const contentId = purchaseHistoryContentIdFromTargetKey(capture.targetKey);
  if (capture.statusCode === 404 || capture.statusCode === 410) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: true,
      terminal: true,
      blocked: false,
      orderRows: 0,
      nextBefore: null,
      outcome: "terminal_missing",
    };
  }
  // 422 is Fansly's "I understood the request but cannot serve THIS entity":
  // `{"error":{"code":99,"details":"error getting account media"}}` for a
  // media the account no longer holds (production, ari-1, 2026-09-02: one such
  // media parked the whole stream for two weeks). Code 99 is Fansly's generic
  // code and carries no signal on its own — the same 99 under HTTP 400 is the
  // bare-probe / parameter-drift shape ("missing accountMediaId"), which is a
  // fact about the request contract and stays a stream-level blocker below.
  // The status carries the distinction; the body is kept verbatim so a later
  // reading can refine it without another request.
  if (capture.statusCode === 422) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: true,
      terminal: true,
      blocked: false,
      orderRows: 0,
      nextBefore: null,
      outcome: "terminal_rejected",
    };
  }

  if (
    capture.statusCode !== null &&
    (capture.statusCode < 200 || capture.statusCode >= 300)
  ) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: null,
      nextBefore: null,
      outcome: "http_rejected",
    };
  }

  const rawRows = fanslyPurchaseHistoryRows(capture.responsePayload);
  if (
    classifyFanslyPurchaseHistoryResponse(capture.responsePayload) === "invalid"
    || rawRows === null
  ) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: null,
      nextBefore: null,
      outcome: "contract_rejected",
    };
  }
  if (rawRows.length === 0) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: true,
      terminal: true,
      blocked: false,
      orderRows: 0,
      nextBefore: null,
      outcome: "terminal_empty",
    };
  }

  // FBuddy's executable client walks to an EMPTY page, even after a short
  // page. The opaque cursor is the last row's orderId; row count is not proof
  // of exhaustion.
  const lastRow = asRecord(rawRows.at(-1))!;
  const nextBefore = asString(lastRow.orderId);
  if (!nextBefore) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: rawRows.length,
      nextBefore: null,
      outcome: "cursor_missing",
    };
  }
  if (nextBefore === capture.requestBefore) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: rawRows.length,
      nextBefore,
      outcome: "cursor_repeated",
    };
  }

  return {
    ...capture,
    contentId,
    captured: true,
    validatedPage: true,
    terminal: false,
    blocked: false,
    orderRows: rawRows.length,
    nextBefore,
    outcome: "continuation",
  };
}

function blockedChainCapture(
  capture: FanslyPurchaseHistoryCaptureClassification,
  outcome: "cursor_repeated" | "cursor_conflict",
): FanslyPurchaseHistoryCaptureClassification {
  return {
    ...capture,
    validatedPage: false,
    terminal: false,
    blocked: true,
    outcome,
  };
}

function resolveFanslyPurchaseHistoryTargetChain(
  targetKey: string,
  captures: readonly FanslyPurchaseHistoryCaptureClassification[],
): FanslyPurchaseHistoryTargetChain {
  const target = purchaseHistoryTargetFromTargetKey(targetKey);
  if (!target) {
    throw new Error(`Invalid Fansly purchase-history target key ${targetKey}`);
  }
  const sorted = [...captures].sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
  const newest = sorted.at(-1);
  const meta = {
    target,
    targetKey,
    firstCaptureId: sorted[0]?.id ?? null,
    lastCaptureId: newest?.id ?? null,
    lastStatusCode: newest?.statusCode ?? null,
    lastRequestBefore: newest?.requestBefore ?? null,
    lastServedCaptureId: sorted
      .filter((capture) => !capture.blocked && isServedStatus(capture.statusCode))
      .reduce<number | null>((max, capture) => Math.max(max ?? -1, capture.id ?? -1), null),
    rejectionsAtLastCursor: sorted.filter((capture) =>
      isRejectionOutcome(capture.outcome)
      && (capture.requestBefore ?? "") === (newest?.requestBefore ?? "")
    ).length,
  };
  const byCursor = new Map<string, FanslyPurchaseHistoryCaptureClassification[]>();
  for (const capture of sorted) {
    const key = capture.requestBefore ?? "";
    const pages = byCursor.get(key) ?? [];
    pages.push(capture);
    byCursor.set(key, pages);
  }

  const visited = new Set<string>();
  let before: string | null = null;
  let orderRows = 0;
  let served = false;
  for (;;) {
    const cursorKey = before ?? "";
    const pages = byCursor.get(cursorKey);
    if (!pages || pages.length === 0) {
      return {
        ...meta,
        orderRows,
        served,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "resumable",
        nextBefore: before,
        blockedCapture: null,
      };
    }

    // A later SERVED answer to the same question supersedes a rejection of
    // it: a retried target (Decision 358) that the repaired provider now
    // serves must not read as a fork between "gone" and "here are the rows".
    const unblockedPages = pages.filter((page) => !page.blocked);
    const servedPages = unblockedPages.filter((page) => isServedStatus(page.statusCode));
    const validPages = servedPages.length > 0 ? servedPages : unblockedPages;
    if (validPages.length === 0) {
      return {
        ...meta,
        orderRows,
        served,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "blocked",
        nextBefore: before,
        blockedCapture: pages.at(-1)!,
      };
    }

    const semanticResults = new Set(validPages.map((page) =>
      page.terminal ? "terminal" : `next:${page.nextBefore ?? ""}`
    ));
    if (semanticResults.size > 1) {
      return {
        ...meta,
        orderRows,
        served,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "blocked",
        nextBefore: before,
        blockedCapture: blockedChainCapture(validPages.at(-1)!, "cursor_conflict"),
      };
    }

    const page = validPages.at(-1)!;
    orderRows += page.orderRows ?? 0;
    served = served || isServedStatus(page.statusCode);
    visited.add(cursorKey);
    if (page.terminal) {
      return {
        ...meta,
        orderRows,
        served,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "complete",
        nextBefore: null,
        blockedCapture: null,
      };
    }

    const nextBefore = page.nextBefore!;
    if (visited.has(nextBefore)) {
      return {
        ...meta,
        orderRows,
        served,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "blocked",
        nextBefore,
        blockedCapture: blockedChainCapture(page, "cursor_repeated"),
      };
    }
    before = nextBefore;
  }
}

/**
 * Builds a contiguous page chain from `before=null` for every target. A target
 * is complete only when that chain reaches an empty or terminal-missing page;
 * otherwise it either exposes the next missing cursor or a durable blocker.
 */
export function classifyFanslyPurchaseHistoryCaptures(
  captures: readonly FanslyPurchaseHistoryCapture[],
): FanslyPurchaseHistoryCaptureIndex {
  const classified = captures.map(classifyFanslyPurchaseHistoryCapture);
  const capturedTargetKeys = new Set<string>();
  const capturedContentIds = new Set<string>();
  const validatedCompleteTargetKeys = new Set<string>();
  const validatedCompleteContentIds = new Set<string>();

  const capturesByTargetKey = new Map<string, FanslyPurchaseHistoryCaptureClassification[]>();
  for (const capture of classified) {
    capturedTargetKeys.add(capture.targetKey);
    capturedContentIds.add(capture.contentId);
    const targetCaptures = capturesByTargetKey.get(capture.targetKey) ?? [];
    targetCaptures.push(capture);
    capturesByTargetKey.set(capture.targetKey, targetCaptures);
  }

  const chains = [...capturesByTargetKey.entries()]
    .map(([targetKey, targetCaptures]) =>
      resolveFanslyPurchaseHistoryTargetChain(targetKey, targetCaptures)
    )
    .sort((left, right) =>
      (left.firstCaptureId ?? Number.MAX_SAFE_INTEGER) -
        (right.firstCaptureId ?? Number.MAX_SAFE_INTEGER)
    );

  // One Fansly content id cannot validly occupy both request namespaces. This
  // is contract drift even when the conflicting captures arrived in separate
  // runs, so turn every affected chain into a local blocker.
  const targetKeysByContentId = new Map<string, string[]>();
  for (const chain of chains) {
    const keys = targetKeysByContentId.get(chain.target.contentId) ?? [];
    keys.push(chain.targetKey);
    targetKeysByContentId.set(chain.target.contentId, keys);
  }
  for (const [contentId, targetKeys] of targetKeysByContentId) {
    if (targetKeys.length < 2) {
      continue;
    }
    for (const targetKey of targetKeys) {
      const chain = chains.find((candidate) => candidate.targetKey === targetKey)!;
      const representative = capturesByTargetKey.get(targetKey)!.at(-1)!;
      chain.status = "blocked";
      chain.nextBefore = null;
      chain.blockedCapture = blockedChainCapture(
        {
          ...representative,
          contentId,
        },
        "cursor_conflict",
      );
    }
  }

  for (const chain of chains) {
    if (chain.status === "complete") {
      validatedCompleteTargetKeys.add(chain.targetKey);
      validatedCompleteContentIds.add(chain.target.contentId);
    }
  }

  const blocked = chains.flatMap((chain) =>
    chain.status === "blocked" && chain.blockedCapture
      ? [chain.blockedCapture]
      : []
  );
  const resumableTargets = chains.flatMap<FanslyPurchaseHistoryPendingTarget>((chain) =>
    chain.status === "resumable"
      ? [{ ...chain.target, before: chain.nextBefore }]
      : []
  );

  return {
    captures: classified,
    capturedTargetKeys: [...capturedTargetKeys],
    capturedContentIds: [...capturedContentIds],
    validatedCompleteTargetKeys: [...validatedCompleteTargetKeys],
    validatedCompleteContentIds: [...validatedCompleteContentIds],
    resumableTargets,
    chains,
    blocked,
  };
}

/**
 * Reads a witness page the contract proof journaled. Served means a
 * well-formed 2xx body — a malformed "success" proves nothing and counts as a
 * failed proof, exactly as it would block an ordinary target.
 */
export function classifyFanslyPurchaseHistoryProbe(
  capture: FanslyPurchaseHistoryCapture & { id: number },
): FanslyPurchaseHistoryProbeOutcome | null {
  const target = purchaseHistoryTargetFromTargetKey(capture.targetKey);
  if (!target) {
    return null;
  }
  const classified = classifyFanslyPurchaseHistoryCapture(capture);
  return {
    id: capture.id,
    kind: target.kind,
    targetKey: capture.targetKey,
    statusCode: capture.statusCode,
    served: isServedStatus(capture.statusCode) && !classified.blocked,
    outcome: classified.outcome,
  };
}

/**
 * Each request namespace's epoch, read off the captures (Decision 358).
 * Nothing here is checkpoint state: a rejection journaled a millisecond
 * before a crash still counts, a proof cut short by the chunk budget resumes
 * where it stopped, a repair that crashed before its checkpoint still owes
 * its retries, and a cursor from before the decision needs no migration.
 *
 * The timeline of one namespace is every served page, every rejected page
 * and every witness page, by capture id. A served answer (page or witness)
 * closes the epoch; between two of them the rejected targets are the streak,
 * each counted by its NEWEST answer (a chain served on page one and rejected
 * on a continuation is a rejection), and the witnesses probed after the
 * newest rejection are the proof attempt in progress. A storm vote — a
 * witness rejected with a member's status, or answering a malformed body —
 * marks the epoch; the served answer that then closes it is a repair, and the
 * epoch's members still rejected once at their cursor are owed one retry.
 */
export function deriveFanslyPurchaseHistoryRejectionStreaks(
  index: Pick<FanslyPurchaseHistoryCaptureIndex, "captures" | "chains">,
  probes: readonly FanslyPurchaseHistoryProbeOutcome[],
  storms: readonly FanslyPurchaseHistoryStormVerdict[] = [],
): FanslyPurchaseHistoryRejectionStreaks {
  const chainByKey = new Map(index.chains.map((chain) => [chain.targetKey, chain]));
  type TimelineEvent = {
    id: number;
    at: "served" | "rejected" | "probe" | "storm";
    target: FanslyPurchaseHistoryTarget;
    targetKey: string;
    statusCode: number | null;
    requestBefore: string | null;
    probeServed: boolean;
    syncRunId: number | null;
  };
  const forKind = (
    kind: FanslyPurchaseHistoryTarget["kind"],
  ): FanslyPurchaseHistoryRejectionStreak => {
    const events: TimelineEvent[] = [];
    for (const capture of index.captures) {
      const target = purchaseHistoryTargetFromTargetKey(capture.targetKey);
      if (capture.id === null || !target || target.kind !== kind || capture.blocked) {
        // A blocked page is neither answer; the run blocks on it before egress.
        continue;
      }
      if (isRejectionOutcome(capture.outcome)) {
        events.push({
          id: capture.id,
          at: "rejected",
          target,
          targetKey: capture.targetKey,
          statusCode: capture.statusCode,
          requestBefore: capture.requestBefore,
          probeServed: false,
          syncRunId: null,
        });
      } else if (isServedStatus(capture.statusCode)) {
        events.push({
          id: capture.id,
          at: "served",
          target,
          targetKey: capture.targetKey,
          statusCode: null,
          requestBefore: capture.requestBefore,
          probeServed: false,
          syncRunId: null,
        });
      }
    }
    for (const probe of probes) {
      const target = purchaseHistoryTargetFromTargetKey(probe.targetKey);
      if (!target || probe.kind !== kind) {
        continue;
      }
      events.push({
        id: probe.id,
        at: "probe",
        target,
        targetKey: probe.targetKey,
        statusCode: probe.statusCode,
        requestBefore: null,
        probeServed: probe.served,
        syncRunId: null,
      });
    }
    for (const storm of storms) {
      if (storm.kind !== kind) {
        continue;
      }
      events.push({
        id: storm.id,
        at: "storm",
        target: { kind, contentId: "" },
        targetKey: "",
        statusCode: null,
        requestBefore: null,
        probeServed: false,
        syncRunId: storm.syncRunId,
      });
    }
    events.sort((left, right) => left.id - right.id);

    // Insertion order is age order: a repeat rejection re-inserts as newest.
    let members = new Map<string, FanslyPurchaseHistoryStreakMember>();
    let probed = new Set<string>();
    let voted = new Set<string>();
    let votes = 0;
    let stormVoted = false;
    let stormDeclared = false;
    let stormVerdictRunId: number | null = null;
    // Rebuilt, never `.delete`d: the retention ratchet reads this file too.
    let owed = new Map<string, FanslyPurchaseHistoryRetry>();
    const stillOwed = (targetKey: string) => {
      const chain = chainByKey.get(targetKey);
      // Complete, not resumable: a walk that stands elsewhere than the
      // rejection re-asks its own cursor anyway; a retry would only duplicate
      // the pending key.
      return chain !== undefined
        && chain.status === "complete"
        && !isServedStatus(chain.lastStatusCode)
        && chain.rejectionsAtLastCursor === 1;
    };
    const closeEpoch = () => {
      if (stormVoted) {
        for (const member of members.values()) {
          const chain = chainByKey.get(member.targetKey);
          if (chain && stillOwed(member.targetKey)) {
            owed.set(member.targetKey, {
              target: member.target,
              targetKey: member.targetKey,
              before: chain.lastRequestBefore,
            });
          }
        }
      }
      members = new Map();
      probed = new Set();
      voted = new Set();
      votes = 0;
      stormVoted = false;
      stormDeclared = false;
      stormVerdictRunId = null;
    };
    for (const event of events) {
      if (event.at === "storm") {
        stormDeclared = members.size > 0;
        stormVerdictRunId = stormDeclared ? event.syncRunId : null;
        continue;
      }
      if (event.at === "served" || (event.at === "probe" && event.probeServed)) {
        owed = new Map([...owed].filter(([targetKey]) => targetKey !== event.targetKey));
        closeEpoch();
        continue;
      }
      if (event.at === "rejected") {
        members = new Map([...members].filter(([targetKey]) => targetKey !== event.targetKey));
        members.set(event.targetKey, {
          target: event.target,
          targetKey: event.targetKey,
          before: event.requestBefore,
          status: event.statusCode ?? 0,
          lastCaptureId: event.id,
        });
        // A new rejection restarts the proof attempt; the epoch's storm
        // record survives it, the verdict does not (the next storm needs its
        // own).
        probed = new Set();
        voted = new Set();
        votes = 0;
        stormDeclared = false;
        stormVerdictRunId = null;
        continue;
      }
      // A rejected (or malformed) witness.
      probed.add(event.targetKey);
      const statuses = new Set([...members.values()].map((member) => member.status));
      if (members.size > 0 && (event.statusCode === null || statuses.has(event.statusCode))) {
        votes += 1;
        voted.add(event.targetKey);
        stormVoted = true;
      }
    }
    return {
      count: members.size,
      statuses: [...new Set([...members.values()].map((member) => member.status))],
      members: [...members.values()],
      probedWitnessKeys: [...probed],
      votes,
      votedWitnessKeys: [...voted],
      stormVoted,
      stormDeclared,
      stormVerdictRunId,
      owedRetries: [...owed.values()].filter((retry) => stillOwed(retry.targetKey)),
    };
  };
  return { single: forKind("single"), bundle: forKind("bundle") };
}
