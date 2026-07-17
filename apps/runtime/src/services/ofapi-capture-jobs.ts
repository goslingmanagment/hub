import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  blockOfapiCaptureJobLease,
  captureOfapiAttemptResponse,
  getComposableOfapiMessageCoverageProof,
  leaseNextOfapiCaptureJob,
  loadOfapiCaptureObservation,
  markObservationParsed,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  reconcileOfapiCapturedAttemptCredit,
  releaseOfapiAttemptPreDispatch,
  reserveOfapiRequestAttempt,
  settleOfapiCaptureParse,
  type OfapiCaptureJobRecord,
  type OfapiHttpOutcome,
  type OfapiMessageCoverageProofReference,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  capturePayloadResponse,
  parseOfapiJsonBytes,
  parseStrictOfapiMessagePage,
} from "./ofapi-capture-contract.ts";
import { resolveOfapiEgressContext } from "./ofapi-egress.ts";
import { OFAPI_CAPTURE_MATERIALIZER_VERSION } from "./ofapi-capture-materialization.ts";
import {
  buildOfapiExportQuoteRequest,
  parseCapturedOfapiExportQuote,
  type OfapiExportQuoteRequestPlan,
} from "./ofapi-export-quotes.ts";
import { executeOfapiExportImportJob } from "./ofapi-export-artifact.ts";
import {
  OfapiGovernedRequestError,
  type OfapiGovernedRawResponse,
} from "./ofapi.ts";
import { appendOfapiMessageMaterialPage } from "./ofapi-message-material.ts";

const JOB_LEASE_TTL_MS = 120_000;
const CAPTURE_COMMIT_ATTEMPTS = 3;
const BALANCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET = 40_000;
const DEFAULT_MIRROR_PRINCIPAL_DAILY_CALL_CAP = 7_000;
const DEFAULT_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP = 7_000;

export function isOfapiBackgroundCaptureRunnable(
  config: Pick<
    AppContext["config"],
    "ofapiMirrorBackgroundCaptureEnabled"
  > | undefined,
) {
  return config?.ofapiMirrorBackgroundCaptureEnabled === true;
}

export interface OfapiCaptureChunkResult {
  kind: "idle" | "success" | "failed" | "blocked";
  pageId: number;
  jobId: string | null;
}

interface ChatPaginateTarget {
  chatId: string;
  frozenHeadId: string;
  anchorMessageId: string | null;
  limit: number;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTarget(job: OfapiCaptureJobRecord): ChatPaginateTarget | null {
  const chatId = stringField(job.target.chatId);
  const frozenHeadId = stringField(job.target.frozenHeadId);
  const anchorMessageId = job.target.anchorMessageId === null ||
      job.target.anchorMessageId === undefined
    ? null
    : stringField(job.target.anchorMessageId);
  const rawLimit = job.target.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit)
    ? Math.max(1, Math.min(100, rawLimit))
    : 100;
  if (
    !chatId ||
    !frozenHeadId ||
    !job.maxPages ||
    !job.maxCalls ||
    !job.maxCredits ||
    (job.goal === "connect_to_anchor" && !anchorMessageId)
  ) {
    return null;
  }
  return { chatId, frozenHeadId, anchorMessageId, limit };
}

function cursorField(job: OfapiCaptureJobRecord, field: string) {
  return stringField(job.cursor?.[field]);
}

function cursorBoundarySemantics(job: OfapiCaptureJobRecord) {
  const value = job.cursor?.boundarySemantics;
  return value === "inclusive" || value === "exclusive" ? value : null;
}

function cursorPages(job: OfapiCaptureJobRecord) {
  const pages = job.cursor?.pages;
  return typeof pages === "number" && Number.isInteger(pages) && pages >= 0
    ? pages
    : job.acceptedPages;
}

