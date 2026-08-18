// G5 slice 3c-2 — the pure judgements, without Docker.
//
// Four decisions in this slice are functions of their arguments and nothing
// else, and each of them is the kind that is easy to get subtly wrong and hard
// to notice: what scope did the operator name, is this month safe to touch,
// does the disk hold the operation, and is a verify verdict still worth
// anything. They live in scope.ts precisely so they can be proved here.

import { describe, expect, it } from "vitest";

import {
  currentMonthVerdict,
  monthUtcRange,
  normalizeIndexDef,
  observationPartitionName,
  parkedRelationName,
  parseCaptureRewriteScope,
  reclaimHeadroomVerdict,
  shadowRelationName,
  vacuumFullHeadroomVerdict,
  VERIFY_VERDICT_MAX_AGE_MS,
  verifyVerdictFreshness,
} from "../apps/runtime/src/services/capture-rewrite/scope.ts";

const GIB = 1024 ** 3;

describe("scope parsing", () => {
  it("observations needs a month and turns it into its partition", () => {
    expect(parseCaptureRewriteScope({ table: "observations", month: "2026-07" }))
      .toEqual({ table: "observations", month: "2026-07" });
    expect(observationPartitionName("2026-07")).toBe("observations_2026_07");
  });

  it("observations without a month is refused, not defaulted", () => {
    expect(() => parseCaptureRewriteScope({ table: "observations", month: undefined }))
      .toThrow(/needs --month/);
  });

  it("a month that is not YYYY-MM is refused", () => {
    for (const month of ["2026-7", "26-07", "2026-13", "2026-00", "2026-07-01", "july"]) {
      expect(() => parseCaptureRewriteScope({ table: "observations", month }), month)
        .toThrow(/YYYY-MM/);
    }
  });

  // The dangerous direction: silently narrowing a whole-table act to a month
  // would produce a verdict that does not describe what the act rewrites.
  it("sync_raw_payloads REFUSES a month rather than ignoring it", () => {
    expect(parseCaptureRewriteScope({ table: "sync_raw_payloads", month: undefined }))
      .toEqual({ table: "sync_raw_payloads", month: null });
    expect(() => parseCaptureRewriteScope({ table: "sync_raw_payloads", month: "2026-07" }))
      .toThrow(/not partitioned/);
  });

  it("an unknown table is refused", () => {
    expect(() => parseCaptureRewriteScope({ table: "domain_events", month: undefined }))
      .toThrow(/--table must be one of/);
    expect(() => parseCaptureRewriteScope({ table: undefined, month: undefined }))
      .toThrow(/--table must be one of/);
  });

  it("the month range is a half-open UTC month and rolls the year over", () => {
    expect(monthUtcRange("2026-07")).toEqual({ from: "2026-07-01", to: "2026-08-01" });
    expect(monthUtcRange("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
  });

  // The parked copy must NOT collide with the name the skinny twin takes.
  it("the parked name is distinct from the partition and from the shadow", () => {
    const partition = observationPartitionName("2026-07");
    const parked = parkedRelationName(partition, new Date("2026-08-18T04:05:06Z"));
    expect(parked).toBe("observations_2026_07__pre_g5_20260818040506");
    expect(parked).not.toBe(partition);
    expect(parked).not.toBe(shadowRelationName(partition));
    expect(shadowRelationName(partition)).toBe("observations_2026_07__skinny");
  });
});

describe("the current-month refusal", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  it("refuses the current UTC month", () => {
    const verdict = currentMonthVerdict("2026-08", now);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/CURRENT UTC month/);
  });

  it("refuses a future month", () => {
    expect(currentMonthVerdict("2026-09", now).ok).toBe(false);
    expect(currentMonthVerdict("2027-01", now).ok).toBe(false);
  });

  it("allows any closed month", () => {
    for (const month of ["2026-07", "2026-01", "2025-12"]) {
      expect(currentMonthVerdict(month, now).ok, month).toBe(true);
    }
  });

  // A local-time reading would shift the boundary for anyone west of UTC —
  // the same trap capturePayloadBucketMonth avoids on the write side.
  it("reads the boundary in UTC, not local time", () => {
    // 2026-09-01T00:30Z is September in UTC even where it is still August local.
    expect(currentMonthVerdict("2026-09", new Date("2026-09-01T00:30:00Z")).ok).toBe(false);
    expect(currentMonthVerdict("2026-08", new Date("2026-09-01T00:30:00Z")).ok).toBe(true);
  });
});

