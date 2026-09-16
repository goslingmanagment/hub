import { createHash } from "node:crypto";
import { z } from "zod";

const DAY = 86_400_000;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const day = z.iso.date();
const attemptSchema = z.object({
  page_id: count.positive(), page_label: name, stream: name, operation: name,
  source: name, day, state: z.enum(["started", "success", "retry", "failed"]),
  failure_kind: name.nullable(), http_status: z.number().int().min(100).max(599).nullable(),
  attempts: count.positive(), retry_attempts: count, unknown_bytes: count,
  captured_payload_bytes: count.nullable(),
});
const coverageSchema = z.object({
  page_label: name, stream: name, source: name, day,
  runs: count.positive(), boundary_runs: count, unknown_runs: count,
  unrecorded_attempts: count.nullable(), unfinished_attempts: count.nullable(),
});
const reportSchema = z.object({
  windowStart: timestamp, windowEnd: timestamp,
  attempts: z.array(attemptSchema).max(100_000),
  httpCoverage: z.array(coverageSchema).max(100_000),
  sweeps: z.array(z.unknown()).max(100_000),
});
const manifestSchema = z.object({
  operation: z.literal("report"), from: timestamp, to: timestamp,
  startedAt: timestamp, completedAt: timestamp,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), records: count,
  atomicSnapshot: z.literal(false),
});
type Attempt = z.infer<typeof attemptSchema>;
type Coverage = z.infer<typeof coverageSchema>;

function sum(values: number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error("unsafe_count_total");
  return result;
}

function nullableSum(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : sum(known);
}

function unique(keys: string[]) {
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_aggregate_group");
}

function windowInstant(value: string) {
  // Date.parse truncates submillisecond precision. Never round a partial UTC
  // day to midnight or hide a mismatch between report and manifest bounds.
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  if (/[1-9]/.test(fraction.slice(3))) throw new Error("submillisecond_window_bound");
  return Date.parse(value);
}

/** Validate the exact retained bytes, not reserialized JSON. Hashes bind files;
 * they do not authenticate the exporter or prove a complete physical census. */
export function parseHttpSnapshot(bytes: Buffer, manifestInput: unknown) {
  const manifest = manifestSchema.parse(manifestInput);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new Error("report_hash_mismatch");
  }
  const report = reportSchema.parse(JSON.parse(bytes.toString("utf8")));
  const from = windowInstant(report.windowStart);
  const to = windowInstant(report.windowEnd);
  if (from !== windowInstant(manifest.from) || to !== windowInstant(manifest.to)
    || from >= to || to - from > 8 * DAY
    || to > Date.parse(manifest.startedAt)
    || Date.parse(manifest.startedAt) > Date.parse(manifest.completedAt)
    || manifest.records !== report.sweeps.length) {
    throw new Error("invalid_report_window_or_manifest");
  }
  const labels = new Map<string, number>();
  const ids = new Map<number, string>();
  for (const row of report.attempts) {
    const startOfDay = Date.parse(`${row.day}T00:00:00Z`);
    if (startOfDay >= to || startOfDay + DAY <= from
      || row.retry_attempts > row.attempts || row.unknown_bytes > row.attempts
      || (row.captured_payload_bytes === null) !== (row.unknown_bytes === row.attempts)
      || (labels.has(row.page_label) && labels.get(row.page_label) !== row.page_id)
      || (ids.has(row.page_id) && ids.get(row.page_id) !== row.page_label)) {
      throw new Error("inconsistent_attempt_aggregate");
    }
    labels.set(row.page_label, row.page_id);
    ids.set(row.page_id, row.page_label);
  }
  for (const row of report.httpCoverage) {
    // Run coverage can start before the window. Its losses cannot be assigned
    // to an exact attempt time, so it must not be trimmed to the attempt days.
    if (Date.parse(`${row.day}T00:00:00Z`) >= to
      || row.boundary_runs > row.runs || row.unknown_runs > row.runs) {
      throw new Error("inconsistent_run_coverage");
    }
  }
  unique(report.attempts.map((r) => JSON.stringify([
    r.page_id, r.stream, r.operation, r.source, r.day, r.state, r.failure_kind, r.http_status,
  ])));
  unique(report.httpCoverage.map((r) => JSON.stringify([r.page_label, r.stream, r.source, r.day])));
  return { report, manifest, from, to, labels };
}
type Snapshot = ReturnType<typeof parseHttpSnapshot>;

function attemptTotals(rows: Attempt[]) {
  const matching = (predicate: (row: Attempt) => boolean) => sum(rows.filter(predicate).map((r) => r.attempts));
  return {
    recordedAttempts: sum(rows.map((r) => r.attempts)),
    retryAttempts: sum(rows.map((r) => r.retry_attempts)),
    retryOutcomes: matching((r) => r.state === "retry"),
    failedAttempts: matching((r) => r.state === "failed"),
    startedAttempts: matching((r) => r.state === "started"),
    http429: matching((r) => r.http_status === 429),
    knownCapturedPayloadBytes: nullableSum(rows.map((r) => r.captured_payload_bytes)),
    unknownBytes: sum(rows.map((r) => r.unknown_bytes)),
  };
}

