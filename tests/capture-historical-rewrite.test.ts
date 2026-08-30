// G5 slice 3c-2 — the pure judgements, without Docker.
//
// Four decisions in this slice are functions of their arguments and nothing
// else, and each of them is the kind that is easy to get subtly wrong and hard
// to notice: what scope did the operator name, is this month safe to touch,
// does the disk hold the operation, and is a verify verdict still worth
// anything. They live in scope.ts precisely so they can be proved here.

import { describe, expect, it } from "vitest";

import {
  backfillHeadroomVerdict,
  captureRewriteForecast,
  CAPTURE_REWRITE_FREE_FLOOR_BYTES,
  currentMonthVerdict,
  headroomRecheckDue,
  CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES,
  monthUtcRange,
  normalizeIndexDef,
  observationPartitionName,
  parkedRelationName,
  parseCaptureRewriteScope,
  reclaimHeadroomVerdict,
  shadowRelationName,
  vacuumFullHeadroomVerdict,
  VACUUM_FULL_COMPACT_SAFETY_FACTOR,
  walReserveBytes,
  WAL_RESERVE_MAX_WAL_SIZE_FACTOR,
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

});

// ---------------------------------------------------------------------------
// Decision #239 — the arithmetic that made the gate satisfiable again.
//
// Production numbers, all measured 2026-08-26 on the box these tests describe:
//   sync_raw_payloads   22.13 GB on disk, ~0.57 GB body-free compact
//   observations 2026-07 10.87 GB on disk, 0.29 GB indexes
//   July run 1          ~4.2 GB inline -> 1.81 GB catalog = 0.43x
//   max_wal_size 1 GiB, archive_mode off, 0 replication slots
const MB = 1024 ** 2;
const PROD = {
  rawTotal: 22.13e9,
  rawCompact: 0.57e9,
  julyTotal: 10.87e9,
  julyIndexes: 0.29e9,
  maxWalSize: 1 * GIB,
  // What ONE body costs in the catalog (spread sample, production 2026-08-26).
  julyCompression: 1.0009,
  // Measured but NOT spent: 362,804 referenced rows -> 206,659 objects.
  julyDedup: 0.5696,
};
const WAL_ENV_OK = {
  maxWalSizeBytes: PROD.maxWalSize,
  // Production reads 0 today; the term exists so that setting it later cannot
  // silently invalidate a gate nobody re-derived.
  walKeepSizeBytes: 0,
  archiveModeOff: true,
  replicationSlots: 0,
};

describe("#239 — the WAL term", () => {
  it("bounds the reserve by max_wal_size when nothing can pin a segment", () => {
    const reserve = walReserveBytes({ copyBytes: 40 * GIB, ...WAL_ENV_OK });
    expect(reserve.basis).toBe("bounded_by_max_wal_size");
    expect(reserve.bytes).toBe(WAL_RESERVE_MAX_WAL_SIZE_FACTOR * PROD.maxWalSize);
  });

  it("ADDS wal_keep_size on top — it retains WAL the checkpointer does not control", () => {
    const keep = 512 * MB;
    const reserve = walReserveBytes({ copyBytes: 40 * GIB, ...WAL_ENV_OK, walKeepSizeBytes: keep });
    expect(reserve.basis).toBe("bounded_by_max_wal_size");
    expect(reserve.bytes).toBe(WAL_RESERVE_MAX_WAL_SIZE_FACTOR * PROD.maxWalSize + keep);
  });

  it("treats an UNREADABLE wal_keep_size as no bound at all, but a legitimate 0 as a value", () => {
    expect(walReserveBytes({ copyBytes: 40 * GIB, ...WAL_ENV_OK, walKeepSizeBytes: null }).basis)
      .toBe("full_copy_fallback");
    expect(walReserveBytes({ copyBytes: 40 * GIB, ...WAL_ENV_OK, walKeepSizeBytes: 0 }).basis)
      .toBe("bounded_by_max_wal_size");
  });

  it("never reserves MORE than the copy itself", () => {
    // A tiny copy on a box with a huge max_wal_size still only writes the copy.
    expect(walReserveBytes({ copyBytes: 100 * MB, ...WAL_ENV_OK }).bytes).toBe(100 * MB);
  });

  it("falls back to the OLD 1:1 reserve the moment an archiver could be behind", () => {
    const archiving = walReserveBytes({
      copyBytes: 40 * GIB,
      maxWalSizeBytes: PROD.maxWalSize,
      walKeepSizeBytes: 0,
      archiveModeOff: false,
      replicationSlots: 0,
    });
    expect(archiving.basis).toBe("full_copy_fallback");
    expect(archiving.bytes).toBe(40 * GIB);
  });

  it("falls back the moment a replication slot exists", () => {
    const slotted = walReserveBytes({
      copyBytes: 40 * GIB,
      maxWalSizeBytes: PROD.maxWalSize,
      walKeepSizeBytes: 0,
      archiveModeOff: true,
      replicationSlots: 1,
    });
    expect(slotted.basis).toBe("full_copy_fallback");
    expect(slotted.bytes).toBe(40 * GIB);
  });

  it("falls back when max_wal_size could not be read", () => {
    expect(walReserveBytes({
      copyBytes: 40 * GIB,
      maxWalSizeBytes: 0,
      walKeepSizeBytes: 0,
      archiveModeOff: true,
      replicationSlots: 0,
    }).basis).toBe("full_copy_fallback");
  });
});

