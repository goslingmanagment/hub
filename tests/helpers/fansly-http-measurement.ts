import { createHash } from "node:crypto";

export function measurementFixture(day = "2026-09-01", to = "2026-09-02") {
  return {
    windowStart: `${day}T00:00:00+00:00`, windowEnd: `${to}T00:00:00+00:00`,
    sweeps: [], dmCoverage: [],
    attempts: [{
      page_id: 4, page_label: "lilly-1", stream: "dm_conversations", operation: "messaging_groups",
      source: "scheduled", day, state: "success", failure_kind: null, http_status: 200,
      attempts: 10, retry_attempts: 2, unknown_bytes: 0, captured_payload_bytes: 1000,
    }],
    httpCoverage: [{
      page_label: "lilly-1", stream: "dm_conversations", source: "scheduled", day,
      runs: 5, boundary_runs: 0, unknown_runs: 0,
      unrecorded_attempts: 0 as number | null, unfinished_attempts: 0 as number | null,
    }],
  };
}

export function measurementArtifact(report: { windowStart: string; windowEnd: string; sweeps: unknown[] }) {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  return { bytes, manifest: {
    operation: "report", from: report.windowStart, to: report.windowEnd,
    startedAt: "2026-09-13T09:44:49.866369+00:00", completedAt: "2026-09-13T09:44:55.300183+00:00",
    records: report.sweeps.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    atomicSnapshot: false,
  } };
}
