import {
  applyOfapiMessageCoverageEvents,
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  OFAPI_MESSAGE_COVERAGE_PROJECTION,
  setProjectionWatermark,
  type DomainEventRow,
  type OfapiMessageCoverageProjectionEvent,
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
  if (evidence.kind !== "vendor_eof") {
    throw new Error("Continuous coverage is missing explicit vendor EOF evidence");
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