describe("#239 — the backfill admission gate", () => {
  const july = (freeBytes: number, overrides: Partial<Parameters<typeof backfillHeadroomVerdict>[0]> = {}) =>
    backfillHeadroomVerdict({
      freeBytes,
      sourceTotalBytes: PROD.julyTotal,
      // 548,350 rows left x 11,934.7 B, as the spread probe measured it on
      // production 2026-08-26 (ground truth 11,071.8 B — the probe is 7.8% high).
      inlineBytesToCopy: 6.545e9,
      // Compression alone — #239 R3: the budget takes NO dedup credit, because
      // the factor is learned from the already-copied prefix and would be spent
      // on a different population.
      copyRatio: PROD.julyCompression,
      ...WAL_ENV_OK,
      ...overrides,
    });

  it("ADMITS the July scope at the free space Phase A actually produces", () => {
    // copy 6.545 GB x 1.0009 = 6.55 GB (no dedup credit — R3);
    // WAL min(6.55 GB, 4 x 1 GiB + 0) = 4.295 GB; + 5 GiB floor = 15.10 GiB.
    // Phase A left 17.87 GiB free, so it admits with ~2.8 GiB of margin.
    const verdict = july(17.87 * GIB);
    expect(verdict.ok).toBe(true);
    expect(verdict.requiredBytes).toBeLessThan(16 * GIB);
    expect(verdict.walBasis).toBe("bounded_by_max_wal_size");
  });

  it("REFUSES the same scope at the free space that stranded run 1", () => {
    expect(july(9.46 * GIB).ok).toBe(false);
    expect(july(9.46 * GIB).reason).toMatch(/< required/);
  });

  it("makes the raw whole-table scope reachable, which the old arithmetic did not", () => {
    // The old term asked 40.41 GiB free on a 79 GiB disk holding 55 GiB of
    // database: unsatisfiable by ANY amount of lawful reclaiming.
    const raw = backfillHeadroomVerdict({
      freeBytes: 30 * GIB,
      sourceTotalBytes: PROD.rawTotal,
      inlineBytesToCopy: 18e9,
      copyRatio: 1,
      ...WAL_ENV_OK,
    });
    // 18 GB copy + WAL capped at 4 x 1 GiB + 5 GiB floor = ~26.6 GiB, against
    // the old term's 40.41 GiB. The WAL cap is what makes it reachable at all.
    expect(raw.requiredBytes).toBeLessThan(28 * GIB);
    expect(raw.walBasis).toBe("bounded_by_max_wal_size");
  });

  it("still REFUSES the raw scope on the free space this job started with", () => {
    expect(backfillHeadroomVerdict({
      freeBytes: 9.46 * GIB,
      sourceTotalBytes: PROD.rawTotal,
      inlineBytesToCopy: 18e9,
      copyRatio: 1,
      ...WAL_ENV_OK,
    }).ok).toBe(false);
  });

  it("takes NO dedup credit: the same inline bytes cost the same however they dedupe", () => {
    // R3: the dedup factor is learned from the already-copied PREFIX and would
    // be spent on the unreferenced REMAINDER — a different population. A
    // duplicate-heavy prefix must not buy the walk a budget it cannot pay for.
    const asMeasured = july(17.87 * GIB, { copyRatio: PROD.julyCompression });
    const withDedupCredit = july(17.87 * GIB, {
      copyRatio: PROD.julyCompression * PROD.julyDedup,
    });
    expect(withDedupCredit.requiredBytes).toBeLessThan(asMeasured.requiredBytes);
    // What the gate actually uses is the one WITHOUT the credit.
    expect(asMeasured.shadowEstimateBytes)
      .toBe(Math.round(6.545e9 * PROD.julyCompression));
  });

  it("falls back to byte-for-byte parity when no sample taught it a ratio", () => {
    const parity = july(40 * GIB, { copyRatio: 1 });
    expect(parity.shadowEstimateBytes).toBe(6.545e9);
  });

  it("treats a nonsense ratio as no ratio at all rather than as a small one", () => {
    for (const copyRatio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(july(40 * GIB, { copyRatio }).shadowEstimateBytes).toBe(6.545e9);
    }
  });

  it("keeps the 5 GiB floor as a term nothing can measure away", () => {
    // Nothing left to copy at all still asks for the floor.
    const empty = july(40 * GIB, { inlineBytesToCopy: 0 });
    expect(empty.requiredBytes).toBe(CAPTURE_REWRITE_FREE_FLOOR_BYTES);
    expect(july(4 * GIB, { inlineBytesToCopy: 0 }).ok).toBe(false);
  });
});