function coverageTotals(rows: Coverage[]) {
  return {
    overlappingRuns: sum(rows.map((r) => r.runs)),
    boundaryRuns: sum(rows.map((r) => r.boundary_runs)),
    unknownRuns: sum(rows.map((r) => r.unknown_runs)),
    // Partial sums stay explicitly reported sums; unknownRuns/null groups
    // remain separate and disqualify a complete count comparison.
    reportedUnrecordedAttempts: nullableSum(rows.map((r) => r.unrecorded_attempts)),
    reportedUnfinishedAttempts: nullableSum(rows.map((r) => r.unfinished_attempts)),
    nullLossCounterGroups: rows.filter((r) => r.unrecorded_attempts === null || r.unfinished_attempts === null).length,
  };
}

function groupedAttempts(rows: Attempt[], key: "source" | "stream") {
  const groups = new Map<string, Attempt[]>();
  for (const row of rows) {
    const group = groups.get(row[key]) ?? [];
    group.push(row);
    groups.set(row[key], group);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([value, group]) => ({ [key]: value, ...attemptTotals(group) }));
}

function summarize(snapshot: Snapshot, pages: string[]) {
  const selected = new Set(pages);
  const attempts = snapshot.report.attempts.filter((r) => selected.has(r.page_label));
  const coverage = snapshot.report.httpCoverage.filter((r) => selected.has(r.page_label));
  const byPage = pages.map((page) => {
    const pageAttempts = attempts.filter((r) => r.page_label === page);
    const pageCoverage = coverage.filter((r) => r.page_label === page);
    const streams = new Set(pageCoverage.map((r) => r.stream));
    const totals = attemptTotals(pageAttempts);
    const runCoverage = coverageTotals(pageCoverage);
    const problems: string[] = [];
    if (!snapshot.labels.has(page)) problems.push("page_identity_unverified");
    if (pageCoverage.length === 0) problems.push("run_coverage_missing");
    if (pageAttempts.some((r) => !streams.has(r.stream))) problems.push("attempt_stream_coverage_missing");
    if (runCoverage.unknownRuns > 0 || runCoverage.nullLossCounterGroups > 0) problems.push("run_telemetry_incomplete");
    if ((runCoverage.reportedUnrecordedAttempts ?? 0) > 0) problems.push("unrecorded_attempts");
    if ((runCoverage.reportedUnfinishedAttempts ?? 0) > 0 || totals.startedAttempts > 0) problems.push("unfinished_attempts");
    return { page, pageId: snapshot.labels.get(page) ?? null, ...totals, coverage: runCoverage, problems };
  });
  return {
    windowStart: new Date(snapshot.from).toISOString(), windowEnd: new Date(snapshot.to).toISOString(),
    reportSha256: snapshot.manifest.sha256,
    exportedAt: snapshot.manifest.completedAt,
    ...attemptTotals(attempts), coverage: coverageTotals(coverage), byPage,
    bySource: groupedAttempts(attempts, "source"), byStream: groupedAttempts(attempts, "stream"),
  };
}

export function compareHttpSnapshots(baseline: Snapshot, current: Snapshot, pageLabels: string[]) {
  const pages = z.array(name).min(1).max(100).parse(pageLabels).sort();
  unique(pages);
  const before = summarize(baseline, pages);
  const after = summarize(current, pages);
  const blockers: { window: "baseline" | "current" | "pair"; page?: string; reason: string }[] = [];
  if (baseline.to - baseline.from !== current.to - current.from) {
    blockers.push({ window: "pair", reason: "unequal_duration" });
  }
  if ([baseline.from, baseline.to, current.from, current.to].some((value) => value % DAY !== 0)) {
    blockers.push({ window: "pair", reason: "whole_utc_days_required" });
  }
  if (baseline.to > current.from) blockers.push({ window: "pair", reason: "windows_overlap_or_reversed" });
  for (const [window, summary] of [["baseline", before], ["current", after]] as const) {
    for (const page of summary.byPage) {
      for (const reason of page.problems) blockers.push({ window, page: page.page, reason });
    }
  }
  for (const page of pages) {
    const left = baseline.labels.get(page);
    const right = current.labels.get(page);
    if (left !== undefined && right !== undefined && left !== right) {
      blockers.push({ window: "pair", page, reason: "page_identity_changed" });
    }
  }
  const eligible = blockers.length === 0;
  return {
    schemaVersion: 1,
    scope: "Fansly sync_http_attempts for the selected pages; every source, stream and state",
    pages, baseline: before, current: after,
    observedRecordedAttemptDelta: after.recordedAttempts - before.recordedAttempts,
    eligibleForObservedCountComparison: eligible,
    observedAttemptChangePercent: eligible && before.recordedAttempts > 0
      ? (after.recordedAttempts - before.recordedAttempts) / before.recordedAttempts * 100 : null,
    blockers,
    causalSavings: "unverified",
    readerLatency: "unmeasured",
    limitations: [
      "Retries and retry outcomes are subsets of recorded attempts, not additional requests.",
      "Run loss counters cover overlapping runs; boundary losses have no exact attempt timestamp.",
      "Equal closed windows do not establish equal workload, policy activation or freshness parity.",
      "Captured payload bytes are serialized payload sizes, not wire bytes or proxy spend.",
      "Browser/bootstrap HTTP and WebSocket traffic are outside this sync HTTP ledger.",
      "Manifest hashes bind retained files; exporter provenance must be verified separately.",
    ],
  };
}