function cursorCount(job: OfapiCaptureJobRecord, field: string) {
  const value = job.cursor?.[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function advancePageChainHash(
  job: OfapiCaptureJobRecord,
  input: {
    observationId: number;
    observationReceivedAt: Date;
    requestedBoundary: string;
    boundarySemantics: "inclusive" | "exclusive" | null;
    bodyBytes: Buffer;
    nextCursor: string | null;
    terminal: boolean;
  },
) {
  const previous = stringField(job.cursor?.pageChainHash) ??
    createHash("sha256").update(`ofapi-page-chain-v1:${job.targetHash}`).digest("hex");
  const bodyHash = createHash("sha256").update(input.bodyBytes).digest("hex");
  return createHash("sha256").update(JSON.stringify({
    previous,
    observationId: input.observationId,
    observationReceivedAt: input.observationReceivedAt.toISOString(),
    requestedBoundary: input.requestedBoundary,
    boundarySemantics: input.boundarySemantics,
    bodyHash,
    nextCursor: input.nextCursor,
    terminal: input.terminal,
  })).digest("hex");
}

function httpOutcome(status: number): OfapiHttpOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 404) return "not_found";
  if (status === 401) return "auth_confirmed";
  if (status === 403) return "forbidden_unconfirmed";
  if (status === 429) return "rate";
  if (status >= 500) return "vendor_5xx";
  if (status === 400 || status === 409 || status === 422) return "request_rejected";
  return "unexpected_http";
}

function retryAfter(headers: Record<string, string>, now: Date) {
  const raw = headers["retry-after"];
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  const waitMs = Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1_000, 60 * 60 * 1_000)
    : 60_000;
  return new Date(now.getTime() + Math.max(1_000, waitMs));
}

async function blockJob(
  app: AppContext,
  job: OfapiCaptureJobRecord,
  reasonCode: string,
  reasonMessage: string,
) {
  if (!job.leaseToken) return false;
  return blockOfapiCaptureJobLease(app.db, {
    jobId: job.id,
    leaseToken: job.leaseToken,
    reasonCode,
    reasonMessage,
  });
}

