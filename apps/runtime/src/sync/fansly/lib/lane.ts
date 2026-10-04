import {
  upsertCaptureCoverage,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
  type Database,
} from "@agency_hub_core/db";

// The lane rules the Sync Engine's resources share: the three-way response
// class, the UTC day key, one offset page's advance and the capture-coverage
// writer.

export type FanslyResponseClass = "nonempty" | "empty" | "invalid";

export function classifyFanslyResponse(
  payload: unknown,
  classifier: {
    isValid: (value: unknown) => boolean;
    isEmpty: (value: unknown) => boolean;
  },
): FanslyResponseClass {
  if (!classifier.isValid(payload)) {
    return "invalid";
  }
  return classifier.isEmpty(payload) ? "empty" : "nonempty";
}

export function fanslyUtcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export function advanceOffsetPage(input: {
  offset: number;
  pageSize: number;
  rowCount: number;
}): { done: boolean; nextOffset: number } {
  return {
    done: input.rowCount < input.pageSize,
    nextOffset: input.offset + input.pageSize,
  };
}

export async function writeFanslyLaneCoverage(input: {
  db: Database;
  pageId: number;
  plane: string;
  scopeRef: string;
  status: CaptureCoverageStatus;
  acquisitionMode: "forward_only" | "retroactive";
  proof: CaptureCoverageProof;
  proofObservationId?: number | null;
  oldestCapturedAt?: Date | null;
  newestCapturedAt?: Date | null;
  replaceWindowBounds?: boolean;
  observedUniqueCount?: number | null;
  expectedCount?: number | null;
  reasonCode?: string | null;
  cursor?: Record<string, unknown>;
}) {
  const { db, ...coverage } = input;
  return upsertCaptureCoverage(db, {
    ...coverage,
    platform: "fansly",
  });
}
