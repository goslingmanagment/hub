import {
  listOfapiSpendProjectionComparisonSamples,
  summarizeOfapiSpendProjectionComparison,
  summarizeOfapiSpendProjectionComparisonByPage,
  type OfapiSpendProjectionComparisonPageRow,
  type OfapiSpendProjectionComparisonSampleRow,
  type OfapiSpendProjectionComparisonStatusRow,
} from "@agency_hub_core/db";
import {
  millsToNumber,
} from "@agency_hub_core/shared";
import type {
  AdminOfapiSpendComparisonQuery,
  OfapiSpendComparisonResponse,
} from "../../../../packages/contracts/src/routes.ts";

import type { AppContext } from "../bootstrap.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date) {
  return date.toISOString();
}

function mills(value: bigint | null) {
  return value === null ? null : millsToNumber(value);
}

function aggregate(row: OfapiSpendProjectionComparisonStatusRow) {
  return {
    status: row.status,
    count: row.count,
    grossAmountMills: millsToNumber(row.grossAmountMills),
    creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills),
    coreGrossAmountMills: millsToNumber(row.coreGrossAmountMills),
    coreCreatorNetAmountMills: millsToNumber(row.coreCreatorNetAmountMills),
  };
}

function pageAggregate(row: OfapiSpendProjectionComparisonPageRow) {
  return {
    pageId: row.pageId,
    pageLabel: row.pageLabel,
    ...aggregate(row),
  };
}

function sample(row: OfapiSpendProjectionComparisonSampleRow) {
  return {
    projectionId: row.projectionId,
    comparisonStatus: row.comparisonStatus,
    sourceEventType: row.sourceEventType,
    projectionStatus: row.projectionStatus,
    eventStatus: row.eventStatus,
    blockedReason: row.blockedReason,
    journalId: row.journalId,
    pageId: row.pageId,
    pageLabel: row.pageLabel,
    fanPlatformUserId: row.fanPlatformUserId,
    transactionId: row.transactionId,
    messageId: row.messageId,
    occurredAt: iso(row.occurredAt),
    grossAmountMills: mills(row.grossAmountMills),
    creatorNetAmountMills: mills(row.creatorNetAmountMills),
    coreTransactionPk: row.coreTransactionPk,
    corePageId: row.corePageId,
    coreFanPlatformUserId: row.coreFanPlatformUserId,
    coreTransactionState: row.coreTransactionState,
    coreOccurredAt: row.coreOccurredAt ? iso(row.coreOccurredAt) : null,
    coreGrossAmountMills: mills(row.coreGrossAmountMills),
    coreCreatorNetAmountMills: mills(row.coreCreatorNetAmountMills),
  };
}

export async function getOfapiSpendComparison(
  app: AppContext,
  query: AdminOfapiSpendComparisonQuery,
): Promise<OfapiSpendComparisonResponse> {
  const days = query.days ?? 7;
  const sampleLimit = query.sampleLimit ?? 25;
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  const input = { from, to, sampleLimit };

  const [summary, byPage, samples] = await Promise.all([
    summarizeOfapiSpendProjectionComparison(app.db, input),
    summarizeOfapiSpendProjectionComparisonByPage(app.db, input),
    listOfapiSpendProjectionComparisonSamples(app.db, input),
  ]);

  return {
    generatedAt: iso(new Date()),
    window: {
      from: iso(from),
      to: iso(to),
      days,
    },
    summary: summary.map(aggregate),
    byPage: byPage.map(pageAggregate),
    samples: samples.map(sample),
    limitations: [
      "Read-only comparison; this endpoint does not write transactions, revenue rollups, or desktop state.",
      "messages.ppv.unlocked rows are estimated purchase signals and are not treated as settled revenue.",
      "tips.received rows remain blocked/excluded until a live verified fixture exists.",
      "Desktop spend sweep must stay at the old cadence until matched production comparison is proven.",
    ],
  };
}