function terminalFact(
  job: OfapiCaptureJobRecord,
  input: {
    evidenceKind: "vendor_eof" | "anchor_chain";
    inheritedProof: OfapiMessageCoverageProofReference | null;
    lastMessageId: string | null;
    pages: number;
    rawCount: number;
    acceptedCount: number;
    boundaryDuplicateCount: number;
    explicitlyIrrelevantCount: number;
    rejectedCount: number;
    pageChainHash: string;
    lastPageObservationId: number;
    lastPageObservationReceivedAt: Date;
    requiredServingHighWater: number;
    boundarySemantics: "inclusive" | "exclusive" | null;
  },
) {
  const chatId = stringField(job.target.chatId);
  if (!chatId) throw new Error("Terminal chat coverage is missing chatId");
  const inherited = input.inheritedProof;
  const inheritedEvidence = inherited === null ? null : {
    proofObservationId: inherited.proofObservationId,
    proofObservationReceivedAt: inherited.proofObservationReceivedAt.toISOString(),
    sourceAccountSeq: inherited.sourceAccountSeq,
    frozenHeadId: inherited.frozenHeadId,
    oldestMessageId: inherited.oldestMessageId,
    targetHash: inherited.targetHash,
    pageChainHash: inherited.pageChainHash,
    rawCount: inherited.rawCount,
    acceptedCount: inherited.acceptedCount,
    boundaryDuplicateCount: inherited.boundaryDuplicateCount,
    explicitlyIrrelevantCount: inherited.explicitlyIrrelevantCount,
    rejectedCount: inherited.rejectedCount,
    parseDebt: inherited.parseDebt,
    requiredServingHighWater: inherited.requiredServingHighWater,
    proofPolicyVersion: inherited.proofPolicyVersion,
    sourceContractVersion: inherited.sourceContractVersion,
    parserVersion: inherited.parserVersion,
  };
  const pageChainHash = inheritedEvidence === null
    ? input.pageChainHash
    : createHash("sha256").update(JSON.stringify({
      protocol: "ofapi-anchor-chain-v1",
      pageChainHash: input.pageChainHash,
      inheritedProof: inheritedEvidence,
      boundarySemantics: input.boundarySemantics,
    })).digest("hex");
  const oldestMessageId = inherited?.oldestMessageId ?? input.lastMessageId;
  const requiredServingHighWater = Math.max(
    input.requiredServingHighWater,
    inherited?.requiredServingHighWater ?? 0,
  );
  const payload = {
    scope: "chat",
    source: "pagination_exhausted",
    jobId: job.id,
    pageId: job.pageId,
    chatId,
    ofapiAccountId: job.ofapiAccountId,
    target: job.target,
    targetHash: job.targetHash,
    frozenHeadId: stringField(job.target.frozenHeadId),
    goal: job.goal,
    classification: "continuous_history",
    range: {
      fromMessageId: oldestMessageId,
      toFrozenHeadId: stringField(job.target.frozenHeadId),
    },
    evidence: {
      kind: input.evidenceKind,
      boundarySemantics: input.boundarySemantics,
      pageChainHash,
      capturedPageChainHash: input.pageChainHash,
      pages: input.pages,
      lastPageObservation: {
        id: input.lastPageObservationId,
        receivedAt: input.lastPageObservationReceivedAt.toISOString(),
      },
      inheritedProof: inheritedEvidence,
    },
    counts: {
      raw: input.rawCount + (inherited?.rawCount ?? 0),
      accepted: input.acceptedCount + (inherited?.acceptedCount ?? 0),
      boundaryDuplicate: input.boundaryDuplicateCount +
        (inherited?.boundaryDuplicateCount ?? 0),
      explicitlyIrrelevant: input.explicitlyIrrelevantCount +
        (inherited?.explicitlyIrrelevantCount ?? 0),
      rejected: input.rejectedCount + (inherited?.rejectedCount ?? 0),
    },
    lastMessageId: oldestMessageId,
    pages: input.pages,
    requiredServingHighWater,
    sourceContractVersion: job.sourceContractVersion,
    parserVersion: job.parserVersion,
    proofPolicyVersion: job.proofPolicyVersion,
    parseDebt: 0,
    supersedes: inheritedEvidence,
  };
  return {
    producer: "ofapi-mirror-background",
    kind: "ofapi.capture_completed.v1",
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `capture-complete:${job.id}:${job.targetHash}`,
    observedAt: new Date(),
    coverage: {
      conversationRef: chatId,
      dedupKey: `capture-coverage:${job.id}:${job.targetHash}`,
      checkpointDedupKey: `projection-checkpoint:capture-coverage:${job.id}:${job.targetHash}`,
      checkpointData: {
        profile: "ofapi_message_coverage_v1",
        originClass: "capture_background",
      },
    },
  };
}

