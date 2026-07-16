import { createHash } from "node:crypto";

import {
  applyOfapiMessageCoverageEvents,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  OFAPI_MESSAGE_COVERAGE_PROJECTION,
  setProjectionWatermark,
  type DomainEventRow,
  type OfapiMessageCoverageProjectionEvent,
  type OfapiMessageCoverageProofReference,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

const EVENT_PAGE_SIZE = 500;

function record(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid coverage ${field}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid coverage ${field}`);
  }
  return value;
}

function count(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid coverage ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string) {
  if (value === null) return null;
  return string(value, field);
}

function proofReference(value: unknown, field: string): OfapiMessageCoverageProofReference {
  const proof = record(value, field);
  const receivedAt = new Date(string(
    proof.proofObservationReceivedAt,
    `${field}.proofObservationReceivedAt`,
  ));
  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error(`Invalid coverage ${field}.proofObservationReceivedAt`);
  }
  return {
    proofObservationId: count(proof.proofObservationId, `${field}.proofObservationId`),
    proofObservationReceivedAt: receivedAt,
    sourceAccountSeq: count(proof.sourceAccountSeq, `${field}.sourceAccountSeq`),
    frozenHeadId: string(proof.frozenHeadId, `${field}.frozenHeadId`),
    oldestMessageId: nullableString(proof.oldestMessageId, `${field}.oldestMessageId`),
    targetHash: string(proof.targetHash, `${field}.targetHash`),
    pageChainHash: string(proof.pageChainHash, `${field}.pageChainHash`),
    rawCount: count(proof.rawCount, `${field}.rawCount`),
    acceptedCount: count(proof.acceptedCount, `${field}.acceptedCount`),
    boundaryDuplicateCount: count(
      proof.boundaryDuplicateCount,
      `${field}.boundaryDuplicateCount`,
    ),
    explicitlyIrrelevantCount: count(
      proof.explicitlyIrrelevantCount,
      `${field}.explicitlyIrrelevantCount`,
    ),
    rejectedCount: count(proof.rejectedCount, `${field}.rejectedCount`),
    parseDebt: count(proof.parseDebt, `${field}.parseDebt`),
    requiredServingHighWater: count(
      proof.requiredServingHighWater,
      `${field}.requiredServingHighWater`,
    ),
    proofPolicyVersion: string(proof.proofPolicyVersion, `${field}.proofPolicyVersion`),
    sourceContractVersion: string(
      proof.sourceContractVersion,
      `${field}.sourceContractVersion`,
    ),
    parserVersion: string(proof.parserVersion, `${field}.parserVersion`),
  };
}

function serializedProof(proof: OfapiMessageCoverageProofReference) {
  return {
    ...proof,
    proofObservationReceivedAt: proof.proofObservationReceivedAt.toISOString(),
  };
}

function parseCoverageEvent(event: DomainEventRow): OfapiMessageCoverageProjectionEvent {
  const data = record(event.data, "data");
  const target = record(data.target, "target");
  const range = record(data.range, "range");
  const evidence = record(data.evidence, "evidence");
  const counts = record(data.counts, "counts");
  const chatId = string(data.chatId, "chatId");
  if (event.conversationRef !== chatId) {
    throw new Error("Coverage conversationRef does not match chatId");
  }
  if (data.classification !== "continuous_history" || data.source !== "pagination_exhausted") {
    throw new Error("Unsupported coverage proof classification");
  }
  const evidenceKind = evidence.kind;
  const supersedes = data.supersedes === null
    ? null
    : proofReference(data.supersedes, "supersedes");
  if (evidenceKind === "vendor_eof") {
    if (
      supersedes !== null ||
      (evidence.inheritedProof !== null && evidence.inheritedProof !== undefined)
    ) {
      throw new Error("Vendor EOF coverage cannot supersede an anchor proof");
    }
  } else if (evidenceKind === "anchor_chain") {
    if (supersedes === null) {
      throw new Error("Anchor-chain coverage is missing supersedes evidence");
    }
    const inherited = proofReference(evidence.inheritedProof, "evidence.inheritedProof");
    if (JSON.stringify(serializedProof(inherited)) !== JSON.stringify(serializedProof(supersedes))) {
      throw new Error("Anchor-chain inherited proof does not match supersedes");
    }
    if (
      target.anchorMessageId !== inherited.frozenHeadId ||
      range.fromMessageId !== inherited.oldestMessageId ||
      data.proofPolicyVersion !== inherited.proofPolicyVersion
    ) {
      throw new Error("Anchor-chain coverage does not join the inherited range");
    }
    const capturedPageChainHash = string(
      evidence.capturedPageChainHash,
      "evidence.capturedPageChainHash",
    );
    const expectedHash = createHash("sha256").update(JSON.stringify({
      protocol: "ofapi-anchor-chain-v1",
      pageChainHash: capturedPageChainHash,
      inheritedProof: serializedProof(inherited),
    })).digest("hex");
    if (evidence.pageChainHash !== expectedHash) {
      throw new Error("Anchor-chain coverage hash is invalid");
    }
  } else {
    throw new Error("Continuous coverage is missing explicit terminal evidence");
  }
  const proofReceivedAt = new Date(string(
    data.proofObservationReceivedAt,
    "proofObservationReceivedAt",
  ));
  if (Number.isNaN(proofReceivedAt.getTime())) {
    throw new Error("Invalid coverage proofObservationReceivedAt");
  }
  return {
    pageId: event.accountId,
    chatId,
    classification: "continuous_history",
    source: "pagination_exhausted",
    frozenHeadId: string(data.frozenHeadId, "frozenHeadId"),
    oldestMessageId: typeof range.fromMessageId === "string" ? range.fromMessageId : null,
    target,
    targetHash: string(data.targetHash, "targetHash"),
    pageChainHash: string(evidence.pageChainHash, "pageChainHash"),
    rawCount: count(counts.raw, "counts.raw"),
    acceptedCount: count(counts.accepted, "counts.accepted"),
    boundaryDuplicateCount: count(counts.boundaryDuplicate, "counts.boundaryDuplicate"),
    explicitlyIrrelevantCount: count(
      counts.explicitlyIrrelevant,
      "counts.explicitlyIrrelevant",
    ),
    rejectedCount: count(counts.rejected, "counts.rejected"),
    parseDebt: count(data.parseDebt, "parseDebt"),
    requiredServingHighWater: count(
      data.requiredServingHighWater,
      "requiredServingHighWater",
    ),
    proofObservationId: count(data.proofObservationId, "proofObservationId"),
    proofObservationReceivedAt: proofReceivedAt,
    proofPolicyVersion: string(data.proofPolicyVersion, "proofPolicyVersion"),
    sourceContractVersion: string(data.sourceContractVersion, "sourceContractVersion"),
    parserVersion: string(data.parserVersion, "parserVersion"),
    sourceAccountSeq: event.accountSeq,
    supersedes,
  };
}

export interface OfapiMessageCoverageProjectionResult {
  accounts: number;
  eventsSeen: number;
  projected: number;
}

export async function runOfapiMessageCoverageProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<OfapiMessageCoverageProjectionResult> {
  const totals = { accounts: 0, eventsSeen: 0, projected: 0 };
  const accounts = input?.accountId != null ? [input.accountId] : await listEventAccounts(app.db);
  for (const accountId of accounts) {
    totals.accounts += 1;
    let watermark = await getProjectionWatermark(
      app.db,
      OFAPI_MESSAGE_COVERAGE_PROJECTION,
      accountId,
    );
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) break;
      totals.eventsSeen += events.length;
      const coverageEvents = events
        .filter((event) => event.type === "capture.coverage_observed")
        .map(parseCoverageEvent);
      const applied = await applyOfapiMessageCoverageEvents(app.db, coverageEvents);
      totals.projected += applied.projected;
      watermark = events.at(-1)!.accountSeq;
      await setProjectionWatermark(
        app.db,
        OFAPI_MESSAGE_COVERAGE_PROJECTION,
        accountId,
        watermark,
      );
      if (events.length < EVENT_PAGE_SIZE) break;
    }
  }
  return totals;
}
