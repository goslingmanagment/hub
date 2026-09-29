import { describe, expect, it } from "vitest";

import { isSelfHosted, summarizeAttempts, summarizeRun } from "../scripts/ci-cost-report.mjs";

const run = { id: 1, name: "CI", event: "pull_request", conclusion: "success", run_attempt: 2 };
const job = { name: "Static checks", status: "completed", conclusion: "success",
  started_at: "2026-09-16T00:00:00Z", completed_at: "2026-09-16T00:01:01Z" };

describe("CI cost accounting", () => {
  it("rounds every executed job independently and counts cancelled work", () => {
    const summary = summarizeRun(run, [job, { ...job, name: "Integration 1/3", conclusion: "cancelled" },
      { ...job, name: "Quality Gate", conclusion: "skipped" }]);
    expect(summary.runner_minutes).toBe(4);
    expect(summary.cancelled_minutes).toBe(2);
    expect(summary.self_hosted_minutes).toBe(0);
    expect(summary.attempt).toBe(2);
    expect(summary.mode).toBe("full");
  });
  it("counts self-hosted pool minutes apart from billed hosted minutes", () => {
    const pc = { labels: ["self-hosted", "ci-pc"] };
    const summary = summarizeRun(run, [
      { ...job, ...pc },
      { ...job, name: "Integration 1/3", ...pc, conclusion: "cancelled" },
      { ...job, name: "Integration 2/3", labels: ["ubuntu-24.04-arm"] },
      { ...job, name: "Quality Gate", labels: ["ubuntu-slim"], started_at: "2026-09-16T00:00:00Z", completed_at: "2026-09-16T00:00:10Z" },
    ]);
    expect(summary.runner_minutes).toBe(3);
    expect(summary.self_hosted_minutes).toBe(4);
    // Cancelled work on the PC is not billed either.
    expect(summary.cancelled_minutes).toBe(0);
    expect(summary.by_job.map(item => [item.name, item.self_hosted])).toEqual([
      ["Static checks", true], ["Integration 1/3", true], ["Integration 2/3", false], ["Quality Gate", false],
    ]);
    // A job without labels (older API responses) is hosted: never under-report the bill.
    expect(isSelfHosted(job)).toBe(false);
    expect(isSelfHosted({ labels: ["ci-pc"] })).toBe(false);
    const rerun = summarizeAttempts(run, [[{ ...job, ...pc, conclusion: "failure" }],
      [{ ...job, started_at: "2026-09-16T00:05:00Z", completed_at: "2026-09-16T00:06:01Z", labels: ["ubuntu-24.04"] }]]);
    expect([rerun.self_hosted_minutes, rerun.runner_minutes]).toEqual([2, 2]);
  });
  it("does not mistake a failed draft gate for successful reuse", () => {
    expect(summarizeRun({ ...run, conclusion: "failure" }, [{ ...job, conclusion: "skipped" }]).mode).toBe("no-completed-heavy-checks");
    expect(summarizeRun(run, [{ ...job, conclusion: "skipped" }, { ...job, name: "Quality Gate" }]).mode).toBe("gate-reused");
    expect(summarizeRun({ ...run, conclusion: "skipped" }, [{ ...job, conclusion: "skipped" }, { ...job, name: "PR description edit (no gate)", conclusion: "skipped" }]).mode).toBe("metadata-only");
  });
  it("recognizes the actual unevaluated skipped-job name without misclassifying cancellation", () => {
    // Observed on hosted description-edit run 35124939415.
    const name = "github.event.action == 'edited' && !github.event.changes.title && !github.event.changes.base && 'PR description edit (no gate)' || 'Quality Gate'";
    const jobs = [{ ...job, name, conclusion: "skipped" }];
    const metadata = summarizeRun({ ...run, conclusion: "skipped" }, jobs);
    expect(metadata.mode).toBe("metadata-only");
    expect(metadata.runner_minutes).toBe(0);
    expect(summarizeRun({ ...run, conclusion: "cancelled" }, jobs).mode).toBe("no-completed-heavy-checks");
  });
  it("distinguishes image-only main, fresh static with a DB proof, and economy static-only", () => {
    expect(summarizeRun(run, [{ ...job, steps: [{ name: "Typecheck", conclusion: "skipped" }] }]).mode).toBe("gate-reused-image");
    expect(summarizeRun(run, [job, { ...job, name: "Quality Gate" }]).mode).toBe("integration-reused");
    const economy = { ...run, conclusion: "failure" };
    expect(summarizeRun(economy, [job, { ...job, name: "Integration 1/3", conclusion: "skipped" },
      { ...job, name: "Quality Gate", conclusion: "failure" }]).mode).toBe("static-only");
    expect(summarizeRun(economy, [job]).mode).toBe("static-only");
  });
  it("recognizes a metadata-only run by its skipped fingerprint", () => {
    const jobs = [{ ...job, name: "Gate fingerprint", conclusion: "skipped" }, { ...job, conclusion: "skipped" },
      { ...job, name: "Quality Gate" }];
    expect(summarizeRun(run, jobs).mode).toBe("metadata-only");
    expect(summarizeRun({ ...run, conclusion: "failure" }, jobs).mode).toBe("metadata-only");
  });
  it("rejects invalid timestamps instead of silently reporting zero", () => {
    expect(() => summarizeRun(run, [{ ...job, completed_at: "invalid" }])).toThrow("timestamps");
  });
  it("does not bill copied successful jobs again when only failed jobs rerun", () => {
    const first = [job, { ...job, name: "Integration 1/3", conclusion: "failure" }];
    const second = [{ ...job, id: 999 }, { ...job, name: "Integration 1/3",
      started_at: "2026-09-16T00:05:00Z", completed_at: "2026-09-16T00:06:01Z" }];
    const summary = summarizeAttempts(run, [first, second]);
    expect(summary.runner_minutes).toBe(6);
    expect(summary.attempts.map(attempt => attempt.runner_minutes)).toEqual([4, 2]);
  });
});