async function parseCapturedJob(
  app: AppContext,
  job: OfapiCaptureJobRecord,
): Promise<OfapiCaptureChunkResult> {
  if (
    !job.leaseToken ||
    !job.pendingObservationId ||
    !job.pendingObservationReceivedAt
  ) {
    await blockJob(app, job, "pending_observation_missing", "Awaiting-parse job has no observation");
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }
  const observation = await loadOfapiCaptureObservation(app.db, {
    observationId: job.pendingObservationId,
    observationReceivedAt: job.pendingObservationReceivedAt,
  });
  if (!observation?.attemptId) {
    await blockJob(app, job, "pending_observation_missing", "Captured observation is unavailable");
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }
  const captured = capturePayloadResponse(observation.payload);
  if (!captured) {
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "contract_rejected",
      rawCount: 0,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 1,
      disposition: { kind: "blocked", reasonCode: "capture_envelope_invalid" },
    });
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  // Credit metadata is replayed from the durable bytes as part of local
  // parsing. The capture chunk also attempts this eagerly, but a process may
  // die after the response transaction commits and before that correction.
  const parsedJson = parseOfapiJsonBytes(captured.bodyBytes);
  const holdsExportStartCeiling = job.kind === "account_export"
    && job.cursor?.phase === "owner_approved";
  if (parsedJson.creditsUsed !== null && !holdsExportStartCeiling) {
    await reconcileOfapiCapturedAttemptCredit(app.db, {
      attemptId: observation.attemptId,
      actualCredits: parsedJson.creditsUsed,
      balanceAfter: parsedJson.balanceAfter,
    });
  }

  if (job.kind === "account_export") {
    const result = await parseCapturedOfapiExportQuote(app, {
      job,
      attemptId: observation.attemptId,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      status: captured.status,
      headers: captured.headers,
      parsedJson,
    });
    return { kind: result, pageId: job.pageId, jobId: job.id };
  }
  if (job.kind !== "chat_paginate") {
    await blockJob(app, job, "unsupported_job_kind", `Unsupported job kind ${job.kind}`);
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  const status = captured.status;
  if (status < 200 || status >= 300) {
    const retryable = status === 429 || status >= 500;
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "intentional_noop",
      rawCount: 0,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: retryable
        ? {
          kind: "retry",
          nextAttemptAt: retryAfter(captured.headers, new Date()),
          reasonCode: status === 429 ? "rate_limited" : "vendor_5xx",
        }
        : {
          kind: "blocked",
          reasonCode: status === 404 ? "chat_not_found" : `http_${status}`,
        },
    });
    return { kind: retryable ? "failed" : "blocked", pageId: job.pageId, jobId: job.id };
  }

  const target = parseTarget(job);
  if (!parsedJson.validJson || !target) {
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "contract_rejected",
      rawCount: 0,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 1,
      disposition: {
        kind: "blocked",
        reasonCode: !target ? "target_invalid" : "invalid_json",
      },
    });
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  const inclusiveCursor = cursorField(job, "firstId");
  const page = parseStrictOfapiMessagePage(parsedJson.body, {
    requiredBoundaryCursor: inclusiveCursor ?? target.frozenHeadId,
    boundaryIsDuplicate: inclusiveCursor !== null,
    expectedBoundarySemantics: cursorBoundarySemantics(job),
  });
  if (!page.accepted) {
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "contract_rejected",
      rawCount: page.rawCount,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: page.rejectedCount,
      disposition: {
        kind: "blocked",
        reasonCode: "contract_rejected",
        reasonMessage: page.reason,
      },
    });
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  if (job.maxItems !== null && job.acceptedItems + page.items.length > job.maxItems) {
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "contract_rejected",
      rawCount: page.rawCount,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: page.rawCount,
      disposition: {
        kind: "blocked",
        reasonCode: "item_cap_exceeded",
        reasonMessage: `Captured page would exceed job item cap ${job.maxItems}`,
      },
    });
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  const itemIds = page.items.flatMap((item) => {
    const id = stringField(item.id) ??
      (typeof item.id === "number" && Number.isFinite(item.id) ? String(item.id) : null);
    return id ? [id] : [];
  });
  let materialHighWater: number;
  try {
    const material = await appendOfapiMessageMaterialPage(app.db, {
      accountId: job.pageId,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      chatId: target.chatId,
      originClass: "capture_background",
      items: page.items,
    });
    materialHighWater = material.highWater;
    await markObservationParsed(app.db, {
      observationId: observation.id,
      receivedAt: observation.receivedAt,
      parseVersion: OFAPI_CAPTURE_MATERIALIZER_VERSION,
    });
  } catch (error) {
    app.logger.error(
      { err: error, jobId: job.id, observationId: observation.id },
      "Captured OFAPI page could not be appended to the material ledger",
    );
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "failed",
      rawCount: page.rawCount,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "parser_failed",
        reasonMessage: error instanceof Error ? error.message : String(error),
      },
    });
    return { kind: "failed", pageId: job.pageId, jobId: job.id };
  }
  const anchorReached = target.anchorMessageId !== null && itemIds.includes(target.anchorMessageId);
  const pages = cursorPages(job) + 1;
  const rawCount = cursorCount(job, "rawCount") + page.rawCount;
  const acceptedCount = job.acceptedItems + page.items.length;
  const boundaryDuplicateCount = cursorCount(job, "boundaryDuplicateCount") +
    page.boundaryDuplicateCount;
  const explicitlyIrrelevantCount = cursorCount(job, "explicitlyIrrelevantCount");
  const rejectedCount = cursorCount(job, "rejectedCount");
  const lastMessageId = page.nextCursor ?? inclusiveCursor ?? target.frozenHeadId;
  const pageChainHash = advancePageChainHash(job, {
    observationId: observation.id,
    observationReceivedAt: observation.receivedAt,
    requestedBoundary: inclusiveCursor ?? target.frozenHeadId,
    boundarySemantics: page.boundarySemantics,
    bodyBytes: captured.bodyBytes,
    nextCursor: lastMessageId,
    terminal: !page.hasNextPage,
  });
  const maxPagesReached = job.maxPages !== null && pages >= job.maxPages;
  const continuousToEnd = !page.hasNextPage;
  const completes = job.goal === "history_to_exhaustion"
    ? continuousToEnd
    : anchorReached || continuousToEnd;

  if (completes) {
    const inheritedProof = continuousToEnd || target.anchorMessageId === null
      ? null
      : await getComposableOfapiMessageCoverageProof(app.db, {
        pageId: job.pageId,
        chatId: target.chatId,
        expectedFrozenHeadId: target.anchorMessageId,
        proofPolicyVersion: job.proofPolicyVersion,
      });
    if (!continuousToEnd && inheritedProof === null) {
      await settleOfapiCaptureParse(app.db, {
        jobId: job.id,
        attemptId: observation.attemptId,
        leaseToken: job.leaseToken,
        observationId: observation.id,
        observationReceivedAt: observation.receivedAt,
        parserOutcome: "accepted",
        rawCount: page.rawCount,
        acceptedCount: page.items.length,
        boundaryDuplicateCount: page.boundaryDuplicateCount,
        explicitlyIrrelevantCount: 0,
        rejectedCount: 0,
        disposition: {
          kind: "blocked",
          reasonCode: "anchor_proof_changed",
          reasonMessage: "The continuous proof at the requested anchor is absent or changed",
        },
      });
      return { kind: "blocked", pageId: job.pageId, jobId: job.id };
    }
    const terminal = terminalFact(job, {
      evidenceKind: continuousToEnd ? "vendor_eof" : "anchor_chain",
      inheritedProof,
      lastMessageId,
      pages,
      rawCount,
      acceptedCount,
      boundaryDuplicateCount,
      explicitlyIrrelevantCount,
      rejectedCount,
      pageChainHash,
      lastPageObservationId: observation.id,
      lastPageObservationReceivedAt: observation.receivedAt,
      requiredServingHighWater: materialHighWater,
      boundarySemantics: page.boundarySemantics,
    });
    const settled = await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "accepted",
      rawCount: page.rawCount,
      acceptedCount: page.items.length,
      boundaryDuplicateCount: page.boundaryDuplicateCount,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "complete",
        ...(inheritedProof === null
          ? {}
          : {
            expectedSupersedes: {
              conversationRef: target.chatId,
              proof: inheritedProof,
            },
          }),
        terminal,
        result: {
          classification: "continuous_history",
          completionEvidence: continuousToEnd ? "vendor_eof" : "anchor_chain",
          lastMessageId: inheritedProof?.oldestMessageId ?? lastMessageId,
          pages,
          pageChainHash: terminal.payload.evidence &&
              typeof terminal.payload.evidence === "object"
            ? (terminal.payload.evidence as Record<string, unknown>).pageChainHash
            : pageChainHash,
          requiredServingHighWater: Math.max(
            materialHighWater,
            inheritedProof?.requiredServingHighWater ?? 0,
          ),
        },
      },
    });
    return { kind: settled ? "success" : "failed", pageId: job.pageId, jobId: job.id };
  }

  if (maxPagesReached || page.nextCursor === null) {
    await settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: observation.attemptId,
      leaseToken: job.leaseToken,
      observationId: observation.id,
      observationReceivedAt: observation.receivedAt,
      parserOutcome: "accepted",
      rawCount: page.rawCount,
      acceptedCount: page.items.length,
      boundaryDuplicateCount: page.boundaryDuplicateCount,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: { kind: "blocked", reasonCode: "gap_open" },
    });
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  await settleOfapiCaptureParse(app.db, {
    jobId: job.id,
    attemptId: observation.attemptId,
    leaseToken: job.leaseToken,
    observationId: observation.id,
    observationReceivedAt: observation.receivedAt,
    parserOutcome: "accepted",
    rawCount: page.rawCount,
    acceptedCount: page.items.length,
    boundaryDuplicateCount: page.boundaryDuplicateCount,
    explicitlyIrrelevantCount: 0,
    rejectedCount: 0,
    disposition: {
      kind: "progress",
      // The event high-water is monotone per account; carrying it through the
      // cursor makes the eventual terminal proof wait for every earlier page.
      cursor: {
        firstId: page.nextCursor,
        pages,
        rawCount,
        boundaryDuplicateCount,
        explicitlyIrrelevantCount,
        rejectedCount,
        pageChainHash,
        boundarySemantics: page.boundarySemantics,
        requiredServingHighWater: materialHighWater,
      },
      acceptedItems: page.items.length,
    },
  });
  return { kind: "success", pageId: job.pageId, jobId: job.id };
}