describe("#239 — the VACUUM FULL gate", () => {
  const raw = (freeBytes: number, compactEstimateBytes = PROD.rawCompact) =>
    vacuumFullHeadroomVerdict({
      freeBytes,
      relationTotalBytes: PROD.rawTotal,
      compactEstimateBytes,
      ...WAL_ENV_OK,
    });

  it("sizes on what the rewrite WRITES, not on what the bloated relation weighs", () => {
    const verdict = raw(20 * GIB);
    // 0.57 GB x2 = 1.14 GB, WAL min(1.14 GB, 4 GiB) = 1.14 GB, + 5 GiB floor.
    expect(verdict.shadowEstimateBytes)
      .toBe(Math.round(PROD.rawCompact * VACUUM_FULL_COMPACT_SAFETY_FACTOR));
    expect(verdict.requiredBytes).toBeLessThan(8 * GIB);
    expect(verdict.ok).toBe(true);
  });

  it("ADMITS the rewrite at the free space Phase A + C2 produce", () => {
    expect(raw(14 * GIB).ok).toBe(true);
  });

  it("REFUSES when the volume cannot even hold the compact copy plus the floor", () => {
    expect(raw(5 * GIB).ok).toBe(false);
    expect(raw(5 * GIB).reason).toMatch(/< required/);
  });

  it("refuses to believe a compact estimate larger than the relation", () => {
    const nonsense = raw(100 * GIB, PROD.rawTotal * 4);
    expect(nonsense.shadowEstimateBytes)
      .toBe(Math.round(PROD.rawTotal * VACUUM_FULL_COMPACT_SAFETY_FACTOR));
  });

  it("keeps the floor: a zero-byte relation still asks for it", () => {
    expect(raw(4 * GIB, 0).ok).toBe(false);
    expect(raw(4 * GIB, 0).requiredBytes).toBe(CAPTURE_REWRITE_FREE_FLOOR_BYTES);
  });

  it("reports the relation's real size for the journal even though the inequality ignores it", () => {
    expect(raw(20 * GIB).sourceTotalBytes).toBe(PROD.rawTotal);
  });
});

describe("#239 — the mid-walk floor re-check cadence", () => {
  const roomy = CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES + GIB;
  const tight = CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES - 1;
  const due = (batchesDone: number, lastFreeBytes: number | null) =>
    headroomRecheckDue({ batchesDone, lastFreeBytes, cadenceBatches: 10 });

  it("keeps the cheap ten-batch cadence while the volume has room", () => {
    expect(due(1, roomy)).toBe(false);
    expect(due(9, roomy)).toBe(false);
    expect(due(10, roomy)).toBe(true);
    expect(due(20, roomy)).toBe(true);
  });

  it("re-reads the volume EVERY batch once free space is below the threshold", () => {
    for (const batchesDone of [1, 2, 3, 7, 11]) {
      expect(due(batchesDone, tight)).toBe(true);
    }
  });

  it("treats an UNKNOWN reading as tight, never as roomy", () => {
    // A gate whose input is missing must not be the reason a check was skipped.
    expect(due(1, null)).toBe(true);
    expect(due(1, Number.NaN)).toBe(true);
  });

  it("never fires before the first batch has run", () => {
    expect(due(0, tight)).toBe(false);
    expect(due(0, null)).toBe(false);
  });
});

describe("#239 — the completion forecast", () => {
  it("says the scope gets BIGGER before it gets smaller", () => {
    const forecast = captureRewriteForecast({
      table: "observations",
      census: { rows: 911_154, referenced: 362_804, unreferencedWithBody: 548_350 },
      copyBytes: 2.71e9,
      sourceTotalBytes: PROD.julyTotal,
      sourceIndexBytes: PROD.julyIndexes,
    });
    expect(forecast.rowsToStamp).toBe(548_350);
    expect(forecast.backfillGrowthBytes).toBe(2.71e9);
    expect(forecast.reclaimReturnBytes).toBe(PROD.julyTotal - PROD.julyIndexes);
    expect(forecast.netBytes).toBeGreaterThan(0);
    expect(forecast.line).toMatch(/BIGGER on disk/);
    expect(forecast.line).toMatch(/parked copy is dropped/);
  });

  it("reports a NEGATIVE net when the copy costs more than the reclaim returns", () => {
    const forecast = captureRewriteForecast({
      table: "observations",
      census: { rows: 10, referenced: 0, unreferencedWithBody: 10 },
      copyBytes: 5e9,
      sourceTotalBytes: 1e9,
      sourceIndexBytes: 0.9e9,
      });
    expect(forecast.netBytes).toBeLessThan(0);
    expect(forecast.line).toMatch(/net -/);
  });

  it("names VACUUM FULL, not a parked copy, for sync_raw_payloads", () => {
    const forecast = captureRewriteForecast({
      table: "sync_raw_payloads",
      census: { rows: 10, referenced: 10, unreferencedWithBody: 0 },
      copyBytes: 0,
      sourceTotalBytes: 10e9,
      sourceIndexBytes: 1e9,
    });
    expect(forecast.line).toMatch(/when VACUUM FULL finishes/);
    expect(forecast.line).toMatch(/Until that rewrite completes/);
    expect(forecast.line).not.toMatch(/parked copy/);
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