describe("§9.1's headroom law", () => {
  it("requires the source AGAIN plus the skinny copy plus its WAL", () => {
    const verdict = reclaimHeadroomVerdict({
      freeBytes: 100 * GIB,
      sourceTotalBytes: 10 * GIB,
      sourceIndexBytes: 2 * GIB,
      // Every row referenced: the skinny copy carries no bodies at all, so it
      // is just the indexes.
      referencedFraction: 1,
    });
    expect(verdict.shadowEstimateBytes).toBe(2 * GIB);
    expect(verdict.walReserveBytes).toBe(2 * GIB);
    expect(verdict.requiredBytes).toBe(14 * GIB);
    expect(verdict.ok).toBe(true);
  });

  it("scales the estimate by the fraction of rows that keep their body", () => {
    // Half the rows unreferenced → half the heap+TOAST comes across.
    const verdict = reclaimHeadroomVerdict({
      freeBytes: 100 * GIB,
      sourceTotalBytes: 10 * GIB,
      sourceIndexBytes: 2 * GIB,
      referencedFraction: 0.5,
    });
    expect(verdict.shadowEstimateBytes).toBe(4 * GIB + 2 * GIB - 2 * GIB + 2 * GIB);
    expect(verdict.shadowEstimateBytes).toBe(6 * GIB);
  });

  it("REFUSES when free space cannot hold source + skinny + WAL", () => {
    const verdict = reclaimHeadroomVerdict({
      freeBytes: 13 * GIB,
      sourceTotalBytes: 10 * GIB,
      sourceIndexBytes: 2 * GIB,
      referencedFraction: 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/< required/);
  });

  it("clamps a nonsense fraction rather than producing a nonsense budget", () => {
    expect(reclaimHeadroomVerdict({
      freeBytes: 100 * GIB,
      sourceTotalBytes: 10 * GIB,
      sourceIndexBytes: 2 * GIB,
      referencedFraction: 5,
    }).shadowEstimateBytes).toBe(2 * GIB);
    expect(reclaimHeadroomVerdict({
      freeBytes: 100 * GIB,
      sourceTotalBytes: 10 * GIB,
      sourceIndexBytes: 2 * GIB,
      referencedFraction: -1,
    }).shadowEstimateBytes).toBe(10 * GIB);
  });

  it("a VACUUM FULL budgets the whole relation twice over", () => {
    expect(vacuumFullHeadroomVerdict({ freeBytes: 25 * GIB, relationTotalBytes: 10 * GIB }).ok)
      .toBe(true);
    expect(vacuumFullHeadroomVerdict({ freeBytes: 15 * GIB, relationTotalBytes: 10 * GIB }).ok)
      .toBe(false);
  });
});

describe("verify verdict freshness", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const fresh = new Date(now.getTime() - 60_000);

  it("blesses a fresh ok verdict with no later backfill", () => {
    expect(verifyVerdictFreshness({
      verifiedAt: fresh,
      verifyVerdict: "ok",
      backfillCompletedAt: new Date(now.getTime() - 3_600_000),
      now,
    })).toEqual({ ok: true });
  });

  it("refuses when no verify has ever settled for the scope", () => {
    const verdict = verifyVerdictFreshness({
      verifiedAt: null,
      verifyVerdict: null,
      backfillCompletedAt: null,
      now,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no settled/);
  });

  it("refuses a verdict that was itself a refusal", () => {
    const verdict = verifyVerdictFreshness({
      verifiedAt: fresh,
      verifyVerdict: "refused",
      backfillCompletedAt: null,
      now,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/said "refused"/);
  });

  it("refuses a stale verdict", () => {
    const verdict = verifyVerdictFreshness({
      verifiedAt: new Date(now.getTime() - VERIFY_VERDICT_MAX_AGE_MS - 1000),
      verifyVerdict: "ok",
      backfillCompletedAt: null,
      now,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/old/);
  });

  // The subtle one: the verdict is fresh in wall-clock terms and describes a
  // scope that has since been rewritten under it.
  it("refuses when a backfill finished AFTER the verify", () => {
    const verdict = verifyVerdictFreshness({
      verifiedAt: new Date(now.getTime() - 3_600_000),
      verifyVerdict: "ok",
      backfillCompletedAt: new Date(now.getTime() - 60_000),
      now,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/AFTER the verify/);
  });
});

describe("index-definition matching", () => {
  const partition = "observations_2026_07";
  const shadow = "observations_2026_07__skinny";

  it("two definitions of the same index over different relations normalize equal", () => {
    const source =
      `CREATE INDEX observations_2026_07_kind_received_idx ON public.${partition} `
      + "USING btree (kind, received_at)";
    const copy =
      `CREATE INDEX ${shadow}_kind_idx ON public.${shadow} USING btree (kind, received_at)`;
    expect(normalizeIndexDef(source, partition, shadow))
      .toBe(normalizeIndexDef(copy, partition, shadow));
  });

  it("a genuinely different index does NOT normalize equal", () => {
    const a = `CREATE INDEX x ON public.${partition} USING btree (kind, received_at)`;
    const b = `CREATE INDEX y ON public.${shadow} USING btree (account_id, received_at)`;
    expect(normalizeIndexDef(a, partition, shadow))
      .not.toBe(normalizeIndexDef(b, partition, shadow));
  });

  it("a partial index keeps its predicate in the comparison", () => {
    const full = `CREATE INDEX a ON public.${partition} USING btree (harvest_machine_id)`;
    const partial = `CREATE INDEX b ON public.${shadow} USING btree (harvest_machine_id) `
      + "WHERE (source = 'client_capture'::text)";
    expect(normalizeIndexDef(full, partition, shadow))
      .not.toBe(normalizeIndexDef(partial, partition, shadow));
  });

  it("uniqueness is part of the identity", () => {
    const plain = `CREATE INDEX a ON public.${partition} USING btree (id)`;
    const unique = `CREATE UNIQUE INDEX b ON public.${shadow} USING btree (id)`;
    expect(normalizeIndexDef(plain, partition, shadow))
      .not.toBe(normalizeIndexDef(unique, partition, shadow));
  });
});