export async function executeOfapiCaptureJobChunk(
  app: AppContext,
  pageId: number,
): Promise<OfapiCaptureChunkResult> {
  if (!isOfapiBackgroundCaptureRunnable(app.config)) {
    return { kind: "idle", pageId, jobId: null };
  }
  const job = await leaseNextOfapiCaptureJob(app.db, {
    pageId,
    leaseOwner: `sync-page-executor:${process.pid}`,
    leaseTtlMs: JOB_LEASE_TTL_MS,
  });
  if (!job) {
    return { kind: "idle", pageId, jobId: null };
  }
  if (job.state === "awaiting_parse") {
    return parseCapturedJob(app, job);
  }
  if (job.kind === "export_import") {
    return executeOfapiExportImportJob(app, job);
  }
  if (!job.leaseToken) {
    await blockJob(app, job, "lease_missing", "Capture job lease token is missing");
    return { kind: "blocked", pageId, jobId: job.id };
  }
  const leaseToken = job.leaseToken;
  let requestPlan: OfapiExportQuoteRequestPlan | {
    operation: "ofapi_capture_chat_messages";
    endpointClass: "chat_messages";
    method: "GET";
    requestSemantics: "safe_read";
    pathname: string;
    query: Record<string, string>;
    bodyBytes: null;
    contentType: null;
    request: Record<string, unknown>;
    observationKind: "ofapi.chat_messages_page.v1";
    reservedCredits: 1;
    timeoutMs: number;
    maxResponseBytes: number;
  } | null = null;
  if (job.kind === "chat_paginate") {
    const target = parseTarget(job);
    if (target) {
      const firstId = cursorField(job, "firstId") ?? target.frozenHeadId;
      const query = {
        limit: String(target.limit),
        order: "desc",
        first_id: firstId,
      };
      requestPlan = {
        operation: "ofapi_capture_chat_messages",
        endpointClass: "chat_messages",
        method: "GET",
        requestSemantics: "safe_read",
        pathname: `/${encodeURIComponent(job.ofapiAccountId)}/chats/${encodeURIComponent(target.chatId)}/messages`,
        query,
        bodyBytes: null,
        contentType: null,
        request: {
          chatId: target.chatId,
          query,
          boundaryIsDuplicate: cursorField(job, "firstId") !== null,
          expectedBoundarySemantics: cursorBoundarySemantics(job),
        },
        observationKind: "ofapi.chat_messages_page.v1",
        reservedCredits: 1,
        timeoutMs: 65_000,
        maxResponseBytes: 10 * 1024 * 1024,
      };
    }
  } else if (job.kind === "account_export") {
    requestPlan = buildOfapiExportQuoteRequest(job);
  }
  if (!requestPlan) {
    await blockJob(
      app,
      job,
      job.kind === "chat_paginate" || job.kind === "account_export"
        ? "target_invalid"
        : "unsupported_job_kind",
      `Capture request cannot be built for ${job.kind}`,
    );
    return { kind: "blocked", pageId, jobId: job.id };
  }
  if (!app.ofapi?.dispatchGovernedRaw) {
    await blockJob(app, job, "transport_unavailable", "OFAPI client is not configured");
    return { kind: "blocked", pageId, jobId: job.id };
  }

  let egress: Awaited<ReturnType<typeof resolveOfapiEgressContext>>;
  try {
    egress = await resolveOfapiEgressContext(app, {
      pageId: job.pageId,
      ofapiAccountId: job.ofapiAccountId,
    });
  } catch (error) {
    await blockJob(
      app,
      job,
      "egress_unavailable",
      error instanceof Error ? error.message : String(error),
    );
    return { kind: "blocked", pageId, jobId: job.id };
  }

  try {
    const deadlineAt = new Date(Date.now() + 65_000);
    const globalDailyCap = Math.max(
      1,
      app.config.ofapiMirrorGlobalDailyCreditBudget ?? DEFAULT_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET,
    );
    const reservation = await reserveOfapiRequestAttempt(app.db, {
      ownerKind: "capture_job",
      ownerId: job.id,
      pageId: job.pageId,
      ofapiAccountId: job.ofapiAccountId,
      originPrincipalId: job.originPrincipalId,
      budgetScope: job.budgetScope,
      operation: requestPlan.operation,
      endpointClass: requestPlan.endpointClass,
      egressKey: egress.egressKey,
      method: requestPlan.method,
      requestSemantics: requestPlan.requestSemantics,
      requestShape: requestPlan.request,
      requireFreshStorageHealth: true,
      reservedCredits: requestPlan.reservedCredits,
      globalDailyCap,
      scopeDailyCap: job.budgetScope === "bulk"
        ? Math.min(globalDailyCap, app.config.ofapiBackfillDailyCreditBudget ?? 200)
        : globalDailyCap,
      creditFloor: Math.max(0, app.config.ofapiCreditFloor ?? 500),
      balanceMaxAgeMs: BALANCE_MAX_AGE_MS,
      allowFloorProbe: job.budgetScope === "live",
      ...(job.originPrincipalId === null
        ? {}
        : {
          principalCallCap: Math.max(
            1,
            app.config.ofapiMirrorPrincipalDailyCallCap ?? DEFAULT_MIRROR_PRINCIPAL_DAILY_CALL_CAP,
          ),
          principalCreditCap: Math.max(
            1,
            app.config.ofapiMirrorPrincipalDailyCreditCap ?? DEFAULT_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP,
          ),
        }),
      jobLeaseToken: leaseToken,
      deadlineAt,
    });
    if (!reservation.admitted) {
      return { kind: "blocked", pageId, jobId: job.id };
    }

    let raw: OfapiGovernedRawResponse;
    const indeterminateRetryAt = requestPlan.operation === "ofapi_export_quote_status"
      ? new Date(Date.now() + 60_000)
      : null;
    try {
      raw = await app.ofapi.dispatchGovernedRaw({
        pageId: job.pageId,
        dispatcher: egress.dispatcher,
        egressKey: egress.egressKey,
      }, {
        attemptId: reservation.attemptId,
        operation: requestPlan.operation,
        method: requestPlan.method,
        pathname: requestPlan.pathname,
        query: requestPlan.query,
        bodyBytes: requestPlan.bodyBytes,
        contentType: requestPlan.contentType,
        priorityClass: job.budgetScope === "bulk" ? "bulk" : "interactive",
        deadlineAt,
        timeoutMs: requestPlan.timeoutMs,
        maxResponseBytes: requestPlan.maxResponseBytes,
        beforeDispatch: async () =>
          isOfapiBackgroundCaptureRunnable(app.config) &&
          await markOfapiAttemptDispatching(app.db, {
            attemptId: reservation.attemptId,
            fenceToken: reservation.fenceToken,
            jobLeaseToken: leaseToken,
          }),
      });
    } catch (error) {
      if (error instanceof OfapiGovernedRequestError && error.phase === "pre_dispatch") {
        await releaseOfapiAttemptPreDispatch(app.db, {
          attemptId: reservation.attemptId,
          fenceToken: reservation.fenceToken,
          reasonCode: error.reason,
          retryAt: new Date(Date.now() + 60_000),
        });
      } else {
        await markOfapiAttemptIndeterminate(app.db, {
          attemptId: reservation.attemptId,
          fenceToken: reservation.fenceToken,
          outcome: "transport",
          details: { error: error instanceof Error ? error.message : String(error) },
          retrySafeReadAt: indeterminateRetryAt,
        });
      }
      return { kind: "failed", pageId, jobId: job.id };
    }

    let captured = false;
    let captureError: unknown = null;
    for (let attempt = 1; attempt <= CAPTURE_COMMIT_ATTEMPTS; attempt += 1) {
      try {
        await captureOfapiAttemptResponse(app.db, {
          attemptId: reservation.attemptId,
          fenceToken: reservation.fenceToken,
          responseObservedAt: raw.receivedAt,
          httpStatus: raw.status,
          httpOutcome: httpOutcome(raw.status),
          responseHeaders: raw.headers,
          bodyBytes: raw.bodyBytes,
          request: requestPlan.request,
          producer: "ofapi-mirror-background",
          observationKind: requestPlan.observationKind,
        });
        captured = true;
        break;
      } catch (error) {
        captureError = error;
        if (attempt < CAPTURE_COMMIT_ATTEMPTS) await delay(attempt * 50);
      }
    }
    if (!captured) {
      await markOfapiAttemptIndeterminate(app.db, {
        attemptId: reservation.attemptId,
        fenceToken: reservation.fenceToken,
        outcome: "capture_uncommitted",
        responseObservedAt: raw.receivedAt,
        details: {
          error: captureError instanceof Error ? captureError.message : String(captureError),
        },
        retrySafeReadAt: indeterminateRetryAt,
      }).catch(() => undefined);
      return { kind: "failed", pageId, jobId: job.id };
    }

    const parsed = parseOfapiJsonBytes(raw.bodyBytes);
    if (parsed.creditsUsed !== null && requestPlan.operation !== "ofapi_export_start") {
      await reconcileOfapiCapturedAttemptCredit(app.db, {
        attemptId: reservation.attemptId,
        actualCredits: parsed.creditsUsed,
        balanceAfter: parsed.balanceAfter,
      });
    }
    // Parsing is deliberately the next local chunk. A crash here re-leases
    // the saved observation and never repeats the paid request.
    return { kind: "success", pageId, jobId: job.id };
  } finally {
    await egress.close().catch((error) => {
      app.logger.warn({ error, jobId: job.id }, "Failed to close OFAPI capture egress");
    });
  }
}
