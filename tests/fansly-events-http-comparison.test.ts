import { describe, expect, it } from "vitest";
import { compareHttpSnapshots, parseHttpSnapshot } from "../scripts/fansly-events/compare-http.ts";
import { measurementArtifact, measurementFixture } from "./helpers/fansly-http-measurement.ts";

function snapshot(report = measurementFixture()) {
  const { bytes, manifest } = measurementArtifact(report);
  return parseHttpSnapshot(bytes, manifest);
}
function comparison(before = measurementFixture(), after = measurementFixture("2026-09-08", "2026-09-09")) {
  return compareHttpSnapshots(snapshot(before), snapshot(after), ["lilly-1"]);
}

describe("retained HTTP count comparison", () => {
  it("includes every source, failures and retries once, with a fixed page cohort", () => {
    const before = measurementFixture();
    for (const source of ["manual", "anomaly", "recovery", "event"]) {
      before.attempts.push({ ...before.attempts[0]!, source, attempts: 3, retry_attempts: 1, state: "retry" });
    }
    before.attempts.push({ ...before.attempts[0]!, state: "failed", attempts: 1, retry_attempts: 0, http_status: 429 });
    // Other pages cannot contaminate this cohort; attempt source need not equal run source.
    before.attempts.push({ ...before.attempts[0]!, page_id: 5, page_label: "lilly-2", attempts: 999 });
    const result = comparison(before);
    expect(result.baseline).toMatchObject({
      recordedAttempts: 23, retryAttempts: 6, retryOutcomes: 12, failedAttempts: 1, http429: 1,
    });
    expect(result.baseline.bySource).toHaveLength(5);
    expect(result.observedRecordedAttemptDelta).toBe(-13);
    expect(result.observedAttemptChangePercent).toBeCloseTo(-13 / 23 * 100);
    expect(result.eligibleForObservedCountComparison).toBe(true);
    expect(result.causalSavings).toBe("unverified");
    expect(result.readerLatency).toBe("unmeasured");
  });

  it("retains all-null loss counters as unknown, including boundary runs before the window", () => {
    const before = measurementFixture();
    Object.assign(before.httpCoverage[0]!, {
      day: "2026-08-31", boundary_runs: 5, unknown_runs: 5, unrecorded_attempts: null, unfinished_attempts: null,
    });
    const result = comparison(before);
    expect(result.baseline.coverage).toMatchObject({
      unknownRuns: 5, boundaryRuns: 5, reportedUnrecordedAttempts: null, reportedUnfinishedAttempts: null,
    });
    expect(result.observedAttemptChangePercent).toBeNull();
    expect(result.blockers).toContainEqual({ window: "baseline", page: "lilly-1", reason: "run_telemetry_incomplete" });
  });

  it("does not hide null groups behind a known zero sum", () => {
    const before = measurementFixture();
    before.httpCoverage.push({ ...before.httpCoverage[0]!, source: "manual", unrecorded_attempts: null });
    const result = comparison(before);
    expect(result.baseline.coverage.reportedUnrecordedAttempts).toBe(0);
    expect(result.baseline.coverage.nullLossCounterGroups).toBe(1);
    expect(result.eligibleForObservedCountComparison).toBe(false);
  });

  it("allows boundary runs with fully known zero losses and unknown payload sizes", () => {
    const before = measurementFixture();
    before.httpCoverage[0]!.boundary_runs = 2;
    Object.assign(before.attempts[0]!, { unknown_bytes: 10, captured_payload_bytes: null });
    const result = comparison(before);
    expect(result.eligibleForObservedCountComparison).toBe(true);
    expect(result.baseline.knownCapturedPayloadBytes).toBeNull();
    expect(result.baseline.unknownBytes).toBe(10);
  });

  it.each([
    ["unrecorded_attempts", { unrecorded_attempts: 1 }],
    ["unfinished_attempts", { unfinished_attempts: 1 }],
    ["run_telemetry_incomplete", { unknown_runs: 1 }],
  ])("blocks a count conclusion for %s", (reason, change) => {
    const before = measurementFixture();
    Object.assign(before.httpCoverage[0]!, change);
    expect(comparison(before).blockers).toContainEqual({ window: "baseline", page: "lilly-1", reason });
  });

  it("blocks an unsettled physical attempt even if run counters say zero", () => {
    const before = measurementFixture();
    before.attempts[0]!.state = "started";
    expect(comparison(before).blockers).toContainEqual({ window: "baseline", page: "lilly-1", reason: "unfinished_attempts" });
  });

  it("requires page and stream run coverage, without requiring attempt/run source equality", () => {
    const before = measurementFixture();
    before.httpCoverage = [];
    expect(comparison(before).blockers.map((b) => b.reason)).toContain("run_coverage_missing");
    before.httpCoverage = [{ ...measurementFixture().httpCoverage[0]!, stream: "followers" }];
    expect(comparison(before).blockers.map((b) => b.reason)).toContain("attempt_stream_coverage_missing");
  });

  it("does not infer page identity or a percent change from an empty baseline", () => {
    const before = measurementFixture();
    before.attempts = [];
    const result = comparison(before);
    expect(result.baseline.recordedAttempts).toBe(0);
    expect(result.observedAttemptChangePercent).toBeNull();
    expect(result.blockers.map((b) => b.reason)).toContain("page_identity_unverified");
  });

  it("detects a reused page label belonging to another ID", () => {
    const after = measurementFixture("2026-09-08", "2026-09-09");
    after.attempts[0]!.page_id = 99;
    expect(comparison(undefined, after).blockers).toContainEqual({ window: "pair", page: "lilly-1", reason: "page_identity_changed" });
  });

  it("reports unequal, partial, overlapping and reversed windows as incomparable", () => {
    const before = measurementFixture();
    expect(comparison(before, measurementFixture("2026-09-08", "2026-09-10")).blockers)
      .toContainEqual({ window: "pair", reason: "unequal_duration" });
    before.windowStart = "2026-09-01T01:00:00Z";
    expect(comparison(before).blockers).toContainEqual({ window: "pair", reason: "whole_utc_days_required" });
    expect(comparison(undefined, measurementFixture()).blockers)
      .toContainEqual({ window: "pair", reason: "windows_overlap_or_reversed" });
    expect(comparison(measurementFixture("2026-09-08", "2026-09-09"), measurementFixture()).blockers)
      .toContainEqual({ window: "pair", reason: "windows_overlap_or_reversed" });
  });

  it("verifies exact report bytes and sweep count, not attempt count", () => {
    const { bytes, manifest } = measurementArtifact(measurementFixture());
    expect(() => parseHttpSnapshot(bytes, manifest)).not.toThrow();
    expect(() => parseHttpSnapshot(Buffer.concat([bytes, Buffer.from(" ")]), manifest)).toThrow("report_hash_mismatch");
    expect(() => parseHttpSnapshot(bytes, { ...manifest, records: 10 })).toThrow("invalid_report_window_or_manifest");
  });

  it("never rounds PostgreSQL microsecond window bounds to whole UTC days", () => {
    const before = measurementFixture();
    before.windowStart = "2026-09-01T00:00:00.000001+00:00";
    expect(() => snapshot(before)).toThrow("submillisecond_window_bound");
    before.windowStart = "2026-09-01T00:00:00.000000+00:00";
    expect(comparison(before).eligibleForObservedCountComparison).toBe(true);
    const { bytes, manifest } = measurementArtifact(before);
    expect(() => parseHttpSnapshot(bytes, { ...manifest, from: "2026-09-01T00:00:00.000002+00:00" }))
      .toThrow("submillisecond_window_bound");
    expect(() => parseHttpSnapshot(bytes, { ...manifest, to: "2026-09-02T00:00:00.000001+00:00" }))
      .toThrow("submillisecond_window_bound");
  });

  it.each([
    { from: "2026-09-01T01:00:00Z" },
    { startedAt: "2026-09-01T23:59:59Z" },
    { completedAt: "2026-09-01T00:00:00Z" },
    { operation: "corpus" },
  ])("rejects mismatched or unfinished export metadata: %j", (change) => {
    const { bytes, manifest } = measurementArtifact(measurementFixture());
    expect(() => parseHttpSnapshot(bytes, { ...manifest, ...change })).toThrow();
  });

  it("rejects duplicate aggregates, conflicting identities and impossible counters", () => {
    const before = measurementFixture();
    before.attempts.push({ ...before.attempts[0]! });
    expect(() => snapshot(before)).toThrow("duplicate_aggregate_group");
    before.attempts[1]!.page_id = 7;
    expect(() => snapshot(before)).toThrow("inconsistent_attempt_aggregate");
    before.attempts.pop();
    before.attempts[0]!.retry_attempts = 11;
    expect(() => snapshot(before)).toThrow("inconsistent_attempt_aggregate");
    before.attempts[0]!.retry_attempts = 2;
    before.attempts[0]!.day = "2026-09-02";
    expect(() => snapshot(before)).toThrow("inconsistent_attempt_aggregate");
  });

  it("rejects unsafe totals and repeated/empty page selection", () => {
    const before = measurementFixture();
    before.attempts[0]!.attempts = Number.MAX_SAFE_INTEGER;
    before.attempts.push({ ...before.attempts[0]!, source: "manual", attempts: 10 });
    expect(() => comparison(before)).toThrow("unsafe_count_total");
    const parsed = snapshot();
    expect(() => compareHttpSnapshots(parsed, parsed, [])).toThrow();
    expect(() => compareHttpSnapshots(parsed, parsed, ["lilly-1", "lilly-1"])).toThrow();
  });

  it("does not propagate additive raw metadata into its allowlisted output", () => {
    const before = measurementFixture();
    Object.assign(before, { secret: "sensitive-sentinel" });
    Object.assign(before.attempts[0]!, { headers: { authorization: "sensitive-sentinel" } });
    expect(JSON.stringify(comparison(before))).not.toContain("sensitive-sentinel");
  });
});
